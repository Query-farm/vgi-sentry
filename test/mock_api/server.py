#!/usr/bin/env python3
"""A strict, offline Sentry REST API replay server for the tests (stdlib only).

It serves two organizations (``acme``, ``globex``) from ``fixtures.py`` in documented
Sentry response shapes and behaves like Sentry where the worker depends on it:

* **Auth.** ``Authorization: Bearer sntrys_test_token``; anything else is a 401
  ``{"detail": "Invalid token"}``.
* **Strict parameters.** Each route accepts only its documented query parameters
  (repeatable ones may repeat, others may not); an unknown parameter, a bad
  ``per_page`` / ``limit``, ``statsPeriod``, ``sort``, ``dataset``, ``field`` or
  ``interval``, or an unparsable search ``query`` is a 400 ``{"detail": ...}``.
* **Search is evaluated** (``search.py``): issue search (``is:``, ``level:``,
  ``issue.priority:``, ``issue.category:``, ``assigned:#team``, ``firstSeen:``,
  ``lastSeen:``, ``timesSeen:``, ``project:``, ``error.unhandled:``, tag keys, free
  text), member / team search, Discover search including aggregate having-conditions,
  and replay search. A missing issues ``query`` applies Sentry's default
  ``is:unresolved``.
* **Windows.** ``statsPeriod`` (``90d``, ``24h`` …) is relative to the fixed
  FIXTURE_NOW (2026-11-15T12:00Z); ``start`` / ``end`` are ISO 8601.
* **Paging.** At most 3 rows per page whatever ``per_page`` asks, with a Sentry
  ``Link`` header (``rel="previous"`` / ``rel="next"``, ``results``, ``cursor``).
* **Rate limits.** ``X-Sentry-Rate-Limit-Limit / -Remaining / -Reset`` (epoch s) and
  ``-ConcurrentLimit / -ConcurrentRemaining`` on every response; the first
  ``/organizations/acme/issues/`` request answers 429 (``Retry-After: 1``) and the
  first ``/organizations/acme/teams/`` request answers 503.
* **Feature detection.** ``globex`` has no audit-log feature (403).
* **Introspection.** ``GET /__requests?path=/api/0/organizations/acme/issues/`` returns
  every recorded request to that path (``seq``, ``path``, ``query`` as a JSON object
  string, repeated parameters as lists, ``auth`` ok/bad).

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixtures as F  # noqa: E402
import search as S  # noqa: E402

TOKEN = "sntrys_test_token"
PAGE_CAP = 3
LOCK = threading.Lock()
REQUESTS: list[dict] = []
ONCE: set[str] = set()


class ApiError(Exception):
    def __init__(self, status: int, detail: str, headers: dict | None = None):
        super().__init__(detail)
        self.status, self.detail, self.headers = status, detail, headers or {}


def bad(msg: str) -> ApiError:
    return ApiError(400, msg)


# ----------------------------------------------------------------- param checks


class Params:
    """Query parameters checked against a route's allowed set."""

    def __init__(self, qs: dict[str, list[str]], single: set[str], multi: set[str] = frozenset()):
        for k, vs in qs.items():
            if k not in single and k not in multi:
                raise bad(f"unknown parameter: {k}")
            if k in single and len(vs) > 1:
                raise bad(f"parameter {k} given more than once")
        self.qs = qs

    def get(self, k: str, default=None):
        v = self.qs.get(k)
        return v[0] if v else default

    def all(self, k: str) -> list[str]:
        return self.qs.get(k, [])


def page_size(p: Params, name: str = "per_page") -> int:
    raw = p.get(name, "100")
    if not re.fullmatch(r"\d+", raw) or not 1 <= int(raw) <= 100:
        raise bad(f"{name} must be 1-100")
    return int(raw)


def parse_period(v: str) -> dt.timedelta:
    m = re.fullmatch(r"(\d+)([smhdw])", v or "")
    if not m:
        raise bad(f"invalid statsPeriod {v!r}")
    n, u = int(m.group(1)), m.group(2)
    return dt.timedelta(**{{"s": "seconds", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}[u]: n})


