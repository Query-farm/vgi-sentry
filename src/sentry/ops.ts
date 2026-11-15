/**
 * Releases (+ health, deploys, commits), alert rules, metric alert incidents, cron
 * monitors + check-ins, replay metadata, user feedback, audit logs and usage stats.
 * Everything is read-only.
 */

import { bool, utf8 } from "@query-farm/vgi";
import { SentryError } from "./client.ts";
import { projectScopes, Q, WINDOW_ARGS, WINDOW_CONSTRAINTS, WINDOW_DOCS, windowParams } from "./issues.ts";
import { eqOne, eqValues, joinQuery, stringTerms, timeBounds } from "./pushdown.ts";
import {
  at,
  C,
  DATA_BODY,
  defineSentryTable,
  enc,
  listAll,
  ORG_COL,
  pick,
  type Row,
  type ScanContext,
  type Scope,
} from "./table.ts";

const PROJECT_SLUG_DOC =
  "Project slug (named). NULL reads every project of the organization (one call per project); a pushed WHERE " +
  "project_slug = / IN (...) works the same way.";

const projectList = (r: Row): string[] | null =>
  Array.isArray(r.projects)
    ? (r.projects as unknown[])
        .map((p) => (typeof p === "string" ? p : (p as Row | null)?.slug))
        .filter((x): x is string => typeof x === "string")
    : null;

// ---------------------------------------------------------------------- releases

type ReleaseArgs = {
  organization: string | null;
  project_id: string | null;
  environment: string | null;
  query: string | null;
  sort: string;
  status: string | null;
};

const RELEASE_ARGS = {
  args: { project_id: utf8(), environment: utf8(), query: utf8(), sort: utf8(), status: utf8() },
  argDocs: {
    project_id: "Numeric project id (named); NULL = every project. Also pushed from WHERE project_id =.",
    environment: "Environment name (named); only releases deployed / seen there.",
    query: "Version search (named): releases whose version contains this text.",
    sort: "Order (named): date (default), sessions, users, crash_free_sessions, crash_free_users, adoption, semver.",
    status: "open (default when NULL: Sentry lists open releases) or archived (named).",
  },
  argDefaults: { project_id: null, environment: null, query: null, sort: "date", status: null },
  argConstraints: {
    sort: { choices: ["date", "sessions", "users", "crash_free_sessions", "crash_free_users", "adoption", "semver"] },
    status: { choices: ["open", "archived"] },
  },
};

function releaseRequest(health: boolean) {
  return (s: Scope, { args, constraints }: ScanContext<ReleaseArgs>) => {
    const version = eqOne(constraints, "version");
    return {
      path: `/organizations/${enc(s.organization)}/releases/`,
      paging: "cursor" as const,
      query: {
        project: args.project_id ?? eqOne(constraints, "project_id"),
        environment: args.environment ?? undefined,
        // `query` is a substring match on the version; the SDK tightens it to equality.
        query: args.query ?? version,
        sort: args.sort ?? "date",
        status: args.status ?? eqOne(constraints, "status"),
        health: health ? "1" : undefined,
      },
    };
  };
}

export const releases = defineSentryTable<ReleaseArgs>({
  name: "releases",
  description: "Sentry releases: versions, dates, new issues, commits, deploys and projects",
  title: "Sentry Releases",
  category: "releases",
  keywords: "sentry, releases, versions, deploys, commits, new issues, regressions, semver",
  docLlm:
    "Releases of each organization (GET /api/0/organizations/{org}/releases/), one row per release: version, " +
    "short_version, ref, url, status, created_at, released_at, first_event / last_event, new_issues (issues first " +
    "seen in the release), commit_count, deploy_count, the last deploy's environment and time, author names and " +
    "project slugs. Arguments (named): project_id, environment, query (version substring), sort, status " +
    "('open' default / 'archived'). For crash-free rates and adoption per project use release_health(); deploys " +
    "and commits are in release_deploys() / release_commits().",
  docMd: "## releases(project_id, environment, query, sort := 'date', status)\n\nOne row per release.",
  pushdown:
    "`version` (=) → `query=` (version search); `project_id` (=) → `project=`; `status` (=) → `status=`; " +
    "`organization` picks organizations. Pages follow the `Link` cursor.",
  ...RELEASE_ARGS,
  columns: [
    ORG_COL,
    C.str("version", "Release version.", "version", false),
    C.str("short_version", "Shortened version for display.", "shortVersion"),
    C.str("ref", "VCS ref (commit SHA or tag) the release was built from.", "ref"),
    C.str("url", "URL associated with the release.", "url"),
    C.str("status", "open or archived.", "status"),
    C.iso("created_at", "When the release was created in Sentry.", "dateCreated"),
    C.iso("released_at", "When the release was marked released (finalized).", "dateReleased"),
    C.iso("first_event", "First event seen in the release.", "firstEvent"),
    C.iso("last_event", "Latest event seen in the release.", "lastEvent"),
    C.big("new_issues", "Issues first seen in this release.", "newGroups"),
    C.big("commit_count", "Commits associated with the release.", "commitCount"),
    C.big("deploy_count", "Deploys of the release.", "deployCount"),
    C.str("last_deploy_environment", "Environment of the most recent deploy.", "lastDeploy.environment"),
    C.iso(
      "last_deploy_at",
      "When the most recent deploy finished.",
      (r) => r.lastDeploy?.dateFinished ?? r.lastDeploy?.dateStarted,
    ),
    C.strList("authors", "Commit author names.", (r) =>
      Array.isArray(r.authors) ? r.authors.map((a: Row) => a?.name ?? a?.email ?? null) : null,
    ),
    C.strList("projects", "Slugs of the release's projects.", projectList),
  ],
  request: releaseRequest(false),
  examples: [
    {
      sql: `SELECT version, released_at, new_issues, deploy_count FROM ${Q}.releases() ORDER BY created_at DESC LIMIT 10`,
      description: "The ten most recent releases and the new issues they introduced",
    },
    {
      sql: `SELECT p AS project, count(*) AS releases FROM ${Q}.releases(), unnest(projects) AS u(p) GROUP BY p ORDER BY releases DESC`,
      description: "Releases per project",
    },
  ],
});

