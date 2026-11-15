/**
 * Organizations, projects, teams, members, environments, issues, issue events and
 * issue tags. Everything is read-only.
 */

import { int32, list, timestampMicros, utf8 } from "@query-farm/vgi";
import type { SentryConfig } from "./client.ts";
import {
  type Constraint,
  eqBool,
  eqOne,
  eqValues,
  joinQuery,
  nullCheck,
  searchKey,
  searchValue,
  stringTerms,
  timeBounds,
  timeTerms,
  toEpochMs,
} from "./pushdown.ts";
import {
  C,
  defineSentryCatalogTable,
  defineSentryTable,
  enc,
  listAll,
  ORG_COL,
  pick,
  type Row,
  type ScanContext,
  type Scope,
} from "./table.ts";

export const Q = "sentry.main";

const PROJECT_SCOPE_DOC =
  "Project slug (named). NULL reads every project of the organization (one call per project); a pushed " +
  "WHERE project_slug = / IN (...) works the same way.";

/** Sub-scopes: one per project slug (argument, pushed filter, or every project). */
export async function projectScopes(
  org: string,
  cfg: SentryConfig,
  ctx: ScanContext<Record<string, unknown>>,
): Promise<Record<string, string>[]> {
  const explicit = pick(ctx.args, ctx.constraints, "project_slug");
  const slugs =
    explicit ??
    (await listAll(cfg, `/organizations/${enc(org)}/projects/`))
      .map((p) => p.slug)
      .filter((s): s is string => typeof s === "string");
  return slugs.map((project_slug) => ({ project_slug }));
}

/** Sub-scopes: one per issue id (argument or pushed filter); there is no listing to fall back on. */
export async function issueScopes(
  _org: string,
  _cfg: SentryConfig,
  ctx: ScanContext<Record<string, unknown>>,
): Promise<Record<string, string>[]> {
  const ids = pick(ctx.args, ctx.constraints, "issue_id");
  if (!ids) {
    throw new Error(
      "issue_id is required: pass issue_id := '<id>' or filter WHERE issue_id = / IN (...) " +
        "(take ids from sentry.main.issues())",
    );
  }
  return ids.map((issue_id) => ({ issue_id }));
}

/** Stats window parameters from stats_period / start_time / end_time arguments (default 90d). */
export function windowParams(
  args: Record<string, unknown>,
  fallback = "90d",
): { statsPeriod?: string; start?: string; end?: string } {
  const start = toEpochMs(args.start_time);
  const end = toEpochMs(args.end_time);
  if (start !== undefined || end !== undefined) {
    const out: { start?: string; end?: string } = {};
    out.start = new Date(start ?? 0).toISOString();
    out.end = new Date(end ?? Date.now()).toISOString();
    return out;
  }
  const p = typeof args.stats_period === "string" && args.stats_period ? args.stats_period : fallback;
  return { statsPeriod: p };
}

export const WINDOW_ARGS = {
  stats_period: utf8(),
  start_time: timestampMicros("UTC"),
  end_time: timestampMicros("UTC"),
};
export const WINDOW_DOCS = {
  stats_period:
    "Relative time window (named), e.g. '24h', '14d', '90d' (Sentry statsPeriod). Ignored when start_time / end_time is given.",
  start_time: "Window start (named, TIMESTAMPTZ); with end_time replaces stats_period.",
  end_time: "Window end (named, TIMESTAMPTZ); defaults to now when only start_time is given.",
};
export const WINDOW_CONSTRAINTS = { stats_period: { pattern: "^[0-9]+[smhdw]$" } };

// ----------------------------------------------------------------- organizations

export const organizations = defineSentryCatalogTable(
  {
    name: "organizations",
    description: "Sentry organizations the auth token can see",
    title: "Sentry Organizations",
    category: "organization",
    keywords: "sentry, organizations, orgs, slug, region, account",
    docLlm:
      "Every Sentry organization the token can see (GET /api/0/organizations/), one row each: id, slug, name, " +
      "status, created_at, whether 2FA is required, early-adopter flag, the region URL (us / de data residency) " +
      "and the enabled feature flags. The slug is the `organization` argument of every other function; an " +
      "organization auth token sees exactly its own organization.",
    docMd: "## organizations\n\nOne row per Sentry organization visible to the token.",
    pushdown: "none (the list is small); the SDK applies WHERE clauses.",
    orgScoped: false,
    columns: [
      C.str("id", "Organization id.", "id"),
      C.str("slug", "Organization slug (used in API paths and URLs).", "slug", false),
      C.str("name", "Organization name.", "name"),
      C.str("status", "Organization status (active, pending_deletion …).", "status.id"),
      C.iso("created_at", "When the organization was created.", "dateCreated"),
      C.bool("require_2fa", "Members must use two-factor authentication.", "require2FA"),
      C.bool("is_early_adopter", "Early-adopter program member.", "isEarlyAdopter"),
      C.str("organization_url", "The organization's web URL.", "links.organizationUrl"),
      C.str("region_url", "The API host for the organization's data-residency region.", "links.regionUrl"),
      C.strList("features", "Enabled organization feature flags.", "features"),
    ],
    request: () => ({ path: "/organizations/", paging: "cursor" }),
    examples: [
      { sql: `SELECT slug, name, region_url FROM ${Q}.organizations ORDER BY slug`, description: "Every organization" },
      {
        sql: `SELECT slug, len(features) AS feature_count FROM ${Q}.organizations WHERE require_2fa ORDER BY slug`,
        description: "Organizations that require 2FA",
      },
    ],
  },
  ["slug"],
);

