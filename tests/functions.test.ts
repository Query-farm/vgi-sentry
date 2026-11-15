// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CATALOG, FUNCTIONS } from "../src/catalog.ts";
import {
  assertSameOrigin,
  buildUrl,
  configFromSecrets,
  DEFAULT_BASE_URL,
  nextCursor,
  normalizeBaseUrl,
  parseLink,
  resetDelayMs,
  type SentryConfig,
  sentryGet,
} from "../src/sentry/client.ts";
import {
  columnName,
  discoverFields,
  discoverTerms,
  fieldKind,
  projectFields,
  strArray,
} from "../src/sentry/discover.ts";
import { incidentStatus, issueQuery, topInAppFrame, windowParams } from "../src/sentry/issues.ts";
import { type Constraint, joinQuery, searchValue, term, timeTerms, toEpochMs } from "../src/sentry/pushdown.ts";
import { asBig, asIso } from "../src/sentry/table.ts";

const ROOT = join(import.meta.dir, "..");
const eq = (column: string, value: unknown): Constraint => ({ kind: "cmp", column, op: "eq", value });
const cmp = (column: string, op: "gt" | "ge" | "lt" | "le" | "ne", value: unknown): Constraint => ({
  kind: "cmp",
  column,
  op,
  value,
});

test("base_url: https required except for loopback; self-hosted path prefix kept", () => {
  expect(normalizeBaseUrl("https://sentry.io/")).toBe("https://sentry.io");
  expect(normalizeBaseUrl("https://sentry.example.com/sentry/api/0/")).toBe("https://sentry.example.com/sentry");
  expect(normalizeBaseUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  expect(() => normalizeBaseUrl("http://sentry.example.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: token required; region picks the host; base_url wins", () => {
  expect(() => configFromSecrets({})).toThrow(/no sentry secret/);
  expect(() => configFromSecrets({ s: { type: "sentry" } })).toThrow(/AUTH_TOKEN/);
  expect(configFromSecrets({ s: { type: "sentry", auth_token: " t " } })).toEqual({
    baseUrl: DEFAULT_BASE_URL,
    token: "t",
  });
  expect(configFromSecrets({ s: { type: "sentry", auth_token: "t", region: "DE" } }).baseUrl).toBe(
    "https://de.sentry.io",
  );
  const own = configFromSecrets({
    s: { type: "sentry", auth_token: "t", region: "us", base_url: "https://sentry.corp.example", organization: "acme" },
  });
  expect(own).toEqual({ baseUrl: "https://sentry.corp.example", token: "t", organization: "acme" });
  expect(() => configFromSecrets({ s: { type: "sentry", auth_token: "t", region: "eu" } })).toThrow(/region/);
});

test("buildUrl: repeated parameters, empty query kept, undefined dropped", () => {
  const cfg: SentryConfig = { baseUrl: "https://sentry.io", token: "t" };
  expect(buildUrl(cfg, "/organizations/acme/issues/", { query: "", project: ["1", "2"], sort: undefined })).toBe(
    "https://sentry.io/api/0/organizations/acme/issues/?query=&project=1&project=2",
  );
  expect(() => assertSameOrigin(cfg, "https://evil.example/api/0/")).toThrow(/refusing/);
});

test("Link header: next cursor only while results=true", () => {
  const h =
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
  expect(parseLink(h).map((l) => [l.rel, l.results, l.cursor])).toEqual([
    ["previous", false, "0:0:1"],
    ["next", true, "0:100:0"],
  ]);
  expect(nextCursor(h)).toBe("0:100:0");
  expect(nextCursor(h.replace('results="true"', 'results="false"'))).toBe("");
  expect(nextCursor(null)).toBe("");
});

test("rate limits: Retry-After seconds, else X-Sentry-Rate-Limit-Reset epoch seconds", () => {
  expect(resetDelayMs(new Headers({ "Retry-After": "2" }))).toBe(2000);
  expect(resetDelayMs(new Headers({ "X-Sentry-Rate-Limit-Reset": "1000" }), 995_000)).toBe(5100);
  expect(resetDelayMs(new Headers())).toBeUndefined();
});

test("search values: bare when safe, quoted and escaped otherwise", () => {
  expect(searchValue("error")).toBe("error");
  expect(searchValue("/checkout")).toBe("/checkout");
  expect(searchValue("web 2")).toBe('"web 2"');
  expect(searchValue('say "hi"')).toBe('"say \\"hi\\""');
  expect(searchValue("a:b")).toBe('"a:b"');
  expect(searchValue("!x")).toBe('"!x"');
  expect(searchValue("C:\\temp")).toBe('"C:\\\\temp"');
  expect(term("level", ["error", "fatal"])).toBe("level:[error,fatal]");
  expect(term("level", ["warning"], true)).toBe("!level:warning");
  expect(joinQuery(["is:unresolved"], "a OR b")).toBe("is:unresolved (a OR b)");
});

test("time terms round outward to whole milliseconds", () => {
  const c = [cmp("first_seen", "gt", 1_763_000_000_000_500n), cmp("first_seen", "lt", 1_763_100_000_000_500n)];
  expect(timeTerms(c, "first_seen", "firstSeen")).toEqual([
    "firstSeen:>=2025-11-13T02:13:20Z",
    "firstSeen:<=2025-11-14T06:00:00.001Z",
  ]);
  expect(toEpochMs(1_763_000_000_000_000)).toBe(1_763_000_000_000);
  expect(toEpochMs(1_763_000_000_000)).toBe(1_763_000_000_000);
});

test("issueQuery: pushed filters, tags and the user query", () => {
  const q = issueQuery(
    [
      eq("status", "unresolved"),
      { kind: "in", column: "level", values: ["error", "fatal"], negated: false },
      { kind: "null", column: "assignee", isNull: true },
      cmp("event_count", "gt", 100n),
      { kind: "in", column: "project_slug", values: ["a", "b"], negated: false },
    ],
    { tags: ["server_name:web 2"], query: "assigned:me" },
  );
  expect(q).toBe(
    'is:unresolved level:[error,fatal] is:unassigned timesSeen:>=101 project:[a,b] server_name:"web 2" assigned:me',
  );
  // An unsupported status value is not pushed (the SDK still filters).
  expect(issueQuery([eq("status", "pending")], {})).toBe("");
  expect(issueQuery([eq("assignee_type", "team"), eq("assignee", "web")], {})).toBe("assigned:#web");
  expect(() => issueQuery([], { tags: ["nocolon"] })).toThrow(/key:value/);
  expect(incidentStatus("ignored")).toBe("acknowledged");
});

test("windowParams: default period, explicit period, start/end", () => {
  expect(windowParams({})).toEqual({ statsPeriod: "90d" });
  expect(windowParams({ stats_period: "24h" })).toEqual({ statsPeriod: "24h" });
  const w = windowParams({ start_time: 1_763_000_000_000_000n, end_time: 1_763_100_000_000_000n });
  expect(w).toEqual({ start: "2025-11-13T02:13:20.000Z", end: "2025-11-14T06:00:00.000Z" });
});

test("topInAppFrame: innermost in-app frame of the innermost exception", () => {
  const ev = {
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              stacktrace: {
                frames: [
                  { function: "a", filename: "a.py", lineNo: 1, inApp: true },
                  { function: "b", filename: "b.py", lineNo: 2, inApp: true },
                  { function: "lib", filename: "lib.py", lineNo: 3, inApp: false },
                ],
              },
            },
          ],
        },
      },
    ],
  };
  expect(topInAppFrame(ev)).toBe("b (b.py:2)");
  expect(topInAppFrame({})).toBeNull();
});

