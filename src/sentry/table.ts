/**
 * One factory for every Sentry list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), the scopes it runs in
 * (the organizations, then optionally per project / issue / release / monitor), and
 * how a scope plus the pushed filters become a request. The factory turns that
 * into a VGI table function that:
 *
 * - resolves the organizations once: `organization := 'slug'`, a pushed
 *   `WHERE organization = / IN (...)`, the secret's ORGANIZATION, or else every
 *   organization the token can see;
 * - resolves any sub-scopes (projects, issues, releases …) once, also from named
 *   arguments or pushed `= / IN` filters before falling back to a listing;
 * - streams one Sentry page per Arrow batch;
 * - keeps its cursor (scope list, scope index, Sentry `Link` cursor) in
 *   serializable state, so a scan resumes on any process over HTTP and survives
 *   rate-limit pauses;
 * - reads the `sentry` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import {
  configFromSecrets,
  nextCursor,
  type QueryValue,
  SECRET_TYPE,
  type SentryConfig,
  SentryError,
  sentryGet,
} from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: Sentry JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
};
/** Sentry sends some counts as strings ("count": "1204"); accept both. */
export const asBig = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
};
export const asNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** ISO 8601 (or epoch seconds) → TIMESTAMPTZ microseconds. */
export function asIso(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v * 1_000_000));
  if (typeof v !== "string" || v === "") return null;
  // Keep microseconds when Sentry sends them (2026-11-14T09:12:03.123456Z).
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/.exec(v);
  if (m) {
    const base = Date.parse(`${m[1]}${m[3] ?? "Z"}`);
    if (!Number.isNaN(base)) {
      const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
      return BigInt(base) * 1000n + BigInt(frac || "0");
    }
  }
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** A JSON value as text: strings as-is, everything else JSON-encoded. */
export const asText = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => asText(x) as string) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

export type Getter = string | ((r: Row) => unknown);
const read = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

/** A field of a STRUCT column: its Arrow type, DuckDB spelling and converter. */
export interface StructField {
  name: string;
  kind: "str" | "int" | "big" | "bool" | "num" | "iso" | "strList" | "text";
  get: Getter;
}

const FIELD_TYPES: Record<StructField["kind"], [() => VgiDataType, string, (v: unknown) => unknown]> = {
  str: [() => utf8(), "VARCHAR", asStr],
  text: [() => utf8(), "VARCHAR", asText],
  int: [() => int32, "INTEGER", asInt],
  big: [() => int64(), "BIGINT", asBig],
  num: [() => float64(), "DOUBLE", asNum],
  bool: [() => bool, "BOOLEAN", asBool],
  iso: [() => timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", asIso],
  strList: [() => list(utf8()), "VARCHAR[]", asStrList],
};

const structType = (fields: StructField[]) =>
  struct(fields.map((f) => field(f.name, FIELD_TYPES[f.kind][0]())) as never);
const structSql = (fields: StructField[]) =>
  `STRUCT(${fields.map((f) => `${f.name} ${FIELD_TYPES[f.kind][1]}`).join(", ")})`;
const structValue = (fields: StructField[], item: Row) =>
  Object.fromEntries(fields.map((f) => [f.name, FIELD_TYPES[f.kind][2](read(item, f.get))]));

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(read(r, g)), nullable),
  /** A JSON value of any type as text (strings unquoted). */
  text: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "VARCHAR", doc, (r) => asText(read(r, g))),
  iso: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asIso(read(r, g)), nullable),
  bool: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(read(r, g)), nullable),
  int: (name: string, doc: string, g: Getter) => mkCol(name, int32, "INTEGER", doc, (r) => asInt(read(r, g))),
  big: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, int64(), "BIGINT", doc, (r) => asBig(read(r, g)), nullable),
  num: (name: string, doc: string, g: Getter) => mkCol(name, float64(), "DOUBLE", doc, (r) => asNum(read(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(read(r, g))),
  json: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "JSON", doc, (r) => asJson(read(r, g))),
  /** A scope value (organization / project / issue …) the row was read under. */
  ctx: (name: string, doc: string, key: string) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, false),
  /** A list of structs. */
  structList: (name: string, doc: string, fields: StructField[], g: Getter) =>
    mkCol(name, list(structType(fields)), `${structSql(fields)}[]`, doc, (r) => {
      const v = read(r, g);
      if (!Array.isArray(v)) return null;
      return v.map((item) => structValue(fields, item));
    }),
};

export const ORG_COL = C.ctx("organization", "Slug of the Sentry organization the row belongs to.", "organization");