export const releaseHealth = defineSentryTable<ReleaseArgs>({
  name: "release_health",
  description: "Sentry release health per release and project: crash-free rates, adoption, sessions",
  title: "Sentry Release Health",
  category: "releases",
  keywords: "sentry, release health, crash free sessions, crash free users, adoption, sessions, stability",
  docLlm:
    "Release health (GET /api/0/organizations/{org}/releases/?health=1), one row per release and project: " +
    "crash_free_sessions and crash_free_users (percent, 0-100), adoption and sessions_adoption (percent of " +
    "sessions/users on this release in the last 24h), total sessions and users, whether health data exists, and " +
    "the adoption stage. Requires the SDKs to send sessions. Arguments as releases().",
  docMd: "## release_health(project_id, environment, query, sort := 'date', status)\n\nOne row per release × project.",
  pushdown: "As releases(): `version` (=) → `query=`, `project_id` (=) → `project=`, `status` (=) → `status=`.",
  ...RELEASE_ARGS,
  columns: [
    ORG_COL,
    C.str("version", "Release version.", "version", false),
    C.str("project_slug", "Project slug.", "__project.slug"),
    C.str("project_id", "Project id.", (r) => (r.__project?.id == null ? null : String(r.__project.id))),
    C.bool("has_health_data", "Sessions have been received for this release and project.", "__project.hasHealthData"),
    C.num("crash_free_sessions", "Crash-free sessions, percent.", "__project.healthData.crashFreeSessions"),
    C.num("crash_free_users", "Crash-free users, percent.", "__project.healthData.crashFreeUsers"),
    C.num("adoption", "Percent of users on this release (last 24h).", "__project.healthData.adoption"),
    C.num(
      "sessions_adoption",
      "Percent of sessions on this release (last 24h).",
      "__project.healthData.sessionsAdoption",
    ),
    C.big("total_sessions", "Sessions in the summary period.", "__project.healthData.totalSessions"),
    C.big("total_users", "Users in the summary period.", "__project.healthData.totalUsers"),
    C.big("sessions_crashed", "Crashed sessions in the summary period.", "__project.healthData.sessionsCrashed"),
    C.str("adoption_stage", "adopted, low_adoption or replaced (per environment, when reported).", (r) => {
      const stages = r.adoptionStages;
      const slug = r.__project?.slug;
      return stages && slug && stages[slug] ? (stages[slug].stage ?? null) : null;
    }),
    C.iso("created_at", "When the release was created.", "dateCreated"),
  ],
  request: releaseRequest(true),
  rows: (body) =>
    (Array.isArray(body) ? (body as Row[]) : []).flatMap((rel) =>
      (Array.isArray(rel.projects) ? rel.projects : []).map((p: Row) => ({ ...rel, __project: p })),
    ),
  examples: [
    {
      sql: `SELECT version, project_slug, crash_free_sessions, adoption FROM ${Q}.release_health() WHERE has_health_data ORDER BY crash_free_sessions`,
      description: "Least stable releases first",
    },
    {
      sql: `SELECT project_slug, avg(crash_free_users) AS avg_crash_free_users FROM ${Q}.release_health(environment := 'production') GROUP BY project_slug ORDER BY project_slug`,
      description: "Average crash-free users per project in production",
    },
  ],
});

/** Sub-scopes: one per release version (argument, pushed filter, or every open release). */
async function versionScopes(
  org: string,
  cfg: Parameters<typeof listAll>[0],
  ctx: ScanContext<Record<string, unknown>>,
): Promise<Record<string, string>[]> {
  const explicit = pick(ctx.args, ctx.constraints, "version");
  const versions =
    explicit ??
    (await listAll(cfg, `/organizations/${enc(org)}/releases/`, { sort: "date" }))
      .map((r) => r.version)
      .filter((v): v is string => typeof v === "string");
  return versions.map((version) => ({ version }));
}

const VERSION_DOC =
  "Release version (named). NULL reads every open release (one call per release); a pushed WHERE version = / IN (...) works the same way.";

export const releaseDeploys = defineSentryTable<{ organization: string | null; version: string | null }>({
  name: "release_deploys",
  description: "Deploys of Sentry releases: environment, start / finish time, name and URL",
  title: "Sentry Release Deploys",
  category: "releases",
  keywords: "sentry, deploys, deployments, environments, production, release",
  docLlm:
    "Deploys of each release (GET /api/0/organizations/{org}/releases/{version}/deploys/): deploy_id, version, " +
    "environment, name, started_at, finished_at, created_at (= finished_at, else started_at) and url. Columns " +
    "follow the web-deploy vocabulary of the Vercel / Netlify workers (environment, created_at, url). version := " +
    "picks one release; otherwise every open release is read (one call each).",
  docMd: "## release_deploys(version := NULL)\n\nOne row per deploy.",
  pushdown: "`version` (=, IN) picks the releases; `organization` picks organizations.",
  args: { version: utf8() },
  argDocs: { version: VERSION_DOC },
  argDefaults: { version: null },
  subScopes: versionScopes,
  columns: [
    ORG_COL,
    C.ctx("version", "Release version.", "version"),
    C.str("deploy_id", "Deploy id.", "id", false),
    C.str("environment", "Environment deployed to.", "environment"),
    C.str("name", "Deploy name.", "name"),
    C.iso("started_at", "When the deploy started.", "dateStarted"),
    C.iso("finished_at", "When the deploy finished.", "dateFinished"),
    C.iso(
      "created_at",
      "finished_at, else started_at (web-deploy vocabulary).",
      (r) => r.dateFinished ?? r.dateStarted,
    ),
    C.str("url", "URL of the deploy (CI run, dashboard …).", "url"),
  ],
  request: (s) => ({
    path: `/organizations/${enc(s.organization)}/releases/${enc(s.version ?? "")}/deploys/`,
    paging: "single",
  }),
  notFoundEmpty: true,
  examples: [
    {
      sql: `SELECT version, environment, finished_at FROM ${Q}.release_deploys() WHERE environment = 'production' ORDER BY finished_at DESC LIMIT 10`,
      description: "The latest production deploys",
    },
    {
      sql: `SELECT environment, count(*) AS deploys FROM ${Q}.release_deploys(version := 'backend@2.4.0') GROUP BY environment ORDER BY environment`,
      description: "Where one release was deployed",
    },
  ],
});

export const releaseCommits = defineSentryTable<{ organization: string | null; version: string | null }>({
  name: "release_commits",
  description: "Commits associated with Sentry releases",
  title: "Sentry Release Commits",
  category: "releases",
  keywords: "sentry, commits, suspect commits, repository, author, release",
  docLlm:
    "Commits of each release (GET /api/0/organizations/{org}/releases/{version}/commits/): commit sha, message, " +
    "created_at, author name and repository name (author emails are not exposed). version := picks one release; " +
    "otherwise every open release is read.",
  docMd: "## release_commits(version := NULL)\n\nOne row per commit of a release.",
  pushdown: "`version` (=, IN) picks the releases.",
  args: { version: utf8() },
  argDocs: { version: VERSION_DOC },
  argDefaults: { version: null },
  subScopes: versionScopes,
  columns: [
    ORG_COL,
    C.ctx("version", "Release version.", "version"),
    C.str("commit_sha", "Commit SHA.", "id", false),
    C.str("message", "Commit message.", "message"),
    C.iso("created_at", "Commit time.", "dateCreated"),
    C.str("author", "Author name.", "author.name"),
    C.str("repository", "Repository name (owner/repo).", "repository.name"),
  ],
  request: (s) => ({
    path: `/organizations/${enc(s.organization)}/releases/${enc(s.version ?? "")}/commits/`,
    paging: "cursor",
  }),
  notFoundEmpty: true,
  examples: [
    {
      sql: `SELECT author, count(*) AS commits FROM ${Q}.release_commits(version := 'backend@2.4.0') GROUP BY author ORDER BY commits DESC`,
      description: "Who contributed to a release",
    },
    {
      sql: `SELECT version, repository, count(*) AS commits FROM ${Q}.release_commits() GROUP BY ALL ORDER BY version, repository`,
      description: "Commits per release and repository",
    },
  ],
});

