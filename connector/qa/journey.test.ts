// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { QAEnvironment, QAFlow } from '../../src/lib/qa/types.ts';
import { buildQaPrompt, parseQaReply } from './generator.ts';
import { runFlow } from './runner.ts';

const env: QAEnvironment = { id: 'dev', name: 'Dev', baseUrl: 'https://api.dev.test', services: {}, headers: {}, variables: {}, auth: { type: 'none' }, readOnly: false, timeoutMs: 5_000 };

const create: QAFlow = {
  id: 'f1', name: 'Create promo', stage: '1. Buat data promo (CMS)', description: '', category: 'happy-path', taskTitles: [], enabled: true,
  steps: [{ id: 's1', name: 'create', request: { method: 'POST', path: '/v1/cms/promo', body: {} }, extract: { promoUuid: '$.data.uuid' }, assertions: [{ type: 'status', op: 'equals', expected: 201 }] }],
};
const reserve: QAFlow = {
  id: 'f2', name: 'Reserve promo', stage: '3. Transaksi', description: '', category: 'happy-path', taskTitles: [], enabled: true,
  dataQueries: [{ name: 'promoUuid', db: 'promo', sql: "SELECT uuid FROM promo WHERE status = 'ACTIVE' LIMIT 1" }],
  steps: [{ id: 's2', name: 'reserve', request: { method: 'POST', path: '/v1/promo/{{promoUuid}}/reserve', body: {} }, assertions: [{ type: 'status', op: 'equals', expected: 200 }] }],
};

describe('journey across flows', () => {
  it('passes values extracted by an earlier flow to the next one, without querying the database', async () => {
    const urls: string[] = [];
    let queried = 0;
    const fetch = (async (url: string) => (urls.push(url), new Response(JSON.stringify({ data: { uuid: 'new-promo-1' } }), { status: url.endsWith('/promo') ? 201 : 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof globalThis.fetch;
    const carried = { values: {}, from: {} };
    const ctx = { env, fetch, carried, query: async () => (queried++, { db: 'promo', sql: '', columns: ['uuid'], rows: [['old-promo']], rowCount: 1, durationMs: 1 }) };
    await runFlow(create, 0, ctx);
    const r = await runFlow(reserve, 1, ctx);
    expect(urls[1]).toBe('https://api.dev.test/v1/promo/new-promo-1/reserve');
    expect(queried).toBe(0);
    expect(r.dataQueries?.[0]).toMatchObject({ ok: true, value: 'new-promo-1', reusedFrom: 'Create promo' });
  });

  it('falls back to the database when a flow runs alone', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => (urls.push(url), new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof globalThis.fetch;
    await runFlow(reserve, 0, { env, fetch, query: async () => ({ db: 'promo', sql: '', columns: ['uuid'], rows: [['old-promo']], rowCount: 1, durationMs: 1 }) });
    expect(urls[0]).toBe('https://api.dev.test/v1/promo/old-promo/reserve');
  });

  it('asks for journey order with stages and keeps the stage of each flow', () => {
    const prompt = buildQaPrompt({ projectId: 'p', projectName: 'Promo', ai: { provider: 'claude', model: '' }, tasks: [{ title: 'Create promo', spec: 'POST /cms/promo' }], categories: ['happy-path'] });
    expect(prompt).toContain('URUTAN FLOW = URUTAN JOURNEY BISNIS');
    expect(prompt).toContain('"stage"');
    const { flows } = parseQaReply(JSON.stringify({ flows: [{ name: 'Create', stage: '1. Buat data promo (CMS)', steps: [{ name: 'c', request: { method: 'POST', path: '/cms/promo' } }] }] }), ['Create promo']);
    expect(flows[0].stage).toBe('1. Buat data promo (CMS)');
  });
});
