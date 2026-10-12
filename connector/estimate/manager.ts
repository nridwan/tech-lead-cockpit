import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import { DEFAULT_HOLIDAYS } from '../../src/lib/estimate/holidays.ts';
import { ESTIMATE_ROLES, roundEffort, taskId, type EstimateJob, type EstimateProject, type EstimateRequest, type EstimateTask, type Holiday } from '../../src/lib/estimate/types.ts';
import { buildEstimatePrompt, parseEstimateReply } from './ai.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Projects (one or more TADs + one team + their estimate) and the holiday calendar, under
 * ~/.tech-lead-cockpit/estimate (0700). The AI proposal runs as a background job the UI polls;
 * the project itself (final efforts, team, dependencies) is saved by the UI, which also computes
 * the schedule. A TAD belongs to at most one project, so its tasks are never counted twice.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 15 * 60_000;

export class EstimateInputError extends Error {}

export interface EstimateDeps {
  dir?: string;
  runAi: (
    ai: AiSelection,
    prompt: string,
    opts: { cwd: string; timeoutMs: number; readOnlyDirs: string[]; onProgress: (text: string) => void },
  ) => { done: Promise<{ reply: string; error?: string }>; cancel: () => void };
  /** Resolves and checks the codebase folder (inside home, exists). */
  resolveServicesRoot: (input: string) => Promise<string>;
  /** Repos changed during the run, to prove the codebase stayed read-only. */
  watchRepos?: (root: string) => Promise<() => Promise<string[]>>;
  /** TAD title for naming projects migrated from the old per-TAD estimates. */
  draftTitle?: (draftId: string) => Promise<string | undefined>;
}