// ------------------------------------------------------------------ alert rules

export const issueAlertRules = defineSentryTable<{ organization: string | null; project_slug: string | null }>({
  name: "issue_alert_rules",
  description: "Sentry issue alert rules per project: conditions, filters, actions, frequency",
  title: "Sentry Issue Alert Rules",
  category: "alerts",
  keywords: "sentry, alerts, issue alerts, rules, notifications, conditions, actions, slack, pagerduty",
  docLlm:
    "Issue alert rules of each project (GET /api/0/projects/{org}/{project}/rules/): id, name, project_slug, " +
    "environment, action_match / filter_match (all, any, none), frequency_minutes (how often the rule may fire " +
    "per issue), status, owner, created_by, created_at, snoozed, and the conditions, filters and actions as JSON " +
    "(each an object with an `id` naming the Sentry rule class plus its settings). project_slug := reads one " +
    "project; otherwise every project.",
  docMd: "## issue_alert_rules(project_slug := NULL)\n\nOne row per issue alert rule.",
  pushdown: "`project_slug` (=, IN) picks the projects; `organization` picks organizations.",
  args: { project_slug: utf8() },
  argDocs: { project_slug: PROJECT_SLUG_DOC },
  argDefaults: { project_slug: null },
  subScopes: projectScopes,
  columns: [
    ORG_COL,
    C.ctx("project_slug", "Project slug.", "project_slug"),
    C.str("id", "Rule id.", "id", false),
    C.str("name", "Rule name.", "name"),
    C.str("environment", "Environment the rule is limited to (NULL: all).", "environment"),
    C.str("action_match", "Conditions combinator: all, any or none.", "actionMatch"),
    C.str("filter_match", "Filters combinator: all, any or none.", "filterMatch"),
    C.int("frequency_minutes", "Minimum minutes between notifications for the same issue.", "frequency"),
    C.str("status", "active or disabled.", "status"),
    C.str("owner", "Owner (user:<id> or team:<id>).", "owner"),
    C.str("created_by", "Name of the creator.", "createdBy.name"),
    C.iso("created_at", "When the rule was created.", "dateCreated"),
    C.bool("snoozed", "The rule is muted.", (r) => (typeof r.snooze === "boolean" ? r.snooze : null)),
    C.int("action_count", "Number of actions.", (r) => (Array.isArray(r.actions) ? r.actions.length : null)),
    C.json("conditions", "Trigger conditions (JSON array).", "conditions"),
    C.json("filters", "Filters (JSON array).", "filters"),
    C.json("actions", "Actions (JSON array: notify email, Slack, PagerDuty …).", "actions"),
  ],
  request: (s) => ({
    path: `/projects/${enc(s.organization)}/${enc(s.project_slug ?? "")}/rules/`,
    paging: "cursor",
  }),
  notFoundEmpty: true,
  examples: [
    {
      sql: `SELECT project_slug, name, frequency_minutes, action_count FROM ${Q}.issue_alert_rules() ORDER BY project_slug, name`,
      description: "Issue alert rules of every project",
    },
    {
      sql: `SELECT project_slug, count(*) AS rules FROM ${Q}.issue_alert_rules() WHERE status = 'active' AND NOT snoozed GROUP BY project_slug ORDER BY rules`,
      description: "Active, unmuted issue alert rules per project",
    },
  ],
});

const triggerThreshold = (label: string) => (r: Row) => {
  const t = Array.isArray(r.triggers) ? r.triggers.find((x: Row) => x?.label === label) : undefined;
  return t?.alertThreshold;
};

export const metricAlertRules = defineSentryTable<{ organization: string | null }>({
  name: "metric_alert_rules",
  description: "Sentry metric alert rules: aggregate, query, window, critical / warning thresholds",
  title: "Sentry Metric Alert Rules",
  category: "alerts",
  keywords: "sentry, metric alerts, thresholds, error rate, latency, p95, crash rate, apdex",
  docLlm:
    "Metric alert rules of each organization (GET /api/0/organizations/{org}/alert-rules/): id, name, dataset " +
    "(events, transactions, sessions, metrics …), query, aggregate (count(), p95(transaction.duration), " +
    "percentage(sessions_crashed, sessions) …), time_window_minutes, threshold_type (above / below), " +
    "critical_threshold, warning_threshold, resolve_threshold, environment, projects, owner, created_at, " +
    "modified_at and the triggers as JSON.",
  docMd: "## metric_alert_rules()\n\nOne row per metric alert rule.",
  pushdown: "`organization` (=, IN) picks organizations; filters are applied by the SDK.",
  columns: [
    ORG_COL,
    C.str("id", "Rule id.", "id", false),
    C.str("name", "Rule name.", "name"),
    C.str("dataset", "Dataset the aggregate runs on.", "dataset"),
    C.str("query", "Event search the aggregate is limited to.", "query"),
    C.str("aggregate", "Aggregate expression, e.g. count() or p95(transaction.duration).", "aggregate"),
    C.int("time_window_minutes", "Aggregation window, minutes.", "timeWindow"),
    C.str("threshold_type", "above or below.", (r) =>
      r.thresholdType === 0 ? "above" : r.thresholdType === 1 ? "below" : null,
    ),
    C.num("critical_threshold", "Threshold of the critical trigger.", triggerThreshold("critical")),
    C.num("warning_threshold", "Threshold of the warning trigger (NULL: none).", triggerThreshold("warning")),
    C.num("resolve_threshold", "Value at which the alert resolves (NULL: the trigger threshold).", "resolveThreshold"),
    C.str("environment", "Environment (NULL: all).", "environment"),
    C.strList("projects", "Project slugs.", projectList),
    C.str("owner", "Owner (user:<id> or team:<id>).", "owner"),
    C.iso("created_at", "When the rule was created.", "dateCreated"),
    C.iso("modified_at", "When the rule was last changed.", "dateModified"),
    C.json("triggers", "Triggers with their actions (JSON array).", "triggers"),
  ],
  request: (s) => ({ path: `/organizations/${enc(s.organization)}/alert-rules/`, paging: "cursor" }),
  onError: (err, s) => metricAlertsUnavailable(err, s, "metric alert rules"),
  examples: [
    {
      sql: `SELECT name, aggregate, critical_threshold, time_window_minutes FROM ${Q}.metric_alert_rules() ORDER BY name`,
      description: "Metric alert rules and their thresholds",
    },
    {
      sql: `SELECT dataset, count(*) AS rules FROM ${Q}.metric_alert_rules() GROUP BY dataset ORDER BY rules DESC`,
      description: "Metric alert rules per dataset",
    },
  ],
});