// ---------------------------------------------------------------------- projects

export const projects = defineSentryTable<{ organization: string | null }>({
  name: "projects",
  description: "Sentry projects of an organization, with platform, teams and product flags",
  title: "Sentry Projects",
  category: "organization",
  keywords: "sentry, projects, platform, teams, sessions, replays, monitors, profiles",
  docLlm:
    "Projects of each organization (GET /api/0/organizations/{org}/projects/): id, slug, name, platform, " +
    "created_at, first event / first transaction times, whether the project has sessions, replays, cron monitors " +
    "or profiles, bookmark / membership flags and the owning team slugs. Project slugs are the `project` / " +
    "`project_slug` arguments elsewhere.",
  docMd: "## projects(organization := NULL)\n\nOne row per project.",
  pushdown: "`organization` (=, IN) picks the organizations; other filters are applied by the SDK.",
  columns: [
    ORG_COL,
    C.str("id", "Project id.", "id", false),
    C.str("slug", "Project slug.", "slug", false),
    C.str("name", "Project name.", "name"),
    C.str("platform", "Project platform (python, javascript-react …).", "platform"),
    C.iso("created_at", "When the project was created.", "dateCreated"),
    C.iso("first_event", "When the project received its first error event (NULL: none yet).", "firstEvent"),
    C.bool("first_transaction_event", "The project has received a transaction.", "firstTransactionEvent"),
    C.bool("has_sessions", "Release health sessions are being sent.", "hasSessions"),
    C.bool("has_replays", "Session replays are being sent.", "hasReplays"),
    C.bool("has_monitors", "The project has cron monitors.", "hasMonitors"),
    C.bool("has_profiles", "Profiles are being sent.", "hasProfiles"),
    C.bool("is_bookmarked", "Bookmarked by the token's user.", "isBookmarked"),
    C.bool("is_member", "The token's user is a member of a team owning the project.", "isMember"),
    C.strList("teams", "Slugs of the teams that own the project.", (r) =>
      Array.isArray(r.teams) ? r.teams.map((t: Row) => t.slug) : null,
    ),
  ],
  request: (s) => ({ path: `/organizations/${enc(s.organization)}/projects/`, paging: "cursor" }),
  examples: [
    {
      sql: `SELECT platform, count(*) AS projects FROM ${Q}.projects() GROUP BY platform ORDER BY projects DESC`,
      description: "Projects per platform",
    },
    {
      sql: `SELECT slug, teams FROM ${Q}.projects(organization := 'acme') WHERE has_replays ORDER BY slug`,
      description: "Projects in one organization that send session replays",
    },
  ],
});

// ------------------------------------------------------------------------- teams

export const teams = defineSentryTable<{ organization: string | null }>({
  name: "teams",
  description: "Sentry teams of an organization, with member counts and project slugs",
  title: "Sentry Teams",
  category: "organization",
  keywords: "sentry, teams, members, ownership, projects",
  docLlm:
    "Teams of each organization (GET /api/0/organizations/{org}/teams/): id, slug, name, created_at, member_count, " +
    "whether the token's user is a member and their team role, and the slugs of the projects the team owns. " +
    "Teams are what issue assignment (`assigned:#team`) and alert ownership refer to.",
  docMd: "## teams(organization := NULL)\n\nOne row per team.",
  pushdown: "`organization` (=, IN) picks the organizations; `slug` (single =) → `query=slug:`.",
  columns: [
    ORG_COL,
    C.str("id", "Team id.", "id", false),
    C.str("slug", "Team slug (#slug in Sentry search).", "slug", false),
    C.str("name", "Team name.", "name"),
    C.iso("created_at", "When the team was created.", "dateCreated"),
    C.int("member_count", "Number of members.", "memberCount"),
    C.bool("is_member", "The token's user belongs to the team.", "isMember"),
    C.str("team_role", "The token's user's role in the team (contributor, admin), if a member.", "teamRole"),
    C.strList("projects", "Slugs of the projects the team owns.", (r) =>
      Array.isArray(r.projects) ? r.projects.map((p: Row) => p.slug) : null,
    ),
  ],
  request: (s, { constraints }) => {
    const slug = eqOne(constraints, "slug");
    return {
      path: `/organizations/${enc(s.organization)}/teams/`,
      paging: "cursor",
      query: { query: slug ? `slug:${searchValue(slug)}` : undefined },
    };
  },
  examples: [
    { sql: `SELECT slug, member_count, projects FROM ${Q}.teams() ORDER BY member_count DESC`, description: "Teams by size" },
    {
      sql: `SELECT t.slug, p FROM ${Q}.teams() t, unnest(t.projects) AS u(p) ORDER BY t.slug, p`,
      description: "One row per team and owned project",
    },
  ],
});

