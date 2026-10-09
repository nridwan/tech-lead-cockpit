import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './paths.ts';

/**
 * Persistent list of agent tasks (Cockpit's local coding-agent runs), stored as a single JSON file
 * under ~/.tech-lead-cockpit/agent-tasks. Writes are atomic (temp file + fsync + rename), every
 * field is bounded on the way in and on the way back from disk, and a corrupt file is moved aside
 * instead of crashing the connector. Tasks that were `running` when the process died are put back
 * to `queued` on load, since nothing is driving them anymore.
 *
 * This module only stores tasks; it does not run anything (coder-runs does).
 */
export const AGENT_TASKS_DIR = join(DATA_DIR, 'agent-tasks');
export const AGENT_TASKS_FILE = 'tasks.json';

export const AGENT_TASK_STATUSES = ['pending', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type AgentTaskPriority = (typeof AGENT_TASK_PRIORITIES)[number];

export const AGENT_APPROVAL_POLICIES = ['review_required', 'auto_approve'] as const;
export type AgentApprovalPolicy = (typeof AGENT_APPROVAL_POLICIES)[number];

/** What the task is: a free prompt, an MR review, implementing a TAD task in code, or a code trace question. */
export const AGENT_TASK_KINDS = ['general', 'review', 'implement', 'trace', 'e2e'] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

/**
 * Who executes it. Only `local` (Cockpit's coding agents) is in use; `hermes` is kept so tasks
 * from the removed remote-agent integration still load (they are hidden from the list).
 */
export const AGENT_TASK_RUNNERS = ['hermes', 'local'] as const;
export type AgentTaskRunner = (typeof AGENT_TASK_RUNNERS)[number];

/** Where the task comes from and what it produced; plain references, never content. */
export interface AgentTaskLinks {
  draftId?: string;
  tadTitle?: string;
  taskTitle?: string;
  jiraKey?: string;
  repo?: string;
  branch?: string;
  mrUrl?: string;
  /** Local coding run (connector/coder-runs.ts) behind an `implement` task. */
  coderRunId?: string;
  /** Code trace (connector/trace) behind a `trace` task. */
  traceId?: string;
  /** E2E pipeline agent (connector/qa) behind an `e2e` task, and its project. */
  qaJobId?: string;
  qaProjectId?: string;
}
const LINK_KEYS = ['draftId', 'tadTitle', 'taskTitle', 'jiraKey', 'repo', 'branch', 'mrUrl', 'coderRunId', 'traceId', 'qaJobId', 'qaProjectId'] as const;

const TERMINAL: ReadonlySet<AgentTaskStatus> = new Set(['completed', 'failed', 'cancelled']);
const PRIORITY_RANK: Record<AgentTaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export const AGENT_TASK_LIMITS = {
  title: 200,
  prompt: 20_000,
  provider: 64,
  model: 128,
  error: 2_000,
  progressMessage: 500,
  idempotencyKey: 128,
  tasks: 2_000,
  fileBytes: 64 * 1024 * 1024,
} as const;

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IDEMPOTENCY_RE = /^[\x21-\x7e]{1,128}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const FILE_VERSION = 1;

export interface AgentTaskProgress {
  /** 0–100. */
  percent?: number;
  message?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
  provider: string;
  model?: string;
  approvalPolicy: AgentApprovalPolicy;
  idempotencyKey?: string;
  runId?: string;
  error?: string;
  progress?: AgentTaskProgress;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Absent on tasks created before kinds existed: those are `general` tasks. */
  kind?: AgentTaskKind;
  runner?: AgentTaskRunner;
  links?: AgentTaskLinks;
}

export interface CreateAgentTaskInput {
  title?: string;
  prompt: string;
  priority?: AgentTaskPriority;
  provider?: string;
  model?: string;
  approvalPolicy?: AgentApprovalPolicy;
  idempotencyKey?: string;
  /** `pending` (default) is held back from dispatch; `queued` is ready to run. */
  status?: 'pending' | 'queued';
  kind?: AgentTaskKind;
  runner?: AgentTaskRunner;
  links?: AgentTaskLinks;
}

export interface UpdateAgentTaskPatch {
  status?: AgentTaskStatus;
  title?: string;
  priority?: AgentTaskPriority;
  model?: string | null;
  runId?: string | null;
  error?: string | null;
  progress?: AgentTaskProgress | null;
  /** Merged into the existing links. */
  links?: AgentTaskLinks;
}

export interface ListAgentTasksOptions {
  status?: AgentTaskStatus | AgentTaskStatus[];
  limit?: number;
}

export type AgentTaskErrorCode = 'invalid_argument' | 'not_found' | 'invalid_state' | 'limit';

export class AgentTaskError extends Error {
  readonly code: AgentTaskErrorCode;
  constructor(code: AgentTaskErrorCode, message: string) {
    super(message);
    this.name = 'AgentTaskError';
    this.code = code;
  }
}

export interface AgentTaskStoreOptions {
  dir?: string;
  now?: () => Date;
  newId?: () => string;
  defaultProvider?: string;
  /** Test hook for fault injection; defaults to fs.rename. */
  renameFile?: (from: string, to: string) => Promise<void>;
}

export interface AgentTaskLoadReport {
  /** Path the unreadable file was moved to, when the store file was corrupt. */
  quarantined?: string;
  /** Entries dropped because they failed validation. */
  droppedTasks: number;
  /** Tasks moved from `running` back to `queued`. */
  recoveredTasks: number;
}

// --- Validation helpers ---

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function invalid(message: string): never {
  throw new AgentTaskError('invalid_argument', message);
}

/** Strips control characters (keeping newlines/tabs when `multiline`) and caps the length. */
function cleanText(value: string, max: number, multiline = false): string {
  const re = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]+/g;
  const text = value.replace(re, multiline ? '' : ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function isStatus(v: unknown): v is AgentTaskStatus {
  return typeof v === 'string' && (AGENT_TASK_STATUSES as readonly string[]).includes(v);
}

function isPriority(v: unknown): v is AgentTaskPriority {
  return typeof v === 'string' && (AGENT_TASK_PRIORITIES as readonly string[]).includes(v);
}

function isApprovalPolicy(v: unknown): v is AgentApprovalPolicy {
  return typeof v === 'string' && (AGENT_APPROVAL_POLICIES as readonly string[]).includes(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

export function isAgentTaskId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

function checkProvider(v: unknown): string {
  if (typeof v !== 'string' || !PROVIDER_RE.test(v)) invalid('Invalid agent provider.');
  return v;
}

function checkModel(v: unknown): string {
  if (typeof v !== 'string' || !MODEL_RE.test(v)) invalid('Invalid agent model.');
  return v;
}

function checkKind(v: unknown): AgentTaskKind {
  if (typeof v !== 'string' || !(AGENT_TASK_KINDS as readonly string[]).includes(v)) invalid('Invalid agent task kind.');
  return v as AgentTaskKind;
}

function checkRunner(v: unknown): AgentTaskRunner {
  if (typeof v !== 'string' || !(AGENT_TASK_RUNNERS as readonly string[]).includes(v)) invalid('Invalid agent task runner.');
  return v as AgentTaskRunner;
}

function checkLinks(v: unknown): AgentTaskLinks {
  if (!isObject(v)) invalid('Agent task links must be an object.');
  const out: AgentTaskLinks = {};
  for (const key of LINK_KEYS) {
    const value = v[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') invalid(`Agent task link ${key} must be a string.`);
    const text = cleanText(value, 500);
    if (text) out[key] = text;
  }
  return out;
}

function checkRunId(v: unknown): string {
  if (typeof v !== 'string' || !RUN_ID_RE.test(v)) invalid('Invalid agent run id.');
  return v;
}

function checkProgress(v: unknown): AgentTaskProgress {
  if (!isObject(v)) invalid('Agent task progress must be an object.');
  const out: AgentTaskProgress = {};
  if (v.percent !== undefined) {
    if (typeof v.percent !== 'number' || !Number.isFinite(v.percent)) invalid('Agent task progress percent must be a number.');
    out.percent = Math.min(100, Math.max(0, Math.round(v.percent * 10) / 10));
  }
  if (v.message !== undefined) {
    if (typeof v.message !== 'string') invalid('Agent task progress message must be a string.');
    const message = cleanText(v.message, AGENT_TASK_LIMITS.progressMessage);
    if (message) out.message = message;
  }
  return out;
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * Re-validates a task read from disk. Returns undefined for entries that cannot be trusted;
 * over-long text is truncated rather than rejected so a hand-edited file still loads.
 */
function sanitizeStoredTask(raw: unknown): AgentTask | undefined {
  if (!isObject(raw)) return undefined;
  try {
    if (!isAgentTaskId(raw.id) || !isStatus(raw.status) || !isPriority(raw.priority)) return undefined;
    if (!isApprovalPolicy(raw.approvalPolicy)) return undefined;
    if (typeof raw.prompt !== 'string' || typeof raw.title !== 'string') return undefined;
    if (!isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)) return undefined;
    const prompt = cleanText(raw.prompt, AGENT_TASK_LIMITS.prompt, true);
    if (!prompt) return undefined;
    const task: AgentTask = {
      id: raw.id,
      title: cleanText(raw.title, AGENT_TASK_LIMITS.title) || titleFromPrompt(prompt),
      prompt,
      status: raw.status,
      priority: raw.priority,
      provider: checkProvider(raw.provider),
      approvalPolicy: raw.approvalPolicy,
      attempts: Number.isSafeInteger(raw.attempts) && (raw.attempts as number) >= 0 ? (raw.attempts as number) : 0,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
    if (raw.model !== undefined) task.model = checkModel(raw.model);
    if (raw.idempotencyKey !== undefined) {
      if (typeof raw.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(raw.idempotencyKey)) return undefined;
      task.idempotencyKey = raw.idempotencyKey;
    }
    if (raw.runId !== undefined) task.runId = checkRunId(raw.runId);
    if (typeof raw.error === 'string' && raw.error) task.error = cleanText(raw.error, AGENT_TASK_LIMITS.error, true);
    if (raw.progress !== undefined) task.progress = checkProgress(raw.progress);
    if (isIsoDate(raw.startedAt)) task.startedAt = raw.startedAt;
    if (isIsoDate(raw.finishedAt)) task.finishedAt = raw.finishedAt;
    if (raw.kind !== undefined) task.kind = checkKind(raw.kind);
    if (raw.runner !== undefined) task.runner = checkRunner(raw.runner);
    if (raw.links !== undefined) task.links = checkLinks(raw.links);
    return task;
  } catch {
    return undefined;
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// --- Store ---

export class AgentTaskStore {
  readonly dir: string;
  readonly file: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly defaultProvider: string;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private tasks: AgentTask[] | undefined;
  private loading: Promise<AgentTaskLoadReport> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private lastLoad: AgentTaskLoadReport | undefined;

  constructor(options: AgentTaskStoreOptions = {}) {
    this.dir = options.dir ?? AGENT_TASKS_DIR;
    this.file = join(this.dir, AGENT_TASKS_FILE);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.defaultProvider = checkProvider(options.defaultProvider ?? 'local');
    this.renameFile = options.renameFile ?? rename;
  }

  /** Result of the initial load (corrupt-file quarantine, dropped entries, recovered runs). */
  async loadReport(): Promise<AgentTaskLoadReport> {
    await this.ensureLoaded();
    return { ...this.lastLoad! };
  }

  async list(options: ListAgentTasksOptions = {}): Promise<AgentTask[]> {
    const tasks = await this.ensureLoaded().then(() => this.tasks!);
    const wanted = options.status === undefined ? undefined : new Set(Array.isArray(options.status) ? options.status : [options.status]);
    if (wanted) for (const s of wanted) if (!isStatus(s)) invalid('Invalid agent task status filter.');
    const limit = options.limit ?? Infinity;
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) invalid('Invalid agent task list limit.');
    return tasks
      .filter((t) => !wanted || wanted.has(t.status))
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  async get(id: string): Promise<AgentTask | undefined> {
    if (!isAgentTaskId(id)) invalid('Invalid agent task id.');
    await this.ensureLoaded();
    const task = this.tasks!.find((t) => t.id === id);
    return task ? clone(task) : undefined;
  }

  /**
   * Creates a task. When `idempotencyKey` matches an existing task, that task is returned
   * unchanged with `created: false`, so a retried request never enqueues a duplicate.
   */
  async create(input: CreateAgentTaskInput): Promise<{ task: AgentTask; created: boolean }> {
    if (!isObject(input as unknown)) invalid('Agent task input must be an object.');
    if (typeof input.prompt !== 'string') invalid('Agent task prompt must be a string.');
    if (input.prompt.length > AGENT_TASK_LIMITS.prompt) invalid(`Agent task prompt exceeds ${AGENT_TASK_LIMITS.prompt} characters.`);
    const prompt = cleanText(input.prompt, AGENT_TASK_LIMITS.prompt, true);
    if (!prompt) invalid('Agent task prompt must not be empty.');
    if (input.title !== undefined && typeof input.title !== 'string') invalid('Agent task title must be a string.');
    if (input.priority !== undefined && !isPriority(input.priority)) invalid('Invalid agent task priority.');
    if (input.approvalPolicy !== undefined && !isApprovalPolicy(input.approvalPolicy)) invalid('Invalid agent task approval policy.');
    if (input.status !== undefined && input.status !== 'pending' && input.status !== 'queued') {
      invalid("New agent tasks must start as 'pending' or 'queued'.");
    }
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(input.idempotencyKey))) {
      invalid('Invalid agent task idempotency key.');
    }
    const provider = checkProvider(input.provider ?? this.defaultProvider);
    const model = input.model === undefined ? undefined : checkModel(input.model);
    const kind = input.kind === undefined ? undefined : checkKind(input.kind);
    const runner = input.runner === undefined ? undefined : checkRunner(input.runner);
    const links = input.links === undefined ? undefined : checkLinks(input.links);

    return this.mutate<{ task: AgentTask; created: boolean }>((tasks) => {
      if (input.idempotencyKey !== undefined) {
        const existing = tasks.find((t) => t.idempotencyKey === input.idempotencyKey);
        if (existing) return { result: { task: clone(existing), created: false }, changed: false };
      }
      this.makeRoom(tasks);
      const at = this.now().toISOString();
      const id = this.newId();
      if (!isAgentTaskId(id) || tasks.some((t) => t.id === id)) throw new AgentTaskError('invalid_state', 'Could not allocate an agent task id.');
      const task: AgentTask = {
        id,
        title: cleanText(input.title ?? '', AGENT_TASK_LIMITS.title) || titleFromPrompt(prompt),
        prompt,
        status: input.status ?? 'pending',
        priority: input.priority ?? 'normal',
        provider,
        approvalPolicy: input.approvalPolicy ?? 'review_required',
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      if (model) task.model = model;
      if (input.idempotencyKey !== undefined) task.idempotencyKey = input.idempotencyKey;
      if (kind) task.kind = kind;
      if (runner) task.runner = runner;
      if (links && Object.keys(links).length) task.links = links;
      tasks.push(task);
      return { result: { task: clone(task), created: true }, changed: true };
    });
  }

  /** Applies a patch to a non-terminal task. Use `retry` to revive failed/cancelled tasks. */
  async update(id: string, patch: UpdateAgentTaskPatch): Promise<AgentTask> {
    if (!isAgentTaskId(id)) invalid('Invalid agent task id.');
    if (!isObject(patch as unknown)) invalid('Agent task patch must be an object.');
    if (patch.status !== undefined && !isStatus(patch.status)) invalid('Invalid agent task status.');
    if (patch.priority !== undefined && !isPriority(patch.priority)) invalid('Invalid agent task priority.');
    if (patch.title !== undefined && typeof patch.title !== 'string') invalid('Agent task title must be a string.');
    if (patch.error !== undefined && patch.error !== null && typeof patch.error !== 'string') invalid('Agent task error must be a string.');
    const runId = patch.runId === undefined || patch.runId === null ? patch.runId : checkRunId(patch.runId);
    const model = patch.model === undefined || patch.model === null ? patch.model : checkModel(patch.model);
    const progress = patch.progress === undefined || patch.progress === null ? patch.progress : checkProgress(patch.progress);
    const links = patch.links === undefined ? undefined : checkLinks(patch.links);

    return this.mutate((tasks) => {
      const task = this.find(tasks, id);
      if (TERMINAL.has(task.status)) {
        throw new AgentTaskError('invalid_state', `Agent task is ${task.status} and can no longer be updated.`);
      }
      const at = this.now().toISOString();
      if (patch.title !== undefined) task.title = cleanText(patch.title, AGENT_TASK_LIMITS.title) || task.title;
      if (patch.priority !== undefined) task.priority = patch.priority;
      if (model === null) delete task.model;
      else if (model !== undefined) task.model = model;
      if (runId === null) delete task.runId;
      else if (runId !== undefined) task.runId = runId;
      if (patch.error === null || patch.error === '') delete task.error;
      else if (patch.error !== undefined) task.error = cleanText(patch.error, AGENT_TASK_LIMITS.error, true);
      if (progress === null) delete task.progress;
      else if (progress !== undefined) task.progress = progress;
      if (links) task.links = { ...task.links, ...links };
      if (patch.status !== undefined && patch.status !== task.status) {
        const resumed = task.status === 'blocked';
        task.status = patch.status;
        // Resuming a blocked task (e.g. after an approval) continues the same attempt.
        if (patch.status === 'running' && !resumed) {
          task.startedAt = at;
          task.attempts += 1;
        }
        if (TERMINAL.has(patch.status)) task.finishedAt = at;
      }
      task.updatedAt = at;
      return { result: clone(task), changed: true };
    });
  }

  /** Cancels a task that has not finished. Cancelling an already-cancelled task is a no-op. */
  async cancel(id: string, reason?: string): Promise<AgentTask> {
    if (!isAgentTaskId(id)) invalid('Invalid agent task id.');
    if (reason !== undefined && typeof reason !== 'string') invalid('Cancel reason must be a string.');
    return this.mutate((tasks) => {
      const task = this.find(tasks, id);
      if (task.status === 'cancelled') return { result: clone(task), changed: false };
      if (TERMINAL.has(task.status)) throw new AgentTaskError('invalid_state', `Agent task is already ${task.status}.`);
      const at = this.now().toISOString();
      task.status = 'cancelled';
      task.finishedAt = at;
      task.updatedAt = at;
      const why = reason === undefined ? '' : cleanText(reason, AGENT_TASK_LIMITS.error, true);
      if (why) task.error = why;
      return { result: clone(task), changed: true };
    });
  }

  /** Puts a failed or cancelled task back in the queue, clearing its previous run state. */
  async retry(id: string): Promise<AgentTask> {
    if (!isAgentTaskId(id)) invalid('Invalid agent task id.');
    return this.mutate((tasks) => {
      const task = this.find(tasks, id);
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        throw new AgentTaskError('invalid_state', `Only failed or cancelled agent tasks can be retried (task is ${task.status}).`);
      }
      task.status = 'queued';
      delete task.runId;
      delete task.error;
      delete task.progress;
      delete task.startedAt;
      delete task.finishedAt;
      task.updatedAt = this.now().toISOString();
      return { result: clone(task), changed: true };
    });
  }

  // --- internals ---

  private find(tasks: AgentTask[], id: string): AgentTask {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new AgentTaskError('not_found', 'Agent task not found.');
    return task;
  }

  /** Drops the oldest finished tasks when the queue is full; refuses if everything is still active. */
  private makeRoom(tasks: AgentTask[]) {
    if (tasks.length < AGENT_TASK_LIMITS.tasks) return;
    const finished = tasks
      .filter((t) => TERMINAL.has(t.status))
      .sort((a, b) => (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt));
    const excess = tasks.length - AGENT_TASK_LIMITS.tasks + 1;
    if (finished.length < excess) throw new AgentTaskError('limit', 'Agent task queue is full.');
    const drop = new Set(finished.slice(0, excess).map((t) => t.id));
    for (let i = tasks.length - 1; i >= 0; i--) if (drop.has(tasks[i].id)) tasks.splice(i, 1);
  }

  /**
   * Serializes mutations: each runs against a copy of the in-memory list, and the copy only
   * replaces the live list once it has been written to disk, so a failed write changes nothing.
   */
  private mutate<T>(fn: (tasks: AgentTask[]) => { result: T; changed: boolean }): Promise<T> {
    const run = async () => {
      await this.ensureLoaded();
      const draft = clone(this.tasks!);
      const { result, changed } = fn(draft);
      if (changed) {
        await this.persist(draft);
        this.tasks = draft;
      }
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private ensureLoaded(): Promise<AgentTaskLoadReport> {
    this.loading ??= this.load().catch((err) => {
      this.loading = undefined;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<AgentTaskLoadReport> {
    const report: AgentTaskLoadReport = { droppedTasks: 0, recoveredTasks: 0 };
    await this.removeStaleTempFiles();
    let text: string | undefined;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    let tasks: AgentTask[] = [];
    if (text !== undefined) {
      let parsed: unknown;
      let ok = text.length <= AGENT_TASK_LIMITS.fileBytes;
      if (ok) {
        try {
          parsed = JSON.parse(text);
        } catch {
          ok = false;
        }
      }
      if (ok && isObject(parsed) && parsed.version === FILE_VERSION && Array.isArray(parsed.tasks)) {
        const seenIds = new Set<string>();
        const seenKeys = new Set<string>();
        for (const raw of parsed.tasks) {
          const task = sanitizeStoredTask(raw);
          if (!task || seenIds.has(task.id) || (task.idempotencyKey && seenKeys.has(task.idempotencyKey))) {
            report.droppedTasks++;
            continue;
          }
          seenIds.add(task.id);
          if (task.idempotencyKey) seenKeys.add(task.idempotencyKey);
          tasks.push(task);
        }
        if (tasks.length > AGENT_TASK_LIMITS.tasks) {
          report.droppedTasks += tasks.length - AGENT_TASK_LIMITS.tasks;
          tasks = tasks.slice(-AGENT_TASK_LIMITS.tasks);
        }
      } else {
        report.quarantined = await this.quarantine();
      }
    }

    const at = this.now().toISOString();
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      task.status = 'queued';
      task.updatedAt = at;
      delete task.startedAt;
      task.progress = { ...task.progress, message: 'Recovered after connector restart; waiting to be re-dispatched.' };
      report.recoveredTasks++;
    }

    if (report.recoveredTasks || report.droppedTasks) await this.persist(tasks);
    this.tasks = tasks;
    this.lastLoad = report;
    return report;
  }

  /** Moves an unreadable store file aside (never deletes it) so it can be inspected by hand. */
  private async quarantine(): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const target = join(this.dir, `${AGENT_TASKS_FILE}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`);
    await rename(this.file, target);
    return target;
  }

  /** Temp files left by a crash mid-write are never the source of truth; clean them up. */
  private async removeStaleTempFiles() {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const prefix = `.${AGENT_TASKS_FILE}.`;
    await Promise.all(names.filter((n) => n.startsWith(prefix) && n.endsWith('.tmp')).map((n) => unlink(join(this.dir, n)).catch(() => undefined)));
  }

  private async persist(tasks: AgentTask[]) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.${AGENT_TASKS_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    const body = JSON.stringify({ version: FILE_VERSION, tasks }, null, 2);
    try {
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(body, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await this.renameFile(tmp, this.file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // Best effort: make the rename itself durable.
    try {
      const dh = await open(this.dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Not supported on every platform.
    }
  }
}
