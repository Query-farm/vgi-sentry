"""Fixture data for the Sentry replay server: two organizations in documented Sentry API shapes.

Times are fixed; the server evaluates relative windows (statsPeriod=90d) against
FIXTURE_NOW, so results never drift with the wall clock.
"""

from __future__ import annotations

import datetime as dt

FIXTURE_NOW = dt.datetime(2026, 11, 15, 12, 0, 0, tzinfo=dt.timezone.utc)
BASE = "https://acme.sentry.io"


def iso(s: str) -> str:
    """'2026-11-15 10:00' → '2026-11-15T10:00:00.000000Z' (Sentry style, microseconds)."""
    d = dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


ORGS = [
    {
        "id": "1",
        "slug": "acme",
        "name": "Acme Corp",
        "dateCreated": iso("2023-03-01 09:00"),
        "status": {"id": "active", "name": "active"},
        "isEarlyAdopter": True,
        "require2FA": True,
        "avatar": {"avatarType": "letter_avatar", "avatarUuid": None},
        "features": ["discover-query", "performance-view", "session-replay", "crons", "audit-log"],
        "links": {"organizationUrl": "https://acme.sentry.io", "regionUrl": "https://us.sentry.io"},
        "hasAuthProvider": False,
    },
    {
        "id": "2",
        "slug": "globex",
        "name": "Globex",
        "dateCreated": iso("2024-06-10 12:00"),
        "status": {"id": "active", "name": "active"},
        "isEarlyAdopter": False,
        "require2FA": False,
        "avatar": {"avatarType": "letter_avatar", "avatarUuid": None},
        "features": ["discover-query"],
        "links": {"organizationUrl": "https://globex.sentry.io", "regionUrl": "https://de.sentry.io"},
        "hasAuthProvider": False,
    },
]


def project(pid, slug, name, platform, created, teams, **flags):
    return {
        "id": pid,
        "slug": slug,
        "name": name,
        "platform": platform,
        "dateCreated": iso(created),
        "isBookmarked": flags.get("bookmarked", False),
        "isMember": True,
        "hasAccess": True,
        "features": ["releases", "minidump"],
        "firstEvent": iso(created.replace("09:00", "10:00")),
        "firstTransactionEvent": flags.get("tx", False),
        "hasSessions": flags.get("sessions", False),
        "hasReplays": flags.get("replays", False),
        "hasMonitors": flags.get("monitors", False),
        "hasProfiles": False,
        "access": ["project:read", "event:read"],
        "teams": [{"id": t[0], "slug": t[1], "name": t[1].title()} for t in teams],
    }


PROJECTS = {
    "acme": [
        project("101", "backend", "Backend", "python-django", "2023-03-01 09:00", [("11", "platform")], tx=True, sessions=True, monitors=True),
        project("102", "frontend", "Frontend", "javascript-react", "2023-03-02 09:00", [("12", "web")], tx=True, sessions=True, replays=True, bookmarked=True),
        project("103", "mobile", "Mobile", "android", "2023-05-01 09:00", [("13", "mobile")], sessions=True),
    ],
    "globex": [project("201", "web", "Web", "javascript", "2024-06-10 09:00", [("21", "core")])],
}
PROJECT_BY_ID = {p["id"]: (org, p) for org, ps in PROJECTS.items() for p in ps}


def team(tid, slug, members, projects, created, role=None):
    return {
        "id": tid,
        "slug": slug,
        "name": slug.title(),
        "dateCreated": iso(created),
        "isMember": role is not None,
        "teamRole": role,
        "memberCount": members,
        "hasAccess": True,
        "isPending": False,
        "avatar": {"avatarType": "letter_avatar"},
        "projects": [{"id": p["id"], "slug": p["slug"], "name": p["name"]} for p in projects],
    }


TEAMS = {
    "acme": [
        team("11", "platform", 4, [PROJECTS["acme"][0]], "2023-03-01 09:00", "admin"),
        team("12", "web", 3, [PROJECTS["acme"][1]], "2023-03-02 09:00", "contributor"),
        team("13", "mobile", 2, [PROJECTS["acme"][2]], "2023-05-01 09:00"),
    ],
    "globex": [team("21", "core", 1, PROJECTS["globex"], "2024-06-10 09:00", "admin")],
}


def member(mid, uid, name, email, role, created, has2fa=True, pending=False, teams=()):
    return {
        "id": mid,
        "email": email,
        "name": name,
        "user": None
        if pending
        else {"id": uid, "name": name, "username": email, "email": email, "isActive": True, "has2fa": has2fa},
        "orgRole": role,
        "role": role,
        "roleName": role.title(),
        "pending": pending,
        "expired": False,
        "flags": {"sso:linked": False},
        "dateCreated": iso(created),
        "inviteStatus": "approved",
        "inviterName": None if not pending else "Jane Doe",
        "teamRoles": [{"teamSlug": t, "role": r} for t, r in teams],
        "teams": [t for t, _ in teams],
    }