// --------------------------------------------------------------------- the factory

/** Where a row was read: always the organization, plus any sub-scope keys. */
export type Scope = Record<string, string> & { organization: string };

export interface SentryRequest {
  /** Path under /api/0 (`/organizations/acme/issues/`). */
  path: string;
  query?: Record<string, QueryValue>;
  /** `cursor`: follow the `Link` header's next cursor; `single`: one response. */
  paging: "cursor" | "single";
  /** The page-size parameter name and value (`per_page` on most endpoints, `limit` on issues). */
  pageParam?: "per_page" | "limit" | "none";
  pageSize?: number;
}

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
  /** Wall-clock anchor fixed when the scan started (epoch ms), stable across resumes. */
  anchorMs: number;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface SentryTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  /** false: account-wide (organizations); no `organization` argument. */
  orgScoped?: boolean;
  /** Extra arguments (`organization` is added automatically). */
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Expand one organization into sub-scopes (one per project, issue, release …). */
  subScopes?: (org: string, cfg: SentryConfig, ctx: ScanContext<A>) => Promise<Record<string, string>[]>;
  /** The request for one scope; null skips the scope. */
  request: (scope: Scope, ctx: ScanContext<A>) => SentryRequest | null;
  /** Pull the rows out of a response body (default: the body itself when it is an array). */
  rows?: (body: unknown, scope: Scope, ctx: ScanContext<A>) => Row[];
  /** A 404 / 403 for a scope means "nothing there" → zero rows rather than an error. */
  notFoundEmpty?: boolean;
  /** Turn an HTTP error for a scope into a clearer one (feature detection). */
  onError?: (err: SentryError, scope: Scope) => Error | null;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  /** Scopes resolved on the first call, as a JSON array of objects; "" = not yet. */
  scopes: string;
  idx: number;
  /** The next `Link` cursor within the current scope; "" = first page. */
  cursor: string;
  anchorMs: number;
}

const ARRAY_BODY = (body: unknown): Row[] => (Array.isArray(body) ? (body as Row[]) : []);

/** `{"data": [...]}` bodies (Discover, replays, monitors' check-ins …). */
export const DATA_BODY = (body: unknown): Row[] => {
  const d = (body as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Row[]) : [];
};

const ORG_DOC =
  "Organization slug (named). NULL uses the secret's ORGANIZATION, else every organization the token can see; " +
  "a pushed WHERE organization = / IN (...) works the same way.";

/** Page through a cursor-paged list and collect every row (bounded). */
export async function listAll(
  cfg: SentryConfig,
  path: string,
  query: Record<string, QueryValue> = {},
  maxPages = 200,
): Promise<Row[]> {
  const out: Row[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const q: Record<string, QueryValue> = { ...query, per_page: "100" };
    if (cursor) q.cursor = cursor;
    const { body, headers } = await sentryGet(cfg, path, q);
    const rows = ARRAY_BODY(body);
    out.push(...rows);
    const next = nextCursor(headers.get("Link"));
    if (!next || next === cursor || rows.length === 0) break;
    cursor = next;
  }
  return out;
}

export const enc = encodeURIComponent;

/** A named argument's value if non-empty, else the pushed `= / IN` values of a column. */
export function pick(
  args: Record<string, unknown>,
  constraints: Constraint[],
  arg: string,
  col = arg,
): string[] | undefined {
  const v = args[arg];
  if (typeof v === "string" && v !== "") return [v];
  if (typeof v === "bigint" || typeof v === "number") return [String(v)];
  return eqValues(constraints, col);
}

/** The organizations a scan reads. */
async function resolveOrgs(
  cfg: SentryConfig,
  args: Record<string, unknown>,
  constraints: Constraint[],
): Promise<string[]> {
  const explicit = pick(args, constraints, "organization");
  if (explicit) return explicit;
  if (cfg.organization) return [cfg.organization];
  const orgs = await listAll(cfg, "/organizations/");
  return orgs.map((o) => o.slug).filter((s): s is string => typeof s === "string");
}

/** The Arrow output schema of a set of columns (column comments ride along as field metadata). */
export function schemaOf(columns: Col[]): VgiSchema {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Discovery tags shared by a spec's function or table. */
export function tagsOf(spec: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  pushdown?: string;
  columns?: Col[];
  /** Markdown table(s) describing columns that vary by argument (vgi.result_dynamic_columns_md). */
  resultDynamicMd?: string;
}): Record<string, string> {
  const tags: Record<string, string> = {
    domain: "observability",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
  };
  if (spec.resultDynamicMd) tags["vgi.result_dynamic_columns_md"] = spec.resultDynamicMd;
  if (spec.columns) {
    tags["vgi.result_columns_schema"] = JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    );
  }
  return tags;
}