test("discover: column names, types and projection", () => {
  expect(columnName("p95(transaction.duration)")).toBe("p95_transaction_duration");
  expect(columnName("count()")).toBe("count");
  expect(columnName("user.email")).toBe("user_email");
  expect(fieldKind("count_unique(user)")).toBe("big");
  expect(fieldKind("avg(span.duration)")).toBe("num");
  expect(fieldKind("last_seen()")).toBe("iso");
  expect(fieldKind("timestamp")).toBe("iso");
  expect(fieldKind("transaction.duration")).toBe("num");
  expect(fieldKind("transaction")).toBe("str");
  expect(strArray(["a", "b"])).toEqual(["a", "b"]);
  expect(() => discoverFields([])).toThrow(/at least one/);
  expect(() => discoverFields(["count()", "count( )"])).toThrow(/both become/);

  const f = discoverFields(["transaction", "count()", "p95(transaction.duration)"]);
  // Grouping fields always stay; unprojected aggregates go, but one aggregate remains.
  expect(projectFields(f, new Set(["transaction"]))).toEqual(["transaction", "count()"]);
  expect(projectFields(f, new Set(["p95_transaction_duration"]))).toEqual(["transaction", "p95(transaction.duration)"]);
  const plain = discoverFields(["id", "transaction", "environment"]);
  expect(projectFields(plain, new Set(["environment"]))).toEqual(["environment"]);
  expect(projectFields(plain, new Set())).toEqual(["id"]);

  const terms = discoverTerms(
    f,
    [eq("transaction", "GET /x"), cmp("count", "ge", 10n), cmp("p95_transaction_duration", "gt", 500)],
    new Set(["transaction", "count()", "p95(transaction.duration)"]),
  );
  expect(terms).toEqual(['transaction:"GET /x"', "count():>=10", "p95(transaction.duration):>500"]);
});