MEMBERS = {
    "acme": [
        member("1001", "501", "Jane Doe", "jane@acme.example", "owner", "2023-03-01 09:00", teams=[("platform", "admin")]),
        member("1002", "502", "Raj Patel", "raj@acme.example", "admin", "2023-04-01 09:00", teams=[("platform", "contributor"), ("web", "admin")]),
        member("1003", "503", "Li Wei", "li@acme.example", "member", "2024-01-15 09:00", has2fa=False, teams=[("web", "contributor")]),
        member("1004", "504", "Ana Gomez", "ana@acme.example", "manager", "2024-07-01 09:00", teams=[("mobile", "admin")]),
        member("1005", None, "", "new.hire@acme.example", "member", "2026-11-12 09:00", has2fa=False, pending=True),
    ],
    "globex": [member("2001", "601", "Hank Scorpio", "hank@globex.example", "owner", "2024-06-10 09:00", teams=[("core", "admin")])],
}

ENVIRONMENTS = {
    "acme": [
        {"id": "1", "name": "production", "isHidden": False},
        {"id": "2", "name": "staging", "isHidden": False},
        {"id": "3", "name": "dev-local", "isHidden": True},
    ],
    "globex": [{"id": "9", "name": "prod", "isHidden": False}],
}

JANE = {"type": "user", "id": "501", "name": "Jane Doe", "email": "jane@acme.example"}
TEAM_WEB = {"type": "team", "id": "12", "name": "web"}
TEAM_PLATFORM = {"type": "team", "id": "11", "name": "platform"}


def issue(gid, short, title, culprit, status, substatus, level, priority, proj, first, last, count, users, **kw):
    org, p = PROJECT_BY_ID[proj]
    meta = kw.get("meta", {})
    return {
        "id": gid,
        "shortId": short,
        "title": title,
        "culprit": culprit,
        "permalink": f"https://{org}.sentry.io/issues/{gid}/",
        "logger": kw.get("logger"),
        "level": level,
        "status": status,
        "statusDetails": {},
        "substatus": substatus,
        "isPublic": False,
        "platform": p["platform"].split("-")[0],
        "project": {"id": p["id"], "name": p["name"], "slug": p["slug"], "platform": p["platform"]},
        "type": kw.get("type", "error"),
        "issueType": kw.get("issueType", "error"),
        "issueCategory": kw.get("issueCategory", "error"),
        "metadata": meta,
        "numComments": kw.get("comments", 0),
        "assignedTo": kw.get("assignee"),
        "isBookmarked": kw.get("bookmarked", False),
        "isSubscribed": True,
        "subscriptionDetails": None,
        "hasSeen": kw.get("seen", True),
        "annotations": [],
        "isUnhandled": kw.get("unhandled", False),
        "count": str(count),
        "userCount": users,
        "firstSeen": iso(first),
        "lastSeen": iso(last),
        "priority": priority,
        "stats": {"24h": []},
        "__org": org,
        "__tags": kw.get("tags", {}),
    }


TAGS_4504001 = {
    "browser": [("Chrome 130", 800, "2026-10-20 08:00", "2026-11-15 10:00"), ("Firefox 132", 300, "2026-10-21 08:00", "2026-11-15 09:00"), ("Safari 18", 104, "2026-10-25 08:00", "2026-11-14 18:00")],
    "browser.name": [("Chrome", 800, "2026-10-20 08:00", "2026-11-15 10:00"), ("Firefox", 300, "2026-10-21 08:00", "2026-11-15 09:00"), ("Safari", 104, "2026-10-25 08:00", "2026-11-14 18:00")],
    "environment": [("production", 1100, "2026-10-20 08:00", "2026-11-15 10:00"), ("staging", 104, "2026-10-20 09:00", "2026-11-13 10:00")],
    "release": [("frontend@3.1.0", 900, "2026-11-12 10:00", "2026-11-15 10:00"), ("frontend@3.0.2", 304, "2026-10-20 08:00", "2026-11-12 09:00")],
    "url": [("https://shop.acme.example/checkout", 1204, "2026-10-20 08:00", "2026-11-15 10:00")],
}

