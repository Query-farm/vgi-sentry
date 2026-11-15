/**
 * Assemble the `sentry` catalog: the table functions, the organizations table, and
 * the `sentry` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { SECRET_TYPE } from "./sentry/client.ts";
import { discover } from "./sentry/discover.ts";
import { ISSUE_FUNCTIONS, ISSUE_TABLES } from "./sentry/issues.ts";
import { OPS_FUNCTIONS } from "./sentry/ops.ts";

export const FUNCTIONS: VgiFunction[] = [...ISSUE_FUNCTIONS, discover, ...OPS_FUNCTIONS];
export const TABLES = ISSUE_TABLES;

const meta = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE sentry, AUTH_TOKEN 'sntrys_…', REGION 'de' | BASE_URL '…', ORGANIZATION '…'). */
export const SENTRY_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "A Sentry auth token plus the host (sentry.io, a us / de region, or self-hosted) and default organization",
  schema: schema(
    [
      field(
        "auth_token",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          [
            "vgi_doc",
            "Sentry auth token: an organization token (sntrys_…), a user token (sntryu_…) or an internal integration token, with read scopes (org:read, project:read, event:read, member:read, team:read, alerts:read).",
          ],
        ]),
      ),
      field(
        "base_url",
        utf8(),
        true,
        meta(
          "Sentry host: https://sentry.io (default) or a self-hosted URL. http:// is accepted only for 127.0.0.1/localhost.",
        ),
      ),
      field("region", utf8(), true, meta("Data-residency region of a sentry.io organization: us or de (used when BASE_URL is not set).")),
      field("organization", utf8(), true, meta("Default organization slug for functions called without organization :=.")),
    ],
    new Map([["vgi_doc_url", "https://docs.sentry.io/account/auth-tokens/"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
  ...stampExampleQueries(FUNCTIONS),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [SENTRY_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};