interface LegacyPlan {
  draftId: string;
  startDate: string;
  skipCutiBersama?: boolean;
  developers?: EstimateProject['developers'];
  tasks?: (Omit<EstimateTask, 'id' | 'draftId'> & { id?: string })[];
  notes?: string;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const JIRA_PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;
/** Free text that ends up quoted in JQL: no quotes, backslashes or control characters. */
const jqlText = (v: unknown, max: number) => String(v ?? '').replace(/["\\\u0000-\u001f]/g, '').trim().slice(0, max);

/** Task sources outside the TADs: a Jira filter, Bug Tracing cases and manual tasks. */
export function opsSources(raw: Partial<EstimateProject>): Pick<EstimateProject, 'jiraFilter' | 'bugCaseIds' | 'manualTasks'> {
  const out: Pick<EstimateProject, 'jiraFilter' | 'bugCaseIds' | 'manualTasks'> = {};
  const f = raw.jiraFilter;
  if (f && typeof f === 'object') {
    const projectKey = String(f.projectKey ?? '').trim().toUpperCase();
    if (projectKey && !JIRA_PROJECT.test(projectKey)) throw new EstimateInputError('Project key Jira tidak valid.');
    if (projectKey) {
      const epicKey = String(f.epicKey ?? '').trim().toUpperCase();
      if (epicKey && !JIRA_KEY.test(epicKey)) throw new EstimateInputError('Epic key Jira tidak valid.');
      const doneDays = Number(f.doneDays);
      out.jiraFilter = {
        projectKey,
        issueTypes: [...new Set((Array.isArray(f.issueTypes) ? f.issueTypes : []).map((t) => jqlText(t, 60)).filter(Boolean))].slice(0, 10),
        ...(jqlText(f.label, 100) ? { label: jqlText(f.label, 100) } : {}),
        ...(epicKey ? { epicKey } : {}),
        ...(f.activeSprint === true ? { activeSprint: true } : {}),
        ...(Number.isInteger(doneDays) && doneDays >= 0 ? { doneDays: Math.min(365, doneDays) } : {}),
      };
    }
  }
  const bugIds = [...new Set((Array.isArray(raw.bugCaseIds) ? raw.bugCaseIds : []).map(String))].filter((d) => ID.test(d)).slice(0, 100);
  if (bugIds.length) out.bugCaseIds = bugIds;
  const manual = (Array.isArray(raw.manualTasks) ? raw.manualTasks : []).slice(0, 300).flatMap((t) => {
    const title = String(t?.title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (!title) return [];
    const jiraKey = String(t.jiraKey ?? '').trim().toUpperCase();
    const repo = String(t.repo ?? '').trim();
    return [{
      id: ID.test(String(t.id)) ? String(t.id) : randomUUID(),
      title,
      ...(/^[A-Za-z0-9._-]{1,100}$/.test(repo) ? { repo } : {}),
      ...(JIRA_KEY.test(jiraKey) ? { jiraKey } : {}),
      ...(t.done === true ? { done: true } : {}),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt.slice(0, 40) : new Date().toISOString(),
    }];
  });
  if (manual.length) out.manualTasks = manual;
  return out;
}

export function validateProject(raw: Partial<EstimateProject>): EstimateProject {
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new EstimateInputError('Nama proyek wajib diisi.');
  if (typeof raw.startDate !== 'string' || !DATE.test(raw.startDate) || Number.isNaN(Date.parse(raw.startDate))) throw new EstimateInputError('Tanggal mulai tidak valid.');
  const draftIds = [...new Set((Array.isArray(raw.draftIds) ? raw.draftIds : []).map(String))].filter((d) => ID.test(d)).slice(0, 30);
  const developers = (Array.isArray(raw.developers) ? raw.developers : []).slice(0, 50).map((d) => {
    const devName = String(d?.name ?? '').trim().slice(0, 80);
    if (!devName) throw new EstimateInputError('Nama developer wajib diisi.');
    if (!(ESTIMATE_ROLES as readonly string[]).includes(d.role)) throw new EstimateInputError(`Role developer "${devName}" tidak dikenal.`);
    const allocation = Number(d.allocation);
    const accountId = String(d.jira?.accountId ?? '');
    const jira = /^[\w.@:-]{1,128}$/.test(accountId) ? { accountId, displayName: String(d.jira?.displayName ?? accountId).slice(0, 120) } : undefined;
    const loadDays = Number(d.jiraLoad?.days);
    const jiraLoad =
      jira && Number.isFinite(loadDays) && loadDays >= 0
        ? { days: Math.min(500, Math.round(loadDays * 2) / 2), issues: Math.max(0, Math.floor(Number(d.jiraLoad?.issues) || 0)), loadedAt: String(d.jiraLoad?.loadedAt ?? '').slice(0, 40) }
        : undefined;
    const memberId = ID.test(String(d.memberId ?? '')) ? String(d.memberId) : undefined;
    return { id: ID.test(String(d.id)) ? String(d.id) : randomUUID(), name: devName, role: d.role, allocation: Number.isFinite(allocation) ? Math.min(1, Math.max(0.1, allocation)) : 1, ...(jira ? { jira } : {}), ...(jiraLoad ? { jiraLoad } : {}), ...(memberId ? { memberId } : {}) };
  });
  const seen = new Set<string>();
  const tasks: EstimateTask[] = [];
  // Tasks of a TAD that left the project go with it.
  for (const t of (Array.isArray(raw.tasks) ? raw.tasks : []).slice(0, 500)) {
    const title = String(t?.title ?? '').trim().slice(0, 300);
    const draftId = String(t?.draftId ?? '');
    if (!title) throw new EstimateInputError('Judul task kosong.');
    if (!draftIds.includes(draftId)) continue;
    const id = taskId(draftId, title);
    if (seen.has(id)) continue;
    seen.add(id);
    const effort = t.effortDays === null || t.effortDays === undefined ? null : Number(t.effortDays);
    tasks.push({
      id,
      draftId,
      title,
      service: String(t.service ?? '').slice(0, 100),
      role: (ESTIMATE_ROLES as readonly string[]).includes(t.role) ? t.role : 'BACKEND',
      roleManual: t.roleManual === true ? true : undefined,
      effortDays: effort === null || !Number.isFinite(effort) || effort <= 0 ? null : Math.min(60, roundEffort(effort)),
      ai: t.ai && Number.isFinite(Number(t.ai.effortDays)) ? { effortDays: Number(t.ai.effortDays), confidence: t.ai.confidence ?? 'medium', reason: String(t.ai.reason ?? '').slice(0, 1_000) } : undefined,
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => String(d).slice(0, 400)),
      assigneeId: t.assigneeId && developers.some((d) => d.id === t.assigneeId) ? t.assigneeId : undefined,
    });
  }
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn)].filter((d) => d !== t.id && seen.has(d));
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : randomUUID(),
    name,
    draftIds,
    ...opsSources(raw),
    startDate: raw.startDate,
    skipCutiBersama: raw.skipCutiBersama !== false,
    developers,
    useJiraLoad: raw.useJiraLoad === true ? true : undefined,
    jiraDefaultDays: Number(raw.jiraDefaultDays) > 0 ? Math.min(20, Math.round(Number(raw.jiraDefaultDays) * 2) / 2) : undefined,
    jiraStaleDays: Number.isInteger(Number(raw.jiraStaleDays)) && Number(raw.jiraStaleDays) >= 0 && raw.jiraStaleDays !== undefined && raw.jiraStaleDays !== null ? Math.min(365, Number(raw.jiraStaleDays)) : undefined,
    tasks,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 5_000) : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
  };
}