ISSUES = [
    issue("4504001", "FRONTEND-1", "TypeError: Cannot read properties of undefined (reading 'map')", "app/components/Cart", "unresolved", "ongoing", "error", "high", "102", "2026-10-20 08:00", "2026-11-15 10:00", 1204, 311, assignee=TEAM_WEB, unhandled=True, meta={"type": "TypeError", "value": "Cannot read properties of undefined (reading 'map')", "filename": "app/components/Cart.tsx", "function": "renderItems"}, tags=TAGS_4504001, comments=2),
    issue("4504002", "BACKEND-1", "KeyError: 'user_id'", "orders.views.create_order", "unresolved", "regressed", "error", "high", "101", "2026-09-01 12:00", "2026-11-14 22:00", 845, 120, assignee=JANE, meta={"type": "KeyError", "value": "'user_id'"}, tags={"environment": [("production", 845, "2026-09-01 12:00", "2026-11-14 22:00")], "release": [("backend@2.4.0", 400, "2026-11-10 12:00", "2026-11-14 22:00"), ("backend@2.3.1", 445, "2026-09-01 12:00", "2026-11-10 11:00")], "server_name": [("web 1", 500, "2026-09-01 12:00", "2026-11-14 22:00"), ("web 2", 345, "2026-09-02 12:00", "2026-11-14 20:00")]}, logger="django.request"),
    issue("4504003", "BACKEND-2", "OperationalError: database is locked", "billing.tasks.charge", "unresolved", "new", "fatal", "high", "101", "2026-11-10 06:00", "2026-11-15 09:00", 57, 12, meta={"type": "OperationalError", "value": "database is locked"}, tags={"environment": [("production", 57, "2026-11-10 06:00", "2026-11-15 09:00")], "release": [("backend@2.4.0", 57, "2026-11-10 06:00", "2026-11-15 09:00")]}, seen=False),
    issue("4504004", "MOBILE-1", "NullPointerException: Attempt to invoke virtual method on a null object", "com.acme.app.CartActivity in onResume", "unresolved", "escalating", "fatal", "high", "103", "2026-11-01 07:00", "2026-11-15 11:00", 3021, 980, unhandled=True, meta={"type": "NullPointerException", "value": "Attempt to invoke virtual method on a null object"}, tags={"environment": [("production", 3021, "2026-11-01 07:00", "2026-11-15 11:00")], "release": [("mobile@5.2.0", 3021, "2026-11-05 07:00", "2026-11-15 11:00")], "os.name": [("Android", 3021, "2026-11-01 07:00", "2026-11-15 11:00")]}),
    issue("4504005", "BACKEND-3", "N+1 Query", "/api/orders", "unresolved", "ongoing", "warning", "medium", "101", "2026-10-01 10:00", "2026-11-13 16:00", 410, 0, type="performance_n_plus_one_db_queries", issueType="performance_n_plus_one_db_queries", issueCategory="performance", assignee=TEAM_PLATFORM, meta={"title": "N+1 Query", "value": "SELECT * FROM orders_item WHERE order_id = %s"}, tags={"environment": [("production", 410, "2026-10-01 10:00", "2026-11-13 16:00")]}),
    issue("4504006", "FRONTEND-2", "ChunkLoadError: Loading chunk 42 failed.", "webpack/runtime", "resolved", None, "error", "medium", "102", "2026-09-15 10:00", "2026-10-30 10:00", 77, 40, meta={"type": "ChunkLoadError", "value": "Loading chunk 42 failed."}, tags={"environment": [("production", 77, "2026-09-15 10:00", "2026-10-30 10:00")], "browser.name": [("Safari", 77, "2026-09-15 10:00", "2026-10-30 10:00")]}),
    issue("4504007", "BACKEND-4", "TimeoutError: upstream timed out", "payments.client.charge", "ignored", "archived_forever", "warning", "low", "101", "2026-08-20 10:00", "2026-09-10 10:00", 12, 3, meta={"type": "TimeoutError", "value": "upstream timed out"}, tags={"environment": [("staging", 12, "2026-08-20 10:00", "2026-09-10 10:00")]}, bookmarked=True),
    issue("4504008", "MOBILE-2", "OutOfMemoryError: Failed to allocate", "com.acme.app.ImageCache", "resolved", None, "fatal", "medium", "103", "2026-06-01 10:00", "2026-07-01 10:00", 230, 120, meta={"type": "OutOfMemoryError", "value": "Failed to allocate"}, tags={"environment": [("production", 230, "2026-06-01 10:00", "2026-07-01 10:00")]}),
    issue("5600001", "WEB-1", "ReferenceError: gtag is not defined", "index.html", "unresolved", "ongoing", "error", "low", "201", "2026-11-01 10:00", "2026-11-14 10:00", 9, 7, meta={"type": "ReferenceError", "value": "gtag is not defined"}),
]
ISSUE_BY_ID = {i["id"]: i for i in ISSUES}


def frames(*fs):
    return [
        {"filename": f[0], "absPath": f[0], "module": f[1], "function": f[2], "lineNo": f[3], "colNo": None, "inApp": f[4], "context": []}
        for f in fs
    ]


def event(eid, gid, when, env, release, browser=None, user="u-1", **kw):
    i = ISSUE_BY_ID[gid]
    org, p = PROJECT_BY_ID[i["project"]["id"]]
    tags = [{"key": "environment", "value": env}, {"key": "level", "value": i["level"]}, {"key": "release", "value": release}]
    if browser:
        tags.append({"key": "browser", "value": browser})
        tags.append({"key": "browser.name", "value": browser.split(" ")[0]})
    exc = kw.get("exc")
    return {
        "id": eid,
        "eventID": eid,
        "groupID": gid,
        "projectID": p["id"],
        "title": i["title"],
        "message": kw.get("message", ""),
        "platform": i["platform"],
        "type": "error",
        "event.type": "error",
        "dateCreated": iso(when),
        "dateReceived": iso(when).replace(".000000Z", ".500000Z"),
        "culprit": i["culprit"],
        "location": kw.get("location"),
        "user": {"id": user, "email": f"{user}@users.example", "ip_address": "203.0.113.9", "username": None, "name": None},
        "tags": tags,
        "sdk": {"name": kw.get("sdk", "sentry.javascript.react"), "version": "8.40.0"},
        "release": {"version": release},
        "metadata": i["metadata"],
        "entries": [{"type": "exception", "data": {"values": exc}}] if exc else [],
        "contexts": {},
        "fingerprints": ["abc"],
        "__org": org,
        "__project": p["slug"],
    }


