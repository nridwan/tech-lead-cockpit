import pg from 'pg';
import type { QADatabase, QADbResult } from '../../src/lib/qa/types.ts';

/**
 * Read-only PostgreSQL access for E2E tests: real data for test variables and data checks after
 * a request. Two guards: only a single SELECT (or WITH … SELECT / EXPLAIN without ANALYZE) passes
 * the check below, and every query runs in a READ ONLY transaction that is rolled back, so the
 * database refuses any change even if the check were fooled. Results are capped in rows and time.
 */

export class QaDbError extends Error {}

export const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const FORBIDDEN = /\b(insert|update|delete|merge|upsert|drop|truncate|alter|create|grant|revoke|copy|call|do|vacuum|analyze|cluster|reindex|lock|listen|notify|refresh|comment|security|set|reset|discard|prepare|execute|deallocate|into)\b/i;

/** The SQL without comments and string/identifier literals, for keyword checks. */
function skeleton(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''");
}

/** Throws unless `sql` is one read-only statement. Returns it without a trailing semicolon. */
export function assertReadOnlySql(sql: string): string {
  const trimmed = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!trimmed) throw new QaDbError('Query kosong.');
  if (trimmed.length > 10_000) throw new QaDbError('Query terlalu panjang.');
  const bare = skeleton(trimmed).trim();
  if (bare.includes(';')) throw new QaDbError('Hanya satu query yang boleh dijalankan.');
  if (!/^(select|with|explain|table|values)\b/i.test(bare)) throw new QaDbError('Hanya query SELECT yang diizinkan (database hanya baca).');
  if (/^explain\b[\s\S]*\banalyze\b/i.test(bare)) throw new QaDbError('EXPLAIN ANALYZE tidak diizinkan (menjalankan query).');
  const bad = bare.match(FORBIDDEN);
  if (bad) throw new QaDbError(`Kata "${bad[0].toUpperCase()}" tidak diizinkan: database hanya baca.`);
  return trimmed;
}

function client(db: QADatabase, password: string | undefined): pg.Client {
  return new pg.Client({
    host: db.host,
    port: db.port || 5432,
    database: db.database,
    user: db.user,
    password: password || undefined,
    ssl: db.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'tech-lead-cockpit-e2e',
  });
}

/** Runs one read-only query: at most MAX_ROWS rows, values as strings. */
export async function queryReadOnly(db: QADatabase, password: string | undefined, sql: string, maxRows = MAX_ROWS): Promise<QADbResult> {
  const safe = assertReadOnlySql(sql);
  // Cap rows without touching the query's own LIMIT/ORDER BY.
  const capped = /^(select|with|table|values)\b/i.test(skeleton(safe).trim()) ? `SELECT * FROM (${safe}) AS tlc_q LIMIT ${maxRows + 1}` : safe;
  const started = Date.now();
  const c = client(db, password);
  try {
    await c.connect();
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const res = await c.query({ text: capped, rowMode: 'array' });
    await c.query('ROLLBACK').catch(() => {});
    const columns = res.fields.map((f) => f.name);
    const rows = (res.rows as unknown[][]).slice(0, maxRows).map((r) => r.map((v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v))));
    return { db: db.name, sql: safe, columns, rows, rowCount: rows.length, truncated: res.rows.length > maxRows || undefined, durationMs: Date.now() - started };
  } catch (e) {
    throw new QaDbError(`DB "${db.name}": ${(e as Error).message}`);
  } finally {
    await c.end().catch(() => {});
  }
}

/** Connects and reports the server version (the "Tes koneksi" button). */
export async function testConnection(db: QADatabase, password: string | undefined): Promise<string> {
  const r = await queryReadOnly(db, password, 'SELECT version()');
  return String(r.rows[0]?.[0] ?? '').split(',')[0];
}

const MAX_SCHEMA_TABLES = 150;
const MAX_SCHEMA_CHARS = 30_000;

/** Tables and columns (user schemas), compact, for the AI that writes the test queries. */
export async function schemaSummary(db: QADatabase, password: string | undefined): Promise<string> {
  const r = await queryReadOnly(
    db,
    password,
    `SELECT table_schema, table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'
      GROUP BY table_schema, table_name
      ORDER BY table_schema, table_name`,
    MAX_SCHEMA_TABLES,
  );
  const lines = r.rows.slice(0, MAX_SCHEMA_TABLES).map(([schema, table, cols]) => `${schema === 'public' ? '' : `${schema}.`}${table}(${cols})`);
  let out = lines.join('\n');
  if (out.length > MAX_SCHEMA_CHARS) out = `${out.slice(0, MAX_SCHEMA_CHARS)}\n…`;
  return out + (r.truncated ? '\n(… tabel lain tidak ditampilkan)' : '');
}

/** First value of the first row: by column name when given, else the first column. */
export function firstValue(r: QADbResult, column?: string): string | undefined {
  const row = r.rows[0];
  if (!row) return undefined;
  const i = column ? r.columns.findIndex((c) => c.toLowerCase() === column.toLowerCase()) : 0;
  const v = i >= 0 ? row[i] : undefined;
  return v === null || v === undefined ? undefined : v;
}