/** Metric alerts are plan- and token-gated; Sentry answers 403/404 when the org can't use them. */
function metricAlertsUnavailable(err: SentryError, s: { organization: string }, what: string): SentryError | null {
  return err.status === 403 || err.status === 404
    ? new SentryError(
        `${what} are not available for organization '${s.organization}' (HTTP ${err.status}): metric alerts need a ` +
          "Sentry plan that includes them and a token with alerts:read scope",
        err.status,
      )
    : null;
}

/** Sentry IncidentStatus: 1 open, 2 closed, 10 warning, 20 critical. */
const INCIDENT_STATUS: Record<number, string> = { 1: "open", 2: "closed", 10: "warning", 20: "critical" };

export const metricAlertIncidents = defineSentryTable<{ organization: string | null }>({
  name: "metric_alert_incidents",
  description: "Sentry metric alert incidents (triggered metric alerts) in the shared incident vocabulary",
  title: "Sentry Metric Alert Incidents",
  category: "alerts",
  keywords: "sentry, incidents, metric alerts, triggered, critical, warning, mttr, resolved",
  docLlm:
    "Incidents opened by metric alert rules (GET /api/0/organizations/{org}/incidents/), in the cross-worker " +
    "incident vocabulary shared with PagerDuty: incident_id (the per-org identifier), title, status (triggered / " +
    "resolved), raw_status (open, warning, critical, closed), severity (warning / critical), created_at " +
    "(dateStarted), detected_at, resolved_at (dateClosed), time_to_resolve_seconds, alert_rule_id / " +
    "alert_rule_name, projects and url. Use it for alert noise and MTTR analysis.",
  docMd: "## metric_alert_incidents()\n\nOne row per metric alert incident.",
  pushdown:
    "`status` = 'resolved' → `status=closed`, = 'triggered' → `status=open`; `organization` picks organizations.",
  columns: [
    ORG_COL,
    C.str("incident_id", "Incident identifier (unique within the organization).", "identifier", false),
    C.str("id", "Internal incident id.", "id"),
    C.str("title", "Incident title (the alert rule name).", "title"),
    C.str("status", "Normalized: triggered or resolved.", (r) => (r.status === 2 ? "resolved" : "triggered"), false),
    C.str(
      "raw_status",
      "Sentry status: open, warning, critical or closed.",
      (r) => INCIDENT_STATUS[r.status as number] ?? String(r.status),
    ),
    C.str("severity", "Highest severity reached: warning or critical.", (r) =>
      r.status === 20 ? "critical" : r.status === 10 ? "warning" : null,
    ),
    C.iso("created_at", "When the incident started.", "dateStarted"),
    C.iso("detected_at", "When Sentry detected it.", "dateDetected"),
    C.iso("resolved_at", "When it closed (NULL while open).", "dateClosed"),
    C.num("time_to_resolve_seconds", "resolved_at - created_at, seconds.", (r) => {
      const a = Date.parse(r.dateStarted);
      const b = Date.parse(r.dateClosed);
      return Number.isNaN(a) || Number.isNaN(b) ? null : (b - a) / 1000;
    }),
    C.str("alert_rule_id", "Id of the metric alert rule.", "alertRule.id"),
    C.str("alert_rule_name", "Name of the metric alert rule.", "alertRule.name"),
    C.strList("projects", "Project slugs.", projectList),
    C.str("url", "Link to the incident in the Sentry web UI.", (r) => {
      // Region API hosts (us.sentry.io / de.sentry.io) serve the UI from sentry.io.
      const base = r.__ctx?.base_url?.replace(/^https:\/\/(us|de)\.sentry\.io$/, "https://sentry.io");
      const org = r.__ctx?.organization;
      const rule = at(r, "alertRule.id");
      return base && org && rule != null
        ? `${base}/organizations/${org}/alerts/rules/details/${rule}/?alert=${r.identifier}`
        : null;
    }),
  ],
  request: (s, { constraints }) => {
    const st = eqOne(constraints, "status");
    return {
      path: `/organizations/${enc(s.organization)}/incidents/`,
      paging: "cursor",
      query: { status: st === "resolved" ? "closed" : st === "triggered" ? "open" : undefined },
    };
  },
  onError: (err, s) => metricAlertsUnavailable(err, s, "metric alert incidents"),

  examples: [
    {
      sql: `SELECT alert_rule_name, count(*) AS incidents, avg(time_to_resolve_seconds) / 60 AS avg_minutes_to_resolve FROM ${Q}.metric_alert_incidents() WHERE status = 'resolved' GROUP BY alert_rule_name ORDER BY incidents DESC`,
      description: "Noisiest metric alerts and their mean time to resolve",
    },
    {
      sql: `SELECT incident_id, title, severity, created_at FROM ${Q}.metric_alert_incidents() WHERE status = 'triggered' ORDER BY created_at`,
      description: "Open metric alert incidents (status=open is sent to Sentry)",
    },
  ],
});

// ------------------------------------------------------------------ cron monitors

const scheduleText = (r: Row): string | null => {
  const s = r.config?.schedule;
  if (typeof s === "string") return s;
  if (Array.isArray(s) && s.length === 2) return `every ${s[0]} ${s[1]}`;
  return null;
};