// ----------------------------------------------------------------------- members

export const members = defineSentryTable<{ organization: string | null }>({
  name: "members",
  description: "Sentry organization members: role, invite state, 2FA, team roles",
  title: "Sentry Members",
  category: "organization",
  keywords: "sentry, members, users, roles, invites, 2fa, sso, team roles",
  docLlm:
    "Members of each organization (GET /api/0/organizations/{org}/members/): member id, user id, name, email " +
    "(only as Sentry returns it to the token's scope; NULL otherwise), organization role (member, admin, manager, " +
    "owner, billing), whether the invite is pending or expired, invite status, 2FA, whether the user is active, " +
    "created_at and per-team roles. Use it for access reviews: who is an owner, who lacks 2FA, stale invites.",
  docMd: "## members(organization := NULL)\n\nOne row per member or pending invite.",
  pushdown:
    "`organization` (=, IN) picks the organizations; `role` (=) → `query=role:`; `pending` (=) → `query=isInvited:`; " +
    "`has_2fa` (=) → `query=has2fa:`.",
  columns: [
    ORG_COL,
    C.str("id", "Organization member id.", "id", false),
    C.str("user_id", "Sentry user id (NULL for a pending invite).", "user.id"),
    C.str("name", "Display name.", "name"),
    C.str("email", "Email address, as returned to the token's scope.", "email"),
    C.str("role", "Organization role: member, admin, manager, owner, billing.", (r) => r.orgRole ?? r.role),
    C.bool("pending", "The invitation has not been accepted yet.", "pending"),
    C.bool("expired", "The invitation has expired.", "expired"),
    C.str("invite_status", "approved, requested_to_be_invited or requested_to_join.", "inviteStatus"),
    C.bool("has_2fa", "The user has two-factor authentication enabled.", "user.has2fa"),
    C.bool("is_active", "The user account is active.", "user.isActive"),
    C.iso("created_at", "When the member was added or invited.", "dateCreated"),
    C.structList(
      "team_roles",
      "Teams the member belongs to and their role in each.",
      [
        { name: "team", kind: "str", get: "teamSlug" },
        { name: "role", kind: "str", get: "role" },
      ],
      "teamRoles",
    ),
  ],
  request: (s, { constraints }) => {
    const terms: string[] = [];
    const role = eqOne(constraints, "role");
    if (role) terms.push(`role:${searchValue(role)}`);
    const pending = eqBool(constraints, "pending");
    if (pending !== undefined) terms.push(`isInvited:${pending}`);
    const tfa = eqBool(constraints, "has_2fa");
    if (tfa !== undefined) terms.push(`has2fa:${tfa}`);
    return {
      path: `/organizations/${enc(s.organization)}/members/`,
      paging: "cursor",
      query: { query: terms.length ? terms.join(" ") : undefined },
    };
  },
  examples: [
    { sql: `SELECT role, count(*) AS members FROM ${Q}.members() GROUP BY role ORDER BY members DESC`, description: "Members per role" },
    {
      sql: `SELECT name, role FROM ${Q}.members() WHERE NOT has_2fa AND NOT pending ORDER BY name`,
      description: "Active members without two-factor authentication",
    },
  ],
});

// ------------------------------------------------------------------ environments

export const environments = defineSentryTable<{ organization: string | null; visibility: string }>({
  name: "environments",
  description: "Sentry environments of an organization (production, staging …)",
  title: "Sentry Environments",
  category: "organization",
  keywords: "sentry, environments, production, staging, deploy targets",
  docLlm:
    "Environments seen by each organization (GET /api/0/organizations/{org}/environments/): id and name. " +
    "visibility := 'visible' (default), 'hidden' or 'all'. Environment names are the `environment` argument " +
    "of issues(), discover(), replays() and the releases functions.",
  docMd: "## environments(organization := NULL, visibility := 'visible')\n\nOne row per environment.",
  pushdown: "`organization` (=, IN) picks the organizations; `visibility` is sent as is.",
  args: { visibility: utf8() },
  argDocs: { visibility: "Which environments to list (named): visible (default), hidden or all." },
  argDefaults: { visibility: "visible" },
  argConstraints: { visibility: { choices: ["visible", "hidden", "all"] } },
  columns: [ORG_COL, C.str("id", "Environment id.", "id", false), C.str("name", "Environment name.", "name", false)],
  request: (s, { args }) => ({
    path: `/organizations/${enc(s.organization)}/environments/`,
    paging: "single",
    query: { visibility: args.visibility ?? "visible" },
  }),
  examples: [
    { sql: `SELECT name FROM ${Q}.environments() ORDER BY name`, description: "Visible environments" },
    {
      sql: `SELECT organization, count(*) AS environments FROM ${Q}.environments(visibility := 'all') GROUP BY organization ORDER BY organization`,
      description: "Environments per organization, hidden ones included",
    },
  ],
});

// ------------------------------------------------------------------------ issues

