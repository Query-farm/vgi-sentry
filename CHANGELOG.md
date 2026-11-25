# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52.3 and @query-farm/vgi-rpc to 0.30.3. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.1 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.0 (unreleased)

Initial release: read-only Sentry REST API worker (sentry.io, us / de regions, self-hosted) — organizations, projects, teams, members, environments, issues (SQL filters → Sentry issue search), issue_events, issue_tags, issue_tag_values, discover, releases, release_health, release_deploys, release_commits, issue_alert_rules, metric_alert_rules, metric_alert_incidents, monitors, monitor_checkins, replays, user_feedback, audit_log and usage_stats, with Link-cursor paging, X-Sentry-Rate-Limit handling and a strict offline replay server for tests.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