FE_EXC = [
    {
        "type": "TypeError",
        "value": "Cannot read properties of undefined (reading 'map')",
        "mechanism": {"type": "onunhandledrejection", "handled": False},
        "stacktrace": {"frames": frames(
            ("node_modules/react-dom/cjs/react-dom.js", None, "renderWithHooks", 1200, False),
            ("app/pages/Checkout.tsx", None, "Checkout", 41, True),
            ("app/components/Cart.tsx", None, "renderItems", 88, True),
            ("node_modules/lodash/map.js", None, "map", 12, False),
        )},
    }
]
BE_EXC = [
    {
        "type": "KeyError",
        "value": "'user_id'",
        "mechanism": {"type": "django", "handled": False},
        "stacktrace": {"frames": frames(
            ("django/core/handlers/base.py", "django.core.handlers.base", "_get_response", 197, False),
            ("orders/views.py", "orders.views", "create_order", 54, True),
            ("orders/serializers.py", "orders.serializers", "validate", 23, True),
        )},
    }
]

EVENTS = [
    event("a1f0000000000000000000000000e001", "4504001", "2026-11-15 10:00", "production", "frontend@3.1.0", "Chrome 130", "u-1", exc=FE_EXC, location="app/components/Cart.tsx"),
    event("a1f0000000000000000000000000e002", "4504001", "2026-11-15 09:00", "production", "frontend@3.1.0", "Firefox 132", "u-2", exc=FE_EXC, location="app/components/Cart.tsx"),
    event("a1f0000000000000000000000000e003", "4504001", "2026-11-14 18:00", "staging", "frontend@3.1.0", "Safari 18", "u-3", exc=FE_EXC, location="app/components/Cart.tsx"),
    event("a1f0000000000000000000000000e004", "4504001", "2026-11-10 08:00", "production", "frontend@3.0.2", "Chrome 130", "u-4", exc=FE_EXC, location="app/components/Cart.tsx"),
    event("a1f0000000000000000000000000e005", "4504001", "2026-10-20 08:00", "production", "frontend@3.0.2", "Chrome 130", "u-5", exc=FE_EXC, location="app/components/Cart.tsx"),
    event("b2f0000000000000000000000000e101", "4504002", "2026-11-14 22:00", "production", "backend@2.4.0", user="u-9", exc=BE_EXC, sdk="sentry.python.django"),
    event("b2f0000000000000000000000000e102", "4504002", "2026-11-01 22:00", "production", "backend@2.3.1", user="u-8", exc=BE_EXC, sdk="sentry.python.django"),
]

# Transactions and spans for Discover.
TRANSACTIONS = []
_tx = [
    ("GET /api/orders", "backend", [120, 135, 150, 180, 240, 900], "200"),
    ("POST /api/checkout", "backend", [300, 320, 410, 1500], "200"),
    ("/checkout", "frontend", [800, 950, 1200], None),
]
_n = 0
for name, proj, durations, status in _tx:
    pid = next(p["id"] for p in PROJECTS["acme"] if p["slug"] == proj)
    for k, d in enumerate(durations):
        _n += 1
        TRANSACTIONS.append({
            "id": f"c3f{_n:029d}",
            "event.type": "transaction",
            "transaction": name,
            "title": name,
            "message": name,
            "transaction.duration": d,
            "timestamp": iso(f"2026-11-{14 + (k % 2):02d} {8 + k:02d}:00"),
            "project": proj,
            "project.id": pid,
            "environment": "production" if k % 3 else "staging",
            "release": "backend@2.4.0" if proj == "backend" else "frontend@3.1.0",
            "level": "info",
            "http.method": name.split(" ")[0] if " " in name else "GET",
            "http.status_code": status if k < len(durations) - 1 else "500",
            "user.id": f"u-{k}",
            "browser.name": "Chrome" if proj == "frontend" else None,
            "error.type": None,
        })

SPANS = [
    {"id": f"d4f{i:029d}", "event.type": "span", "span.op": op, "span.description": desc, "span.duration": dur, "transaction": tx, "project": "backend", "project.id": "101", "environment": "production", "timestamp": iso(f"2026-11-15 0{i % 9}:00"), "release": "backend@2.4.0"}
    for i, (op, desc, dur, tx) in enumerate([
        ("db", "SELECT * FROM orders", 12.5, "GET /api/orders"),
        ("db", "SELECT * FROM orders_item WHERE order_id = %s", 3.0, "GET /api/orders"),
        ("db", "SELECT * FROM orders_item WHERE order_id = %s", 3.4, "GET /api/orders"),
        ("http.client", "POST https://payments.example/charge", 250.0, "POST /api/checkout"),
        ("cache.get", "cart:42", 0.8, "POST /api/checkout"),
    ])
]


def error_row(e):
    """An error event flattened into Discover fields."""
    i = ISSUE_BY_ID[e["groupID"]]
    tags = {t["key"]: t["value"] for t in e["tags"]}
    return {
        "id": e["eventID"],
        "event.type": "error",
        "title": e["title"],
        "message": e["message"] or e["title"],
        "timestamp": e["dateCreated"],
        "transaction": i["culprit"],
        "transaction.duration": None,
        "project": e["__project"],
        "project.id": e["projectID"],
        "environment": tags.get("environment"),
        "release": tags.get("release"),
        "level": i["level"],
        "error.type": i["metadata"].get("type"),
        "user.id": e["user"]["id"],
        "browser.name": tags.get("browser.name"),
        "http.method": None,
        "http.status_code": None,
        "issue": i["shortId"],
    }


