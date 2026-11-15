"""Sentry search syntax, parsed strictly enough to filter fixture data.

Supports what the worker sends and what the tests use:

* ``key:value``, ``key:"quoted value"`` (``\\"`` and ``\\\\`` escapes), ``key:[a, "b c"]``
* ``!key:value`` / ``!key:[...]`` negation
* ``key:>=value``, ``>``, ``<=``, ``<`` comparisons (numbers, ISO 8601 times)
* ``*`` wildcards inside values
* aggregate keys for Discover having-conditions: ``count():>=10``, ``p95(transaction.duration):>500``
* bare words / quoted phrases (substring match on the message / title)

Anything malformed (unterminated quote, empty value, a bare ``(`` / ``OR``) raises
``SearchError`` so the server answers 400, as Sentry does for invalid searches.
"""

from __future__ import annotations

import datetime as dt
import fnmatch
import re
from dataclasses import dataclass

KEY = r"[A-Za-z_][A-Za-z0-9_.\-@]*(?:\([A-Za-z0-9_.,\- ]*\))?"


class SearchError(ValueError):
    pass


@dataclass
class Term:
    key: str | None  # None: free text
    op: str  # "=", ">=", ">", "<=", "<"
    values: list[str]
    negated: bool = False


def _read_quoted(s: str, i: int) -> tuple[str, int]:
    assert s[i] == '"'
    out = []
    i += 1
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(s[i + 1])
            i += 2
            continue
        if c == '"':
            return "".join(out), i + 1
        out.append(c)
        i += 1
    raise SearchError("unterminated quoted value")


def _read_list(s: str, i: int) -> tuple[list[str], int]:
    assert s[i] == "["
    i += 1
    vals: list[str] = []
    while True:
        while i < len(s) and s[i] == " ":
            i += 1
        if i >= len(s):
            raise SearchError("unterminated list")
        if s[i] == '"':
            v, i = _read_quoted(s, i)
        else:
            j = i
            while i < len(s) and s[i] not in ",]":
                i += 1
            v = s[j:i].strip()
        if v == "":
            raise SearchError("empty list item")
        vals.append(v)
        while i < len(s) and s[i] == " ":
            i += 1
        if i < len(s) and s[i] == ",":
            i += 1
            continue
        if i < len(s) and s[i] == "]":
            return vals, i + 1
        raise SearchError("bad list")


def parse(q: str) -> list[Term]:
    terms: list[Term] = []
    i = 0
    s = q or ""
    key_re = re.compile(rf"(!?)({KEY}):(>=|<=|>|<)?")
    while i < len(s):
        if s[i] == " ":
            i += 1
            continue
        if s[i] in "()":
            raise SearchError("parenthesized / OR searches are not supported by this fixture")
        m = key_re.match(s, i)
        if m:
            neg, key, op = m.group(1) == "!", m.group(2), m.group(3) or "="
            i = m.end()
            if i >= len(s) or s[i] == " ":
                raise SearchError(f"empty value for {key}")
            if s[i] == '"':
                v, i = _read_quoted(s, i)
                vals = [v]
            elif s[i] == "[":
                if op != "=":
                    raise SearchError("a list cannot be compared")
                vals, i = _read_list(s, i)
            else:
                j = i
                while i < len(s) and s[i] != " ":
                    i += 1
                raw = s[j:i]
                if '"' in raw:
                    raise SearchError(f"stray quote in value {raw!r}")
                vals = [raw]
            terms.append(Term(key, op, vals, neg))
            continue
        if s[i] == '"':
            v, i = _read_quoted(s, i)
            terms.append(Term(None, "=", [v]))
            continue
        j = i
        while i < len(s) and s[i] != " ":
            i += 1
        word = s[j:i]
        if word in ("OR", "AND"):
            raise SearchError("boolean operators are not supported by this fixture")
        if '"' in word:
            raise SearchError(f"stray quote in {word!r}")
        terms.append(Term(None, "=", [word]))
    return terms


def parse_time(v: str) -> dt.datetime:
    try:
        d = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError as e:
        raise SearchError(f"invalid date {v!r}") from e
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def match_value(actual, wanted: str) -> bool:
    if actual is None:
        return False
    a = str(actual)
    if "*" in wanted:
        return fnmatch.fnmatchcase(a, wanted)
    return a == wanted


def compare(actual, op: str, wanted: str) -> bool:
    if actual is None:
        return False
    if isinstance(actual, (int, float)) or re.fullmatch(r"-?\d+(\.\d+)?", str(actual) or ""):
        try:
            a, w = float(actual), float(wanted)
        except ValueError as e:
            raise SearchError(f"{wanted!r} is not a number") from e
    else:
        a, w = parse_time(str(actual)), parse_time(wanted)
    return {"=": a == w, ">=": a >= w, ">": a > w, "<=": a <= w, "<": a < w}[op]


def check(term: Term, actual) -> bool:
    """Does one term hold for a (possibly multi-valued) actual value?"""
    actuals = actual if isinstance(actual, list) else [actual]
    if term.op == "=":
        ok = any(match_value(a, w) for a in actuals for w in term.values)
    else:
        ok = any(compare(a, term.op, term.values[0]) for a in actuals)
    return ok != term.negated
