/**
 * `discover(dataset, fields, ...)`: Sentry's Discover / Explore event query
 * (GET /api/0/organizations/{org}/events/) as a table function.
 *
 * The output columns are the requested `fields`, named by a stable sanitising rule
 * (`count()` → `count`, `p95(transaction.duration)` → `p95_transaction_duration`,
 * `user.email` → `user_email`) and typed from the field syntax: count-like
 * aggregates are BIGINT, other aggregates and numeric measurements DOUBLE,
 * `timestamp` and `last_seen()` TIMESTAMPTZ, everything else VARCHAR.
 *
 * Pushdown:
 * - **projection → field list.** Without aggregates, only projected fields are
 *   requested. With aggregates the grouping fields are always kept (dropping one
 *   would change the grouping) and unprojected aggregates are dropped (at least one
 *   aggregate stays, or Discover would list raw events instead).
 * - **filters → query.** `=`, `IN`, `!=`, `NOT IN` on a string column become
 *   `field:value` / `field:[a,b]` / `!field:…` terms; `>= > <= <` on an aggregate
 *   column become having-conditions (`count():>=100`) and on a numeric field
 *   comparisons (`transaction.duration:>500`); a `timestamp` range becomes `start` /
 *   `end` when no window argument is given.
 * - **sort** is the `sort` argument (Sentry needs the sort field in `fields`).
 */