/** Sentry issue status → the `is:` search value; only the documented ones are pushed. */
const STATUS_IS = new Set(["unresolved", "resolved", "ignored", "archived"]);
const SUBSTATUS_IS = new Set(["ongoing", "escalating", "regressed", "new"]);

/** Build the Sentry issue search `query` for a scan: pushed filters + tags + the user's query. */
export function issueQuery(
  constraints: Constraint[],
  args: { query?: string | null; tags?: string[] | null; project?: string | null },
): string {
  const terms: string[] = [];
  const status = eqOne(constraints, "status");
  if (status && STATUS_IS.has(status)) terms.push(`is:${status}`);
  const substatus = eqOne(constraints, "substatus");
  if (substatus && SUBSTATUS_IS.has(substatus)) terms.push(`is:${substatus}`);
  terms.push(...stringTerms(constraints, "level", "level"));
  terms.push(...stringTerms(constraints, "priority", "issue.priority"));
  terms.push(...stringTerms(constraints, "issue_category", "issue.category"));
  const unassigned = nullCheck(constraints, "assignee");
  if (unassigned === true) terms.push("is:unassigned");
  if (unassigned === false) terms.push("is:assigned");
  const atype = eqOne(constraints, "assignee_type");
  const assignee = eqOne(constraints, "assignee");
  if (atype === "team" && assignee && searchKey(assignee)) terms.push(`assigned:#${assignee}`);
  if (eqBool(constraints, "is_bookmarked") === true) terms.push("is:bookmarked");
  if (eqBool(constraints, "is_unhandled") === true) terms.push("error.unhandled:true");
  terms.push(...timeTerms(constraints, "first_seen", "firstSeen"));
  terms.push(...timeTerms(constraints, "last_seen", "lastSeen"));
  // times_seen counts events; event_count >= n / > n narrows exactly.
  for (const c of constraints) {
    if (c.column === "event_count" && c.kind === "cmp" && (c.op === "ge" || c.op === "gt")) {
      const n = Number(c.value);
      if (Number.isFinite(n)) terms.push(`timesSeen:>=${Math.ceil(c.op === "gt" ? Math.floor(n) + 1 : n)}`);
    }
  }
  const projects = args.project ? [args.project] : eqValues(constraints, "project_slug");
  if (projects?.length) terms.push(projects.length === 1 ? `project:${searchValue(projects[0] as string)}` : `project:[${projects.map(searchValue).join(",")}]`);
  for (const t of args.tags ?? []) {
    const i = t.indexOf(":");
    if (i <= 0) throw new Error(`tags: '${t}' is not 'key:value'`);
    const key = t.slice(0, i).trim();
    if (!searchKey(key)) throw new Error(`tags: '${key}' is not a valid Sentry tag key`);
    terms.push(`${key}:${searchValue(t.slice(i + 1))}`);
  }
  return joinQuery(terms, args.query);
}

/** Sentry issue status → the cross-worker incident status (triggered / acknowledged / resolved). */
export function incidentStatus(status: unknown): string | null {
  if (status === "resolved") return "resolved";
  if (status === "ignored" || status === "archived" || status === "muted") return "acknowledged";
  if (status === "unresolved") return "triggered";
  return null;
}

type IssuesArgs = {
  organization: string | null;
  project: string | null;
  environment: string | null;
  query: string | null;
  tags: string[] | null;
  sort: string;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
  page_size: number;
};