export const monitors = defineSentryTable<{ organization: string | null; environment: string | null }>({
  name: "monitors",
  description: "Sentry cron monitors with schedule, margins and per-environment status",
  title: "Sentry Cron Monitors",
  category: "crons",
  keywords: "sentry, crons, cron monitors, scheduled jobs, check-ins, missed, timeout, heartbeat",
  docLlm:
    "Cron monitors of each organization (GET /api/0/organizations/{org}/monitors/): id, slug, name, project_slug, " +
    "status (active / disabled), is_muted, schedule_type (crontab / interval), schedule ('0 * * * *' or 'every 1 " +
    "hour'), timezone, checkin_margin_minutes, max_runtime_minutes, failure_issue_threshold, created_at, the " +
    "worst environment status (ok, error, missed_checkin, timeout), last_check_in, next_check_in, and every " +
    "environment as a list of {name, status, is_muted, last_check_in, next_check_in}.",
  docMd: "## monitors(environment := NULL)\n\nOne row per cron monitor.",
  pushdown:
    "`environment` (named) → `environment=`; `project_id` (=) → `project=`; `organization` picks organizations.",
  args: { environment: utf8() },
  argDocs: { environment: "Environment name (named); only monitors with check-ins there." },
  argDefaults: { environment: null },
  columns: [
    ORG_COL,
    C.str("id", "Monitor id.", "id", false),
    C.str("slug", "Monitor slug (used in check-in URLs).", "slug", false),
    C.str("name", "Monitor name.", "name"),
    C.str("project_slug", "Project slug.", "project.slug"),
    C.str("project_id", "Project id.", (r) => (r.project?.id == null ? null : String(r.project.id))),
    C.str("status", "active or disabled.", "status"),
    C.bool("is_muted", "Notifications are muted.", "isMuted"),
    C.str("schedule_type", "crontab or interval.", "config.schedule_type"),
    C.str("schedule", "Crontab expression or 'every <n> <unit>'.", scheduleText),
    C.str("timezone", "Schedule timezone.", "config.timezone"),
    C.int("checkin_margin_minutes", "Grace period before a check-in counts as missed.", "config.checkin_margin"),
    C.int("max_runtime_minutes", "Runtime after which an in-progress check-in times out.", "config.max_runtime"),
    C.int("failure_issue_threshold", "Consecutive failures before an issue opens.", "config.failure_issue_threshold"),
    C.iso("created_at", "When the monitor was created.", "dateCreated"),
    C.str(
      "environment_status",
      "Worst status across environments: error, timeout, missed_checkin, ok, active.",
      (r) => {
        const order = ["error", "timeout", "missed_checkin", "ok", "active"];
        const st = (Array.isArray(r.environments) ? r.environments : []).map((e: Row) => e?.status);
        return order.find((o) => st.includes(o)) ?? st[0] ?? null;
      },
    ),
    C.iso("last_check_in", "Latest check-in across environments.", (r) => maxIso(r.environments, "lastCheckIn")),
    C.iso("next_check_in", "Next expected check-in across environments.", (r) => minIso(r.environments, "nextCheckIn")),
    C.structList(
      "environments",
      "Per-environment state.",
      [
        { name: "name", kind: "str", get: "name" },
        { name: "status", kind: "str", get: "status" },
        { name: "is_muted", kind: "bool", get: "isMuted" },
        { name: "last_check_in", kind: "iso", get: "lastCheckIn" },
        { name: "next_check_in", kind: "iso", get: "nextCheckIn" },
      ],
      "environments",
    ),
  ],
  request: (s, { args, constraints }) => ({
    path: `/organizations/${enc(s.organization)}/monitors/`,
    paging: "cursor",
    query: { environment: args.environment ?? undefined, project: eqOne(constraints, "project_id") },
  }),
  examples: [
    {
      sql: `SELECT slug, schedule, environment_status, last_check_in FROM ${Q}.monitors() WHERE environment_status <> 'ok' ORDER BY slug`,
      description: "Cron monitors that are failing, timing out or missing check-ins",
    },
    {
      sql: `SELECT project_slug, count(*) AS monitors FROM ${Q}.monitors() WHERE status = 'active' GROUP BY project_slug ORDER BY project_slug`,
      description: "Active cron monitors per project",
    },
  ],
});

function maxIso(list: unknown, key: string): string | null {
  const v = (Array.isArray(list) ? list : [])
    .map((e: Row) => e?.[key])
    .filter((x): x is string => typeof x === "string");
  return v.length ? (v.sort().at(-1) ?? null) : null;
}
function minIso(list: unknown, key: string): string | null {
  const v = (Array.isArray(list) ? list : [])
    .map((e: Row) => e?.[key])
    .filter((x): x is string => typeof x === "string");
  return v.length ? (v.sort()[0] ?? null) : null;
}

export const monitorCheckins = defineSentryTable<{
  organization: string | null;
  monitor_slug: string | null;
  environment: string | null;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
}>({
  name: "monitor_checkins",
  description: "Check-ins of Sentry cron monitors: status, duration, expected time",
  title: "Sentry Cron Check-ins",
  category: "crons",
  keywords: "sentry, crons, check-ins, job runs, duration, missed, timeout, error",
  docLlm:
    "Check-ins of each cron monitor (GET /api/0/organizations/{org}/monitors/{slug}/checkins/), newest first: " +
    "checkin_id, monitor_slug, environment, status (ok, error, in_progress, missed, timeout), duration_ms, " +
    "created_at and expected_at (when the schedule expected it). monitor_slug := picks one monitor (also from " +
    "WHERE monitor_slug = / IN); otherwise every monitor is read. Window: stats_period (default 90d) or " +
    "start_time / end_time; a pushed created_at range becomes start / end.",
  docMd:
    "## monitor_checkins(monitor_slug := NULL, environment, stats_period, start_time, end_time)\n\nOne row per check-in.",
  pushdown:
    "`monitor_slug` (=, IN) picks the monitors; `environment` (=) → `environment=`; `created_at` ranges → `start` / " +
    "`end` when no window argument is given.",
  args: { monitor_slug: utf8(), environment: utf8(), ...WINDOW_ARGS },
  argDocs: {
    monitor_slug: "Monitor slug (named). NULL reads every monitor; WHERE monitor_slug = / IN works the same way.",
    environment: "Environment name (named); also from WHERE environment =.",
    ...WINDOW_DOCS,
  },
  argDefaults: { monitor_slug: null, environment: null, stats_period: null, start_time: null, end_time: null },
  argConstraints: WINDOW_CONSTRAINTS,
  subScopes: async (org, cfg, ctx) => {
    const slugs =
      pick(ctx.args, ctx.constraints, "monitor_slug") ??
      (await listAll(cfg, `/organizations/${enc(org)}/monitors/`))
        .map((m) => m.slug)
        .filter((s): s is string => typeof s === "string");
    return slugs.map((monitor_slug) => ({ monitor_slug }));
  },
  columns: [
    ORG_COL,
    C.ctx("monitor_slug", "Monitor slug.", "monitor_slug"),
    C.str("checkin_id", "Check-in id.", "id", false),
    C.str("environment", "Environment.", "environment"),
    C.str("status", "ok, error, in_progress, missed or timeout.", "status"),
    C.big("duration_ms", "Run time in milliseconds (NULL: still running / missed).", "duration"),
    C.iso("created_at", "When the check-in was received.", "dateCreated"),
    C.iso("expected_at", "When the schedule expected this check-in.", "expectedTime"),
  ],
  request: (s, { args, constraints }) => {
    let window: Record<string, string | undefined> = windowParams(args);
    if (!args.stats_period && args.start_time == null && args.end_time == null) {
      const { lo, hi } = timeBounds(constraints, "created_at");
      if (lo !== undefined || hi !== undefined) {
        window = { start: new Date(lo ?? 0).toISOString(), end: new Date(hi ?? Date.now()).toISOString() };
      }
    }
    return {
      path: `/organizations/${enc(s.organization)}/monitors/${enc(s.monitor_slug ?? "")}/checkins/`,
      paging: "cursor",
      query: { environment: args.environment ?? eqOne(constraints, "environment"), ...window },
    };
  },
  notFoundEmpty: true,
  examples: [
    {
      sql: `SELECT monitor_slug, status, count(*) AS checkins FROM ${Q}.monitor_checkins() GROUP BY ALL ORDER BY monitor_slug, status`,
      description: "Check-in outcomes per monitor",
    },
    {
      sql: `SELECT created_at, duration_ms FROM ${Q}.monitor_checkins(monitor_slug := 'nightly-billing') WHERE status = 'ok' ORDER BY created_at DESC LIMIT 20`,
      description: "Run times of the last 20 successful runs of one job",
    },
  ],
});