test("value converters: string counts and microsecond ISO times", () => {
  expect(asBig("1204")).toBe(1204n);
  expect(asBig("x")).toBeNull();
  expect(asIso("2026-11-15T10:00:00.123456Z")).toBe(1_794_736_800_123_456n);
  expect(asIso("2026-11-15T10:00:00Z")).toBe(1_794_736_800_000_000n);
  expect(asIso(null)).toBeNull();
});

test("catalog: every function documented, secret type registered", () => {
  expect(CATALOG.name).toBe("sentry");
  expect(CATALOG.secretTypes?.[0]?.name).toBe("sentry");
  for (const fn of FUNCTIONS) {
    expect(fn.meta.tags?.["vgi.doc_llm"]?.length ?? 0).toBeGreaterThan(80);
    expect(fn.meta.examples?.length ?? 0).toBeGreaterThanOrEqual(2);
  }
});

describe("against the Sentry replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let cfg: SentryConfig;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    cfg = { baseUrl: `http://127.0.0.1:${port}`, token: "sntrys_test_token" };
  });

  afterAll(() => {
    mock?.kill();
  });

  test("a 429 is retried after Retry-After and paging follows the Link cursor", async () => {
    const t0 = Date.now();
    const first = await sentryGet(cfg, "/organizations/acme/issues/", { query: "", statsPeriod: "90d", limit: "100" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect((first.body as unknown[]).length).toBe(3);
    const cursor = nextCursor(first.headers.get("Link"));
    expect(cursor).toBe("0:3:0");
    const second = await sentryGet(cfg, "/organizations/acme/issues/", {
      query: "",
      statsPeriod: "90d",
      limit: "100",
      cursor,
    });
    expect((second.body as unknown[]).length).toBe(3);
  });

  test("unknown parameters and bad tokens are rejected with the status in the message", async () => {
    await expect(sentryGet(cfg, "/organizations/", { bogus: "1" })).rejects.toThrow(/HTTP 400.*unknown parameter/);
    await expect(sentryGet({ ...cfg, token: "nope" }, "/organizations/")).rejects.toThrow(/HTTP 401/);
  });
});