export const issues = defineSentryTable<IssuesArgs>({
  name: "issues",
  description: "Sentry issues (grouped errors and other problems) with pushed-down issue search",
  title: "Sentry Issues",
  category: "issues",
  keywords: "sentry, issues, errors, exceptions, unresolved, regressions, triage, assignee, incidents",
  docLlm:
    "Issues of each organization (GET /api/0/organizations/{org}/issues/), one row per issue: issue_id, short_id " +
    "(PROJ-1A), title, culprit, status (unresolved / resolved / ignored), substatus (ongoing, new, regressed, " +
    "escalating, archived_*), incident_status (triggered / acknowledged / resolved, the cross-worker incident " +
    "vocabulary shared with PagerDuty), level, priority, project_slug, platform, first_seen (= created_at), " +
    "last_seen, event_count, user_count, assignee / assignee_type, url (permalink) and the exception type/value. " +
    "Arguments (all named): project (slug), environment, query (raw Sentry issue search, ANDed with pushed " +
    "filters), tags (['browser:Chrome 120', ...] → tag filters, quoted correctly), sort ('date' = last seen " +
    "(default), 'new' = first seen, 'freq', 'user', 'trends', 'inbox'), stats_period (default 90d) or " +
    "start_time/end_time. WHERE filters on status, substatus, level, priority, issue_category, assignee IS " +
    "NULL, assignee_type = 'team' AND assignee = 'slug', first_seen, last_seen, event_count >= n, " +
    "project_slug and is_bookmarked become Sentry search terms, so only matching issues are fetched. " +
    "Unlike the Sentry UI, no default 'is:unresolved' filter is applied: without a status filter every status is returned.",
  docMd:
    "## issues(project, environment, query, tags, sort := 'date', stats_period := '90d', start_time, end_time)\n\n" +
    "One row per issue. Columns follow the shared incident vocabulary where they fit: `title`, `status` " +
    "(Sentry's own), `incident_status` (triggered / acknowledged / resolved), `created_at` (= first_seen), " +
    "`assignee`, `url`.",
  pushdown:
    "`status` = → `is:`; `substatus` (ongoing/new/regressed/escalating) = → `is:`; `level`, `priority`, " +
    "`issue_category` (=, IN, !=, NOT IN) → `level:[…]`, `issue.priority:[…]`, `issue.category:[…]` (`!` for " +
    "negation); `assignee IS NULL / IS NOT NULL` → `is:unassigned / is:assigned`; `assignee_type = 'team' AND " +
    "assignee = 'x'` → `assigned:#x`; `first_seen` / `last_seen` ranges → `firstSeen:>=… lastSeen:<=…`; " +
    "`event_count >= n` → `timesSeen:>=n`; `project_slug` (=, IN) → `project:`; `is_bookmarked` → `is:bookmarked`; " +
    "`organization` picks organizations. `environment`, `stats_period` / `start_time` / `end_time` and `sort` are " +
    "request parameters. Pages follow the `Link` cursor (kept in scan state).",
  args: {
    project: utf8(),
    environment: utf8(),
    query: utf8(),
    tags: list(utf8()),
    sort: utf8(),
    ...WINDOW_ARGS,
    page_size: int32,
  },
  argDocs: {
    project: "Project slug (named); NULL = every project. Also pushed from WHERE project_slug = / IN.",
    environment: "Environment name (named), e.g. 'production'; NULL = every environment.",
    query:
      "Raw Sentry issue search (named), e.g. 'assigned:me is:unresolved' or 'url:*checkout*'; ANDed with the pushed filters.",
    tags: "Tag filters (named) as 'key:value' strings, e.g. ['browser.name:Chrome', 'server_name:web 1'].",
    sort: "Order (named): date (last seen, default), new (first seen), freq (events), user (users), trends, inbox.",
    ...WINDOW_DOCS,
    page_size: "Issues per Sentry page (named), 1-100 (default 100).",
  },
  argDefaults: {
    project: null,
    environment: null,
    query: null,
    tags: null,
    sort: "date",
    stats_period: null,
    start_time: null,
    end_time: null,
    page_size: 100,
  },
  argConstraints: {
    sort: { choices: ["date", "new", "freq", "user", "trends", "inbox"] },
    page_size: { ge: 1, le: 100 },
    ...WINDOW_CONSTRAINTS,
  },
  columns: [
    ORG_COL,
    C.str("issue_id", "Issue (group) id.", "id", false),
    C.str("short_id", "Human issue id, e.g. BACKEND-1A.", "shortId"),
    C.str("title", "Issue title.", "title"),
    C.str("culprit", "Where the error happened (transaction or function).", "culprit"),
    C.str("status", "Sentry status: unresolved, resolved or ignored.", "status", false),
    C.str("substatus", "ongoing, new, regressed, escalating, archived_until_escalating, archived_forever …", "substatus"),
    C.str("incident_status", "Cross-worker incident status: triggered (unresolved), acknowledged (ignored/archived) or resolved.", (r) =>
      incidentStatus(r.status),
    ),
    C.str("level", "Level: fatal, error, warning, info, debug.", "level"),
    C.str("priority", "Issue priority: high, medium or low.", "priority"),
    C.str("issue_type", "Issue type (error, performance_n_plus_one_db_queries, …).", "issueType"),
    C.str("issue_category", "Issue category: error, performance, cron, replay, feedback, …", "issueCategory"),
    C.str("project_slug", "Slug of the project the issue belongs to.", "project.slug"),
    C.str("project_id", "Id of the project.", "project.id"),
    C.str("platform", "Platform of the events (python, javascript …).", "platform"),
    C.str("logger", "Logger name, if any.", "logger"),
    C.str("exception_type", "Exception type from the issue metadata (e.g. KeyError).", "metadata.type"),
    C.str("exception_value", "Exception message from the issue metadata.", "metadata.value"),
    C.iso("first_seen", "First event of the issue.", "firstSeen"),
    C.iso("created_at", "Same as first_seen (incident vocabulary).", "firstSeen"),
    C.iso("last_seen", "Most recent event of the issue.", "lastSeen"),
    C.big("event_count", "Number of events (in the stats window).", "count"),
    C.big("user_count", "Number of distinct affected users (in the stats window).", "userCount"),
    C.str("assignee", "Assigned user's name or team slug (NULL: unassigned).", "assignedTo.name"),
    C.str("assignee_type", "user or team.", "assignedTo.type"),
    C.str("assignee_id", "Id of the assigned user or team.", "assignedTo.id"),
    C.bool("is_unhandled", "At least one event was unhandled (crashed).", "isUnhandled"),
    C.bool("is_bookmarked", "Bookmarked by the token's user.", "isBookmarked"),
    C.bool("is_public", "Shared publicly.", "isPublic"),
    C.bool("has_seen", "The token's user has viewed the issue.", "hasSeen"),
    C.int("comment_count", "Number of comments.", "numComments"),
    C.str("url", "Link to the issue in the Sentry web UI.", "permalink"),
  ],
  request: (s, { args, constraints }) => ({
    path: `/organizations/${enc(s.organization)}/issues/`,
    paging: "cursor",
    pageParam: "limit",
    pageSize: Number(args.page_size ?? 100),
    query: {
      // Always send `query`: without it Sentry applies a default 'is:unresolved' search.
      query: issueQuery(constraints, args),
      environment: args.environment ?? undefined,
      sort: args.sort ?? "date",
      ...windowParams(args),
    },
  }),
  examples: [
    {
      sql: `SELECT short_id, title, event_count, last_seen FROM ${Q}.issues(environment := 'production') WHERE status = 'unresolved' AND level IN ('error', 'fatal') ORDER BY event_count DESC LIMIT 10`,
      description: "Top unresolved production errors (status and level are sent as issue search terms)",
    },
    {
      sql: `SELECT project_slug, count(*) AS new_issues FROM ${Q}.issues(sort := 'new') WHERE first_seen >= TIMESTAMPTZ '2026-11-01 00:00:00+00' GROUP BY project_slug ORDER BY new_issues DESC`,
      description: "New issues per project since November (firstSeen:>= is pushed)",
    },
  ],
});