import {
  defineTableFunction,
  float64,
  formatPushedFilters,
  int64,
  list,
  timestampMicros,
  utf8,
  type VgiDataType,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { configFromSecrets, nextCursor, SECRET_TYPE, sentryGet } from "./client.ts";
import { Q, WINDOW_ARGS, WINDOW_CONSTRAINTS, WINDOW_DOCS, windowParams } from "./issues.ts";
import { type Constraint, constraintsOf, eqOne, joinQuery, searchTime, stringTerms, timeBounds } from "./pushdown.ts";
import { asBig, asIso, asNum, asText, C, type Col, DATA_BODY, enc, rowsToBatch, schemaOf, tagsOf } from "./table.ts";

/** Field string → column name: lower-case, non-alphanumerics to `_`, trimmed. */
export function columnName(field: string): string {
  const n = field
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return n === "" ? "field" : /^[0-9]/.test(n) ? `f_${n}` : n;
}

const COUNT_FN = /^(count|count_unique|count_if|count_miserable|count_web_vitals|count_scores)\(/;
const TIME_FN = /^(last_seen|first_seen|min\(timestamp\)|max\(timestamp\))/;
const NUMERIC_FIELD =
  /^(transaction\.duration|span\.duration|span\.self_time|measurements\.|spans\.|http\.response_content_length|stack\.lineno)/;

export const isAggregate = (f: string): boolean => /^[a-z_0-9]+\(.*\)$/.test(f);

export type FieldKind = "big" | "num" | "iso" | "str";

/** The column type implied by a Discover field. */
export function fieldKind(f: string): FieldKind {
  if (isAggregate(f)) {
    if (COUNT_FN.test(f)) return "big";
    if (TIME_FN.test(f)) return "iso";
    if (/^(any|last|first)\(/.test(f)) return "str";
    return "num";
  }
  if (f === "timestamp" || f.startsWith("timestamp.to_")) return "iso";
  if (NUMERIC_FIELD.test(f)) return "num";
  return "str";
}

const KIND_COL: Record<FieldKind, [() => VgiDataType, string, (v: unknown) => unknown]> = {
  big: [() => int64(), "BIGINT", asBig],
  num: [() => float64(), "DOUBLE", asNum],
  iso: [() => timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", asIso],
  str: [() => utf8(), "VARCHAR", asText],
};

/** A constant list argument as strings (arrays, Arrow vectors, iterables). */
export function strArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  const it = v as { toArray?: () => unknown[] } & Iterable<unknown>;
  if (typeof it.toArray === "function") return Array.from(it.toArray(), String);
  if (typeof it[Symbol.iterator] === "function") return Array.from(it, String);
  return [String(v)];
}

export interface DiscoverField {
  field: string;
  column: string;
  kind: FieldKind;
}

/** Validate and name the requested fields. */
export function discoverFields(raw: unknown): DiscoverField[] {
  const fields = strArray(raw)
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length === 0)
    throw new Error("discover: fields must list at least one field, e.g. ['transaction', 'count()']");
  if (fields.length > 20) throw new Error("discover: at most 20 fields per query");
  const seen = new Map<string, string>();
  return fields.map((field) => {
    const column = columnName(field);
    const prev = seen.get(column);
    if (prev !== undefined) throw new Error(`discover: fields '${prev}' and '${field}' both become column '${column}'`);
    seen.set(column, field);
    return { field, column, kind: fieldKind(field) };
  });
}

/** Columns of a discover query: organization first, then one per field. */
export function discoverColumns(fields: DiscoverField[]): Col[] {
  return [
    C.ctx("organization", "Slug of the Sentry organization queried.", "organization"),
    ...fields.map((f) => {
      const [type, sqlType, conv] = KIND_COL[f.kind];
      return {
        name: f.column,
        type: type(),
        sqlType,
        doc: `Discover field ${f.field}.`,
        nullable: true,
        get: (r: Record<string, unknown>) => conv(r[f.field]),
      } as Col;
    }),
  ];
}

/** Which fields to request, given the projected column names. */
export function projectFields(fields: DiscoverField[], projected: Set<string>): string[] {
  const aggs = fields.filter((f) => isAggregate(f.field));
  if (aggs.length === 0) {
    const keep = fields.filter((f) => projected.has(f.column));
    return (keep.length ? keep : fields.slice(0, 1)).map((f) => f.field);
  }
  const keepAggs = aggs.filter((f) => projected.has(f.column));
  const aggSet = new Set((keepAggs.length ? keepAggs : aggs.slice(0, 1)).map((f) => f.field));
  return fields.filter((f) => !isAggregate(f.field) || aggSet.has(f.field)).map((f) => f.field);
}

const OPS: Record<string, string> = { gt: ">", ge: ">=", lt: "<", le: "<=", eq: "" };

/** Search terms for the pushed filters on discover columns. */
export function discoverTerms(fields: DiscoverField[], constraints: Constraint[], requested: Set<string>): string[] {
  const terms: string[] = [];
  for (const f of fields) {
    if (!requested.has(f.field)) continue;
    if (f.kind === "str" && !isAggregate(f.field)) {
      terms.push(...stringTerms(constraints, f.column, f.field));
      continue;
    }
    if (f.kind === "big" || f.kind === "num") {
      for (const c of constraints) {
        if (c.column !== f.column || c.kind !== "cmp") continue;
        const op = OPS[c.op];
        const n = Number(c.value);
        if (op === undefined || !Number.isFinite(n)) continue;
        terms.push(`${f.field}:${op}${n}`);
      }
    }
    if (f.kind === "iso" && !isAggregate(f.field) && f.field !== "timestamp") {
      const { lo, hi } = timeBounds(constraints, f.column);
      if (lo !== undefined) terms.push(`${f.field}:>=${searchTime(lo)}`);
      if (hi !== undefined) terms.push(`${f.field}:<=${searchTime(hi)}`);
    }
  }
  return terms;
}

type DiscoverArgs = {
  dataset: string;
  fields: unknown;
  organization: string | null;
  query: string | null;
  sort: string | null;
  project_id: string | null;
  environment: string | null;
  stats_period: string | null;
  start_time: unknown;
  end_time: unknown;
};

interface DiscoverState {
  orgs: string;
  idx: number;
  cursor: string;
}

const DATASETS = ["discover", "errors", "transactions", "spans"];

const DOC_LLM =
  "Run a Sentry Discover / Explore query (GET /api/0/organizations/{org}/events/) and return its table. " +
  "dataset: 'errors', 'transactions', 'spans' or 'discover' (errors + transactions). fields: the Discover field " +
  "list, e.g. ['transaction', 'count()', 'p95(transaction.duration)'] — plain fields group the aggregates, like " +
  "GROUP BY. Each field becomes a column named by lower-casing and replacing non-alphanumerics with '_' " +
  "(count() → count, p95(transaction.duration) → p95_transaction_duration, user.email → user_email); count-like " +
  "aggregates are BIGINT, other aggregates and durations DOUBLE, timestamp TIMESTAMPTZ, others VARCHAR. Named " +
  "arguments: query (Sentry event search, e.g. 'level:error http.status_code:500'), sort (a field, '-' for " +
  "descending, e.g. '-count()'; must be one of the fields), project_id, environment, stats_period (default 14d) " +
  "or start_time / end_time, organization. WHERE filters on columns push into the search query (string fields: " +
  "=, IN, !=; aggregates and numeric fields: <, <=, >, >=; timestamp range → start/end), and only projected " +
  "fields are requested when that cannot change the grouping.";

const outDoc =
  "## discover(dataset, fields, query, sort, project_id, environment, stats_period := '14d', start_time, end_time)\n\n" +
  "Sentry Discover as a table: one column per requested field.";

export const discover = defineTableFunction<DiscoverArgs, DiscoverState>({
  name: "discover",
  description: "Query Sentry Discover / Explore (errors, transactions, spans): fields, aggregates, search, sort",
  args: {
    dataset: utf8(),
    fields: list(utf8()),
    organization: utf8(),
    query: utf8(),
    sort: utf8(),
    project_id: utf8(),
    environment: utf8(),
    ...WINDOW_ARGS,
  },
  argDocs: {
    dataset: "errors, transactions, spans or discover (errors + transactions).",
    fields: "Discover fields and aggregates, e.g. ['transaction', 'count()', 'p95(transaction.duration)'] (1-20).",
    organization:
      "Organization slug (named). NULL uses the secret's ORGANIZATION, else every organization the token can see.",
    query: "Sentry event search (named), e.g. 'level:error browser.name:Firefox'; ANDed with pushed filters.",
    sort: "Sort field (named), one of the fields, '-' prefix for descending, e.g. '-count()'.",
    project_id: "Numeric project id (named); NULL = every project.",
    environment: "Environment name (named); NULL = every environment.",
    ...WINDOW_DOCS,
    stats_period: "Relative window (named), e.g. '24h', '14d' (default 14d). Ignored with start_time / end_time.",
  },
  argDefaults: {
    organization: null,
    query: null,
    sort: null,
    project_id: null,
    environment: null,
    stats_period: null,
    start_time: null,
    end_time: null,
  },
  argConstraints: { dataset: { choices: DATASETS }, ...WINDOW_CONSTRAINTS } as never,
  // DuckDB tells the worker which columns the query uses, so the field list sent to
  // Sentry can shrink (see projectFields for when that is safe).
  projectionPushdown: true,
  filterPushdown: true,
  autoApplyFilters: true,
  onBind: (params) => {
    const outputSchema = schemaOf(discoverColumns(discoverFields(params.args.fields)));
    return params.resolvedSecretsProvided ? { outputSchema } : { outputSchema, lookupSecretTypes: [SECRET_TYPE] };
  },
  initialState: () => ({ orgs: "", idx: 0, cursor: "" }),
  process: async (params, state, out) => {
    const cfg = configFromSecrets(params.secrets);
    const args = params.args;
    const fields = discoverFields(args.fields);
    const columns = discoverColumns(fields);
    const constraints = constraintsOf(params.pushdownFilters);
    log.debug(`discover: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
    if (!state.orgs) {
      const explicit = args.organization ? [args.organization] : eqOne(constraints, "organization");
      let orgs: string[];
      if (Array.isArray(explicit)) orgs = explicit;
      else if (explicit) orgs = [explicit];
      else if (cfg.organization) orgs = [cfg.organization];
      else {
        const { body } = await sentryGet(cfg, "/organizations/");
        orgs = (Array.isArray(body) ? body : []).map((o: { slug?: string }) => o.slug).filter((s): s is string => !!s);
      }
      state.orgs = JSON.stringify(orgs);
    }
    const orgs = JSON.parse(state.orgs) as string[];
    const projected = new Set(params.outputSchema.fields.map((f) => f.name));
    const requested = projectFields(fields, projected);
    const reqSet = new Set(requested);
    const terms = discoverTerms(fields, constraints, reqSet);
    let window: Record<string, string | undefined> = windowParams(args, "14d");
    const ts = fields.find((f) => f.field === "timestamp");
    if (ts && !args.stats_period && args.start_time == null && args.end_time == null) {
      const { lo, hi } = timeBounds(constraints, ts.column);
      if (lo !== undefined || hi !== undefined) {
        window = { start: new Date(lo ?? 0).toISOString(), end: new Date(hi ?? Date.now()).toISOString() };
      }
    }
    for (;;) {
      const org = orgs[state.idx];
      if (org === undefined) {
        out.finish();
        return;
      }
      const q = joinQuery(terms, args.query);
      const { body, headers } = await sentryGet(cfg, `/organizations/${enc(org)}/events/`, {
        dataset: args.dataset,
        field: requested,
        query: q || undefined,
        sort: args.sort ?? undefined,
        project: args.project_id ?? undefined,
        environment: args.environment ?? undefined,
        per_page: "100",
        cursor: state.cursor || undefined,
        ...window,
      });
      const rows = DATA_BODY(body);
      const next = nextCursor(headers.get("Link"));
      if (next && next !== state.cursor && rows.length > 0) state.cursor = next;
      else {
        state.idx += 1;
        state.cursor = "";
      }
      if (rows.length === 0) continue;
      out.emit(
        rowsToBatch(
          rows.map((r) => ({ ...r, __ctx: { organization: org } })),
          columns,
          params.outputSchema,
        ),
      );
      return;
    }
  },
  tags: tagsOf({
    title: "Sentry Discover",
    category: "events",
    keywords: "sentry, discover, explore, events, transactions, spans, aggregates, p95, count, performance, errors",
    docLlm: DOC_LLM,
    docMd: outDoc,
    pushdown:
      "projection → `field` list (grouping fields kept); string-field `=`/`IN`/`!=` → `field:value`; aggregate and " +
      "numeric comparisons → `count():>=n`; `timestamp` range → `start` / `end`; `organization` picks organizations.",
  }),
  examples: [
    {
      sql: `SELECT transaction, count, p95_transaction_duration FROM ${Q}.discover('transactions', ['transaction', 'count()', 'p95(transaction.duration)'], sort := '-count()') ORDER BY count DESC LIMIT 10`,
      description: "Busiest transactions with their p95 latency",
    },
    {
      sql: `SELECT error_type, count FROM ${Q}.discover('errors', ['error.type', 'count()'], query := 'level:error', stats_period := '24h') WHERE count >= 10 ORDER BY count DESC`,
      description: "Exception types with at least ten errors in the last day (count():>=10 is pushed)",
    },
  ],
});