def releases():
    def rel(version, created, released, projects, new, commits, deploys, last_deploy, status="open", health=None, authors=()):
        ps = []
        for slug in projects:
            p = next(x for x in PROJECTS["acme"] if x["slug"] == slug)
            h = (health or {}).get(slug)
            ps.append({
                "id": int(p["id"]),
                "slug": slug,
                "name": p["name"],
                "platform": p["platform"],
                "platforms": [p["platform"]],
                "newGroups": new,
                "hasHealthData": h is not None,
                "healthData": None if h is None else {
                    "crashFreeSessions": h[0],
                    "crashFreeUsers": h[1],
                    "adoption": h[2],
                    "sessionsAdoption": h[3],
                    "totalSessions": h[4],
                    "totalUsers": h[5],
                    "sessionsCrashed": h[6],
                    "durationP50": None,
                    "durationP90": None,
                },
            })
        return {
            "version": version,
            "shortVersion": version.split("@")[1],
            "ref": version.split("@")[1].replace(".", "") + "deadbeef",
            "url": f"https://github.com/acme/{version.split('@')[0]}/releases/tag/v{version.split('@')[1]}",
            "status": status,
            "dateCreated": iso(created),
            "dateReleased": iso(released) if released else None,
            "firstEvent": iso(created),
            "lastEvent": iso("2026-11-15 10:00") if status == "open" else iso(created),
            "newGroups": new,
            "commitCount": commits,
            "deployCount": deploys,
            "lastDeploy": last_deploy,
            "authors": [{"name": a, "email": f"{a.split()[0].lower()}@acme.example"} for a in authors],
            "projects": ps,
            "adoptionStages": {s: {"stage": "adopted" if (health or {}).get(s) else "low_adoption", "adopted": None, "unadopted": None} for s in projects},
            "versionInfo": {"package": version.split("@")[0], "version": {"raw": version.split("@")[1]}},
            "owner": None,
            "data": {},
        }

    def dep(did, env, start, end, name=None):
        return {"id": did, "environment": env, "dateStarted": iso(start), "dateFinished": iso(end), "name": name, "url": f"https://ci.acme.example/deploys/{did}"}

    data = {
        "backend@2.4.0": (rel("backend@2.4.0", "2026-11-10 11:00", "2026-11-10 12:00", ["backend"], 2, 3, 2, None, health={"backend": (99.1, 99.6, 72.0, 70.5, 18000, 2400, 162)}, authors=["Jane Doe", "Raj Patel"]),
                          [dep("31", "staging", "2026-11-10 11:10", "2026-11-10 11:20", "2.4.0 staging"), dep("32", "production", "2026-11-10 12:00", "2026-11-10 12:15", "2.4.0 prod")],
                          [("a1b2c3d", "Fix order validation", "2026-11-09 15:00", "Jane Doe", "acme/backend"), ("b2c3d4e", "Add billing retries", "2026-11-09 16:00", "Raj Patel", "acme/backend"), ("c3d4e5f", "Bump Django", "2026-11-10 09:00", "Jane Doe", "acme/backend")]),
        "backend@2.3.1": (rel("backend@2.3.1", "2026-10-28 10:00", "2026-10-28 10:30", ["backend"], 0, 1, 1, None, health={"backend": (99.7, 99.9, 20.0, 22.0, 9000, 1500, 27)}, authors=["Raj Patel"]),
                          [dep("21", "production", "2026-10-28 10:30", "2026-10-28 10:40")],
                          [("d4e5f60", "Hotfix serializer", "2026-10-28 09:00", "Raj Patel", "acme/backend")]),
        "frontend@3.1.0": (rel("frontend@3.1.0", "2026-11-12 10:00", "2026-11-12 10:00", ["frontend"], 1, 2, 2, None, health={"frontend": (96.4, 97.8, 81.0, 80.0, 52000, 9100, 1872)}, authors=["Li Wei"]),
                           [dep("41", "staging", "2026-11-12 09:00", "2026-11-12 09:05"), dep("42", "production", "2026-11-12 10:00", "2026-11-12 10:08")],
                           [("e5f6071", "New cart component", "2026-11-11 14:00", "Li Wei", "acme/frontend"), ("f607182", "Lazy-load checkout", "2026-11-11 17:00", "Li Wei", "acme/frontend")]),
        "frontend@3.0.2": (rel("frontend@3.0.2", "2026-10-15 10:00", "2026-10-15 10:00", ["frontend"], 1, 1, 1, None, health={"frontend": (98.9, 99.2, 15.0, 16.0, 30000, 6000, 330)}, authors=["Li Wei"]),
                           [dep("11", "production", "2026-10-15 10:00", "2026-10-15 10:06")],
                           [("0718293", "Fix chunk loading", "2026-10-14 12:00", "Li Wei", "acme/frontend")]),
        "mobile@5.2.0": (rel("mobile@5.2.0", "2026-11-05 07:00", None, ["mobile"], 1, 0, 0, None, health={"mobile": (93.2, 95.0, 64.0, 60.0, 41000, 12000, 2788)}, authors=[]),
                         [],
                         []),
        "backend@2.2.0": (rel("backend@2.2.0", "2026-08-01 10:00", "2026-08-01 11:00", ["backend"], 0, 0, 1, None, status="archived"),
                          [dep("01", "production", "2026-08-01 11:00", "2026-08-01 11:05")],
                          []),
    }
    for v, (r, deps, _c) in data.items():
        if deps:
            last = max(deps, key=lambda d: d["dateFinished"])
            r["lastDeploy"] = {"id": last["id"], "environment": last["environment"], "dateStarted": last["dateStarted"], "dateFinished": last["dateFinished"], "name": last["name"]}
    return data