// ------------------------------------------------------------------ issue events

/** The innermost exception of a full event (`entries[type=exception].data.values`, last one). */
function exceptionOf(ev: Row): Row | undefined {
  const entries = Array.isArray(ev.entries) ? ev.entries : [];
  const exc = entries.find((e: Row) => e?.type === "exception");
  const values = exc?.data?.values;
  return Array.isArray(values) && values.length ? (values[values.length - 1] as Row) : undefined;
}

/** "function (file:line)" of the innermost in-app frame (frames are oldest first). */
export function topInAppFrame(ev: Row): string | null {
  const frames = exceptionOf(ev)?.stacktrace?.frames;
  if (!Array.isArray(frames)) return null;
  const inApp = frames.filter((f: Row) => f?.inApp === true);
  const f = (inApp.length ? inApp : frames)[(inApp.length ? inApp : frames).length - 1] as Row | undefined;
  if (!f) return null;
  const where = [f.filename ?? f.module ?? f.absPath, f.lineNo].filter((x) => x != null).join(":");
  return `${f.function ?? "<unknown>"}${where ? ` (${where})` : ""}`;
}

const tagOf = (ev: Row, key: string): string | null => {
  const t = Array.isArray(ev.tags) ? ev.tags.find((x: Row) => x?.key === key) : undefined;
  return typeof t?.value === "string" ? t.value : null;
};

export const EVENT_COLUMNS = [
  ORG_COL,
  C.ctx("issue_id", "The issue the event belongs to.", "issue_id"),
  C.str("event_id", "Event id (32 hex characters).", (r) => r.eventID ?? r.id),
  C.str("title", "Event title.", "title"),
  C.str("message", "Log message or formatted exception.", "message"),
  C.str("event_type", "error, default, transaction …", (r) => r["event.type"] ?? r.type),
  C.str("platform", "SDK platform.", "platform"),
  C.iso("created_at", "When the event happened (client timestamp).", "dateCreated"),
  C.iso("received_at", "When Sentry received the event.", "dateReceived"),
  C.str("culprit", "Transaction or function blamed.", "culprit"),
  C.str("location", "Source location of the error.", "location"),
  C.str("environment", "environment tag.", (r) => tagOf(r, "environment")),
  C.str("release", "Release version (release tag).", (r) => r.release?.version ?? tagOf(r, "release")),
  C.str("level", "level tag.", (r) => tagOf(r, "level")),
  C.str("user_id", "Affected user's id as sent by the SDK (no email or IP).", "user.id"),
  C.str("exception_type", "Innermost exception type.", (r) => exceptionOf(r)?.type ?? r.metadata?.type),
  C.str("exception_value", "Innermost exception message.", (r) => exceptionOf(r)?.value ?? r.metadata?.value),
  C.bool("handled", "The exception was handled (mechanism.handled).", (r) => exceptionOf(r)?.mechanism?.handled),
  C.str("top_in_app_frame", "Innermost in-app stack frame as 'function (file:line)'.", (r) => topInAppFrame(r)),
  C.str("sdk", "SDK name and version.", (r) => (r.sdk?.name ? `${r.sdk.name} ${r.sdk.version ?? ""}`.trim() : null)),
  C.structList(
    "tags",
    "Every tag of the event.",
    [
      { name: "key", kind: "str", get: "key" },
      { name: "value", kind: "str", get: "value" },
    ],
    "tags",
  ),
];

type EventArgs = {
  organization: string | null;
  issue_id: string | null;
  which: string;
  environment: string | null;
  query: string | null;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
};