/**
 * An account-wide spec with no arguments exposed as a catalog table
 * (`SELECT … FROM sentry.main.organizations`). The scan function keeps every
 * capability (pushdown, paging, secrets) and is table-only.
 */
export function defineSentryCatalogTable(
  spec: SentryTableSpec<Record<string, never>>,
  primaryKey: string[],
): TableDescriptor {
  const fn = defineSentryTable({ ...spec, name: `${spec.name}_scan` });
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY", columns: string[]) =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.name,
      id,
      kind,
      columns: columns.map((c) => [c]),
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: schemaOf(spec.columns),
    function: fn,
    constraints: [
      ...primaryKey.map((c) => record(`${c}_not_null`, "NOT_NULL", [c])),
      record("pk", "PRIMARY_KEY", primaryKey),
    ],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

/** Emit `rows` (tagged with their scope) as one batch of the projected output schema. */
export function rowsToBatch(rows: Row[], columns: Col[], outputSchema: VgiSchema) {
  const cols: Record<string, unknown[]> = {};
  for (const f of outputSchema.fields) {
    const c = columns.find((x) => x.name === f.name);
    cols[f.name] = c ? rows.map((r) => c.get(r)) : rows.map(() => null);
  }
  return batchFromColumns(cols, outputSchema);
}

export function defineSentryTable<A extends Record<string, unknown>>(spec: SentryTableSpec<A>): VgiFunction {
  const outSchema = schemaOf(spec.columns);
  const extract = spec.rows ?? ARRAY_BODY;
  const orgScoped = spec.orgScoped ?? true;
  const args: Record<string, VgiDataType> = {};
  const argDocs: Record<string, string> = {};
  const argDefaults: Record<string, unknown> = {};
  Object.assign(args, spec.args ?? {});
  Object.assign(argDocs, spec.argDocs ?? {});
  Object.assign(argDefaults, spec.argDefaults ?? {});
  if (orgScoped) {
    args.organization = utf8();
    argDocs.organization = ORG_DOC;
    argDefaults.organization = null;
  }

  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args,
    argDocs,
    argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Sentry returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ scopes: "", idx: 0, cursor: "", anchorMs: Date.now() }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext<A> = {
        args: params.args,
        constraints: constraintsOf(params.pushdownFilters),
        anchorMs: state.anchorMs,
      };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      if (!state.scopes) {
        const orgs = orgScoped
          ? await resolveOrgs(cfg, params.args as Record<string, unknown>, scan.constraints)
          : [""];
        const scopes: Scope[] = [];
        for (const organization of orgs) {
          if (!spec.subScopes) scopes.push({ organization });
          else for (const sub of await spec.subScopes(organization, cfg, scan)) scopes.push({ ...sub, organization });
        }
        state.scopes = JSON.stringify(scopes);
      }
      const scopes = JSON.parse(state.scopes) as Scope[];
      const nextScope = () => {
        state.idx += 1;
        state.cursor = "";
      };

      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        const scope = scopes[state.idx];
        if (!scope) {
          out.finish();
          return;
        }
        const req = spec.request(scope, scan);
        if (!req) {
          nextScope();
          continue;
        }
        const query: Record<string, QueryValue> = { ...(req.query ?? {}) };
        if (req.paging === "cursor") {
          const pp = req.pageParam ?? "per_page";
          if (pp !== "none") query[pp] = String(req.pageSize ?? 100);
          if (state.cursor) query.cursor = state.cursor;
        }
        let res: Awaited<ReturnType<typeof sentryGet>>;
        try {
          res = await sentryGet(cfg, req.path, query);
        } catch (err) {
          if (err instanceof SentryError) {
            const mapped = spec.onError?.(err, scope);
            if (mapped) throw mapped;
            if (spec.notFoundEmpty && (err.status === 404 || err.status === 403)) {
              nextScope();
              continue;
            }
          }
          throw err;
        }
        const rows = extract(res.body, scope, scan);
        if (req.paging === "cursor") {
          const next = nextCursor(res.headers.get("Link"));
          if (next && next !== state.cursor && rows.length > 0) state.cursor = next;
          else nextScope();
        } else {
          nextScope();
        }
        if (rows.length === 0) continue;
        const tagged = rows.map((r) => ({ ...r, __ctx: { ...scope, base_url: cfg.baseUrl } }));
        out.emit(rowsToBatch(tagged, spec.columns, params.outputSchema));
        return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}
