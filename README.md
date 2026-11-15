<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Sentry Issues, Events, Discover, Releases and Crons in DuckDB

> **vgi-sentry** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-sentry/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-sentry/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

[Sentry](https://sentry.io) error and performance monitoring as SQL, read-only, through the
[Sentry REST API](https://docs.sentry.io/api/) — sentry.io (US or EU data residency) or a
self-hosted Sentry. Triage issues with SQL filters that become Sentry issue search, look
inside their events and tag distributions, run Discover queries over errors, transactions
and spans, see what shipped and whether it is stable, audit alerting and cron jobs, and
watch how much volume is accepted or dropped.

```sql
CREATE SECRET sentry (TYPE sentry, AUTH_TOKEN 'sntrys_…', ORGANIZATION 'acme');

-- Top unresolved production errors (status and level become `is:unresolved level:[error,fatal]`).
SELECT short_id, title, event_count, user_count, last_seen, assignee
FROM sentry.main.issues(environment := 'production')
WHERE status = 'unresolved' AND level IN ('error', 'fatal')
ORDER BY event_count DESC LIMIT 10;

-- Busiest transactions and their p95 latency over the last day.
SELECT transaction, count, p95_transaction_duration
FROM sentry.main.discover('transactions', ['transaction', 'count()', 'p95(transaction.duration)'],
                          sort := '-count()', stats_period := '24h')
ORDER BY count DESC LIMIT 10;

-- New issues per release, next to its crash-free session rate.
SELECT r.version, r.new_issues, h.crash_free_sessions, d.finished_at AS deployed_to_prod
FROM sentry.main.releases() r
JOIN sentry.main.release_health() h USING (version)
LEFT JOIN sentry.main.release_deploys() d ON d.version = r.version AND d.environment = 'production'
ORDER BY r.created_at DESC;
```

## Functions and tables

All live in `sentry.main`. Every function takes an optional `organization :=` (or a pushed
`WHERE organization = …`); without one it uses the secret's `ORGANIZATION`, and without that
every organization the token can see. Everything pushed down is re-applied exactly by the
SDK, so pushdown only ever narrows what crosses the network.

| Object | Sentry endpoint | What pushes down |
|---|---|---|
| `organizations` (table) | `GET /api/0/organizations/` | — |
| `projects()` | `GET /organizations/{org}/projects/` | `organization` |
| `teams()` | `GET /organizations/{org}/teams/` | `slug =` → `query=slug:` |
| `members()` | `GET /organizations/{org}/members/` | `role`, `pending`, `has_2fa` (=) → `query=role: isInvited: has2fa:` |
| `environments(visibility := 'visible')` | `GET /organizations/{org}/environments/` | — |
| `issues(project, environment, query, tags, sort := 'date', stats_period, start_time, end_time, page_size)` | `GET /organizations/{org}/issues/` | `status` / `substatus` = → `is:`; `level`, `priority`, `issue_category` (=, IN, !=, NOT IN) → `level:[…]`, `issue.priority:`, `issue.category:` (`!` to negate); `assignee IS NULL / NOT NULL` → `is:unassigned / is:assigned`; `assignee_type = 'team' AND assignee = 'x'` → `assigned:#x`; `first_seen` / `last_seen` ranges → `firstSeen:>= lastSeen:<=`; `event_count >=` → `timesSeen:>=`; `project_slug` (=, IN) → `project:`; `is_bookmarked` → `is:bookmarked`; `tags := ['key:value']` → quoted tag terms |
| `issue_events(issue_id, which := 'all', environment, query, …window)` | `…/issues/{id}/events/` (`full=true`) or `…/events/{latest,oldest,recommended}/` | `issue_id` (=, IN); `environment` =; `release` = → `query=release:`; `created_at` range → `start` / `end` |
| `issue_tags(issue_id, environment)` | `…/issues/{id}/tags/` | `issue_id`; `key` (=, IN) → `key=` |
| `issue_tag_values(issue_id, key, environment, sort := '-count')` | `…/issues/{id}/tags/{key}/values/` | `issue_id`, `key` |
| `discover(dataset, fields, query, sort, project_id, environment, …window)` | `GET /organizations/{org}/events/` | projection → `field` list; string fields (=, IN, !=) → `field:value`; aggregates and numeric fields (`<`, `<=`, `>`, `>=`) → `count():>=n`; `timestamp` range → `start` / `end` |
| `releases(project_id, environment, query, sort := 'date', status)` | `GET /organizations/{org}/releases/` | `version =` → `query=`; `project_id`, `status` = |
| `release_health(…same)` | `…/releases/?health=1` | same; one row per release × project |
| `release_deploys(version)` | `…/releases/{version}/deploys/` | `version` (=, IN); otherwise every open release |
| `release_commits(version)` | `…/releases/{version}/commits/` | `version` (=, IN) |
| `issue_alert_rules(project_slug)` | `GET /projects/{org}/{project}/rules/` | `project_slug` (=, IN) |
| `metric_alert_rules()` | `GET /organizations/{org}/alert-rules/` | — |
| `metric_alert_incidents()` | `GET /organizations/{org}/incidents/` | `status = 'triggered' / 'resolved'` → `status=open / closed` |
| `monitors(environment)` | `GET /organizations/{org}/monitors/` | `project_id` = |
| `monitor_checkins(monitor_slug, environment, …window)` | `…/monitors/{slug}/checkins/` | `monitor_slug` (=, IN); `environment` =; `created_at` range → `start` / `end` |
| `replays(project_id, environment, query, sort, …window)` | `GET /organizations/{org}/replays/` (metadata `field`s only) | `browser_name`, `os_name`, `platform` → `browser.name:` …; `error_count`, `rage_click_count`, `dead_click_count` `>=` → `count_errors:>=n` …; `started_at` range → `start` / `end` |
| `user_feedback(project_slug, include_pii := false)` | `GET /projects/{org}/{project}/user-feedback/` | `project_slug` (=, IN) |
| `audit_log()` | `GET /organizations/{org}/audit-logs/` | `event` = → `event=`; `actor_id` = → `actor=` |
| `usage_stats(interval := '1d', …window)` | `GET /organizations/{org}/stats_v2/` (`sum(quantity)` by outcome, category, reason, project) | `category`, `outcome` (=, IN), `reason` =, `project_id` (=, IN) |

Notes:

- **Windows.** `issues`, `issue_events`, `monitor_checkins` and `replays` default to the last
  90 days, `discover` to 14 days and `usage_stats` to 30 days; pass `stats_period := '24h'`
  or `start_time := … , end_time := …`. Unlike the Sentry UI, `issues()` applies no default
  `is:unresolved`: without a status filter you get every status.
- **Discover columns** are the requested fields, lower-cased with non-alphanumerics turned
  into `_` (`count()` → `count`, `p95(transaction.duration)` → `p95_transaction_duration`).
  Count-like aggregates are `BIGINT`, other aggregates and durations `DOUBLE`, `timestamp`
  `TIMESTAMPTZ`, everything else `VARCHAR`. When the query has aggregates, unprojected
  aggregates are dropped from the request but grouping fields never are (that would change
  the grouping).
- **Search quoting.** Values with spaces, quotes, colons, brackets or a leading `!` are
  double-quoted with `\"` / `\\` escapes, so `tags := ['server_name:web 2']` becomes
  `server_name:"web 2"`. A `*` inside a value is a Sentry wildcard (the SDK re-checks the
  exact value).
- **PII.** Replays expose `user_id` only (no email, IP or name). `user_feedback` returns the
  reporter's name and email only with `include_pii := true`; its comments are free text and
  may contain personal data. Member emails appear as Sentry returns them to the token.
- **Feature detection.** `audit_log()` fails with *audit logs are not available for
  organization …* when the plan or token scope lacks the feature, instead of returning zero
  rows.

### Shared vocabularies

`issues()` and `metric_alert_incidents()` use the incident vocabulary of the PagerDuty worker
where it fits — `title`, `status` / `incident_status` (`triggered`, `acknowledged`,
`resolved`), `created_at` (= `first_seen`), `resolved_at`, `time_to_resolve_seconds`,
`assignee`, `url` — so they `UNION ALL` with other incident sources. `release_deploys()`
follows the web-deploy vocabulary of the Vercel / Netlify workers: `environment`,
`created_at`, `url`.

## Authentication

Create one `sentry` secret with an **auth token**: an organization token (`sntrys_…`,
*Settings → Developer Settings → Organization Tokens*), a user token (`sntryu_…`) or an
internal integration token, with read scopes (`org:read`, `project:read`, `event:read`,
`member:read`, `team:read`, `alerts:read`).

```sql
CREATE SECRET sentry (TYPE sentry, AUTH_TOKEN 'sntrys_…');                              -- sentry.io
CREATE SECRET sentry_eu (TYPE sentry, AUTH_TOKEN 'sntrys_…', REGION 'de');              -- https://de.sentry.io
CREATE SECRET sentry_self (TYPE sentry, AUTH_TOKEN '…', BASE_URL 'https://sentry.example.com');
CREATE SECRET sentry_acme (TYPE sentry, AUTH_TOKEN 'sntrys_…', ORGANIZATION 'acme');    -- default organization
```

`AUTH_TOKEN` is a redacted secret field sent as `Authorization: Bearer …`. It is read from
the secret on every call and never stored in scan state, so it never travels in HTTP
continuation tokens, and it is never sent to an origin other than the configured host
(`https://` only, except `http://127.0.0.1` / `localhost` for local test servers).

## Paging and rate limits

Each Sentry page becomes one Arrow batch. Sentry pages with a `Link` header
(`rel="next"; results="true"; cursor="…"`); the cursor — plus the resolved organizations,
projects, issues or releases and the current position — lives in the table function's
serializable state, so long scans resume on any worker process over the HTTP transport.
`X-Sentry-Rate-Limit-Remaining` / `-Reset` (epoch seconds) are tracked: a 429 waits for
`Retry-After` (or the reset, up to 65 s), the worker pauses on its own when the window is
about to run dry, and 5xx and network errors retry with exponential backoff.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-sentry.git && cd vgi-sentry
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'sentry' (TYPE vgi, LOCATION '/abs/path/to/vgi-sentry/bin/vgi-sentry-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'sentry' (TYPE vgi, LOCATION '/abs/path/to/vgi-sentry/bin/vgi-sentry-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship signed
standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (search quoting, Link paging, backoff, discover naming)
make test-sql                  # test/sql/sentry.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Sentry account. `test/mock_api/server.py` is a
stdlib-only, strict replay server over two hand-built organizations
(`test/mock_api/fixtures.py`, in Sentry's documented response shapes). It checks the bearer
token, rejects unknown or repeated query parameters and bad sort / dataset / field /
interval values, parses Sentry search syntax (`test/mock_api/search.py`: quoting, lists,
negation, comparisons, wildcards, Discover having-conditions) and evaluates it against the
fixtures, so pushdown really narrows the data. It serves at most three rows per page with a
Sentry `Link` header, evaluates relative windows against a fixed clock, answers a 429 and a
503 once each so the retry paths always run, and keeps a `/__requests` log the SQL tests
read to check exactly what was pushed down.

The metadata check runs with `execute: false` in CI: every object needs a `sentry` secret
for a live Sentry organization.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