export const issueEvents = defineSentryTable<EventArgs>({
  name: "issue_events",
  description: "Events of a Sentry issue (all, or just the latest / oldest / recommended one), exception summarized",
  title: "Sentry Issue Events",
  category: "issues",
  keywords: "sentry, events, exceptions, stack trace, in-app frame, latest event, release, environment",
  docLlm:
    "Events of one or more issues. issue_id := '<id>' (or WHERE issue_id = / IN (...)) is required; take ids " +
    "from issues(). which := 'all' (default) pages through GET /api/0/organizations/{org}/issues/{id}/events/ " +
    "(full=true); 'latest', 'oldest' or 'recommended' fetch one event from …/events/{which}/. Each row has " +
    "event_id, title, message, created_at, environment, release, level, user_id (no email / IP), the innermost " +
    "exception type / value / handled flag, the innermost in-app stack frame as 'function (file:line)' and all " +
    "tags. environment := and query := (event search, e.g. 'browser.name:Firefox') narrow 'all'.",
  docMd:
    "## issue_events(issue_id, which := 'all', environment, query, stats_period, start_time, end_time)\n\n" +
    "One row per event; exception and stack trace summarized into columns.",
  pushdown:
    "`issue_id` (=, IN) picks the issues; `environment` (=) → `environment=`; `created_at` ranges → `start` / `end` " +
    "when no window argument is given; `release` (=) → `query=release:`.",
  args: { issue_id: utf8(), which: utf8(), environment: utf8(), query: utf8(), ...WINDOW_ARGS },
  argDocs: {
    issue_id: "Issue id (named). Required unless WHERE issue_id = / IN (...) is given.",
    which: "all (default), latest, oldest or recommended (named).",
    environment: "Environment name (named); also pushed from WHERE environment =.",
    query: "Event search (named), e.g. 'release:1.2.0 browser.name:Firefox'; ANDed with pushed filters.",
    ...WINDOW_DOCS,
  },
  argDefaults: {
    issue_id: null,
    which: "all",
    environment: null,
    query: null,
    stats_period: null,
    start_time: null,
    end_time: null,
  },
  argConstraints: { which: { choices: ["all", "latest", "oldest", "recommended"] }, ...WINDOW_CONSTRAINTS },
  subScopes: issueScopes,
  columns: EVENT_COLUMNS,
  request: (s: Scope, { args, constraints }) => {
    const base = `/organizations/${enc(s.organization)}/issues/${enc(s.issue_id ?? "")}/events/`;
    const which = args.which ?? "all";
    if (which !== "all") {
      return { path: `${base}${which}/`, paging: "single", query: { environment: args.environment ?? undefined } };
    }
    const env = args.environment ?? eqOne(constraints, "environment");
    const release = eqOne(constraints, "release");
    let window: Record<string, string | undefined> = windowParams(args);
    if (!args.stats_period && args.start_time == null && args.end_time == null) {
      const { lo, hi } = timeBounds(constraints, "created_at");
      if (lo !== undefined || hi !== undefined) {
        window = { start: new Date(lo ?? 0).toISOString(), end: new Date(hi ?? Date.now()).toISOString() };
      }
    }
    const q = joinQuery(release ? [`release:${searchValue(release)}`] : [], args.query);
    return {
      path: base,
      paging: "cursor",
      pageParam: "none",
      query: { full: "true", environment: env, query: q || undefined, ...window },
    };
  },
  rows: (body) => (Array.isArray(body) ? (body as Row[]) : body && typeof body === "object" ? [body as Row] : []),
  examples: [
    {
      sql: `SELECT event_id, created_at, release, exception_type, top_in_app_frame FROM ${Q}.issue_events(issue_id := '4504001', which := 'latest')`,
      description: "The latest event of an issue with its innermost in-app frame",
    },
    {
      sql: `SELECT release, count(*) AS events FROM ${Q}.issue_events(issue_id := '4504001') WHERE environment = 'production' GROUP BY release ORDER BY events DESC`,
      description: "Events of an issue per release in production",
    },
  ],
});

// -------------------------------------------------------------------- issue tags