// ------------------------------------------------------------------------ replays

type ReplayArgs = {
  organization: string | null;
  project_id: string | null;
  environment: string | null;
  query: string | null;
  sort: string;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
};

const REPLAY_FIELDS = [
  "id",
  "project_id",
  "started_at",
  "finished_at",
  "duration",
  "count_errors",
  "count_segments",
  "count_urls",
  "count_dead_clicks",
  "count_rage_clicks",
  "environment",
  "platform",
  "releases",
  "browser",
  "os",
  "device",
  "user",
  "is_archived",
  "replay_type",
  "urls",
];

export const replays = defineSentryTable<ReplayArgs>({
  name: "replays",
  description: "Sentry session replay metadata (no recordings): duration, errors, rage clicks, browser",
  title: "Sentry Session Replays",
  category: "replays",
  keywords: "sentry, session replay, replays, rage clicks, dead clicks, frontend, ux, browser",
  docLlm:
    "Session replay metadata of each organization (GET /api/0/organizations/{org}/replays/); recordings are never " +
    "fetched. One row per replay: replay_id, project_id, started_at, finished_at, duration_seconds, error_count, " +
    "segment_count, url_count, dead_click_count, rage_click_count, environment, platform, releases, browser / os / " +
    "device names and versions, replay_type (session / buffer), is_archived, the visited urls, and user_id only " +
    "(no email, IP or name). Arguments (named): project_id, environment, query (replay search, e.g. " +
    "'count_rage_clicks:>0'), sort ('-started_at' default), stats_period (default 90d) / start_time / end_time.",
  docMd:
    "## replays(project_id, environment, query, sort := '-started_at', stats_period, start_time, end_time)\n\nOne row per replay.",
  pushdown:
    "`environment` (=) → `environment=`; `project_id` (=) → `project=`; `browser_name`, `os_name`, `platform` (=, IN, " +
    "!=) → `browser.name:` / `os.name:` / `platform:`; `error_count`, `rage_click_count`, `dead_click_count` `>= / >` → " +
    "`count_errors:>=n` …; `started_at` range → `start` / `end` when no window argument is given. Only the " +
    "metadata `field`s the worker reads are requested.",
  args: { project_id: utf8(), environment: utf8(), query: utf8(), sort: utf8(), ...WINDOW_ARGS },
  argDocs: {
    project_id: "Numeric project id (named); also pushed from WHERE project_id =.",
    environment: "Environment name (named); also pushed from WHERE environment =.",
    query: "Replay search (named), e.g. 'count_errors:>0 url:*checkout*'; ANDed with pushed filters.",
    sort: "Order (named): -started_at (default), started_at, -duration, -count_errors, -count_rage_clicks …",
    ...WINDOW_DOCS,
  },
  argDefaults: {
    project_id: null,
    environment: null,
    query: null,
    sort: "-started_at",
    stats_period: null,
    start_time: null,
    end_time: null,
  },
  argConstraints: { sort: { pattern: "^-?[a-z_]+$" }, ...WINDOW_CONSTRAINTS },
  columns: [
    ORG_COL,
    C.str("replay_id", "Replay id.", "id", false),
    C.str("project_id", "Project id.", (r) => (r.project_id == null ? null : String(r.project_id))),
    C.iso("started_at", "Replay start.", "started_at"),
    C.iso("finished_at", "Replay end.", "finished_at"),
    C.big("duration_seconds", "Duration, seconds.", "duration"),
    C.big("error_count", "Errors during the replay.", "count_errors"),
    C.big("segment_count", "Recording segments.", "count_segments"),
    C.big("url_count", "Pages visited.", "count_urls"),
    C.big("dead_click_count", "Clicks with no visible response.", "count_dead_clicks"),
    C.big("rage_click_count", "Rapid repeated clicks (frustration).", "count_rage_clicks"),
    C.str("environment", "Environment.", "environment"),
    C.str("platform", "SDK platform.", "platform"),
    C.strList("releases", "Release versions seen in the replay.", "releases"),
    C.str("browser_name", "Browser name.", "browser.name"),
    C.str("browser_version", "Browser version.", "browser.version"),
    C.str("os_name", "Operating system name.", "os.name"),
    C.str("os_version", "Operating system version.", "os.version"),
    C.str("device_name", "Device name / model.", "device.name"),
    C.str("replay_type", "session or buffer (on-error capture).", "replay_type"),
    C.bool("is_archived", "Replay is archived (no longer viewable).", "is_archived"),
    C.str("user_id", "User id as sent by the SDK (no email, name or IP).", "user.id"),
    C.strList("urls", "URLs visited, in order.", "urls"),
  ],
  request: (s, { args, constraints }) => {
    const terms = [
      ...stringTerms(constraints, "browser_name", "browser.name"),
      ...stringTerms(constraints, "os_name", "os.name"),
      ...stringTerms(constraints, "platform", "platform"),
    ];
    for (const [col, key] of [
      ["error_count", "count_errors"],
      ["rage_click_count", "count_rage_clicks"],
      ["dead_click_count", "count_dead_clicks"],
    ] as const) {
      for (const c of constraints) {
        if (c.column === col && c.kind === "cmp" && (c.op === "ge" || c.op === "gt")) {
          const n = Number(c.value);
          if (Number.isFinite(n)) terms.push(`${key}:>=${c.op === "gt" ? Math.floor(n) + 1 : Math.ceil(n)}`);
        }
      }
    }
    let window: Record<string, string | undefined> = windowParams(args);
    if (!args.stats_period && args.start_time == null && args.end_time == null) {
      const { lo, hi } = timeBounds(constraints, "started_at");
      if (lo !== undefined || hi !== undefined) {
        window = { start: new Date(lo ?? 0).toISOString(), end: new Date(hi ?? Date.now()).toISOString() };
      }
    }
    const q = joinQuery(terms, args.query);
    return {
      path: `/organizations/${enc(s.organization)}/replays/`,
      paging: "cursor",
      query: {
        field: REPLAY_FIELDS,
        project: args.project_id ?? eqOne(constraints, "project_id"),
        environment: args.environment ?? eqOne(constraints, "environment"),
        query: q || undefined,
        sort: args.sort ?? "-started_at",
        ...window,
      },
    };
  },
  rows: DATA_BODY,
  examples: [
    {
      sql: `SELECT browser_name, count(*) AS replays, sum(rage_click_count) AS rage_clicks FROM ${Q}.replays() GROUP BY browser_name ORDER BY rage_clicks DESC`,
      description: "Rage clicks per browser",
    },
    {
      sql: `SELECT replay_id, duration_seconds, error_count FROM ${Q}.replays(environment := 'production') WHERE error_count >= 1 ORDER BY error_count DESC LIMIT 10`,
      description: "Production replays with errors (count_errors:>=1 is pushed)",
    },
  ],
});

