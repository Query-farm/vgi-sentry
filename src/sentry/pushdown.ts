/**
 * Turn DuckDB's pushed-down WHERE predicates into Sentry request parameters and
 * Sentry search syntax (`is:unresolved level:[error,fatal] firstSeen:>=2026-11-01T00:00:00Z`).
 *
 * Every table function here sets `autoApplyFilters: true`, so the SDK re-applies
 * every pushed predicate to each batch exactly. Translation therefore only has to
 * NARROW the upstream request without ever dropping a matching row: predicates we
 * cannot express are simply not sent, and anything Sentry matches more loosely
 * (a `*` inside a value is a wildcard; times round outward to whole milliseconds)
 * is tightened again by the SDK.
 *
 * Only top-level conjuncts are translated (a predicate under OR / NOT is left to the
 * SDK), so every generated search term is implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

export type CmpOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le";

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: CmpOp; value: unknown }
  | { kind: "in"; column: string; values: unknown[]; negated: boolean }
  | { kind: "null"; column: string; isNull: boolean }
  | { kind: "contains"; column: string; value: string };

const FLIP: Record<string, CmpOp> = { eq: "eq", ne: "ne", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  // A bare boolean column (`WHERE is_bookmarked`) and its negation.
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "not" && unwrap(e.expression).node === "column_ref") {
    const c = unwrap(e.expression) as Extract<Expr, { node: "column_ref" }>;
    out.push({ kind: "cmp", column: c.columnName, op: "eq", value: false });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as CmpOp, value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values, negated: !!e.negated });
    }
    return;
  }
  if (e.node === "is_null") {
    const col = unwrap(e.expression);
    if (col.node === "column_ref") out.push({ kind: "null", column: col.columnName, isNull: !e.negated });
    return;
  }
  // list_contains(tags, 'x') (DuckDB normalises list_has / array_contains to it).
  if (e.node === "call" && e.function === "list_contains" && e.arguments.length === 2) {
    const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
    if (c.node === "column_ref" && v.node === "literal" && typeof v.value === "string") {
      out.push({ kind: "contains", column: c.columnName, value: v.value });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return out;
}

/** A TIMESTAMPTZ literal or argument as epoch milliseconds (µs bigint / number, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v) / 1000;
  // TIMESTAMPTZ arguments can arrive as a number of microseconds; epoch ms for any
  // date before year 5138 is below 1e14, so larger numbers are microseconds.
  if (typeof v === "number") return Math.abs(v) >= 1e14 ? v / 1000 : v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** The tightest inclusive [lo, hi] epoch-ms bounds the constraints put on a time column (rounded outward). */
export function timeBounds(constraints: Constraint[], column: string): { lo?: number; hi?: number } {
  let lo: number | undefined;
  let hi: number | undefined;
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    if (c.op === "gt" || c.op === "ge" || c.op === "eq") {
      const v = Math.floor(ms);
      lo = lo === undefined ? v : Math.max(lo, v);
    }
    if (c.op === "lt" || c.op === "le" || c.op === "eq") {
      const v = Math.ceil(ms);
      hi = hi === undefined ? v : Math.min(hi, v);
    }
  }
  return { lo, hi };
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && (typeof c.value === "string" || typeof c.value === "number"))
      vs = [String(c.value)];
    else if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "bigint") vs = [c.value.toString()];
    else if (c.kind === "in" && !c.negated && c.values.every((v) => typeof v === "string" || typeof v === "bigint"))
      vs = c.values.map(String);
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

/** `!=` / NOT IN values pushed for a column (as strings). */
export function neValues(constraints: Constraint[], column: string): string[] {
  const out: string[] = [];
  for (const c of constraints) {
    if (c.column !== column) continue;
    if (c.kind === "cmp" && c.op === "ne" && typeof c.value === "string") out.push(c.value);
    if (c.kind === "in" && c.negated && c.values.every((v) => typeof v === "string"))
      out.push(...(c.values as string[]));
  }
  return [...new Set(out)];
}

/** The single equality value pushed for a column, if exactly one. */
export function eqOne(constraints: Constraint[], column: string): string | undefined {
  const vs = eqValues(constraints, column);
  return vs && vs.length === 1 ? vs[0] : undefined;
}

/** A pushed `col = true/false` (or bare boolean column), if any. */
export function eqBool(constraints: Constraint[], column: string): boolean | undefined {
  for (const c of constraints) {
    if (c.column === column && c.kind === "cmp" && c.op === "eq" && typeof c.value === "boolean") return c.value;
  }
  return undefined;
}

/** A pushed `col IS NULL` (true) / `IS NOT NULL` (false), if any. */
export function nullCheck(constraints: Constraint[], column: string): boolean | undefined {
  for (const c of constraints) if (c.column === column && c.kind === "null") return c.isNull;
  return undefined;
}

/** Every `list_contains(col, 'x')` value pushed for a list column. */
export function containsValues(constraints: Constraint[], column: string): string[] {
  const out: string[] = [];
  for (const c of constraints) if (c.column === column && c.kind === "contains") out.push(c.value);
  return [...new Set(out)];
}

// ------------------------------------------------------------- Sentry search syntax

/**
 * Quote a value for Sentry's search syntax. Plain tokens stay bare; anything with
 * whitespace, quotes, parentheses, brackets, commas, a leading `!` or a colon is
 * double-quoted with `"` and `\` escaped.
 */
export function searchValue(v: string): string {
  if (v !== "" && /^[^\s"()[\],:!\\]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Tag keys Sentry accepts bare in `key:value` (letters, digits, `_ . - @`). */
export function searchKey(k: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.\-@]*$/.test(k);
}

/** `key:value`, `key:[a,b]`, `!key:value` or `!key:[a,b]`. */
export function term(key: string, values: string[], negate = false): string {
  const v = values.length === 1 ? searchValue(values[0] as string) : `[${values.map(searchValue).join(",")}]`;
  return `${negate ? "!" : ""}${key}:${v}`;
}

/** An ISO 8601 UTC time for search comparisons (milliseconds dropped when zero). */
export function searchTime(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Range terms for a time column (`firstSeen:>=… firstSeen:<=…`). */
export function timeTerms(constraints: Constraint[], column: string, key: string): string[] {
  const { lo, hi } = timeBounds(constraints, column);
  const out: string[] = [];
  if (lo !== undefined) out.push(`${key}:>=${searchTime(lo)}`);
  if (hi !== undefined) out.push(`${key}:<=${searchTime(hi)}`);
  return out;
}

/** Equality / IN / != / NOT IN terms for one string column mapped to a search key. */
export function stringTerms(constraints: Constraint[], column: string, key: string): string[] {
  const out: string[] = [];
  const eq = eqValues(constraints, column);
  if (eq && eq.length > 0) out.push(term(key, eq));
  const ne = neValues(constraints, column);
  if (ne.length > 0) out.push(term(key, ne, true));
  return out;
}

/** Join search terms and a user-supplied query (wrapped in parentheses when it has OR). */
export function joinQuery(terms: string[], user?: string | null): string {
  const parts = [...terms];
  const u = user?.trim();
  if (u) parts.push(/\bOR\b/.test(u) ? `(${u})` : u);
  return parts.join(" ");
}