RELEASES = releases()


def commit_rows(v):
    return [
        {"id": sha, "message": msg, "dateCreated": iso(when), "author": {"name": author, "email": f"{author.split()[0].lower()}@acme.example"}, "repository": {"id": "7", "name": repo, "provider": {"id": "integrations:github", "name": "GitHub"}}}
        for sha, msg, when, author, repo in RELEASES[v][2]
    ]


ISSUE_RULES = {
    ("acme", "backend"): [
        {"id": "701", "name": "Notify on new backend errors", "conditions": [{"id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"}], "filters": [{"id": "sentry.rules.filters.level.LevelFilter", "match": "gte", "level": "40"}], "actions": [{"id": "sentry.integrations.slack.notify_action.SlackNotifyServiceAction", "channel": "#backend-alerts"}], "actionMatch": "any", "filterMatch": "all", "frequency": 30, "environment": "production", "dateCreated": iso("2024-01-10 10:00"), "owner": "team:11", "createdBy": {"id": 501, "name": "Jane Doe", "email": "jane@acme.example"}, "projects": ["backend"], "status": "active", "snooze": False},
        {"id": "702", "name": "Page on high-volume issues", "conditions": [{"id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition", "value": 100, "interval": "1h"}], "filters": [], "actions": [{"id": "sentry.integrations.pagerduty.notify_action.PagerDutyNotifyServiceAction", "service": "1"}, {"id": "sentry.mail.actions.NotifyEmailAction", "targetType": "IssueOwners"}], "actionMatch": "all", "filterMatch": "all", "frequency": 60, "environment": None, "dateCreated": iso("2024-02-10 10:00"), "owner": None, "createdBy": {"id": 502, "name": "Raj Patel", "email": "raj@acme.example"}, "projects": ["backend"], "status": "active", "snooze": True},
    ],
    ("acme", "frontend"): [
        {"id": "703", "name": "Frontend regressions", "conditions": [{"id": "sentry.rules.conditions.regression_event.RegressionEventCondition"}], "filters": [], "actions": [{"id": "sentry.mail.actions.NotifyEmailAction", "targetType": "Team", "targetIdentifier": 12}], "actionMatch": "all", "filterMatch": "all", "frequency": 1440, "environment": "production", "dateCreated": iso("2024-03-10 10:00"), "owner": "team:12", "createdBy": {"id": 503, "name": "Li Wei", "email": "li@acme.example"}, "projects": ["frontend"], "status": "disabled", "snooze": False},
    ],
}


def trigger(label, threshold):
    return {"id": f"t-{label}", "label": label, "thresholdType": 0, "alertThreshold": threshold, "resolveThreshold": None, "actions": [{"type": "slack", "targetIdentifier": "#alerts"}]}


METRIC_RULES = {
    "acme": [
        {"id": "801", "name": "Checkout p95 latency", "organizationId": "1", "queryType": 1, "dataset": "transactions", "query": "transaction:\"POST /api/checkout\"", "aggregate": "p95(transaction.duration)", "thresholdType": 0, "resolveThreshold": 800.0, "timeWindow": 10, "environment": "production", "triggers": [trigger("critical", 1200.0), trigger("warning", 900.0)], "projects": ["backend"], "owner": "team:11", "dateModified": iso("2026-10-01 10:00"), "dateCreated": iso("2025-05-01 10:00")},
        {"id": "802", "name": "Error spike", "organizationId": "1", "queryType": 0, "dataset": "events", "query": "level:error", "aggregate": "count()", "thresholdType": 0, "resolveThreshold": None, "timeWindow": 60, "environment": None, "triggers": [trigger("critical", 500.0)], "projects": ["backend", "frontend"], "owner": None, "dateModified": iso("2026-09-01 10:00"), "dateCreated": iso("2025-01-01 10:00")},
        {"id": "803", "name": "Crash-free sessions", "organizationId": "1", "queryType": 2, "dataset": "metrics", "query": "", "aggregate": "percentage(sessions_crashed, sessions) AS _crash_rate_alert_aggregate", "thresholdType": 1, "resolveThreshold": 98.0, "timeWindow": 60, "environment": "production", "triggers": [trigger("critical", 95.0)], "projects": ["mobile"], "owner": "team:13", "dateModified": iso("2026-11-01 10:00"), "dateCreated": iso("2025-08-01 10:00")},
    ],
    "globex": [],
}

