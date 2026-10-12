import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAiSelection, type AiSelection } from '../../src/lib/ai/types.ts';
import type { ReviewStrictness } from '../../src/lib/gitlab/types.ts';
import {
  sameReviewScope,
  type ReviewJob,
  type ReviewJobEvent,
  type ReviewJobKind,
  type ReviewJobMr,
  type ReviewJobTask,
  type StartReviewRequest,
} from '../../src/lib/review/types.ts';
import { ASSISTANT_SYSTEM_PROMPTS, STRICTNESS_GUIDELINES, buildAssistantPrompt } from '../assistant.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Background MR reviews under ~/.tech-lead-cockpit/reviews (0700), one JSON file per review. The
 * page sends what it already loaded (MR metadata, diff, instruction); the connector runs the same
 * code-review prompt as the inline review, but with a longer timeout and independent of the page,
 * so the user can leave and come back for the result. Every job is mirrored into Agent Tasks
 * (kind `review`) through `sink`.
 */

const ID = /^[A-Za-z0-9-]{1,64}$/;
const TIMEOUT_MS = 15 * 60_000;
const SYNC_EVERY_MS = 5_000;
const MAX_EVENTS = 200;
const MAX_EVENT_TEXT = 500;
/** Reviews kept on disk; the oldest finished ones are removed beyond this. */
const KEEP = 200;
export const MAX_LIVE_REVIEWS = 4;
export const REVIEW_LIMITS = { prompt: 40_000, context: 250_000, title: 300, ref: 200, url: 500 } as const;

const STRICTNESS = new Set<ReviewStrictness>(['lenient', 'standard', 'strict']);
const JIRA_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const SHA = /^[0-9a-f]{7,64}$/;

export class ReviewInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ReviewDeps {
  dir?: string;
  runAi: (
    ai: AiSelection,
    prompt: string,
    opts: { systemPrompt: string; timeoutMs: number; onEvent: (e: Omit<ReviewJobEvent, 'at'>) => void },
  ) => { done: Promise<{ reply: string; error?: string }>; cancel: () => void };
  /** Mirrors a job into Agent Tasks; returns the agent task id it is listed under. */
  sink?: (job: ReviewJob) => Promise<string | undefined>;
}

interface LiveJob {
  progress?: string;
  events: ReviewJobEvent[];
  cancel?: () => void;
  cancelled?: boolean;
}

function text(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ReviewInputError(`${field} wajib diisi.`);
    return '';
  }
  if (typeof v !== 'string') throw new ReviewInputError(`${field} harus berupa teks.`);
  const out = v.replace(/\u0000/g, '').trim();
  if (out.length > max) throw new ReviewInputError(`${field} maksimal ${max} karakter.`);
  if (required && !out) throw new ReviewInputError(`${field} wajib diisi.`);
  return out;
}

