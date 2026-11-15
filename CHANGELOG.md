# Changelog

## 0.1.0 (unreleased)

Initial release: read-only Sentry REST API worker (sentry.io, us / de regions, self-hosted) — organizations, projects, teams, members, environments, issues (SQL filters → Sentry issue search), issue_events, issue_tags, issue_tag_values, discover, releases, release_health, release_deploys, release_commits, issue_alert_rules, metric_alert_rules, metric_alert_incidents, monitors, monitor_checkins, replays, user_feedback, audit_log and usage_stats, with Link-cursor paging, X-Sentry-Rate-Limit handling and a strict offline replay server for tests.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
