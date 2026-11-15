/**
 * Sentry REST API client: authentication, regions, Link-cursor paging, rate limits.
 *
 * - **Auth.** A `sentry` DuckDB secret carries an AUTH_TOKEN (an organization auth
 *   token `sntrys_…`, a user auth token `sntryu_…` or an internal-integration token),
 *   sent as `Authorization: Bearer …`. It never enters table-function state, never
 *   appears in an error message and is never sent to another origin.
 * - **Host.** BASE_URL (default https://sentry.io) points at sentry.io or a self-hosted
 *   install; REGION 'us' / 'de' selects https://us.sentry.io / https://de.sentry.io (the
 *   data-residency region hosts) when BASE_URL is not given.
 * - **Paging.** Sentry pages with an RFC 5988 `Link` header whose `rel="next"` entry
 *   carries `results="true|false"` and `cursor="…"`. The cursor string is what a scan
 *   keeps in its serializable state.
 * - **Rate limits.** Sentry answers with `X-Sentry-Rate-Limit-Remaining` /
 *   `-Reset` (epoch **seconds**) and `-ConcurrentRemaining`. A 429 waits for
 *   `Retry-After` (seconds) or the reset, bounded; when the window is about to run
 *   dry the client pauses before the next call instead of burning a 429. 5xx and
 *   network errors retry with exponential backoff.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "sentry";
export const DEFAULT_BASE_URL = "https://sentry.io";
export const REGION_URLS: Record<string, string> = { us: "https://us.sentry.io", de: "https://de.sentry.io" };
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit window. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-sentry-worker/${VERSION}`;

export class SentryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SentryConfig {
  baseUrl: string;
  token: string;
  /** Default organization slug from the secret, if any. */
  organization?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SentryError(`sentry secret: base_url '${raw}' is not a URL (expected e.g. ${DEFAULT_BASE_URL})`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new SentryError("sentry secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)");
  }
  // Self-hosted installs may live under a path prefix (https://example.com/sentry).
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/0$/, "");
  return `${url.origin}${path}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `sentry` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): SentryConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new SentryError(
      "no sentry secret: run CREATE SECRET (TYPE sentry, AUTH_TOKEN 'sntrys_…') " +
        "(add REGION 'de' for EU data residency, or BASE_URL 'https://sentry.example.com' for self-hosted)",
    );
  }
  const token = str(s.auth_token);
  if (!token) throw new SentryError("sentry secret: AUTH_TOKEN is required (an organization or user auth token)");
  const region = str(s.region)?.toLowerCase();
  if (region && !REGION_URLS[region]) {
    throw new SentryError(`sentry secret: region '${region}' is not one of us, de`);
  }
  const base = str(s.base_url) ?? (region ? REGION_URLS[region] : undefined) ?? DEFAULT_BASE_URL;
  const cfg: SentryConfig = { baseUrl: normalizeBaseUrl(base), token };
  const org = str(s.organization);
  if (org) cfg.organization = org;
  return cfg;
}

/** Refuse to send the token to an origin other than the configured host. */
export function assertSameOrigin(cfg: SentryConfig, url: string): void {
  if (new URL(url).origin !== new URL(cfg.baseUrl).origin) {
    throw new SentryError(`refusing to follow a link to ${new URL(url).origin}: it is not the configured Sentry host`);
  }
}

/** A query value: one value, a repeated parameter, or absent. `""` is sent (empty). */
export type QueryValue = string | string[] | undefined;

/** Build the request URL; repeated parameters (`project=1&project=2`) come from arrays. */
export function buildUrl(cfg: SentryConfig, path: string, query?: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
  }
  const q = qs.toString();
  return `${cfg.baseUrl}/api/0${path}${q ? `?${q}` : ""}`;
}

/** One entry of a `Link` header. */
export interface LinkEntry {
  url: string;
  rel: string;
  results?: boolean;
  cursor?: string;
}

/** Parse Sentry's `Link` header (`<url>; rel="next"; results="true"; cursor="0:100:0"`). */
export function parseLink(header: string | null): LinkEntry[] {
  if (!header) return [];
  const out: LinkEntry[] = [];
  for (const m of header.matchAll(/<([^>]*)>((?:\s*;\s*[a-zA-Z_]+\s*=\s*"[^"]*")*)/g)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? "").matchAll(/([a-zA-Z_]+)\s*=\s*"([^"]*)"/g)) attrs[a[1] as string] = a[2] as string;
    const e: LinkEntry = { url: m[1] as string, rel: attrs.rel ?? "" };
    if (attrs.results !== undefined) e.results = attrs.results === "true";
    if (attrs.cursor !== undefined) e.cursor = attrs.cursor;
    out.push(e);
  }
  return out;
}

/** The next page's cursor, or "" when the `Link` header says there are no more results. */
export function nextCursor(header: string | null): string {
  const next = parseLink(header).find((e) => e.rel === "next");
  if (!next || next.results === false) return "";
  if (next.cursor) return next.cursor;
  try {
    return new URL(next.url, "http://x").searchParams.get("cursor") ?? "";
  } catch {
    return "";
  }
}

interface Window {
  remaining: number;
  resetMs: number;
}
/** Last rate-limit readings per origin (module-level: one worker process, many scans). */
const windows = new Map<string, Window>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait after a 429: Retry-After seconds, else until X-Sentry-Rate-Limit-Reset (epoch s). */
export function resetDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After");
  if (retry && /^\d+(\.\d+)?$/.test(retry)) return Math.ceil(Number(retry) * 1000);
  const reset = headers.get("X-Sentry-Rate-Limit-Reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now) + 100;
  return undefined;
}

function noteWindow(origin: string, headers: Headers): void {
  const remaining = headers.get("X-Sentry-Rate-Limit-Remaining");
  const reset = headers.get("X-Sentry-Rate-Limit-Reset");
  if (remaining && /^\d+$/.test(remaining) && reset && /^\d+$/.test(reset)) {
    windows.set(origin, { remaining: Number(remaining), resetMs: Number(reset) * 1000 });
  }
}

async function waitForWindow(origin: string): Promise<void> {
  const w = windows.get(origin);
  if (w && w.remaining <= 1 && w.resetMs > Date.now()) {
    const wait = Math.min(w.resetMs - Date.now() + 100, MAX_RATE_WAIT_MS);
    log.info(`sentry: rate-limit window nearly exhausted; waiting ${wait} ms for reset`);
    windows.delete(origin);
    await sleep(wait);
  }
}

export interface SentryResponse {
  body: unknown;
  headers: Headers;
}

/**
 * GET one Sentry API resource. `path` is relative to `/api/0` (`/organizations/`);
 * `query` values that are arrays repeat the parameter.
 */
export async function sentryGet(
  cfg: SentryConfig,
  path: string,
  query?: Record<string, QueryValue>,
): Promise<SentryResponse> {
  const url = buildUrl(cfg, path, query);
  assertSameOrigin(cfg, url);
  const origin = new URL(cfg.baseUrl).origin;

  for (let attempt = 1; ; attempt++) {
    await waitForWindow(origin);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${cfg.token}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new SentryError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    noteWindow(origin, res.headers);
    if (res.ok) {
      const text = await res.text();
      return { body: text ? JSON.parse(text) : null, headers: res.headers };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new SentryError(
        `GET ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`,
        res.status,
      );
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(resetDelayMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.debug(`sentry: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Sentry errors are `{"detail": "..."}`; keep the message short. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail && typeof j.detail === "object") return JSON.stringify(j.detail).slice(0, 300);
    return text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Show the path + query of a URL in errors (the token is a header, never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