function checkMr(v: unknown): ReviewJobMr {
  if (!v || typeof v !== 'object') throw new ReviewInputError('Data MR wajib diisi.');
  const m = v as Record<string, unknown>;
  const webUrl = text(m.webUrl, 'URL MR', REVIEW_LIMITS.url);
  if (!/^https?:\/\//.test(webUrl)) throw new ReviewInputError('URL MR tidak valid.');
  const headSha = text(m.headSha, 'Head SHA', 64, false);
  if (headSha && !SHA.test(headSha)) throw new ReviewInputError('Head SHA tidak valid.');
  const keys = Array.isArray(m.jiraKeys) ? m.jiraKeys : [];
  return {
    ref: text(m.ref, 'Ref MR', REVIEW_LIMITS.ref),
    webUrl,
    title: text(m.title, 'Judul MR', REVIEW_LIMITS.title, false) || '(tanpa judul)',
    ...(headSha ? { headSha } : {}),
    jiraKeys: keys.filter((k): k is string => typeof k === 'string' && JIRA_KEY.test(k)).slice(0, 20),
  };
}

function checkTask(v: unknown): ReviewJobTask {
  if (!v || typeof v !== 'object') throw new ReviewInputError('Task TAD wajib dipilih untuk cek kesesuaian.');
  const t = v as Record<string, unknown>;
  const tadTitle = text(t.tadTitle, 'Judul TAD', REVIEW_LIMITS.title, false);
  return { draftId: text(t.draftId, 'Draft TAD', 200), title: text(t.title, 'Judul task', REVIEW_LIMITS.title), ...(tadTitle ? { tadTitle } : {}) };
}

export class ReviewManager {
  private readonly dir: string;
  private readonly live = new Map<string, LiveJob>();

  constructor(private readonly deps: ReviewDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'reviews');
  }

  isBusy(): boolean {
    return this.live.size > 0;
  }

  private file(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new ReviewInputError('Id review tidak valid.');
    return join(this.dir, `${id}.json`);
  }

  private async save(job: ReviewJob): Promise<ReviewJob> {
    job.updatedAt = new Date().toISOString();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Atomic: the page polling while a review finishes never sees a half-written file.
    const file = this.file(job.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    return job;
  }

  private async read(id: string): Promise<ReviewJob> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as ReviewJob;
    } catch (e) {
      if (e instanceof ReviewInputError) throw e;
      throw new ReviewInputError('Review tidak ditemukan.', 404);
    }
  }

  /** The saved job plus live progress; a job left running by a restart is closed as failed. */
  async get(id: string): Promise<ReviewJob> {
    const job = await this.read(id);
    if (job.status !== 'running') return job;
    const live = this.live.get(job.id);
    if (live) return { ...job, progress: live.progress ?? job.progress, events: [...live.events] };
    job.status = 'error';
    job.error = 'Terhenti karena connector dimulai ulang. Jalankan review lagi.';
    job.progress = undefined;
    job.finishedAt = new Date().toISOString();
    await this.save(job);
    await this.sync(job);
    return job;
  }

  /** Newest first; `mrUrl` narrows to one MR. */
  async list(filter: { mrUrl?: string } = {}): Promise<ReviewJob[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.slice(0, -5)).catch(() => null)));
    return all
      .filter((j): j is ReviewJob => Boolean(j) && (!filter.mrUrl || j!.mr.webUrl === filter.mrUrl))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async sync(job: ReviewJob) {
    if (!this.deps.sink) return;
    const id = await this.deps.sink(job).catch(() => undefined);
    if (id && id !== job.agentTaskId) {
      job.agentTaskId = id;
      const fresh = await this.read(job.id).catch(() => null);
      if (fresh) {
        fresh.agentTaskId = id;
        await this.save(fresh);
      }
    }
  }

  /** Starts a review in the background and returns it as `running`. */
  async start(req: StartReviewRequest): Promise<ReviewJob> {
    if (!req || typeof req !== 'object') throw new ReviewInputError('Body tidak valid.');
    const kind = req.kind as ReviewJobKind;
    if (kind !== 'mr' && kind !== 'tad') throw new ReviewInputError('Jenis review tidak valid.');
    if (!isAiSelection(req.ai)) throw new ReviewInputError('Pilihan AI tidak valid.');
    if (req.strictness !== undefined && !STRICTNESS.has(req.strictness)) throw new ReviewInputError('Tingkat ketelitian tidak valid.');
    const mr = checkMr(req.mr);
    const task = kind === 'tad' ? checkTask(req.task) : undefined;
    const prompt = text(req.prompt, 'Instruksi review', REVIEW_LIMITS.prompt);
    const context = text(req.context, 'Diff MR', REVIEW_LIMITS.context);

    if (this.live.size >= MAX_LIVE_REVIEWS) throw new ReviewInputError(`Sudah ada ${MAX_LIVE_REVIEWS} review berjalan di background; tunggu salah satu selesai.`, 409);
    for (const id of this.live.keys()) {
      const other = await this.read(id).catch(() => null);
      if (other && other.mr.webUrl === mr.webUrl && sameReviewScope(other, kind, task)) {
        throw new ReviewInputError('Review yang sama untuk MR ini masih berjalan; tunggu atau batalkan dulu.', 409);
      }
    }

    const now = new Date().toISOString();
    const job: ReviewJob = {
      id: randomUUID(),
      kind,
      mr,
      ...(task ? { task } : {}),
      ai: req.ai,
      ...(kind === 'mr' && req.strictness ? { strictness: req.strictness } : {}),
      status: 'running',
      progress: 'Menyiapkan…',
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(job);
    const live: LiveJob = { progress: job.progress, events: [] };
    this.live.set(job.id, live);
    await this.sync(job);
    void this.prune();
    void this.run(job, buildAssistantPrompt(prompt, context), live);
    return this.get(job.id);
  }

  private async run(job: ReviewJob, prompt: string, live: LiveJob) {
    let lastSync = 0;
    let finished = false;
    // Progress updates and the final update go through one chain, so a late progress update can
    // never land after (and overwrite) the result.
    let chain: Promise<unknown> = Promise.resolve();
    const queue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch(() => {}));
    const finish = (patch: Partial<ReviewJob>) => {
      finished = true;
      return queue(async () => {
        const saved = await this.read(job.id).catch(() => null);
        if (!saved) return;
        Object.assign(saved, patch, { progress: undefined, events: live.events, finishedAt: new Date().toISOString() });
        await this.save(saved);
        await this.sync(saved);
      });
    };
    const record = (e: Omit<ReviewJobEvent, 'at'>) => {
      const entry = { at: new Date().toISOString(), kind: e.kind, text: String(e.text ?? '').slice(0, MAX_EVENT_TEXT) };
      live.events.push(entry);
      if (live.events.length > MAX_EVENTS) live.events.splice(0, live.events.length - MAX_EVENTS);
      live.progress = e.kind === 'text' ? 'AI sedang menulis review…' : entry.text.slice(0, 200);
      if (Date.now() - lastSync < SYNC_EVERY_MS) return;
      lastSync = Date.now();
      void queue(async () => {
        if (finished) return;
        const saved = await this.read(job.id);
        if (saved.status === 'running') await this.sync({ ...saved, progress: live.progress });
      });
    };

    try {
      let systemPrompt = ASSISTANT_SYSTEM_PROMPTS['code-review'];
      if (job.strictness) systemPrompt = `${systemPrompt}\n\n${STRICTNESS_GUIDELINES[job.strictness]}`;
      if (live.cancelled) return await finish({ status: 'cancelled', error: 'Dibatalkan.' });
      const run = this.deps.runAi(job.ai, prompt, { systemPrompt, timeoutMs: TIMEOUT_MS, onEvent: record });
      live.cancel = run.cancel;
      const outcome = await run.done;
      if (live.cancelled) return await finish({ status: 'cancelled', error: 'Dibatalkan.' });
      if (outcome.error) throw new Error(outcome.error);
      if (!outcome.reply.trim()) throw new Error('AI tidak mengembalikan hasil review.');
      await finish({ status: 'done', reply: outcome.reply, error: undefined });
    } catch (e) {
      await finish(live.cancelled ? { status: 'cancelled', error: 'Dibatalkan.' } : { status: 'error', error: (e as Error).message });
    } finally {
      await chain;
      this.live.delete(job.id);
    }
  }

  async cancel(id: string): Promise<ReviewJob> {
    const job = await this.get(id);
    const live = this.live.get(job.id);
    if (live) {
      live.cancelled = true;
      live.cancel?.();
    }
    return job;
  }

  /** Keeps the folder bounded: removes the oldest finished reviews beyond KEEP. */
  private async prune() {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json') && !this.live.has(n.slice(0, -5)));
    if (names.length <= KEEP) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, at: (await stat(join(this.dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => a.at - b.at);
    await Promise.all(dated.slice(0, names.length - KEEP).map(({ n }) => rm(join(this.dir, n), { force: true })));
  }
}
