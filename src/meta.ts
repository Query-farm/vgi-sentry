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
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-sentry";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "organization", title: "Organization", description: "Organizations, projects, teams, members and environments." },
  { name: "issues", title: "Issues", description: "Issues with pushed-down issue search, their events and tag distributions." },
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
  "Sentry error and performance monitoring as SQL: issues with pushed-down issue search, events, Discover queries, releases and deploys, alerts, cron monitors, replays and usage, read-only from sentry.io or a self-hosted Sentry.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to Sentry (sentry.io, its us / de regions, or self-hosted) through the REST API. Reach " +
  "for it to answer: which errors are hurting users right now and since when (issues: WHERE status, level, " +
  "priority, first_seen / last_seen, assignee, project_slug push down as Sentry issue search terms; tags := " +
  "['browser.name:Chrome'] and query := add raw search), what an issue looks like (issue_events with the " +
  "innermost exception and in-app frame; issue_tags / issue_tag_values for its browser / release / user " +
  "distribution), ad-hoc aggregates over errors, transactions and spans (discover(dataset, fields) — e.g. " +
  "['transaction', 'count()', 'p95(transaction.duration)']; columns are the sanitised field names), what " +
  "shipped and whether it is stable (releases, release_health, release_deploys, release_commits), how alerting " +
  "is configured and how noisy it is (issue_alert_rules, metric_alert_rules, metric_alert_incidents), whether " +
  "scheduled jobs run (monitors, monitor_checkins), frontend UX signals (replays: metadata only), user feedback " +
  "(names / emails only with include_pii := true), who changed what (audit_log, Business plan) and how much " +
  "volume is accepted or dropped (usage_stats). Every object needs a `sentry` DuckDB secret with AUTH_TOKEN and " +
  "optional REGION ('us' / 'de'), BASE_URL (self-hosted) and ORGANIZATION (default organization slug). Without " +
  "an organization every organization the token sees is read. Issue, event and replay functions default to a " +
  "90-day window (stats_period / start_time / end_time), discover to 14 days, usage_stats to 30 days.";

export const CATALOG_DOC_MD =
  "# Sentry\n\n" +
  "Query Sentry from DuckDB: organizations, projects, teams, members and environments; issues with their " +
  "events and tags; Discover queries over errors, transactions and spans; releases with health, deploys and " +
  "commits; issue and metric alert rules and metric alert incidents; cron monitors and check-ins; session " +
  "replay metadata; user feedback; the audit log; and usage stats. Read-only.\n\n" +
  "Create a `sentry` secret with an auth token (`AUTH_TOKEN`); add `REGION 'de'` for EU data residency, " +
  "`BASE_URL` for self-hosted Sentry and `ORGANIZATION` for a default organization. WHERE filters become " +
  "Sentry issue / event search terms, so only matching rows cross the network; `Link` cursor paging and the " +
  "`X-Sentry-Rate-Limit-*` headers are handled for you." +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Sentry REST API collections as SQL. `organizations` is a table; everything else is a table function with an " +
  "optional organization := named argument (NULL = the secret's ORGANIZATION, else all organizations). " +
  "Per-project functions (issue_alert_rules, user_feedback) take project_slug :=; per-issue functions " +
  "(issue_events, issue_tags, issue_tag_values) need issue_id := (from issues()); per-release functions " +
  "(release_deploys, release_commits) take version := and otherwise read every open release. issues() and " +
  "discover() translate WHERE filters into Sentry search syntax and re-check them exactly. All objects need a " +
  "`sentry` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Sentry collections: organization structure, issues and events, Discover, releases, alerts, crons, replays " +
  "and administration.\n\n" +
  "Functions take the organization, project, issue or release as named arguments or pushed filters. Filters " +
  "push down into Sentry's search syntax and request parameters.\n\n" +
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
  "vgi.title": "Sentry Error and Performance Monitoring",
  "vgi.subtitle":
    "Sentry issues, events, Discover, releases, alerts, crons, replays and usage as SQL tables.",
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