INCIDENTS = {
    "acme": [
        {"id": "9001", "identifier": "41", "organizationId": "1", "projects": ["backend"], "alertRule": {"id": "801", "name": "Checkout p95 latency"}, "status": 2, "statusMethod": 3, "type": 2, "title": "Checkout p95 latency", "dateStarted": iso("2026-11-02 10:00"), "dateDetected": iso("2026-11-02 10:00"), "dateCreated": iso("2026-11-02 10:01"), "dateClosed": iso("2026-11-02 10:45")},
        {"id": "9002", "identifier": "42", "organizationId": "1", "projects": ["backend", "frontend"], "alertRule": {"id": "802", "name": "Error spike"}, "status": 2, "statusMethod": 3, "type": 2, "title": "Error spike", "dateStarted": iso("2026-11-08 14:00"), "dateDetected": iso("2026-11-08 14:00"), "dateCreated": iso("2026-11-08 14:01"), "dateClosed": iso("2026-11-08 16:00")},
        {"id": "9003", "identifier": "43", "organizationId": "1", "projects": ["mobile"], "alertRule": {"id": "803", "name": "Crash-free sessions"}, "status": 20, "statusMethod": 3, "type": 2, "title": "Crash-free sessions", "dateStarted": iso("2026-11-14 07:00"), "dateDetected": iso("2026-11-14 07:00"), "dateCreated": iso("2026-11-14 07:01"), "dateClosed": None},
        {"id": "9004", "identifier": "44", "organizationId": "1", "projects": ["backend"], "alertRule": {"id": "801", "name": "Checkout p95 latency"}, "status": 10, "statusMethod": 3, "type": 2, "title": "Checkout p95 latency", "dateStarted": iso("2026-11-15 09:30"), "dateDetected": iso("2026-11-15 09:30"), "dateCreated": iso("2026-11-15 09:31"), "dateClosed": None},
    ],
    "globex": [],
}


def monitor(mid, slug, name, proj, stype, schedule, envs, status="active", muted=False, created="2025-01-01 10:00"):
    p = next(x for x in PROJECTS["acme"] if x["slug"] == proj)
    return {
        "id": mid,
        "slug": slug,
        "name": name,
        "status": status,
        "isMuted": muted,
        "type": "cron_job",
        "config": {"schedule_type": stype, "schedule": schedule, "checkin_margin": 5, "max_runtime": 30, "timezone": "UTC", "failure_issue_threshold": 1, "recovery_threshold": 1, "alert_rule_id": None},
        "dateCreated": iso(created),
        "project": {"id": p["id"], "slug": p["slug"], "name": p["name"]},
        "environments": [{"name": e[0], "status": e[1], "isMuted": False, "dateCreated": iso(created), "lastCheckIn": iso(e[2]) if e[2] else None, "nextCheckIn": iso(e[3]) if e[3] else None, "nextCheckInLatest": None} for e in envs],
        "owner": None,
        "alertRule": None,
    }


MONITORS = {
    "acme": [
        monitor("m-1", "nightly-billing", "Nightly billing", "backend", "crontab", "0 2 * * *", [("production", "ok", "2026-11-15 02:00", "2026-11-16 02:00")]),
        monitor("m-2", "hourly-sync", "Hourly CRM sync", "backend", "interval", [1, "hour"], [("production", "error", "2026-11-15 11:00", "2026-11-15 12:00"), ("staging", "ok", "2026-11-15 11:00", "2026-11-15 12:00")]),
        monitor("m-3", "weekly-report", "Weekly report", "frontend", "crontab", "0 6 * * 1", [("production", "missed_checkin", "2026-11-03 06:00", "2026-11-10 06:00")]),
    ],
    "globex": [],
}

CHECKINS = {
    "nightly-billing": [("ci-1", "production", "ok", 61000, "2026-11-15 02:01", "2026-11-15 02:00"), ("ci-2", "production", "ok", 58000, "2026-11-14 02:01", "2026-11-14 02:00"), ("ci-3", "production", "ok", 64000, "2026-11-13 02:01", "2026-11-13 02:00"), ("ci-4", "production", "error", 12000, "2026-11-12 02:00", "2026-11-12 02:00")],
    "hourly-sync": [("ch-1", "production", "error", 3000, "2026-11-15 11:00", "2026-11-15 11:00"), ("ch-2", "staging", "ok", 2000, "2026-11-15 11:00", "2026-11-15 11:00"), ("ch-3", "production", "ok", 2500, "2026-11-15 10:00", "2026-11-15 10:00"), ("ch-4", "production", "timeout", None, "2026-11-15 09:00", "2026-11-15 09:00")],
    "weekly-report": [("cw-1", "production", "missed", None, "2026-11-10 06:05", "2026-11-10 06:00"), ("cw-2", "production", "ok", 420000, "2026-11-03 06:07", "2026-11-03 06:00")],
}

REPLAYS = {
    "acme": [
        {"id": f"r{n:031d}", "project_id": "102", "trace_ids": [], "error_ids": [], "environment": env, "tags": {}, "user": {"id": uid, "username": None, "email": f"{uid}@users.example", "ip": "203.0.113.5", "display_name": f"user {uid}"}, "sdk": {"name": "sentry.javascript.react", "version": "8.40.0"}, "os": {"name": os_, "version": "14"}, "browser": {"name": br, "version": "130"}, "device": {"name": None, "brand": None, "model": None, "family": None}, "ota_updates": {}, "is_archived": False, "urls": urls, "clicks": [], "count_dead_clicks": dead, "count_rage_clicks": rage, "count_errors": errs, "duration": dur, "finished_at": iso(end), "started_at": iso(start), "activity": 4, "count_urls": len(urls), "replay_type": rtype, "count_segments": segs, "platform": "javascript", "releases": ["frontend@3.1.0"], "dist": None}
        for n, (env, uid, os_, br, urls, dead, rage, errs, dur, start, end, rtype, segs) in enumerate([
            ("production", "u-1", "Windows", "Chrome", ["https://shop.acme.example/", "https://shop.acme.example/checkout"], 1, 3, 2, 182, "2026-11-15 09:55", "2026-11-15 09:58", "session", 6),
            ("production", "u-2", "macOS", "Firefox", ["https://shop.acme.example/checkout"], 0, 0, 1, 64, "2026-11-15 08:59", "2026-11-15 09:00", "buffer", 2),
            ("production", "u-7", "iOS", "Safari", ["https://shop.acme.example/"], 2, 0, 0, 300, "2026-11-14 18:00", "2026-11-14 18:05", "session", 9),
            ("staging", "u-3", "Windows", "Chrome", ["https://staging.acme.example/"], 0, 1, 0, 45, "2026-11-13 12:00", "2026-11-13 12:01", "session", 1),
            ("production", "u-4", "Windows", "Chrome", ["https://shop.acme.example/cart"], 0, 0, 0, 20, "2026-07-01 12:00", "2026-07-01 12:00", "session", 1),
        ], start=1)
    ],
    "globex": [],
}