// ------------------------------------------------------------------ user feedback

export const userFeedback = defineSentryTable<{
  organization: string | null;
  project_slug: string | null;
  include_pii: boolean;
}>({
  name: "user_feedback",
  description: "Sentry user feedback per project (comments; names / emails only with include_pii := true)",
  title: "Sentry User Feedback",
  category: "replays",
  keywords: "sentry, user feedback, user reports, comments, crash reports, pii",
  docLlm:
    "User feedback submitted through the Sentry feedback widget or crash-report dialog (GET /api/0/projects/" +
    "{org}/{project}/user-feedback/): feedback_id, project_slug, comments, created_at, event_id and the linked " +
    "issue_id / issue_short_id / issue_title. PII WARNING: feedback carries end users' names and email " +
    "addresses. They are NULL unless include_pii := true is passed explicitly; comments are free text written by " +
    "users and may themselves contain personal data. project_slug := reads one project; otherwise every project.",
  docMd:
    "## user_feedback(project_slug := NULL, include_pii := false)\n\n" +
    "One row per feedback report. **PII:** `name` and `email` are returned only with `include_pii := true`.",
  pushdown: "`project_slug` (=, IN) picks the projects; `organization` picks organizations.",
  args: { project_slug: utf8(), include_pii: bool },
  argDocs: {
    project_slug: PROJECT_SLUG_DOC,
    include_pii:
      "Return the reporter's name and email (named, default false). Only enable when you are allowed to process them.",
  },
  argDefaults: { project_slug: null, include_pii: false },
  subScopes: projectScopes,
  columns: [
    ORG_COL,
    C.ctx("project_slug", "Project slug.", "project_slug"),
    C.str("feedback_id", "Feedback id.", "id", false),
    C.str("comments", "What the user wrote (free text; may contain personal data).", "comments"),
    C.iso("created_at", "When the feedback was submitted.", "dateCreated"),
    C.str("event_id", "Event the feedback is attached to.", "eventID"),
    C.str("issue_id", "Issue of that event.", "issue.id"),
    C.str("issue_short_id", "Short id of that issue.", "issue.shortId"),
    C.str("issue_title", "Title of that issue.", "issue.title"),
    C.str("name", "Reporter's name (PII; NULL unless include_pii := true).", (r) => (r.__pii ? r.name : null)),
    C.str("email", "Reporter's email (PII; NULL unless include_pii := true).", (r) => (r.__pii ? r.email : null)),
  ],
  request: (s) => ({
    path: `/projects/${enc(s.organization)}/${enc(s.project_slug ?? "")}/user-feedback/`,
    paging: "cursor",
  }),
  rows: (body, _s, ctx) =>
    (Array.isArray(body) ? (body as Row[]) : []).map((r) => ({ ...r, __pii: ctx.args.include_pii === true })),
  notFoundEmpty: true,
  examples: [
    {
      sql: `SELECT issue_short_id, count(*) AS reports FROM ${Q}.user_feedback() GROUP BY issue_short_id ORDER BY reports DESC`,
      description: "Issues with the most user feedback (no PII)",
    },
    {
      sql: `SELECT created_at, comments FROM ${Q}.user_feedback(project_slug := 'frontend') ORDER BY created_at DESC LIMIT 20`,
      description: "Latest feedback comments of one project",
    },
  ],
});

// --------------------------------------------------------------------- audit log

export const auditLog = defineSentryTable<{ organization: string | null }>({
  name: "audit_log",
  description: "Sentry organization audit log (Business / Enterprise plans; feature-detected)",
  title: "Sentry Audit Log",
  category: "admin",
  keywords: "sentry, audit log, security, compliance, member changes, settings changes, who changed what",
  docLlm:
    "The organization audit log (GET /api/0/organizations/{org}/audit-logs/), newest first: entry id, event " +
    "(member.invite, project.edit, org.edit …), actor name and id, ip_address, note, target_object, target_user, " +
    "created_at and the event's data as JSON. Audit logs need a Business or Enterprise plan and an org:read / " +
    "org:admin scope: when the organization does not have the feature the function fails with a clear 'audit " +
    "logs are not available' error instead of returning zero rows.",
  docMd: "## audit_log()\n\nOne row per audit log entry.",
  pushdown: "`event` (=) → `event=`; `actor_id` (=) → `actor=`; `organization` picks organizations.",
  columns: [
    ORG_COL,
    C.str("id", "Entry id.", "id", false),
    C.str("event", "Event name, e.g. member.invite, project.remove.", "event"),
    C.str("actor", "Who did it (user name or API key label).", (r) => r.actor?.name ?? r.actor?.username ?? null),
    C.str("actor_id", "Actor user id.", "actor.id"),
    C.str("ip_address", "Source IP address.", "ipAddress"),
    C.str("note", "Human-readable summary.", "note"),
    C.str("target_object", "Id of the object changed.", "targetObject"),
    C.str("target_user", "User affected (name).", (r) => r.targetUser?.name ?? null),
    C.iso("created_at", "When it happened.", "dateCreated"),
    C.json("data", "Event details (JSON).", "data"),
  ],
  request: (s, { constraints }) => ({
    path: `/organizations/${enc(s.organization)}/audit-logs/`,
    paging: "cursor",
    query: { event: eqOne(constraints, "event"), actor: eqOne(constraints, "actor_id") },
  }),
  rows: (body) => {
    const r = (body as { rows?: unknown } | null)?.rows;
    return Array.isArray(r) ? (r as Row[]) : [];
  },
  onError: (err, s) =>
    err.status === 403 || err.status === 404
      ? new SentryError(
          `audit logs are not available for organization '${s.organization}' (HTTP ${err.status}): the feature needs a ` +
            "Business or Enterprise plan and a token with org:read or org:admin scope",
          err.status,
        )
      : null,
  examples: [
    {
      sql: `SELECT event, count(*) AS entries FROM ${Q}.audit_log() GROUP BY event ORDER BY entries DESC`,
      description: "Most common audit events",
    },
    {
      sql: `SELECT created_at, actor, note FROM ${Q}.audit_log() WHERE event = 'member.invite' ORDER BY created_at DESC`,
      description: "Who invited whom (event=member.invite is sent to Sentry)",
    },
  ],
});