export function validateHolidays(raw: unknown): Holiday[] {
  if (!Array.isArray(raw)) throw new EstimateInputError('Daftar libur harus berupa array.');
  const seen = new Set<string>();
  const out: Holiday[] = [];
  for (const h of raw.slice(0, 2_000)) {
    const date = String(h?.date ?? '').trim();
    if (!DATE.test(date) || Number.isNaN(Date.parse(date))) throw new EstimateInputError(`Tanggal libur tidak valid: ${date || '(kosong)'}`);
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, name: String(h.name ?? '').trim().slice(0, 120) || 'Libur', kind: h.kind === 'cuti-bersama' ? 'cuti-bersama' : 'libur' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export class EstimateManager {
  private readonly dir: string;
  private readonly jobs = new Map<string, EstimateJob & { cancel?: () => void }>();

  constructor(private readonly deps: EstimateDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'estimate');
  }

  private async write(file: string, data: unknown) {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private async read<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  isBusy(): boolean {
    return [...this.jobs.values()].some((j) => j.status === 'running');
  }

  // Holidays -------------------------------------------------------------------------------

  private holidaysFile = () => join(this.dir, 'holidays.json');

  /** The user's list, or the built-in SKB list until they edit it. */
  async holidays(): Promise<{ holidays: Holiday[]; custom: boolean }> {
    const saved = await this.read<Holiday[]>(this.holidaysFile());
    return saved ? { holidays: saved, custom: true } : { holidays: DEFAULT_HOLIDAYS, custom: false };
  }

  async saveHolidays(raw: unknown): Promise<{ holidays: Holiday[]; custom: boolean }> {
    await this.write(this.holidaysFile(), validateHolidays(raw));
    return this.holidays();
  }

  async resetHolidays(): Promise<{ holidays: Holiday[]; custom: boolean }> {
    await rm(this.holidaysFile(), { force: true });
    return this.holidays();
  }

  // Projects -------------------------------------------------------------------------------

  private projectFile(id: string) {
    if (!ID.test(id)) throw new EstimateInputError('Id proyek tidak valid.');
    return join(this.dir, 'projects', `${id}.json`);
  }

  private migrated = false;

  /** Turns the old per-TAD estimates (plans/<draftId>.json) into one project each, once. */
  private async migrateLegacyPlans(existing: EstimateProject[]): Promise<EstimateProject[]> {
    if (this.migrated) return existing;
    this.migrated = true;
    const dir = join(this.dir, 'plans');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    const created: EstimateProject[] = [];
    for (const name of names) {
      const plan = await this.read<LegacyPlan>(join(dir, name));
      if (!plan?.draftId || !ID.test(plan.draftId)) continue;
      if (![...existing, ...created].some((p) => p.draftIds.includes(plan.draftId))) {
        const draftId = plan.draftId;
        const ids = new Map((plan.tasks ?? []).map((t) => [t.title, taskId(draftId, t.title)]));
        const title = await this.deps.draftTitle?.(draftId).catch(() => undefined);
        const project = validateProject({
          name: title ? `Proyek ${title}` : 'Proyek tanpa nama',
          draftIds: [draftId],
          startDate: plan.startDate,
          skipCutiBersama: plan.skipCutiBersama,
          developers: plan.developers ?? [],
          tasks: (plan.tasks ?? []).map((t) => ({ ...t, id: ids.get(t.title)!, draftId, dependsOn: (t.dependsOn ?? []).map((d) => ids.get(d) ?? d) })),
          notes: plan.notes,
        });
        await this.write(this.projectFile(project.id), project);
        created.push(project);
      }
      await mkdir(join(dir, 'migrated'), { recursive: true, mode: 0o700 });
      await rename(join(dir, name), join(dir, 'migrated', name)).catch(() => {});
    }
    return [...existing, ...created];
  }

  async listProjects(): Promise<EstimateProject[]> {
    const dir = join(this.dir, 'projects');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    const projects = (await Promise.all(names.map((n) => this.read<EstimateProject>(join(dir, n))))).filter((p): p is EstimateProject => Boolean(p?.id));
    return (await this.migrateLegacyPlans(projects)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async project(id: string): Promise<EstimateProject | null> {
    return (await this.read<EstimateProject>(this.projectFile(id))) ?? null;
  }

  async saveProject(raw: Partial<EstimateProject>): Promise<EstimateProject> {
    const project = validateProject(raw);
    const clash = (await this.listProjects()).find((p) => p.id !== project.id && p.draftIds.some((d) => project.draftIds.includes(d)));
    if (clash) throw new EstimateInputError(`Salah satu TAD sudah masuk proyek "${clash.name}". Keluarkan dulu dari proyek itu.`);
    await this.write(this.projectFile(project.id), project);
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    await rm(this.projectFile(id), { force: true });
  }

  // AI proposal ----------------------------------------------------------------------------

  async start(req: EstimateRequest): Promise<EstimateJob> {
    if (typeof req.projectId !== 'string' || !ID.test(req.projectId)) throw new EstimateInputError('Id proyek tidak valid.');
    if (!req.tasks?.length) throw new EstimateInputError('Tidak ada task untuk diestimasi.');
    const busy = [...this.jobs.values()].find((j) => j.projectId === req.projectId && j.status === 'running');
    if (busy) return this.public(busy);
    const servicesRoot = req.servicesRoot ? await this.deps.resolveServicesRoot(req.servicesRoot).catch((e: Error) => Promise.reject(new EstimateInputError(e.message))) : undefined;

    const job: EstimateJob & { cancel?: () => void } = { id: randomUUID(), projectId: req.projectId, status: 'running', startedAt: new Date().toISOString(), progress: 'Menyiapkan…' };
    this.jobs.set(job.id, job);
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-estimate-'));
    const changed = servicesRoot && this.deps.watchRepos ? await this.deps.watchRepos(servicesRoot).catch(() => undefined) : undefined;
    const run = this.deps.runAi(req.ai, buildEstimatePrompt({ ...req, servicesRoot }, Boolean(servicesRoot)), {
      cwd,
      timeoutMs: TIMEOUT_MS,
      readOnlyDirs: servicesRoot ? [servicesRoot] : [],
      onProgress: (text) => (job.progress = text.slice(0, 200)),
    });
    job.cancel = run.cancel;
    void run.done
      .then(async (outcome) => {
        if (job.status === 'cancelled') return;
        if (outcome.error) throw new Error(outcome.error);
        try {
          job.result = parseEstimateReply(outcome.reply, req.tasks);
        } catch (e) {
          job.rawReply = outcome.reply.slice(0, 50_000);
          throw e;
        }
        job.status = 'done';
      })
      .catch((e: Error) => {
        if (job.status === 'running') {
          job.status = 'error';
          job.error = e.message;
        }
      })
      .finally(async () => {
        job.finishedAt ??= new Date().toISOString();
        job.cancel = undefined;
        if (changed) job.touchedRepos = await changed().catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      });
    return this.public(job);
  }

  private public(job: EstimateJob & { cancel?: () => void }): EstimateJob {
    const { cancel: _cancel, ...rest } = job;
    return rest;
  }

  job(id: string): EstimateJob | undefined {
    const j = this.jobs.get(id);
    return j && this.public(j);
  }

  latestJob(projectId: string): EstimateJob | undefined {
    const all = [...this.jobs.values()].filter((j) => j.projectId === projectId);
    return all.length ? this.public(all[all.length - 1]) : undefined;
  }

  cancel(id: string): EstimateJob | undefined {
    const j = this.jobs.get(id);
    if (j?.status === 'running') {
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
      j.cancel?.();
    }
    return j && this.public(j);
  }
}
