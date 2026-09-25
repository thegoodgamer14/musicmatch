import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite, Transaction } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);

export interface Db {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

const INTEGER_OIDS = new Set([20, 21, 23]);

type Field = { name: string; type: number };

function coerceInteger(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return value;
}

function normalizeRows<T extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[],
  fields: readonly Field[],
): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    const names = fields.length > 0 ? fields.map((field) => field.name) : Object.keys(row);
    for (const name of names) out[name] = row[name];
    for (const field of fields) {
      if (!INTEGER_OIDS.has(field.type)) continue;
      out[field.name] = coerceInteger(out[field.name]);
    }
    return out as T;
  });
}

type PostgresRows = Array<Record<string, unknown>> & {
  columns: { name: string; type: number }[] | null;
};

type PostgresQueryable = {
  unsafe(query: string, parameters?: unknown[]): Promise<PostgresRows>;
  begin?<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
  savepoint?<T>(fn: (tx: PostgresQueryable) => Promise<T>): Promise<T>;
};

async function queryPostgres<T extends Record<string, unknown>>(
  sql: PostgresQueryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await sql.unsafe(text, params);
  const fields = (rows.columns ?? []).map((column) => ({ name: column.name, type: column.type }));
  return normalizeRows<T>(rows, fields);
}

function wrapPostgres(sql: PostgresQueryable): Db {
  return {
    query: (text, params) => queryPostgres(sql, text, params),
    async one<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | undefined> {
      const rows = await queryPostgres<T>(sql, text, params);
      return rows[0];
    },
    async exec(text, params = []) {
      await sql.unsafe(text, params);
    },
    transaction(fn) {
      if (sql.begin) return sql.begin((tx) => fn(wrapPostgres(tx)));
      if (!sql.savepoint) throw new Error("Nested transactions are not available");
      return sql.savepoint((tx) => fn(wrapPostgres(tx)));
    },
  };
}

type PgliteQueryable = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] }>;
  exec(sql: string): Promise<unknown>;
  transaction?<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
};

async function queryPglite<T extends Record<string, unknown>>(
  client: PgliteQueryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query(text, params);
  const fields = result.fields.map((field) => ({ name: field.name, type: field.dataTypeID }));
  return normalizeRows<T>(result.rows, fields);
}

function wrapPglite(client: PgliteQueryable, nested: boolean): Db {
  const db: Db = {
    query: (text, params) => queryPglite(client, text, params),
    async one<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | undefined> {
      const rows = await queryPglite<T>(client, text, params);
      return rows[0];
    },
    async exec(text, params = []) {
      if (params.length > 0) {
        await client.query(text, params);
        return;
      }
      await client.exec(text);
    },
    async transaction(fn) {
      if (!nested && client.transaction) {
        return client.transaction(async (tx) => fn(wrapPglite(tx, true)));
      }
      await client.exec("SAVEPOINT musicmatch_tx");
      try {
        const result = await fn(db);
        await client.exec("RELEASE SAVEPOINT musicmatch_tx");
        return result;
      } catch (error) {
        await client.exec("ROLLBACK TO SAVEPOINT musicmatch_tx");
        throw error;
      }
    },
  };
  return db;
}

const bigintAsNumber = {
  to: 20,
  from: [20],
  parse: (value: string) => Number(value),
  serialize: (value: number | bigint | string) => String(value),
};

let singleton: Db | null = null;

export function getDb(): Db {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing required environment: DATABASE_URL");
  const postgres = require("postgres") as (
    url: string,
    options: { prepare: boolean; types: { bigint: typeof bigintAsNumber } },
  ) => PostgresQueryable;
  singleton = wrapPostgres(postgres(url, { prepare: false, types: { bigint: bigintAsNumber } }));
  return singleton;
}

export async function openTestDatabase(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg: PGlite = new PGlite();
  const migration = readFileSync(
    join(process.cwd(), "supabase/migrations/20260925120000_musicmatch.sql"),
    "utf8",
  );
  await pg.exec(migration);
  return wrapPglite(pg, false);
}
