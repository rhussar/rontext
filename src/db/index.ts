import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { DemoReadOnlyError, isDemo } from "@/lib/demo";

function createDb() {
  const sql = neon(process.env.DATABASE_URL!);
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Every way a Drizzle instance can write through the builder API. `select`,
 * `query`, `$count` and friends pass through untouched. Blocking at property
 * access (not call) is deliberate: `db.insert(t).values(…)` never gets as far
 * as building a query. `execute` is handled separately below — the codebase
 * uses it for raw *reads* on hot paths, so it gets inspected, not banned.
 */
const WRITE_ENTRY_POINTS = new Set([
  "insert",
  "update",
  "delete",
  "transaction",
  "batch",
  "refreshMaterializedView",
]);

const READ_STATEMENT = /^\s*(select|with|explain)\b/i;
/** Word-bounded, so `updated_at` / `created_at` column names don't trip it. */
const WRITE_KEYWORD = /\b(insert|update|delete|truncate|alter|drop|create|grant|merge|copy)\b/i;

/**
 * Raw SQL is allowed through only when it reads. A CTE can hide a write
 * (`with x as (delete …)`), hence the second, keyword check on the whole text.
 */
function assertReadOnlySql(db: Db, query: SQLWrapper | string) {
  const text =
    typeof query === "string"
      ? query
      : (db as unknown as { dialect: PgDialect }).dialect.sqlToQuery(query as SQL).sql;
  if (!READ_STATEMENT.test(text) || WRITE_KEYWORD.test(text)) {
    throw new DemoReadOnlyError();
  }
}

/**
 * The read-only view handed out in demo mode. Methods are bound to the real
 * instance so Drizzle's internal `this.session` / `this.dialect` lookups
 * bypass the proxy entirely — only the first property access is inspected.
 */
function readOnly(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_ENTRY_POINTS.has(prop)) {
        throw new DemoReadOnlyError();
      }
      if (prop === "execute") {
        return (query: SQLWrapper | string) => {
          assertReadOnlySql(target, query);
          return target.execute(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let _db: Db | null = null;
let _readOnly: Db | null = null;

/**
 * The real, writable instance. The only legitimate caller outside this file
 * is scripts/seed-demo.ts, which has to write the demo database that every
 * request path must treat as read-only. Do not reach for this from app code.
 */
export function getUnguardedDb(): Db {
  if (!_db) _db = createDb();
  return _db;
}

export function getDb(): Db {
  if (!isDemo()) return getUnguardedDb();
  if (!_readOnly) _readOnly = readOnly(getUnguardedDb());
  return _readOnly;
}