// ------------------------------------------------------------------- usage stats

type StatsArgs = {
  organization: string | null;
  interval: string;
  by_project: boolean;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
};

export const usageStats = defineSentryTable<StatsArgs>({
  name: "usage_stats",
  description: "Sentry usage stats v2: accepted, filtered, rate-limited and dropped volume per category",
  title: "Sentry Usage Stats",
  category: "admin",
  keywords: "sentry, usage, quota, stats, outcomes, accepted, rate limited, filtered, billing, spend",
  docLlm:
    "Organization usage (GET /api/0/organizations/{org}/stats_v2/, field=sum(quantity), grouped by outcome, " +
    "category, reason and project): one row per time bucket × outcome × category × reason × project with the " +
    "quantity. outcome is accepted, filtered, rate_limited, invalid, abuse, client_discard or cardinality_limited; " +
    "category is error, transaction, attachment, replay, profile, monitor, span …; quantity counts items " +
    "(bytes for attachments). interval := '1d' (default) or '1h'; window: stats_period (default 30d) or " +
    "start_time / end_time. by_project := true adds a per-project breakdown, but Sentry then returns window totals " +
    "only: time is the window start and quantity the window total. project_id is NULL unless by_project is true or " +
    "a single project_id is filtered.",
  docMd:
    "## usage_stats(interval := '1d', by_project := false, stats_period := '30d', start_time, end_time)\n\n" +
    "One row per bucket and group. With `by_project := true` Sentry returns only window totals (no time series), " +
    "so each row's `time` is the window start and `quantity` the total for the whole window.",
  pushdown:
    "`category` (=, IN) → `category=`; `outcome` (=, IN) → `outcome=`; `reason` (=) → `reason=`; `project_id` (=, IN) → " +
    "`project=`; `organization` picks organizations.",
  args: { interval: utf8(), by_project: bool, ...WINDOW_ARGS },
  argDocs: {
    interval: "Bucket size (named): 1d (default) or 1h.",
    by_project:
      "Break usage down per project (named, default false). Sentry then returns totals for the whole window, not a time series.",
    ...WINDOW_DOCS,
    stats_period: "Relative window (named), default 30d.",
  },
  argDefaults: { interval: "1d", by_project: false, stats_period: null, start_time: null, end_time: null },
  argConstraints: { interval: { choices: ["1h", "1d"] }, ...WINDOW_CONSTRAINTS },
  columns: [
    ORG_COL,
    C.iso("time", "Start of the bucket.", "__time", false),
    C.str("category", "Data category: error, transaction, attachment, replay, profile, monitor, span …", "by.category"),
    C.str(
      "outcome",
      "accepted, filtered, rate_limited, invalid, abuse, client_discard, cardinality_limited.",
      "by.outcome",
    ),
    C.str("reason", "Why the item was filtered / dropped (NULL or 'none' when accepted).", "by.reason"),
    C.str("project_id", "Project id (NULL unless by_project := true or one project_id is filtered).", (r) => {
      const p = r.by?.project ?? r.__project;
      return p == null ? null : String(p);
    }),
    C.big("quantity", "Items (bytes for attachments) in the bucket.", "__quantity", false),
  ],
  request: (s, { args, constraints }) => ({
    path: `/organizations/${enc(s.organization)}/stats_v2/`,
    paging: "single",
    query: {
      field: "sum(quantity)",
      groupBy: args.by_project ? ["outcome", "category", "reason", "project"] : ["outcome", "category", "reason"],
      interval: args.interval ?? "1d",
      category: eqValues(constraints, "category"),
      outcome: eqValues(constraints, "outcome"),
      reason: eqOne(constraints, "reason"),
      project: eqValues(constraints, "project_id"),
      ...windowParams(args, "30d"),
    },
  }),
  rows: (body, _s, ctx) => {
    const b = body as { start?: unknown; intervals?: unknown; groups?: unknown } | null;
    const intervals = Array.isArray(b?.intervals) ? (b.intervals as string[]) : [];
    const groups = Array.isArray(b?.groups) ? (b.groups as Row[]) : [];
    const start = typeof b?.start === "string" ? b.start : null;
    const projects = ctx ? eqValues(ctx.constraints, "project_id") : undefined;
    const onlyProject = Array.isArray(projects) && projects.length === 1 ? projects[0] : undefined;
    const out: Row[] = [];
    for (const g of groups) {
      const series = g.series?.["sum(quantity)"];
      if (Array.isArray(series) && intervals.length > 0) {
        intervals.forEach((t, i) => {
          const q = series[i];
          if (typeof q === "number" && q !== 0)
            out.push({ by: g.by, __time: t, __quantity: q, __project: onlyProject });
        });
        continue;
      }
      // Grouping by project makes Sentry return window totals only (no intervals / series).
      const total = g.totals?.["sum(quantity)"];
      if (typeof total === "number" && total !== 0 && start)
        out.push({ by: g.by, __time: start, __quantity: total, __project: onlyProject });
    }
    return out;
  },
  examples: [
    {
      sql: `SELECT category, outcome, sum(quantity) AS items FROM ${Q}.usage_stats() GROUP BY ALL ORDER BY items DESC`,
      description: "Volume per category and outcome over the last 30 days",
    },
    {
      sql: `SELECT time, sum(quantity) AS dropped FROM ${Q}.usage_stats() WHERE outcome = 'rate_limited' AND category = 'error' GROUP BY time ORDER BY time`,
      description: "Rate-limited errors per day (outcome and category are sent to Sentry)",
    },
  ],
});

export const OPS_FUNCTIONS = [
  releases,
  releaseHealth,
  releaseDeploys,
  releaseCommits,
  issueAlertRules,
  metricAlertRules,
  metricAlertIncidents,
  monitors,
  monitorCheckins,
  replays,
  userFeedback,
  auditLog,
  usageStats,
];
