/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "sentry";
export const VERSION = "0.2.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-sentry";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "organization",
    title: "Organization",
    description: "Organizations, projects, teams, members and environments.",
  },
  {
    name: "issues",
    title: "Issues",
    description: "Issues with pushed-down issue search, their events and tag distributions.",
  },
  { name: "events", title: "Discover", description: "Discover / Explore queries over errors, transactions and spans." },
  { name: "releases", title: "Releases", description: "Releases, release health, deploys and commits." },
  { name: "alerts", title: "Alerts", description: "Issue and metric alert rules and metric alert incidents." },
  { name: "crons", title: "Crons", description: "Cron monitors and their check-ins." },
  { name: "replays", title: "Replays and Feedback", description: "Session replay metadata and user feedback." },
  { name: "admin", title: "Administration", description: "The audit log and usage stats (outcomes)." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "\n\n**Upstream documentation**\n\n" +
  "- [Sentry API reference](https://docs.sentry.io/api/)\n" +
  "- [Issue search syntax](https://docs.sentry.io/concepts/search/) and [searchable properties](https://docs.sentry.io/concepts/search/searchable-properties/)\n" +
  "- [Pagination](https://docs.sentry.io/api/pagination/) and [rate limits](https://docs.sentry.io/api/ratelimits/)\n" +
  "- [Auth tokens](https://docs.sentry.io/account/auth-tokens/)";

export const CATALOG_COMMENT =
  "Sentry error and performance monitoring as read-only SQL, from sentry.io or a self-hosted Sentry, with WHERE filters pushed into Sentry's own search syntax.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to Sentry (sentry.io, its us / de regions, or self-hosted) through the REST API. Reach " +
  "for it to answer operational questions an engineer would otherwise click through the Sentry UI for: which " +
  "errors are hurting users right now and since when, what a failing issue's events and tag distribution look " +
  "like, ad-hoc aggregates over errors, transactions and spans, what shipped and whether it is stable, how " +
  "alerting is configured and how noisy it is, whether scheduled jobs check in, what users experienced and " +
  "reported, who changed the organization's settings, and how much event volume is accepted or dropped. " +
  "Authentication: every object needs a `sentry` DuckDB secret with AUTH_TOKEN and optional REGION ('us' / " +
  "'de'), BASE_URL (self-hosted) and ORGANIZATION (default organization slug); without an organization every " +
  "organization the token sees is read. Filtering: WHERE predicates on status, level, priority, timestamps, " +
  "assignee, project and similar columns become Sentry search terms or request parameters and are re-checked " +
  "exactly, so only matching rows cross the network. Time-windowed functions take stats_period / start_time / " +
  "end_time and document their own default window. Privacy: session replays are metadata only, and reporter " +
  "names and emails need an explicit opt-in.";

export const CATALOG_DOC_MD =
  "# Sentry\n\n" +
  "Query Sentry from DuckDB to triage errors, check release stability, audit alerting and cron monitoring, " +
  "and watch event volume, without leaving SQL. Read-only, against sentry.io (US or EU) or a self-hosted " +
  "Sentry.\n\n" +
  "Create a `sentry` secret with an auth token (`AUTH_TOKEN`); add `REGION 'de'` for EU data residency, " +
  "`BASE_URL` for self-hosted Sentry and `ORGANIZATION` for a default organization. WHERE filters become " +
  "Sentry issue / event search terms, so only matching rows cross the network; `Link` cursor paging and the " +
  "`X-Sentry-Rate-Limit-*` headers are handled for you." +
  SOURCES_MD;

export const SCHEMA_COMMENT =
  "Sentry's REST API collections as SQL, scoped by organization, project, issue or release arguments.";

export const SCHEMA_DOC_LLM =
  "Sentry REST API collections as SQL. The organization list is a plain table; everything else is a table " +
  "function with an optional organization := named argument (NULL = the secret's ORGANIZATION, else all " +
  "organizations), because Sentry scopes its endpoints by organization. Narrower scopes are named arguments " +
  "too: per-project functions take project_slug :=, per-issue functions require issue_id := (take ids from the " +
  "issue search), and per-release functions take version := or otherwise read every open release, one call " +
  "each. The issue search and Discover functions translate WHERE filters into Sentry search syntax and " +
  "re-check them exactly; each function's description lists its pushed-down columns and arguments. All " +
  "objects need a `sentry` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Everything in one schema, mirroring Sentry's REST API: the organization structure, issues and their " +
  "events, Discover aggregates, release health, alerting, cron monitoring, replays and administration.\n\n" +
  "Functions take the organization, project, issue or release as named arguments or pushed filters, and " +
  "filters push down into Sentry's search syntax and request parameters, so scope a query as tightly as " +
  "you can before it pages through results.\n\n" +
  "All objects need a `sentry` secret.";

export const AGENT_TEST_TASKS = [
  { name: "org_slugs", prompt: "List the slugs of every Sentry organization the token can see." },
  {
    name: "unresolved_fatal",
    prompt: "In the acme Sentry organization, which unresolved issues have level fatal? Give their short ids.",
  },
  {
    name: "noisiest_issue",
    prompt: "Which acme issue has the most events? Give its short id and event count.",
  },
  {
    name: "issue_browsers",
    prompt: "Which browser values appear in the tags of acme issue 4504001, and how many events each?",
  },
  {
    name: "latest_event_frame",
    prompt: "What is the innermost in-app stack frame of the latest event of acme issue 4504001?",
  },
  {
    name: "busiest_transaction",
    prompt: "Using Sentry Discover on the acme transactions dataset, which transaction has the most events?",
  },
  {
    name: "production_deploys",
    prompt: "Which acme release versions have been deployed to production?",
  },
  {
    name: "least_stable_release",
    prompt: "Which acme release and project has the lowest crash-free session rate?",
  },
  {
    name: "failing_monitors",
    prompt: "Which acme cron monitors are not in an ok state?",
  },
  {
    name: "open_metric_incidents",
    prompt: "Which acme metric alert incidents are still open (not resolved)?",
  },
  {
    name: "team_sizes",
    prompt: "Which acme team has the most members?",
  },
  {
    name: "rate_limited_errors",
    prompt: "How many error events were rate limited in the acme organization over the last 30 days?",
  },
  {
    name: "invite_events",
    prompt: "Who invited members to the acme organization, according to the audit log, and when?",
  },
  { name: "hidden_environments", prompt: "Which acme environments are hidden?" },
  { name: "snoozed_issue_rules", prompt: "Which acme issue alert rules are snoozed (muted)?" },
  { name: "issue_tag_keys", prompt: "Which tag keys does acme issue 4504002 have?" },
  { name: "members_without_2fa", prompt: "Which active acme members do not have two-factor authentication?" },
  {
    name: "latency_alert_threshold",
    prompt: "What is the critical threshold of the acme metric alert on p95 checkout latency?",
  },
  { name: "failed_job_runs", prompt: "How many acme cron check-ins ended in error, missed or timeout, per monitor?" },
  { name: "replay_projects", prompt: "Which acme projects send session replays?" },
  { name: "release_authors", prompt: "Who authored the commits in acme release backend@2.4.0?" },
  { name: "newest_release", prompt: "What is the most recently created open acme release?" },
  { name: "rage_click_replays", prompt: "How many acme session replays had at least one rage click?" },
  { name: "feedback_per_issue", prompt: "Which acme issue received the most user feedback reports?" },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "issues_columns",
    description: "The issues() result columns (binds only; create a sentry secret and drop LIMIT 0 for rows)",
    sql: "SELECT short_id, title, status, level, event_count, last_seen FROM sentry.main.issues() LIMIT 0",
  },
  {
    name: "discover_columns",
    description: "discover() names its columns after the fields (binds only; needs a sentry secret for rows)",
    sql: "SELECT transaction, count, p95_transaction_duration FROM sentry.main.discover('transactions', ['transaction', 'count()', 'p95(transaction.duration)']) LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Sentry Monitoring",
  "vgi.subtitle": "Sentry issues, events, Discover, releases, alerts, crons, replays and usage as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "sentry, error monitoring, exceptions, issues, apm, performance, discover, releases, crons, session replay, observability",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Sentry REST API",
  domain: "observability",
  "vgi.keywords": keywordsArray("sentry, issues, events, discover, releases, alerts, crons, replays, usage"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
