// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAAgentJob, QAFlow, QAGenerateRequest, QARun } from '../../src/lib/qa/types.ts';
import { QaManager } from './manager.ts';
import { evidenceMentions } from './plan.ts';

const AI = { provider: 'claude' as const, model: '' };

const PLAN = JSON.stringify({
  notes: 'kuota belum jelas',
  variables: [{ name: 'promoUuid', description: 'uuid promo', producedBy: 's1' }],
  stages: [
    {
      id: 's1',
      title: '1. Buat promo',
      goal: 'promo tersimpan',
      taskTitles: ['Create promo'],
      endpoints: [
        { method: 'POST', path: '/v1/cms/promo', service: 'core-promo', evidence: 'core-promo/router/router.go:3' },
        { method: 'GET', path: '/v1/cms/ghost', service: 'core-promo', evidence: 'core-promo/router/router.go:2' },
      ],
      produces: ['promoUuid'],
      consumes: [],
      rules: ['nama wajib unik'],
    },
    {
      id: 's2',
      title: '2. Reserve promo',
      goal: 'kuota berkurang',
      taskTitles: ['Reserve'],
      endpoints: [{ method: 'POST', path: '/v1/promo/{{promoUuid}}/reserve', service: 'core-promo', evidence: 'core-promo/router/router.go:4' }],
      produces: [],
      consumes: ['promoUuid'],
      rules: [],
    },
  ],
});

const flowsReply = (name: string, path: string) =>
  JSON.stringify({ flows: [{ name, category: 'happy-path', steps: [{ name: 'hit', service: 'core-promo', request: { method: 'POST', path } }] }] });

const REQ: QAGenerateRequest = {
  projectId: 'proj',
  projectName: 'Promo',
  ai: AI,
  tasks: [
    { title: 'Create promo', service: 'core-promo', spec: 'POST /v1/cms/promo' },
    { title: 'Reserve', service: 'core-promo', spec: 'POST /reserve' },
  ],
  categories: ['happy-path'],
};