def window(p: Params, default: str | None) -> tuple[dt.datetime | None, dt.datetime | None]:
    sp, start, end = p.get("statsPeriod"), p.get("start"), p.get("end")
    if sp and (start or end):
        raise bad("statsPeriod cannot be combined with start/end")
    if start or end:
        if not (start and end):
            raise bad("start and end must be given together")
        try:
            return S.parse_time(start), S.parse_time(end)
        except S.SearchError as e:
            raise bad(str(e)) from e
    if sp or default:
        return F.FIXTURE_NOW - parse_period(sp or default), F.FIXTURE_NOW
    return None, None


def ts(v: str | None) -> dt.datetime | None:
    return S.parse_time(v) if v else None


def search(q: str | None) -> list[S.Term]:
    try:
        return S.parse(q or "")
    except S.SearchError as e:
        raise bad(f"Invalid search query: {e}") from e


def apply_terms(rows: list[dict], terms: list[S.Term], getter, text_fields=("title",)) -> list[dict]:
    out = []
    for r in rows:
        ok = True
        for t in terms:
            if t.key is None:
                hay = " ".join(str(r.get(f) or "") for f in text_fields).lower()
                ok = t.values[0].lower().strip("*") in hay
            else:
                try:
                    ok = S.check(t, getter(r, t.key))
                except S.SearchError as e:
                    raise bad(f"Invalid search query: {e}") from e
            if not ok:
                break
        if ok:
            out.append(r)
    return out


# ------------------------------------------------------------------- paging


def paginate(handler, rows: list, size: int, cursor: str | None, path: str, qs: dict) -> list:
    offset = 0
    if cursor:
        m = re.fullmatch(r"(\d+):(\d+):(0|1)", cursor)
        if not m:
            raise bad(f"invalid cursor {cursor!r}")
        offset = int(m.group(2))
    n = min(size, PAGE_CAP)
    page = rows[offset : offset + n]
    base = f"http://{handler.headers.get('Host')}{path}"

    def link(rel: str, off: int, results: bool) -> str:
        c = f"0:{off}:{1 if rel == 'previous' else 0}"
        q = {k: v for k, v in qs.items() if k != "cursor"}
        q["cursor"] = [c]
        return f'<{base}?{urlencode(q, doseq=True)}>; rel="{rel}"; results="{str(results).lower()}"; cursor="{c}"'

    handler.extra_headers["Link"] = ", ".join(
        [link("previous", max(0, offset - n), offset > 0), link("next", offset + n, offset + n < len(rows))]
    )
    return page


# ------------------------------------------------------------------- routes


def org_or_404(org: str) -> str:
    if org not in {o["slug"] for o in F.ORGS}:
        raise ApiError(404, "The requested resource does not exist")
    return org


def strip(r: dict) -> dict:
    return {k: v for k, v in r.items() if not k.startswith("__")}


def issue_getter(i: dict, key: str):
    tags = i["__tags"]
    m = {
        "is": [i["status"], i["substatus"], "unassigned" if not i["assignedTo"] else "assigned"]
        + (["bookmarked"] if i["isBookmarked"] else [])
        + (["archived"] if i["status"] == "ignored" else []),
        "level": i["level"],
        "issue.priority": i["priority"],
        "issue.category": i["issueCategory"],
        "issue.type": i["issueType"],
        "assigned": (f"#{i['assignedTo']['name']}" if i["assignedTo"] and i["assignedTo"]["type"] == "team" else (i["assignedTo"] or {}).get("email")),
        "firstSeen": i["firstSeen"],
        "lastSeen": i["lastSeen"],
        "timesSeen": int(i["count"]),
        "project": i["project"]["slug"],
        "error.unhandled": "true" if i["isUnhandled"] else "false",
    }
    if key in m:
        return m[key]
    if key in tags:
        return [v[0] for v in tags[key]]
    return None