FEEDBACK = {
    ("acme", "frontend"): [
        {"id": "f-1", "eventID": "a1f0000000000000000000000000e001", "name": "Pat Shopper", "email": "pat@customers.example", "comments": "The cart went blank when I clicked checkout.", "dateCreated": iso("2026-11-15 10:01"), "user": None, "event": {"id": "a1f0000000000000000000000000e001", "eventID": "a1f0000000000000000000000000e001"}, "issue": {"id": "4504001", "shortId": "FRONTEND-1", "title": ISSUE_BY_ID["4504001"]["title"]}},
        {"id": "f-2", "eventID": "a1f0000000000000000000000000e002", "name": "Sam Buyer", "email": "sam@customers.example", "comments": "Checkout broken again", "dateCreated": iso("2026-11-15 09:02"), "user": None, "event": {"id": "a1f0000000000000000000000000e002", "eventID": "a1f0000000000000000000000000e002"}, "issue": {"id": "4504001", "shortId": "FRONTEND-1", "title": ISSUE_BY_ID["4504001"]["title"]}},
        {"id": "f-3", "eventID": None, "name": "Kim", "email": "kim@customers.example", "comments": "Pages load slowly on mobile.", "dateCreated": iso("2026-11-10 12:00"), "user": None, "event": None, "issue": None},
    ],
    ("acme", "backend"): [
        {"id": "f-4", "eventID": "b2f0000000000000000000000000e101", "name": "Ops", "email": "ops@acme.example", "comments": "Order creation failed with a 500.", "dateCreated": iso("2026-11-14 22:05"), "user": None, "event": {"id": "b2f0000000000000000000000000e101", "eventID": "b2f0000000000000000000000000e101"}, "issue": {"id": "4504002", "shortId": "BACKEND-1", "title": "KeyError: 'user_id'"}},
    ],
}

AUDIT = {
    "acme": [
        {"id": "a-5", "actor": {"id": "501", "name": "Jane Doe", "username": "jane@acme.example", "email": "jane@acme.example"}, "event": "member.invite", "ipAddress": "198.51.100.10", "note": "invited member new.hire@acme.example", "targetObject": 1005, "targetUser": None, "data": {"email": "new.hire@acme.example", "role": "member"}, "dateCreated": iso("2026-11-12 09:00")},
        {"id": "a-4", "actor": {"id": "502", "name": "Raj Patel", "username": "raj@acme.example", "email": "raj@acme.example"}, "event": "rule.edit", "ipAddress": "198.51.100.11", "note": "edited rule \"Page on high-volume issues\"", "targetObject": 702, "targetUser": None, "data": {"label": "Page on high-volume issues"}, "dateCreated": iso("2026-11-11 15:00")},
        {"id": "a-3", "actor": {"id": "501", "name": "Jane Doe", "username": "jane@acme.example", "email": "jane@acme.example"}, "event": "member.edit", "ipAddress": "198.51.100.10", "note": "edited member ana@acme.example (role manager)", "targetObject": 1004, "targetUser": {"id": "504", "name": "Ana Gomez"}, "data": {"role": "manager"}, "dateCreated": iso("2026-11-01 10:00")},
        {"id": "a-2", "actor": {"id": "502", "name": "Raj Patel", "username": "raj@acme.example", "email": "raj@acme.example"}, "event": "project.edit", "ipAddress": "198.51.100.11", "note": "edited project settings", "targetObject": 101, "targetUser": None, "data": {"slug": "backend"}, "dateCreated": iso("2026-10-20 10:00")},
        {"id": "a-1", "actor": {"id": "501", "name": "Jane Doe", "username": "jane@acme.example", "email": "jane@acme.example"}, "event": "member.invite", "ipAddress": "198.51.100.10", "note": "invited member ana@acme.example", "targetObject": 1004, "targetUser": None, "data": {"email": "ana@acme.example"}, "dateCreated": iso("2024-07-01 09:00")},
    ],
}

# Usage per day: (category, outcome, reason, project_id) → quantity per day function(day_index).
USAGE = [
    ("error", "accepted", None, 101, lambda d: 100),
    ("error", "accepted", None, 102, lambda d: 40),
    ("error", "rate_limited", "key_quota", 102, lambda d: 10 if d < 3 else 0),
    ("transaction", "accepted", None, 101, lambda d: 500),
    ("transaction", "filtered", "release-version", 101, lambda d: 20),
    ("replay", "accepted", None, 102, lambda d: 5),
]