describe('E2E multi-agent pipeline', () => {
  let dir = '';
  let services = '';
  let prompts: string[] = [];
  let reply: (prompt: string) => string;
  let delay: (prompt: string) => number;
  let running = 0;
  let maxRunning = 0;
  let synced: QAAgentJob[] = [];
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async () => null,
      writeSecret: async () => true,
      deleteSecret: async () => true,
      resolveServicesRoot: async () => services,
      agentSink: async (job) => (synced.push({ ...job }), `task-${job.id}`),
      runAi: (_ai, prompt) => {
        prompts.push(prompt);
        running++;
        maxRunning = Math.max(maxRunning, running);
        let cancel = () => {};
        const done = new Promise<{ reply: string; error?: string }>((resolve) => {
          const t = setTimeout(() => resolve({ reply: reply(prompt) }), delay(prompt));
          cancel = () => (clearTimeout(t), resolve({ reply: '', error: 'Dibatalkan.' }));
        }).finally(() => running--);
        return { done, cancel: () => cancel() };
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-pipe-'));
    services = join(dir, 'Services');
    await mkdir(join(services, 'core-promo', 'router'), { recursive: true });
    await writeFile(join(services, 'core-promo', 'router', 'router.go'), ['package router', '// nothing here', 'g.POST("/promo", h.Create)', 'g.POST("/:uuid/reserve", h.Reserve)'].join('\n'));
    prompts = [];
    synced = [];
    running = maxRunning = 0;
    reply = () => PLAN;
    delay = () => 1;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const settle = async (m: QaManager) => {
    for (let i = 0; i < 400; i++) {
      const { pipeline } = await m.getPipeline('proj');
      if (!pipeline.agents.some((a) => a.status === 'running' || a.status === 'queued')) return pipeline;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('pipeline did not settle');
  };

  it('plans the journey, checks each endpoint against the router, then waits for review', async () => {
    const m = manager();
    await m.startPlan({ ...REQ, useCodebase: true });
    const pipeline = await settle(m);
    expect(pipeline.phase).toBe('review');
    const { plan } = await m.getPipeline('proj');
    expect(plan?.stages.map((s) => s.title)).toEqual(['1. Buat promo', '2. Reserve promo']);
    const [create, ghost] = plan!.stages[0].endpoints;
    expect(create.verified).toBe(true);
    // The cited line exists but registers another route.
    expect(ghost.verified).toBe(false);
    expect(plan!.stages[1].endpoints[0].verified).toBe(true);
    expect(prompts[0]).toContain('Create promo');
    // Mirrored into Agent Tasks: queued/running … done.
    expect(synced.at(-1)).toMatchObject({ role: 'plan', status: 'done' });
    expect(synced.some((j) => j.status === 'running')).toBe(true);
  });

  it('writes each stage with its own agent, at most `concurrency` at once, in journey order', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    // A manual flow outside the plan stays.
    await m.saveSuite({ projectId: 'proj', projectName: 'Promo', flows: [{ id: 'manual', name: 'Manual', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [{ id: 'x', name: 'x', request: { method: 'GET', path: '/x' }, assertions: [] }] } as QAFlow], updatedAt: '' });
    // Stage 1 finishes last; the suite still lists it first.
    reply = (p) => (p.includes('FOKUS AGENT INI: tahap "1. Buat promo"') ? flowsReply('Create', '/v1/cms/promo') : flowsReply('Reserve', '/v1/promo/{{promoUuid}}/reserve/extra'));
    delay = (p) => (p.includes('tahap "1. Buat promo"') ? 40 : 5);
    await m.writeFromPlan('proj', { concurrency: 2 });
    await settle(m);
    expect(maxRunning).toBe(2);
    const writers = prompts.slice(1);
    expect(writers).toHaveLength(2);
    expect(writers.find((p) => p.includes('tahap "2. Reserve promo"'))).toContain('Data dari tahap sebelumnya, pakai PERSIS nama ini: {{promoUuid}} (uuid promo)');
    const suite = await m.getSuite('proj');
    expect(suite?.flows.map((f) => [f.name, f.stage])).toEqual([
      ['Create', '1. Buat promo'],
      ['Reserve', '2. Reserve promo'],
      ['Manual', undefined],
    ]);
    // Static check: a step outside the plan's endpoints is flagged.
    expect(suite?.flows[0].warnings).toBeUndefined();
    expect(suite?.flows[1].warnings?.[0]).toContain('tidak ada di peta journey');
  });

  it('rewrites only the chosen stages and keeps the others', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    reply = (p) => (p.includes('tahap "1. Buat promo"') ? flowsReply('Create v1', '/v1/cms/promo') : flowsReply('Reserve v1', '/v1/promo/1/reserve'));
    await m.writeFromPlan('proj', { concurrency: 3 });
    await settle(m);
    reply = () => flowsReply('Reserve v2', '/v1/promo/1/reserve');
    await m.writeFromPlan('proj', { stageIds: ['s2'] });
    await settle(m);
    expect((await m.getSuite('proj'))?.flows.map((f) => f.name)).toEqual(['Create v1', 'Reserve v2']);
  });

  it('refuses a second batch while agents run, and cancels queued agents', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    delay = () => 200;
    const p = await m.writeFromPlan('proj', { concurrency: 1 });
    await expect(m.writeFromPlan('proj')).rejects.toThrow('Masih ada agent E2E');
    for (let i = 0; i < 100 && !p.agents.some((a) => a.status === 'running'); i++) await new Promise((r) => setTimeout(r, 2));
    const queued = p.agents.find((a) => a.status === 'queued')!;
    expect(m.cancelAgent(queued.id)?.status).toBe('cancelled');
    m.cancelPipeline('proj');
    const done = await settle(m);
    expect(done.agents.every((a) => a.status === 'cancelled')).toBe(true);
    expect(prompts).toHaveLength(2); // the planner and the one writer that had started
  });

  it('repairs failed flows: fixes a wrong test, lists a service bug as a suspect', async () => {
    const m = manager();
    const step = (id: string) => ({ id, name: id, service: 'core-promo', request: { method: 'POST', path: '/v1/promo' }, assertions: [{ type: 'status', expected: 200 }] });
    await m.saveSuite({
      projectId: 'proj',
      projectName: 'Promo',
      ai: AI,
      updatedAt: '',
      flows: [
        { id: 'wrong', name: 'Wrong path', description: '', category: 'happy-path', taskTitles: [], enabled: true, stage: '1. Buat promo', steps: [step('a')] },
        { id: 'buggy', name: 'Buggy service', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [step('b')] },
        { id: 'fine', name: 'Fine', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [step('c')] },
      ] as unknown as QAFlow[],
    });
    const runId = randomUUID();
    const result = (flowId: string, status: 'failed' | 'passed') => ({ flowId, name: flowId, category: 'happy-path', taskTitles: [], status, steps: [{ stepId: 'a', name: 'a', status, assertions: [{ passed: status === 'passed', message: 'status 404 ≠ 200' }] }] });
    const run = { id: runId, projectId: 'proj', projectName: 'Promo', environment: { id: 'e', name: 'dev', readOnly: false }, status: 'done', startedAt: new Date().toISOString(), flows: [result('wrong', 'failed'), result('buggy', 'failed'), result('fine', 'passed')], summary: { flows: 3, passedFlows: 1, steps: 3, passedSteps: 1 } };
    await mkdir(join(dir, 'runs', 'proj'), { recursive: true });
    await writeFile(join(dir, 'runs', 'proj', `${runId}.json`), JSON.stringify(run as unknown as QARun));
    reply = (p) =>
      p.includes('"Wrong path"')
        ? JSON.stringify({ verdict: 'fix-test', reason: 'path salah, router pakai /v1/cms/promo', flow: { name: 'Wrong path', category: 'happy-path', steps: [{ id: 'a', name: 'a', request: { method: 'POST', path: '/v1/cms/promo' } }] } })
        : JSON.stringify({ verdict: 'service-bug', reason: 'handler tidak menyimpan', bug: { title: 'Promo tidak tersimpan', detail: 'router.go:3', service: 'core-promo' } });
    const p = await m.repairRun('proj', runId);
    expect(p.agents.map((a) => a.flowId)).toEqual(['wrong', 'buggy']);
    await settle(m);
    const suite = await m.getSuite('proj');
    const fixed = suite!.flows.find((f) => f.id === 'wrong')!;
    expect(fixed.steps[0].request.path).toBe('/v1/cms/promo');
    expect(fixed.stage).toBe('1. Buat promo');
    expect(fixed.repairNote).toContain('Test diperbaiki: path salah');
    expect(suite!.flows.find((f) => f.id === 'buggy')!.steps[0].request.path).toBe('/v1/promo');
    expect(suite!.suspects).toEqual([expect.objectContaining({ flowId: 'buggy', title: 'Promo tidak tersimpan', service: 'core-promo', runId })]);
  });
});

describe('evidenceMentions', () => {
  it('looks for the last static segment of the path near the cited line', () => {
    expect(evidenceMentions('/v1/promo/{{uuid}}/reserve', 'g.POST("/:uuid/reserve", h.Reserve)')).toBe(true);
    expect(evidenceMentions('/v1/promo/{{uuid}}', '  5 ▶ promo := r.Group("/v1/promo")')).toBe(true);
    expect(evidenceMentions('/v1/cms/ghost', 'g.POST("/promo", h.Create)')).toBe(false);
    expect(evidenceMentions('/v1/x', undefined)).toBe(false);
  });
});