def r_issues(h, org, p: Params):
    terms = search(p.get("query") if "query" in p.qs else "is:unresolved")
    for t in terms:
        if t.key == "is" and not set(t.values) <= {"unresolved", "resolved", "ignored", "archived", "ongoing", "new", "regressed", "escalating", "unassigned", "assigned", "bookmarked"}:
            raise bad(f"Invalid search query: unknown is: value {t.values}")
    sort = p.get("sort", "date")
    if sort not in {"date", "new", "freq", "user", "trends", "inbox", "priority"}:
        raise bad(f"invalid sort {sort!r}")
    start, end = window(p, "14d")
    rows = [i for i in F.ISSUES if i["__org"] == org]
    if p.all("project"):
        rows = [i for i in rows if i["project"]["id"] in p.all("project")]
    if p.all("environment"):
        rows = [i for i in rows if set(v[0] for v in i["__tags"].get("environment", [])) & set(p.all("environment"))]
    rows = [i for i in rows if ts(i["lastSeen"]) >= start and ts(i["firstSeen"]) <= end]
    rows = apply_terms(rows, terms, issue_getter)
    key = {"date": "lastSeen", "new": "firstSeen", "freq": "count", "user": "userCount", "trends": "lastSeen", "inbox": "lastSeen", "priority": "lastSeen"}[sort]
    rows.sort(key=lambda i: (int(i[key]) if key in ("count", "userCount") else i[key], i["id"]), reverse=True)
    return [strip(i) for i in paginate(h, rows, page_size(p, "limit"), p.get("cursor"), h.path_only, p.qs)]


def issue_in(org, gid):
    i = F.ISSUE_BY_ID.get(gid)
    if not i or i["__org"] != org:
        raise ApiError(404, "Issue not found")
    return i


def event_getter(e: dict, key: str):
    tags = {t["key"]: t["value"] for t in e["tags"]}
    if key in tags:
        return tags[key]
    if key == "user.id":
        return e["user"]["id"]
    return None


def r_issue_events(h, org, gid, p: Params):
    issue_in(org, gid)
    if p.get("full") not in (None, "true", "false", "1", "0"):
        raise bad("full must be a boolean")
    start, end = window(p, None)
    rows = [e for e in F.EVENTS if e["groupID"] == gid]
    if p.all("environment"):
        rows = [e for e in rows if event_getter(e, "environment") in p.all("environment")]
    if start:
        rows = [e for e in rows if start <= ts(e["dateCreated"]) <= end]
    rows = apply_terms(rows, search(p.get("query")), event_getter, ("title", "message"))
    rows.sort(key=lambda e: e["dateCreated"], reverse=True)
    full = p.get("full") in ("true", "1")
    page = paginate(h, rows, 100, p.get("cursor"), h.path_only, p.qs)
    out = []
    for e in page:
        r = strip(e)
        if not full:
            r.pop("entries", None)
        out.append(r)
    return out


def r_issue_event_one(h, org, gid, which, p: Params):
    issue_in(org, gid)
    rows = [e for e in F.EVENTS if e["groupID"] == gid]
    if p.all("environment"):
        rows = [e for e in rows if event_getter(e, "environment") in p.all("environment")]
    if not rows:
        raise ApiError(404, "No events")
    rows.sort(key=lambda e: e["dateCreated"])
    e = rows[0] if which == "oldest" else rows[-1]
    return strip(e)


def tag_values(i, key, envs):
    vals = i["__tags"].get(key, [])
    return [{"key": key, "name": v[0], "value": v[0], "count": v[1], "firstSeen": F.iso(v[2]), "lastSeen": F.iso(v[3])} for v in vals]


def r_issue_tags(h, org, gid, p: Params):
    i = issue_in(org, gid)
    keys = p.all("key") or list(i["__tags"])
    out = []
    for k in keys:
        if k not in i["__tags"]:
            continue
        vals = sorted(tag_values(i, k, p.all("environment")), key=lambda v: -v["count"])
        out.append({"key": k, "name": k.replace(".", " ").title(), "totalValues": sum(v["count"] for v in vals), "topValues": vals[:9]})
    return out


