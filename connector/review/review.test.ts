// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import { sameReviewScope, type ReviewJob, type StartReviewRequest } from '../../src/lib/review/types.ts';
import { AgentTaskStore, type AgentTask } from '../agent-tasks.ts';
import { connectorMiddleware } from '../dev-connector.ts';
import { reviewSummary, syncReviewJob } from './agent-sync.ts';
import { MAX_LIVE_REVIEWS, ReviewManager, type ReviewDeps } from './manager.ts';

const AI: AiSelection = { provider: 'claude', model: 'sonnet' };
const REVIEW = '## Ringkasan Perubahan\nTambah endpoint refund.\n\n## Kesimpulan\n**REQUEST CHANGES** — refund belum idempotent.';

const request = (over: Partial<StartReviewRequest> = {}): StartReviewRequest => ({
  kind: 'mr',
  mr: { ref: 'payments/core!12', webUrl: 'https://git.example.test/payments/core/-/merge_requests/12', title: 'Refund endpoint', headSha: 'abc1234', jiraKeys: ['PAY-7', 'bad key'] },
  prompt: 'Review merge request ini.',
  context: 'MR: payments/core!12\n### refund.go\n```diff\n+func Refund() {}\n```',
  strictness: 'strict',
  ai: AI,
  ...over,
});

type Outcome = { reply: string; error?: string };