export const issueTags = defineSentryTable<{ organization: string | null; issue_id: string | null; environment: string | null }>({
  name: "issue_tags",
  description: "Tag keys of a Sentry issue with their top values and counts",
  title: "Sentry Issue Tags",
  category: "issues",
  keywords: "sentry, tags, browser, os, release, environment, distribution, top values",
  docLlm:
    "Tag distribution of one or more issues (GET /api/0/organizations/{org}/issues/{id}/tags/): one row per tag " +
    "key with total_values and top_values (a list of {value, count, first_seen, last_seen}). issue_id := is required " +
    "(or WHERE issue_id = / IN). environment := narrows to one environment. Use unnest(top_values) for one row " +
    "per value, or issue_tag_values() for the complete value list of one key.",
  docMd: "## issue_tags(issue_id, environment := NULL)\n\nOne row per tag key of the issue.",
  pushdown: "`issue_id` (=, IN) picks the issues; `key` (=, IN) → `key=` (repeated).",
  args: { issue_id: utf8(), environment: utf8() },
  argDocs: {
    issue_id: "Issue id (named). Required unless WHERE issue_id = / IN (...) is given.",
    environment: "Environment name (named); NULL = all environments.",
  },
  argDefaults: { issue_id: null, environment: null },
  subScopes: issueScopes,
  columns: [
    ORG_COL,
    C.ctx("issue_id", "The issue.", "issue_id"),
    C.str("key", "Tag key.", "key", false),
    C.str("name", "Tag display name.", "name"),
    C.big("total_values", "Number of events carrying the tag.", "totalValues"),
    C.structList(
      "top_values",
      "Most common values of the tag.",
      [
        { name: "value", kind: "str", get: "value" },
        { name: "count", kind: "big", get: "count" },
        { name: "first_seen", kind: "iso", get: "firstSeen" },
        { name: "last_seen", kind: "iso", get: "lastSeen" },
      ],
      "topValues",
    ),
  ],
  request: (s, { args, constraints }) => ({
    path: `/organizations/${enc(s.organization)}/issues/${enc(s.issue_id ?? "")}/tags/`,
    paging: "single",
    query: { environment: args.environment ?? undefined, key: eqValues(constraints, "key") },
  }),
  examples: [
    {
      sql: `SELECT key, total_values FROM ${Q}.issue_tags(issue_id := '4504001') ORDER BY total_values DESC`,
      description: "Tag keys of an issue",
    },
    {
      sql: `SELECT v.value, v.count FROM ${Q}.issue_tags(issue_id := '4504001') t, unnest(t.top_values) AS u(v) WHERE t.key = 'browser' ORDER BY v.count DESC`,
      description: "Which browsers an issue affects",
    },
  ],
});

export const issueTagValues = defineSentryTable<{
  organization: string | null;
  issue_id: string | null;
  key: string | null;
  environment: string | null;
  sort: string;
}>({
  name: "issue_tag_values",
  description: "Every value of one tag of a Sentry issue, with counts",
  title: "Sentry Issue Tag Values",
  category: "issues",
  keywords: "sentry, tag values, browser, release, user, distribution",
  docLlm:
    "All values of one tag key of an issue (GET /api/0/organizations/{org}/issues/{id}/tags/{key}/values/), paged " +
    "through the Link cursor: value, count, first_seen, last_seen. issue_id := and key := are required (key also " +
    "from WHERE key =). sort := '-count' (default), '-last_seen', '-first_seen' or '-id'.",
  docMd: "## issue_tag_values(issue_id, key, environment := NULL, sort := '-count')\n\nOne row per tag value.",
  pushdown: "`issue_id` (=, IN) picks the issues; `key` (=, IN) picks the tag keys.",
  args: { issue_id: utf8(), key: utf8(), environment: utf8(), sort: utf8() },
  argDocs: {
    issue_id: "Issue id (named). Required unless WHERE issue_id = / IN (...) is given.",
    key: "Tag key (named), e.g. 'browser' or 'release'. Required unless WHERE key = is given.",
    environment: "Environment name (named); NULL = all environments.",
    sort: "Order (named): -count (default), -last_seen, -first_seen, -id.",
  },
  argDefaults: { issue_id: null, key: null, environment: null, sort: "-count" },
  argConstraints: { sort: { choices: ["-count", "-last_seen", "-first_seen", "-id"] } },
  subScopes: async (org, cfg, ctx) => {
    const issues = await issueScopes(org, cfg, ctx);
    const keys = pick(ctx.args, ctx.constraints, "key");
    if (!keys) throw new Error("key is required: pass key := 'browser' (or WHERE key = ...); see issue_tags()");
    return issues.flatMap((i) => keys.map((key) => ({ ...i, key })));
  },
  columns: [
    ORG_COL,
    C.ctx("issue_id", "The issue.", "issue_id"),
    C.ctx("key", "Tag key.", "key"),
    C.str("value", "Tag value.", "value"),
    C.str("name", "Display name of the value.", "name"),
    C.big("count", "Events with this value.", "count"),
    C.iso("first_seen", "First event with this value.", "firstSeen"),
    C.iso("last_seen", "Latest event with this value.", "lastSeen"),
  ],
  request: (s, { args }) => ({
    path: `/organizations/${enc(s.organization)}/issues/${enc(s.issue_id ?? "")}/tags/${enc(s.key ?? "")}/values/`,
    paging: "cursor",
    pageParam: "none",
    query: { environment: args.environment ?? undefined, sort: args.sort ?? "-count" },
  }),
  examples: [
    {
      sql: `SELECT value, count FROM ${Q}.issue_tag_values(issue_id := '4504001', key := 'release') ORDER BY count DESC`,
      description: "Which releases an issue appears in",
    },
    {
      sql: `SELECT sum(count) AS events FROM ${Q}.issue_tag_values(issue_id := '4504001', key := 'browser') WHERE value LIKE 'Chrome%'`,
      description: "Events of an issue from any Chrome version",
    },
  ],
});

export const ISSUE_FUNCTIONS = [projects, teams, members, environments, issues, issueEvents, issueTags, issueTagValues];
export const ISSUE_TABLES = [organizations];