def r_issue_tag_values(h, org, gid, key, p: Params):
    i = issue_in(org, gid)
    if key not in i["__tags"]:
        raise ApiError(404, "Tag key not found")
    sort = p.get("sort", "-count")
    if sort not in {"-count", "-last_seen", "-first_seen", "-id", "count", "last_seen"}:
        raise bad(f"invalid sort {sort!r}")
    vals = tag_values(i, key, p.all("environment"))
    field = {"count": "count", "last_seen": "lastSeen", "first_seen": "firstSeen", "id": "value"}[sort.lstrip("-")]
    vals.sort(key=lambda v: v[field], reverse=sort.startswith("-"))
    return paginate(h, vals, 100, p.get("cursor"), h.path_only, p.qs)


# --------------------------------------------------------------------- discover

DISCOVER_FIELDS = {"id", "event.type", "title", "message", "timestamp", "transaction", "transaction.duration", "project", "project.id", "environment", "release", "level", "error.type", "user.id", "browser.name", "http.method", "http.status_code", "issue", "span.op", "span.description", "span.duration"}
AGG = re.compile(r"^(count|count_unique|avg|sum|min|max|p50|p75|p95|p99|last_seen)\(([a-z_.]*)\)$")


def discover_rows(org: str, dataset: str) -> list[dict]:
    if org != "acme":
        return []
    errors = [F.error_row(e) for e in F.EVENTS if e["__org"] == org]
    if dataset == "errors":
        return errors
    if dataset == "transactions":
        return list(F.TRANSACTIONS)
    if dataset == "spans":
        return list(F.SPANS)
    return errors + list(F.TRANSACTIONS)


def agg_value(fn: str, arg: str, rows: list[dict]):
    if fn == "count":
        return len(rows)
    vals = [r.get(arg) for r in rows if r.get(arg) is not None]
    if fn == "count_unique":
        return len(set(vals))
    if fn == "last_seen":
        return max((r["timestamp"] for r in rows), default=None)
    if not vals:
        return None
    if fn == "avg":
        return statistics.fmean(vals)
    if fn == "sum":
        return float(sum(vals))
    if fn == "min":
        return float(min(vals))
    if fn == "max":
        return float(max(vals))
    q = {"p50": 0.5, "p75": 0.75, "p95": 0.95, "p99": 0.99}[fn]
    s = sorted(vals)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return float(s[lo] + (s[hi] - s[lo]) * (k - lo))


def r_discover(h, org, p: Params):
    dataset = p.get("dataset", "discover")
    if dataset not in {"discover", "errors", "transactions", "spans"}:
        raise bad(f"invalid dataset {dataset!r}")
    fields = p.all("field")
    if not fields:
        raise bad("No columns selected")
    plain, aggs = [], []
    for f in fields:
        m = AGG.match(f)
        if m:
            if m.group(2) and m.group(2) not in DISCOVER_FIELDS:
                raise bad(f"Invalid query: unknown field {m.group(2)}")
            if m.group(1) not in ("count", "last_seen") and not m.group(2):
                raise bad(f"Invalid query: {m.group(1)} needs an argument")
            aggs.append((f, m.group(1), m.group(2)))
        elif f in DISCOVER_FIELDS:
            plain.append(f)
        else:
            raise bad(f"Invalid query: unknown field {f}")
    sort = p.get("sort")
    if sort and sort.lstrip("-") not in fields:
        raise bad(f"Cannot sort by a field that is not selected: {sort}")
    start, end = window(p, "14d")
    rows = [r for r in discover_rows(org, dataset) if start <= ts(r["timestamp"]) <= end]
    if p.all("project"):
        rows = [r for r in rows if r["project.id"] in p.all("project")]
    if p.all("environment"):
        rows = [r for r in rows if r["environment"] in p.all("environment")]
    terms = search(p.get("query"))
    having = [t for t in terms if t.key and AGG.match(t.key)]
    where = [t for t in terms if t not in having]
    for t in having:
        if t.key not in fields:
            raise bad(f"Invalid query: aggregate {t.key} must be selected to filter on it")
    for t in where:
        if t.key and t.key not in DISCOVER_FIELDS:
            raise bad(f"Invalid query: unknown field {t.key}")
    rows = apply_terms(rows, where, lambda r, k: r.get(k), ("title", "message"))
    if aggs:
        groups: dict[tuple, list] = {}
        for r in rows:
            groups.setdefault(tuple(r.get(f) for f in plain), []).append(r)
        out = []
        for key, grp in groups.items():
            row = dict(zip(plain, key))
            for f, fn, arg in aggs:
                row[f] = agg_value(fn, arg, grp)
            out.append(row)
        out = apply_terms(out, having, lambda r, k: r.get(k))
    else:
        out = [{f: r.get(f) for f in plain} for r in rows]
    if sort:
        k = sort.lstrip("-")
        out.sort(key=lambda r: (r.get(k) is None, r.get(k) if r.get(k) is not None else 0), reverse=sort.startswith("-"))
    page = paginate(h, out, page_size(p), p.get("cursor"), h.path_only, p.qs)
    types = {f: ("integer" if f.startswith("count") else "number" if AGG.match(f) else "date" if f == "timestamp" else "string") for f in fields}
    return {"data": page, "meta": {"fields": types, "units": {}}}