describe('ReviewManager', () => {
  let dir = '';
  let store: AgentTaskStore;
  let resolvers: ((v: Outcome) => void)[];
  let calls: { prompt: string; systemPrompt: string; timeoutMs: number }[];
  let cancelled = 0;

  const manager = (over: Partial<ReviewDeps> = {}) =>
    new ReviewManager({
      dir: join(dir, 'reviews'),
      runAi: (_ai, prompt, opts) => {
        calls.push({ prompt, systemPrompt: opts.systemPrompt, timeoutMs: opts.timeoutMs });
        opts.onEvent({ kind: 'tool', text: 'Membaca diff refund.go' });
        opts.onEvent({ kind: 'text', text: 'Ringkasan…' });
        const done = new Promise<Outcome>((r) => resolvers.push(r));
        return { done, cancel: () => (cancelled++, resolvers.shift()?.({ reply: '', error: 'killed' })) };
      },
      sink: (job) => syncReviewJob(store, job),
      ...over,
    });

  async function settle(m: ReviewManager, id: string): Promise<ReviewJob> {
    for (let i = 0; i < 500; i++) {
      const j = await m.get(id);
      if (!m.isBusy() && j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('review did not settle');
  }

  const nextRun = async () => {
    for (let i = 0; i < 500 && !resolvers.length; i++) await new Promise((r) => setTimeout(r, 5));
    return resolvers.shift()!;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-review-'));
    store = new AgentTaskStore({ dir: join(dir, 'agent-tasks') });
    resolvers = [];
    calls = [];
    cancelled = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('runs the code-review prompt in the background and lists it as a review task', async () => {
    const m = manager();
    const started = await m.start(request());
    expect(started.status).toBe('running');
    expect(started.mr.jiraKeys).toEqual(['PAY-7']);

    // Same prompt shape as the inline review: diff block, then the instruction; strictness in the system prompt.
    expect(calls[0].prompt).toContain('### KODE / DIFF YANG DIREVIEW:');
    expect(calls[0].prompt.trim().endsWith('Review merge request ini.')).toBe(true);
    expect(calls[0].systemPrompt).toContain('Code Review');
    expect(calls[0].systemPrompt).toContain('SANGAT KETAT');
    expect(calls[0].timeoutMs).toBeGreaterThan(120_000);

    const [running] = await store.list();
    expect(running).toMatchObject({ kind: 'review', runner: 'local', status: 'running', title: '[Review MR] payments/core!12: Refund endpoint' });
    expect(running.links).toMatchObject({ reviewId: started.id, mrUrl: request().mr.webUrl, jiraKey: 'PAY-7' });

    (await nextRun())({ reply: REVIEW });
    const done = await settle(m, started.id);
    expect(done).toMatchObject({ status: 'done', reply: REVIEW, agentTaskId: running.id });
    expect(done.events.map((e) => e.kind)).toEqual(['tool', 'text']);
    const [task] = await store.list();
    expect(task.status).toBe('completed');
    expect(task.progress?.message).toBe('REQUEST CHANGES — refund belum idempotent.');
  });

  it('records a failed run and an empty answer as failed tasks', async () => {
    const m = manager();
    const a = await m.start(request());
    (await nextRun())({ reply: '', error: 'Claude CLI tidak ditemukan.' });
    expect(await settle(m, a.id)).toMatchObject({ status: 'error', error: 'Claude CLI tidak ditemukan.' });

    const b = await m.start(request());
    (await nextRun())({ reply: '   ' });
    expect((await settle(m, b.id)).error).toContain('tidak mengembalikan');
    const tasks = await store.list();
    expect(tasks.map((t) => t.status)).toEqual(['failed', 'failed']);
    expect(tasks[0].error).toBe('Claude CLI tidak ditemukan.');
  });

  it('refuses the same review twice while it runs, but allows another TAD task of the same MR', async () => {
    const m = manager();
    const first = await m.start(request());
    await expect(m.start(request())).rejects.toMatchObject({ status: 409 });
    const tad = await m.start(request({ kind: 'tad', task: { draftId: 'draft-1', title: 'API refund', tadTitle: 'TAD Refund' } }));
    expect(tad.task).toEqual({ draftId: 'draft-1', title: 'API refund', tadTitle: 'TAD Refund' });
    expect(tad.strictness).toBeUndefined();
    await expect(m.start(request({ kind: 'tad', task: { draftId: 'draft-1', title: 'API refund' } }))).rejects.toMatchObject({ status: 409 });

    const tadTask = (await store.list()).find((t) => t.links?.reviewId === tad.id)!;
    expect(tadTask.title).toBe('[Cek TAD] payments/core!12 · API refund');
    expect(tadTask.links).toMatchObject({ draftId: 'draft-1', taskTitle: 'API refund', tadTitle: 'TAD Refund' });

    while (resolvers.length < 2) await new Promise((r) => setTimeout(r, 5));
    resolvers.splice(0).forEach((r) => r({ reply: REVIEW }));
    await settle(m, first.id);
    await settle(m, tad.id);
  });

  it('caps the number of reviews running at once', async () => {
    const m = manager();
    for (let i = 0; i < MAX_LIVE_REVIEWS; i++) await m.start(request({ mr: { ...request().mr, webUrl: `https://git.example.test/x/-/merge_requests/${i}` } }));
    await expect(m.start(request())).rejects.toMatchObject({ status: 409 });
    while (resolvers.length < MAX_LIVE_REVIEWS) await new Promise((r) => setTimeout(r, 5));
    resolvers.splice(0).forEach((r) => r({ reply: REVIEW }));
    for (let i = 0; i < 200 && m.isBusy(); i++) await new Promise((r) => setTimeout(r, 5));
  });

  it('cancels a running review', async () => {
    const m = manager();
    const job = await m.start(request());
    await nextRun().then((r) => resolvers.unshift(r)); // wait until the AI runs
    await m.cancel(job.id);
    expect(cancelled).toBe(1);
    expect(await settle(m, job.id)).toMatchObject({ status: 'cancelled', error: 'Dibatalkan.' });
    expect((await store.list())[0].status).toBe('cancelled');
  });

  it('closes a review left running by a restart', async () => {
    const m = manager();
    const job = await m.start(request());
    const fresh = manager(); // new process: no live job
    const after = await fresh.get(job.id);
    expect(after.status).toBe('error');
    expect(after.error).toContain('dimulai ulang');
    expect((await store.list())[0].status).toBe('failed');
    (await nextRun())({ reply: REVIEW });
    for (let i = 0; i < 200 && m.isBusy(); i++) await new Promise((r) => setTimeout(r, 5));
  });

  it('lists the reviews of one MR, newest first', async () => {
    const m = manager();
    const a = await m.start(request());
    (await nextRun())({ reply: REVIEW });
    await settle(m, a.id);
    const other = await m.start(request({ mr: { ...request().mr, webUrl: 'https://git.example.test/other/-/merge_requests/1' } }));
    (await nextRun())({ reply: REVIEW });
    await settle(m, other.id);
    await new Promise((r) => setTimeout(r, 5));
    const b = await m.start(request());
    (await nextRun())({ reply: REVIEW });
    await settle(m, b.id);

    expect((await m.list({ mrUrl: request().mr.webUrl })).map((j) => j.id)).toEqual([b.id, a.id]);
    expect(await m.list()).toHaveLength(3);
    expect((await readdir(join(dir, 'reviews'))).every((n) => n.endsWith('.json'))).toBe(true);
  });

  it('validates input', async () => {
    const m = manager();
    await expect(m.start(request({ kind: 'x' as 'mr' }))).rejects.toThrow('Jenis');
    await expect(m.start(request({ ai: { provider: 'nope', model: '' } as unknown as AiSelection }))).rejects.toThrow('AI');
    await expect(m.start(request({ prompt: '  ' }))).rejects.toThrow('wajib');
    await expect(m.start(request({ context: 'x'.repeat(260_000) }))).rejects.toThrow('maksimal');
    await expect(m.start(request({ mr: { ...request().mr, webUrl: 'javascript:alert(1)' } }))).rejects.toThrow('URL');
    await expect(m.start(request({ mr: { ...request().mr, headSha: 'zz' } }))).rejects.toThrow('SHA');
    await expect(m.start(request({ kind: 'tad' }))).rejects.toThrow('Task TAD');
    await expect(m.start(request({ strictness: 'brutal' as 'strict' }))).rejects.toThrow('ketelitian');
    await expect(m.get('../x')).rejects.toThrow('tidak valid');
    await expect(m.get('nope')).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
  });
});

describe('review task sync', () => {
  it('summarizes the conclusion section for the task card', () => {
    expect(reviewSummary(REVIEW)).toBe('REQUEST CHANGES — refund belum idempotent.');
    expect(reviewSummary('Semua aman.')).toBe('Semua aman.');
  });

  it('matches jobs to the same check', () => {
    const tad = { kind: 'tad' as const, task: { draftId: 'd', title: 't' } };
    expect(sameReviewScope({ kind: 'mr' }, 'mr')).toBe(true);
    expect(sameReviewScope(tad, 'tad', { draftId: 'd', title: 't' })).toBe(true);
    expect(sameReviewScope(tad, 'tad', { draftId: 'd', title: 'u' })).toBe(false);
    expect(sameReviewScope(tad, 'mr')).toBe(false);
  });

  it('leaves a task alone once it is finished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tlc-review-sync-'));
    try {
      const store = new AgentTaskStore({ dir });
      const job: ReviewJob = {
        id: 'r1',
        kind: 'mr',
        mr: { ref: 'a!1', webUrl: 'https://git.example.test/a/-/merge_requests/1', title: 'A', jiraKeys: [] },
        ai: AI,
        status: 'running',
        events: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const id = await syncReviewJob(store, job);
      await store.cancel(id);
      expect(await syncReviewJob(store, { ...job, agentTaskId: id, status: 'done', reply: REVIEW })).toBe(id);
      expect((await store.get(id))?.status).toBe('cancelled');
      expect((await store.get(id))?.links).toEqual({ reviewId: 'r1', mrUrl: job.mr.webUrl });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe('connector /reviews routes and review tasks in Agent Tasks', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';
  let store: AgentTaskStore;
  const pending: ((v: Outcome) => void)[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-review-routes-'));
    store = new AgentTaskStore({ dir: join(dir, 'tasks') });
    const reviews = new ReviewManager({
      dir: join(dir, 'reviews'),
      runAi: (_ai, _prompt, opts) => {
        opts.onEvent({ kind: 'tool', text: 'Membaca diff' });
        return { done: new Promise((r) => pending.push(r)), cancel: () => pending.shift()?.({ reply: '', error: 'killed' }) };
      },
      sink: (job) => syncReviewJob(store, job),
    });
    const handler = connectorMiddleware({}, {
      readToken: async () => null,
      appendAudit: async () => {},
      readAudit: async () => [],
      logError: () => {},
      agentRuntime: () => ({ store }),
      reviewManager: () => reviews,
    });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    appUrl = await listen(app);
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path: string, json?: unknown) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
    });

  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 500; i++) {
      const v = await fn();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('condition not reached');
  }
  const nextRun = async () => (await until(async () => pending.length, (n) => n > 0), pending.shift()!);
  const taskOf = async (reviewId: string) => (await store.list()).find((t) => t.links?.reviewId === reviewId);

  it('starts a review in the background, lists it in Agent Tasks and returns the result for the MR page', async () => {
    expect((await call('/reviews', { ...request(), ai: 'bad' })).status).toBe(400);
    const res = await call('/reviews', request());
    expect(res.status).toBe(202);
    const job: ReviewJob = await res.json();
    expect(job.status).toBe('running');
    expect((await call('/reviews', request())).status).toBe(409);

    const list = await (await call('/agent-tasks')).json();
    const task = list.tasks.find((t: AgentTask) => t.links?.reviewId === job.id);
    expect(task).toMatchObject({ kind: 'review', runner: 'local', status: 'running' });

    // Only cancel is offered from Agent Tasks; a review is rerun from the MR page.
    expect((await call(`/agent-tasks/${task.id}/steer`, { message: 'lagi' })).status).toBe(409);

    (await nextRun())({ reply: REVIEW });
    await until(() => taskOf(job.id), (t) => t?.status === 'completed');

    const detail = await (await call(`/agent-tasks/${task.id}`)).json();
    expect(detail.review).toMatchObject({ id: job.id, status: 'done', reply: REVIEW });
    expect(detail.events).toEqual([expect.objectContaining({ event: 'local.tool', data: JSON.stringify('Membaca diff') })]);

    const forMr: ReviewJob[] = await (await call(`/reviews?${new URLSearchParams({ mrUrl: request().mr.webUrl })}`)).json();
    expect(forMr.map((j) => j.id)).toEqual([job.id]);
    expect((await (await call(`/reviews/one?id=${job.id}`)).json()).reply).toBe(REVIEW);
    expect((await call('/reviews?mrUrl=https%3A%2F%2Fother')).status).toBe(200);
    expect(await (await call('/reviews?mrUrl=https%3A%2F%2Fother')).json()).toEqual([]);
  });

  it('cancels from Agent Tasks and from the MR page', async () => {
    const a: ReviewJob = await (await call('/reviews', request())).json();
    await until(async () => pending.length, (n) => n > 0);
    const task = (await taskOf(a.id))!;
    expect((await call(`/agent-tasks/${task.id}/cancel`, {})).status).toBe(200);
    await until(() => taskOf(a.id), (t) => t?.status === 'cancelled');

    const b: ReviewJob = await (await call('/reviews', request())).json();
    await until(async () => pending.length, (n) => n > 0);
    expect((await call('/reviews/cancel', { id: b.id })).status).toBe(200);
    expect((await until(async () => (await call(`/reviews/one?id=${b.id}`)).json(), (j: ReviewJob) => j.status !== 'running')).status).toBe('cancelled');
    expect((await call('/reviews/cancel', { id: '../x' })).status).toBe(400);
    expect((await call('/reviews/one?id=missing')).status).toBe(404);
  });
});
