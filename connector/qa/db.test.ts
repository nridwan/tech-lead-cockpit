// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QADbResult, QAEnvironment, QAFlow } from '../../src/lib/qa/types.ts';
import { assertReadOnlySql, firstValue } from './db.ts';
import { buildQaPrompt, parseQaReply } from './generator.ts';
import { QaManager } from './manager.ts';
import { checkDbAssertion, runFlow } from './runner.ts';

const result = (columns: string[], rows: (string | null)[][]): QADbResult => ({ db: 'promo', sql: 'SELECT 1', columns, rows, rowCount: rows.length, durationMs: 3 });

describe('read-only SQL guard', () => {
  it('accepts one SELECT (also WITH, comments, keywords inside strings)', () => {
    expect(assertReadOnlySql("SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1;")).toBe("SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1");
    expect(assertReadOnlySql('WITH a AS (SELECT 1 AS x) SELECT x FROM a')).toContain('WITH');
    expect(assertReadOnlySql("SELECT note FROM logs WHERE note = 'please delete; drop table x' -- update later")).toContain('SELECT');
  });

  it('refuses anything that could change data', () => {
    for (const sql of [
      'DELETE FROM promos',
      'UPDATE promos SET status = 1',
      "INSERT INTO promos VALUES (1)",
      'DROP TABLE promos',
      'TRUNCATE promos',
      'SELECT 1; DELETE FROM promos',
      'WITH d AS (DELETE FROM promos RETURNING id) SELECT * FROM d',
      'SELECT * INTO backup FROM promos',
      'EXPLAIN ANALYZE SELECT 1',
      'SELECT 1 FOR UPDATE',
      '',
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow();
    }
  });

  it('reads the first value by column', () => {
    const r = result(['id', 'status'], [['p-1', 'ACTIVE']]);
    expect(firstValue(r)).toBe('p-1');
    expect(firstValue(r, 'STATUS')).toBe('ACTIVE');
    expect(firstValue(result(['id'], []))).toBeUndefined();
  });

  it('checks data: exists / not_exists on rows, other operators on a column', () => {
    const a = (op: 'exists' | 'not_exists' | 'equals', expected?: unknown, column?: string) => ({ type: 'db' as const, db: 'promo', sql: 'SELECT 1', op, expected, column });
    expect(checkDbAssertion(a('exists'), result(['x'], [['1']])).passed).toBe(true);
    expect(checkDbAssertion(a('not_exists'), result(['x'], [['1']])).passed).toBe(false);
    expect(checkDbAssertion(a('equals', 'RESERVED', 'status'), result(['id', 'status'], [['r1', 'RESERVED']])).passed).toBe(true);
    expect(checkDbAssertion(a('equals', 2, 'qty'), result(['qty'], [['2']])).passed).toBe(true);
  });
});

const env: QAEnvironment = { id: 'dev', name: 'Dev', baseUrl: 'https://api.dev.test', services: {}, headers: {}, variables: {}, auth: { type: 'none' }, readOnly: false, timeoutMs: 5_000, databases: [{ name: 'promo', host: 'db.dev.test', port: 5432, database: 'promo', user: 'ro' }] };

const flow: QAFlow = {
  id: 'f1',
  name: 'Reserve promo',
  description: '',
  category: 'happy-path',
  taskTitles: [],
  enabled: true,
  dataQueries: [{ name: 'promoId', db: 'promo', sql: "SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1" }],
  steps: [
    {
      id: 's1',
      name: 'Reserve',
      request: { method: 'POST', path: '/v1/promos/{{promoId}}/reserve', body: { promoId: '{{promoId}}' } },
      extract: { reservationId: '$.data.id' },
      assertions: [
        { type: 'status', op: 'equals', expected: 200 },
        { type: 'db', db: 'promo', sql: "SELECT status FROM reservations WHERE id = '{{reservationId}}'", column: 'status', op: 'equals', expected: 'RESERVED' },
      ],
    },
  ],
};

describe('runner with a database', () => {
  it('fills variables from real data before the first request and checks data after it', async () => {
    const queries: string[] = [];
    const urls: string[] = [];
    const r = await runFlow(flow, 0, {
      env,
      fetch: (async (url: string) => (urls.push(url), new Response(JSON.stringify({ data: { id: 'res-9' } }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch,
      query: async (_db, sql) => (queries.push(sql), sql.includes('promos') ? result(['id'], [['promo-42']]) : result(['status'], [['RESERVED']])),
    });
    expect(urls[0]).toBe('https://api.dev.test/v1/promos/promo-42/reserve');
    expect(queries[1]).toContain("id = 'res-9'");
    expect(r.status).toBe('passed');
    expect(r.dataQueries?.[0]).toMatchObject({ kind: 'data', ok: true, value: 'promo-42' });
    expect(r.steps[0].dbChecks?.[0]).toMatchObject({ kind: 'check', ok: true });
  });

  it('stops the flow without sending requests when real data is missing', async () => {
    let sent = 0;
    const r = await runFlow(flow, 0, { env, fetch: (async () => (sent++, new Response('{}'))) as unknown as typeof fetch, query: async () => result(['id'], []) });
    expect(sent).toBe(0);
    expect(r.status).toBe('error');
    expect(r.dataQueries?.[0].error).toContain('tidak mengembalikan data');
    expect(r.steps[0].error).toContain('{{promoId}}');
  });
});

describe('generator with a database', () => {
  it('puts the schema in the prompt and keeps only read-only queries from the AI', () => {
    const prompt = buildQaPrompt({ projectId: 'p', projectName: 'Promo', ai: { provider: 'claude', model: '' }, tasks: [{ title: 'Reserve', spec: 'POST /reserve' }], categories: ['happy-path'], databases: [{ name: 'promo', schema: 'promos(id uuid, status text)' }] });
    expect(prompt).toContain('## Database (HANYA BACA)');
    expect(prompt).toContain('promos(id uuid, status text)');
    const reply = JSON.stringify({
      flows: [
        {
          name: 'Reserve',
          dataQueries: [
            { name: 'promoId', db: 'promo', sql: "SELECT id FROM promos WHERE status='ACTIVE' LIMIT 1" },
            { name: 'bad', db: 'promo', sql: 'DELETE FROM promos' },
          ],
          steps: [{ name: 'Reserve', request: { method: 'POST', path: '/reserve' }, assertions: [{ type: 'db', db: 'promo', sql: 'UPDATE promos SET x=1', op: 'exists' }, { type: 'db', db: 'promo', sql: 'SELECT 1 FROM promos', op: 'exists' }] }],
        },
      ],
    });
    const { flows } = parseQaReply(reply, ['Reserve']);
    expect(flows[0].dataQueries).toEqual([{ name: 'promoId', db: 'promo', sql: "SELECT id FROM promos WHERE status='ACTIVE' LIMIT 1" }]);
    expect(flows[0].steps[0].assertions.filter((a) => a.type === 'db')).toHaveLength(1);
  });
});

describe('QaManager databases', () => {
  let dir = '';
  const secrets = new Map<string, string>();
  const seen: { password?: string; sql: string }[] = [];
  let prompt = '';
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async (k) => secrets.get(k) ?? null,
      writeSecret: async (k, v) => (secrets.set(k, v), true),
      deleteSecret: async (k) => secrets.delete(k),
      runAi: (_ai, p) => ((prompt = p), { done: Promise.resolve({ reply: '{"flows":[{"name":"x","steps":[{"name":"s","request":{"method":"GET","path":"/x"}}]}]}' }), cancel: () => {} }),
      db: {
        query: async (_d, password, sql) => (seen.push({ password, sql }), result(['x'], [['1']])),
        schema: async (_d, password) => `promos(id uuid) [pw:${password ? 'yes' : 'no'}]`,
        test: async () => 'PostgreSQL 16.2',
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-db-'));
    secrets.clear();
    seen.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('stores database passwords in the Keychain only, tests the connection and reads the schema for generation', async () => {
    const m = manager();
    const [saved] = await m.saveEnvironment({ ...env, id: '' }, undefined, undefined, { promo: 's3cret' });
    expect(saved.databases?.[0]).toMatchObject({ name: 'promo', host: 'db.dev.test' });
    expect(saved.dbPasswords).toEqual({ promo: true });
    expect(secrets.get(`${saved.id}:db:promo`)).toBe('s3cret');
    expect(await readFile(join(dir, 'environments.json'), 'utf8')).not.toContain('s3cret');
    expect(await m.testDatabase(saved.id, 'promo')).toBe('PostgreSQL 16.2');

    const job = await m.generate({ projectId: 'proj', projectName: 'P', ai: { provider: 'claude', model: '' }, tasks: [{ title: 't', spec: 's' }], categories: ['happy-path'], environmentId: saved.id });
    expect(job.status).toBeDefined();
    expect(prompt).toContain('promos(id uuid) [pw:yes]');
    expect(prompt).not.toContain('s3cret');

    // Removing the database removes its password.
    await m.saveEnvironment({ ...saved, databases: [] });
    expect(secrets.has(`${saved.id}:db:promo`)).toBe(false);
  });

  it('rejects an invalid database definition', async () => {
    await expect(manager().saveEnvironment({ ...env, id: '', databases: [{ name: 'bad name', host: 'h', port: 5432, database: 'd', user: 'u' }] })).rejects.toThrow('tidak valid');
    await expect(manager().saveEnvironment({ ...env, id: '', databases: [{ name: 'promo', host: 'h', port: 5432, database: '', user: 'u' }] })).rejects.toThrow('wajib');
  });
});