# --------------------------------------------------------------------- releases


def r_releases(h, org, p: Params):
    sort = p.get("sort", "date")
    if sort not in {"date", "sessions", "users", "crash_free_sessions", "crash_free_users", "adoption", "semver"}:
        raise bad(f"invalid sort {sort!r}")
    status = p.get("status", "open")
    if status not in {"open", "archived"}:
        raise bad(f"invalid status {status!r}")
    if p.get("health") not in (None, "0", "1"):
        raise bad("health must be 0 or 1")
    rows = [r for r, _d, _c in F.RELEASES.values()] if org == "acme" else []
    rows = [r for r in rows if r["status"] == status]
    if p.get("query"):
        rows = [r for r in rows if p.get("query") in r["version"]]
    if p.all("project"):
        rows = [r for r in rows if any(str(pp["id"]) in p.all("project") for pp in r["projects"])]
    if p.all("environment"):
        envs = set(p.all("environment"))
        rows = [r for r in rows if any(d["environment"] in envs for d in F.RELEASES[r["version"]][1])]
    rows.sort(key=lambda r: r["dateCreated"], reverse=True)
    health = p.get("health") == "1"
    out = []
    for r in paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, p.qs):
        r = json.loads(json.dumps(r))
        if not health:
            for pp in r["projects"]:
                pp["healthData"] = None
        out.append(r)
    return out


def release_or_404(org, version):
    if org != "acme" or version not in F.RELEASES:
        raise ApiError(404, "Release not found")
    return F.RELEASES[version]


# ------------------------------------------------------------------- dispatch

REPLAY_FIELDS = {"id", "project_id", "started_at", "finished_at", "duration", "count_errors", "count_segments", "count_urls", "count_dead_clicks", "count_rage_clicks", "environment", "platform", "releases", "browser", "os", "device", "user", "is_archived", "replay_type", "urls", "trace_ids", "error_ids", "tags", "sdk", "clicks", "activity", "dist", "ota_updates"}


def replay_getter(r, key):
    if "." in key:
        a, b = key.split(".", 1)
        return (r.get(a) or {}).get(b)
    return r.get(key)


def route(h, path: str, qs: dict):  # noqa: C901 - one table of routes
    m = re.fullmatch(r"/api/0(/.*)", path)
    if not m:
        raise ApiError(404, "Not found")
    rest = m.group(1)

    if rest == "/organizations/":
        p = Params(qs, {"owner", "query", "sortBy", "per_page", "cursor", "member"})
        return paginate(h, F.ORGS, page_size(p), p.get("cursor"), h.path_only, qs)

    m = re.fullmatch(r"/organizations/([^/]+)/(.*)", rest)
    if m:
        org, sub = org_or_404(unquote(m.group(1))), m.group(2)
        if sub == "projects/":
            p = Params(qs, {"per_page", "cursor", "query", "all_projects"})
            return paginate(h, F.PROJECTS[org], page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "teams/":
            p = Params(qs, {"per_page", "cursor", "query", "detailed"})
            rows = apply_terms(F.TEAMS[org], search(p.get("query")), lambda t, k: t.get(k), ("slug", "name"))
            return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "members/":
            p = Params(qs, {"per_page", "cursor", "query"})

            def mg(mem, k):
                return {"role": mem["orgRole"], "isInvited": str(mem["pending"]).lower(), "has2fa": str(bool((mem["user"] or {}).get("has2fa"))).lower(), "email": mem["email"]}.get(k)

            for t in search(p.get("query")):
                if t.key not in (None, "role", "isInvited", "has2fa", "email"):
                    raise bad(f"unknown member search key {t.key}")
            rows = apply_terms(F.MEMBERS[org], search(p.get("query")), mg, ("name", "email"))
            return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "environments/":
            p = Params(qs, {"visibility"})
            vis = p.get("visibility", "visible")
            if vis not in {"visible", "hidden", "all"}:
                raise bad("invalid visibility")
            return [{"id": e["id"], "name": e["name"]} for e in F.ENVIRONMENTS[org] if vis == "all" or e["isHidden"] == (vis == "hidden")]
        if sub == "issues/":
            p = Params(qs, {"statsPeriod", "start", "end", "groupStatsPeriod", "shortIdLookup", "query", "viewId", "sort", "limit", "cursor"}, {"environment", "project", "expand", "collapse"})
            return r_issues(h, org, p)
        m2 = re.fullmatch(r"issues/(\d+)/events/", sub)
        if m2:
            p = Params(qs, {"start", "end", "statsPeriod", "full", "sample", "query", "cursor"}, {"environment"})
            return r_issue_events(h, org, m2.group(1), p)
        m2 = re.fullmatch(r"issues/(\d+)/events/(latest|oldest|recommended)/", sub)
        if m2:
            p = Params(qs, set(), {"environment"})
            return r_issue_event_one(h, org, m2.group(1), m2.group(2), p)
        m2 = re.fullmatch(r"issues/(\d+)/tags/", sub)
        if m2:
            p = Params(qs, set(), {"environment", "key"})
            return r_issue_tags(h, org, m2.group(1), p)
        m2 = re.fullmatch(r"issues/(\d+)/tags/([^/]+)/values/", sub)
        if m2:
            p = Params(qs, {"sort", "cursor"}, {"environment"})
            return r_issue_tag_values(h, org, m2.group(1), unquote(m2.group(2)), p)
        if sub == "events/":
            p = Params(qs, {"dataset", "query", "sort", "per_page", "cursor", "statsPeriod", "start", "end"}, {"field", "project", "environment"})
            return r_discover(h, org, p)
        if sub == "releases/":
            p = Params(qs, {"query", "sort", "status", "health", "per_page", "cursor", "healthStatsPeriod", "summaryStatsPeriod"}, {"project", "environment"})
            return r_releases(h, org, p)
        m2 = re.fullmatch(r"releases/([^/]+)/deploys/", sub)
        if m2:
            Params(qs, set())
            return release_or_404(org, unquote(m2.group(1)))[1]
        m2 = re.fullmatch(r"releases/([^/]+)/commits/", sub)
        if m2:
            p = Params(qs, {"per_page", "cursor"})
            v = unquote(m2.group(1))
            release_or_404(org, v)
            return paginate(h, F.commit_rows(v), page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "alert-rules/":
            p = Params(qs, {"per_page", "cursor"})
            return paginate(h, F.METRIC_RULES[org], page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "incidents/":
            p = Params(qs, {"status", "per_page", "cursor", "expand", "title"}, {"project"})
            st = p.get("status")
            if st not in (None, "open", "closed"):
                raise bad("status must be open or closed")
            rows = F.INCIDENTS[org]
            if st:
                rows = [i for i in rows if (i["status"] == 2) == (st == "closed")]
            rows = sorted(rows, key=lambda i: i["dateStarted"], reverse=True)
            return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "monitors/":
            p = Params(qs, {"owner", "query", "per_page", "cursor"}, {"project", "environment"})
            rows = F.MONITORS[org]
            if p.all("project"):
                rows = [x for x in rows if x["project"]["id"] in p.all("project")]
            if p.all("environment"):
                rows = [x for x in rows if any(e["name"] in p.all("environment") for e in x["environments"])]
            return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
        m2 = re.fullmatch(r"monitors/([^/]+)/checkins/", sub)
        if m2:
            p = Params(qs, {"statsPeriod", "start", "end", "per_page", "cursor"}, {"environment"})
            slug = unquote(m2.group(1))
            if org != "acme" or slug not in F.CHECKINS:
                raise ApiError(404, "Monitor not found")
            start, end = window(p, "90d")
            rows = [{"id": c[0], "environment": c[1], "status": c[2], "duration": c[3], "dateCreated": F.iso(c[4]), "dateAdded": F.iso(c[4]), "expectedTime": F.iso(c[5]), "monitorConfig": {}, "groups": []} for c in F.CHECKINS[slug]]
            rows = [r for r in rows if start <= ts(r["dateCreated"]) <= end]
            if p.all("environment"):
                rows = [r for r in rows if r["environment"] in p.all("environment")]
            return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
        if sub == "replays/":
            p = Params(qs, {"statsPeriod", "start", "end", "sort", "query", "per_page", "cursor"}, {"field", "project", "environment"})
            for f in p.all("field"):
                if f not in REPLAY_FIELDS:
                    raise bad(f"Invalid field: {f}")
            sort = p.get("sort", "-started_at")
            if sort.lstrip("-") not in {"started_at", "finished_at", "duration", "count_errors", "count_rage_clicks", "count_dead_clicks", "count_urls"}:
                raise bad(f"invalid sort {sort!r}")
            start, end = window(p, "14d")
            rows = [r for r in F.REPLAYS[org] if start <= ts(r["started_at"]) <= end]
            if p.all("project"):
                rows = [r for r in rows if r["project_id"] in p.all("project")]
            if p.all("environment"):
                rows = [r for r in rows if r["environment"] in p.all("environment")]
            rows = apply_terms(rows, search(p.get("query")), replay_getter, ("urls",))
            k = sort.lstrip("-")
            rows.sort(key=lambda r: r[k], reverse=sort.startswith("-"))
            page = paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
            fields = p.all("field") or sorted(REPLAY_FIELDS)
            return {"data": [{f: r.get(f) for f in fields} for r in page]}
        if sub == "audit-logs/":
            p = Params(qs, {"actor", "event", "per_page", "cursor"})
            if org not in F.AUDIT:
                raise ApiError(403, "Your organization does not have access to this feature.")
            rows = F.AUDIT[org]
            if p.get("event"):
                rows = [r for r in rows if r["event"] == p.get("event")]
            if p.get("actor"):
                rows = [r for r in rows if r["actor"]["id"] == p.get("actor")]
            page = paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
            return {"rows": page, "options": sorted({r["event"] for r in F.AUDIT[org]})}
        if sub == "stats_v2/":
            return r_stats(org, Params(qs, {"field", "reason", "statsPeriod", "start", "end", "interval"}, {"groupBy", "category", "outcome", "project"}))
    m = re.fullmatch(r"/projects/([^/]+)/([^/]+)/(rules|user-feedback)/", rest)
    if m:
        org, proj, what = org_or_404(unquote(m.group(1))), unquote(m.group(2)), m.group(3)
        if proj not in {p["slug"] for p in F.PROJECTS[org]}:
            raise ApiError(404, "Project not found")
        p = Params(qs, {"per_page", "cursor"})
        rows = (F.ISSUE_RULES if what == "rules" else F.FEEDBACK).get((org, proj), [])
        return paginate(h, rows, page_size(p), p.get("cursor"), h.path_only, qs)
    raise ApiError(404, "The requested resource does not exist")


def r_stats(org, p: Params):
    if p.get("field") not in ("sum(quantity)", "sum(times_seen)"):
        raise bad("field must be sum(quantity) or sum(times_seen)")
    for g in p.all("groupBy"):
        if g not in {"outcome", "category", "reason", "project"}:
            raise bad(f"invalid groupBy {g}")
    cats = {"error", "transaction", "attachment", "replay", "profile", "monitor", "span", "default", "security"}
    outs = {"accepted", "filtered", "rate_limited", "invalid", "abuse", "client_discard", "cardinality_limited"}
    for c in p.all("category"):
        if c not in cats:
            raise bad(f"invalid category {c}")
    for o in p.all("outcome"):
        if o not in outs:
            raise bad(f"invalid outcome {o}")
    interval = p.get("interval", "1h")
    if interval not in ("1h", "1d"):
        raise bad("interval must be 1h or 1d")
    start, end = window(p, "14d")
    day0 = start.replace(hour=0, minute=0, second=0, microsecond=0)
    step = dt.timedelta(days=1) if interval == "1d" else dt.timedelta(hours=1)
    intervals = []
    t = day0
    while t < end:
        intervals.append(t)
        t += step
    groups = {}
    usage = F.USAGE if org == "acme" else []
    for cat, outcome, reason, proj, fn in usage:
        if p.all("category") and cat not in p.all("category"):
            continue
        if p.all("outcome") and outcome not in p.all("outcome"):
            continue
        if p.get("reason") and reason != p.get("reason"):
            continue
        if p.all("project") and str(proj) not in p.all("project"):
            continue
        by_all = {"outcome": outcome, "category": cat, "reason": reason or "none", "project": proj}
        by = {k: by_all[k] for k in p.all("groupBy")}
        key = json.dumps(by, sort_keys=True)
        g = groups.setdefault(key, {"by": by, "totals": {p.get("field"): 0}, "series": {p.get("field"): [0] * len(intervals)}})
        for idx, it in enumerate(intervals):
            days_ago = (F.FIXTURE_NOW - it).days
            q = fn(days_ago)
            if interval == "1h":
                q = q // 24
            g["series"][p.get("field")][idx] += q
            g["totals"][p.get("field")] += q
    return {"start": start.isoformat(), "end": end.isoformat(), "intervals": [i.strftime("%Y-%m-%dT%H:%M:%SZ") for i in intervals], "groups": list(groups.values())}


# ------------------------------------------------------------------- handler


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def send_json(self, status: int, body, headers: dict | None = None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        reset = int(time.time()) + 60
        for k, v in {
            "X-Sentry-Rate-Limit-Limit": "40",
            "X-Sentry-Rate-Limit-Remaining": "39",
            "X-Sentry-Rate-Limit-Reset": str(reset),
            "X-Sentry-Rate-Limit-ConcurrentLimit": "25",
            "X-Sentry-Rate-Limit-ConcurrentRemaining": "24",
            **(headers or {}),
            **self.extra_headers,
        }.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        self.extra_headers: dict = {}
        u = urlparse(self.path)
        self.path_only = u.path
        qs = parse_qs(u.query, keep_blank_values=True)
        if u.path == "/__requests":
            want = (qs.get("path") or [""])[0]
            with LOCK:
                rows = [r for r in REQUESTS if not want or r["path"] == want]
            return self.send_json(200, rows)
        if u.path == "/health":
            return self.send_json(200, {"ok": True})
        auth_ok = self.headers.get("Authorization") == f"Bearer {TOKEN}"
        with LOCK:
            REQUESTS.append({"seq": len(REQUESTS) + 1, "path": u.path, "query": json.dumps({k: v[0] if len(v) == 1 else v for k, v in qs.items()}, sort_keys=True), "auth": "ok" if auth_ok else "bad"})
        try:
            if not auth_ok:
                raise ApiError(401, "Invalid token")
            for once_path, status in (("/api/0/organizations/acme/issues/", 429), ("/api/0/organizations/acme/teams/", 503)):
                if u.path == once_path:
                    with LOCK:
                        first = once_path not in ONCE
                        ONCE.add(once_path)
                    if first:
                        if status == 429:
                            raise ApiError(429, "You are attempting to use this endpoint too frequently. Limit is 40 requests in 1 seconds", {"Retry-After": "1", "X-Sentry-Rate-Limit-Remaining": "0"})
                        raise ApiError(503, "Service unavailable")
            body = route(self, u.path, qs)
            self.send_json(200, body)
        except ApiError as e:
            self.send_json(e.status, {"detail": e.detail}, e.headers)
        except Exception as e:  # pragma: no cover - surfaced to the test as a 500
            self.send_json(500, {"detail": f"fixture server error: {type(e).__name__}: {e}"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
