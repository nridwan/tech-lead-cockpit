import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import type { QADatabase, QADbConnection, QADbResult, QADbServer, QAEnvironment, QAFlow, QAGenerateJob, QAGenerateRequest, QARun, QARunRequest, QASuite } from '../../src/lib/qa/types.ts';
import { listDatabases, QaDbError, queryReadOnly, schemaSummary, testConnection } from './db.ts';
import { matchDatabases } from '../../src/lib/qa/db-match.ts';
import { buildQaPrompt, parseQaReply, QA_SYSTEM_PROMPT } from './generator.ts';
import { runFlow, summarize } from './runner.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * E2E state: environments, one suite per TAD draft and its run history, all under
 * ~/.tech-lead-cockpit/qa (0700). Environment secrets live in the Keychain, never in these files.
 * Generation and runs are background jobs the UI polls, so a reload doesn't lose them.
 */

export const QA_KEYCHAIN_SERVICE = 'tech-lead-cockpit.qa';
const KEEP_RUNS = 30;
/** Reading the codebase makes generation slower. */
const GENERATE_TIMEOUT_MS = 20 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class QaInputError extends Error {}

export interface QaDeps {
  dir?: string;
  /** `key` is the environment id, or `<id>:vars` for its secret variables (a JSON object). */
  readSecret: (key: string) => Promise<string | null>;
  writeSecret: (key: string, value: string) => Promise<boolean>;
  deleteSecret: (key: string) => Promise<boolean>;
  runAi: (ai: AiSelection, prompt: string, opts: { cwd: string; timeoutMs: number; systemPrompt: string; readOnlyDirs?: string[]; onProgress: (text: string) => void }) => {
    done: Promise<{ reply: string; error?: string }>;
    cancel: () => void;
  };
  fetch?: typeof fetch;
  /** The Services codebase the AI may read (read-only) while generating. */
  resolveServicesRoot?: (input: string) => Promise<string>;
  /** Snapshot of the repos' working trees; the returned function lists repos changed since. */
  watchRepos?: (root: string) => Promise<() => Promise<string[]>>;
  /** Read-only database access (PostgreSQL); tests inject a fake. */
  db?: {
    query: (db: QADbConnection, password: string | undefined, sql: string) => Promise<QADbResult>;
    schema: (db: QADbConnection, password: string | undefined) => Promise<string>;
    test: (db: QADbConnection, password: string | undefined) => Promise<string>;
    list: (server: QADbConnection, password: string | undefined) => Promise<string[]>;
  };
}

const REAL_DB = { query: queryReadOnly, schema: schemaSummary, test: testConnection, list: listDatabases };
const DB_NAME = /^[A-Za-z][\w.-]{0,79}$/;
const MAX_DATABASES = 80;
/** Databases whose schema the AI reads in one generation (the selected tasks' services). */
const MAX_SCHEMA_DBS = 8;
const dbSecretKey = (envId: string, name: string) => `${envId}:db:${name}`;
const serverSecretKey = (envId: string) => `${envId}:dbserver`;

function cleanServer(raw: unknown): QADbServer | undefined {
  const d = (raw ?? {}) as Partial<QADbServer>;
  const host = String(d.host ?? '').trim();
  if (!host) return undefined;
  if (!/^[\w.-]{1,253}$/.test(host)) throw new QaInputError('Host server database tidak valid.');
  const user = String(d.user ?? '').trim();
  if (!user) throw new QaInputError('User server database wajib diisi.');
  const port = Number(d.port) || 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new QaInputError('Port server database tidak valid.');
  return { host, port, user: user.slice(0, 100), ...(d.ssl ? { ssl: true } : {}) };
}

function cleanDatabases(raw: unknown): QADatabase[] {
  const out: QADatabase[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_DATABASES) : []) {
    const d = (item ?? {}) as Partial<QADatabase>;
    const service = String(d.service ?? '').trim();
    const name = String(d.name ?? '').trim() || service;
    const database = String(d.database ?? '').trim();
    if (!name && !database) continue;
    if (!DB_NAME.test(name)) throw new QaInputError(`Nama database "${name}" tidak valid (huruf, angka, titik, - atau _).`);
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new QaInputError(`"${name}" dipetakan dua kali.`);
    if (!database || !/^[\w.$-]{1,100}$/.test(database)) throw new QaInputError(`${name}: nama database tidak valid.`);
    const host = String(d.host ?? '').trim();
    if (host && !/^[\w.-]{1,253}$/.test(host)) throw new QaInputError(`${name}: host tidak valid.`);
    const port = Number(d.port);
    out.push({
      name,
      ...(service ? { service: service.slice(0, 100) } : {}),
      database,
      ...(host ? { host, ...(Number.isInteger(port) && port > 0 && port < 65_536 ? { port } : {}), ...(d.user ? { user: String(d.user).trim().slice(0, 100) } : {}), ...(d.ssl ? { ssl: true } : {}) } : {}),
    });
  }
  return out;
}

const httpUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v);

function cleanRecord(v: unknown, what: string, check?: (k: string, val: string) => void): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new QaInputError(`${what} harus berupa objek.`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const key = k.trim();
    if (!key) continue;
    if (key.length > 100) throw new QaInputError(`${what}: nama "${key.slice(0, 20)}…" terlalu panjang.`);
    const value = String(val ?? '').trim();
    check?.(key, value);
    out[key] = value;
  }
  return out;
}

export function validateEnvironment(raw: Partial<QAEnvironment>): QAEnvironment {
  const name = String(raw.name ?? '').trim().slice(0, 80);
  if (!name) throw new QaInputError('Nama environment wajib diisi.');
  const baseUrl = String(raw.baseUrl ?? '').trim();
  if (baseUrl && !httpUrl(baseUrl)) throw new QaInputError('Base URL harus diawali http:// atau https://.');
  const services = cleanRecord(raw.services, 'URL service', (k, v) => {
    if (v && !httpUrl(v)) throw new QaInputError(`URL service "${k}" harus diawali http:// atau https://.`);
  });
  if (!baseUrl && !Object.values(services).some(Boolean)) throw new QaInputError('Isi base URL default atau minimal satu URL service.');
  const authType = raw.auth?.type ?? 'none';
  if (!['none', 'bearer', 'basic', 'header'].includes(authType)) throw new QaInputError('Tipe auth tidak dikenal.');
  const headerName = String(raw.auth?.headerName ?? '').trim();
  if (authType === 'header' && !/^[\w-]{1,100}$/.test(headerName)) throw new QaInputError('Nama header auth tidak valid.');
  const timeoutMs = Number(raw.timeoutMs ?? 30_000);
  return {
    id: raw.id && ID.test(raw.id) ? raw.id : '',
    name,
    baseUrl,
    services,
    headers: cleanRecord(raw.headers, 'Header'),
    variables: cleanRecord(raw.variables, 'Variabel'),
    auth: { type: authType, ...(authType === 'header' ? { headerName } : {}), ...(authType === 'basic' ? { username: String(raw.auth?.username ?? '').trim() } : {}) },
    readOnly: raw.readOnly === true,
    dbServer: cleanServer(raw.dbServer),
    databases: cleanDatabases(raw.databases),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1_000), 300_000) : 30_000,
  };
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'env';
  return `${base}-${randomUUID().slice(0, 6)}`;
}

export class QaManager {
  private readonly dir: string;
  private readonly jobs = new Map<string, QAGenerateJob & { cancel?: () => void }>();
  private readonly runs = new Map<string, { run: QARun; cancelled: boolean }>();

  constructor(private readonly deps: QaDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'qa');
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

  private projectId(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new QaInputError('Id proyek tidak valid.');
    return id;
  }

  // Environments ---------------------------------------------------------------------------

  /** A generation or run is in progress (only in this process's memory). */
  isBusy(): boolean {
    return [...this.jobs.values()].some((j) => j.status === 'running') || [...this.runs.values()].some((r) => r.run.status === 'running');
  }

  private envFile = () => join(this.dir, 'environments.json');

  /**
   * Databases saved before servers existed (each with its own host): when they share one server,
   * that becomes the environment's server (password copied), and each gets its service guessed
   * from the database name. Runs once per environment.
   */
  private async migrateDatabases(envs: QAEnvironment[]): Promise<boolean> {
    let changed = false;
    for (const env of envs) {
      const legacy = (env.databases ?? []).filter((d) => d.host);
      if (env.dbServer || !legacy.length) continue;
      const first = legacy[0];
      if (!legacy.every((d) => d.host === first.host && (d.port ?? 5432) === (first.port ?? 5432) && d.user === first.user)) continue;
      env.dbServer = { host: first.host!, port: first.port ?? 5432, user: first.user ?? '', ...(first.ssl ? { ssl: true } : {}) };
      const password = await this.deps.readSecret(dbSecretKey(env.id, first.name));
      if (password && !(await this.deps.readSecret(serverSecretKey(env.id)))) await this.deps.writeSecret(serverSecretKey(env.id), password);
      const guesses = matchDatabases(Object.keys(env.services), legacy.map((d) => d.database));
      env.databases = (env.databases ?? []).map((d) => {
        if (!d.host) return d;
        const service = d.service ?? Object.entries(guesses).find(([, db]) => db === d.database)?.[0];
        void this.deps.deleteSecret(dbSecretKey(env.id, d.name));
        return { name: service ?? d.name, ...(service ? { service } : {}), database: d.database };
      });
      changed = true;
    }
    return changed;
  }

  async listEnvironments(): Promise<QAEnvironment[]> {
    const envs = (await this.read<QAEnvironment[]>(this.envFile())) ?? [];
    if (await this.migrateDatabases(envs)) await this.write(this.envFile(), envs);
    return Promise.all(
      envs.map(async (e) => ({
        ...e,
        hasSecret: Boolean(await this.deps.readSecret(e.id)),
        secretVariableNames: Object.keys(await this.secretVariables(e.id)),
        dbServerPassword: Boolean(await this.deps.readSecret(serverSecretKey(e.id))),
        dbPasswords: Object.fromEntries(await Promise.all((e.databases ?? []).filter((d) => d.host).map(async (d) => [d.name, Boolean(await this.deps.readSecret(dbSecretKey(e.id, d.name)))] as const))),
      })),
    );
  }

  private async secretVariables(envId: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse((await this.deps.readSecret(`${envId}:vars`)) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /**
   * `secret`: undefined keeps the stored one, '' removes it. `secretVariables`: undefined keeps
   * them; an object replaces them, where an empty value keeps that variable's stored value.
   */
  async saveEnvironment(raw: Partial<QAEnvironment>, secret?: string, secretVariables?: Record<string, string>, dbPasswords?: Record<string, string>, dbServerPassword?: string): Promise<QAEnvironment[]> {
    const env = validateEnvironment(raw);
    const envs = (await this.read<QAEnvironment[]>(this.envFile())) ?? [];
    const index = env.id ? envs.findIndex((e) => e.id === env.id) : -1;
    if (index < 0) env.id = slug(env.name);
    if (dbServerPassword !== undefined) {
      if (dbServerPassword === '' || !env.dbServer) await this.deps.deleteSecret(serverSecretKey(env.id));
      else if (!(await this.deps.writeSecret(serverSecretKey(env.id), dbServerPassword))) throw new QaInputError('Gagal menyimpan password database ke Keychain.');
    }
    // Database passwords: '' removes, a value sets, absent keeps; removed databases lose theirs.
    for (const [name, value] of Object.entries(dbPasswords ?? {})) {
      if (!env.databases?.some((d) => d.name === name) || typeof value !== 'string') continue;
      if (value === '') await this.deps.deleteSecret(dbSecretKey(env.id, name));
      else if (!(await this.deps.writeSecret(dbSecretKey(env.id, name), value))) throw new QaInputError('Gagal menyimpan password database ke Keychain.');
    }
    for (const old of index >= 0 ? (envs[index].databases ?? []) : []) {
      if (!env.databases?.some((d) => d.name === old.name)) await this.deps.deleteSecret(dbSecretKey(env.id, old.name));
    }
    if (secret !== undefined) {
      if (secret === '') await this.deps.deleteSecret(env.id);
      else if (!(await this.deps.writeSecret(env.id, secret))) throw new QaInputError('Gagal menyimpan token ke Keychain.');
    }
    if (secretVariables !== undefined) {
      const current = await this.secretVariables(env.id);
      const next = Object.fromEntries(Object.entries(cleanRecord(secretVariables, 'Variabel rahasia')).map(([k, v]) => [k, v || current[k] || '']).filter(([, v]) => v));
      if (!Object.keys(next).length) await this.deps.deleteSecret(`${env.id}:vars`);
      else if (!(await this.deps.writeSecret(`${env.id}:vars`, JSON.stringify(next)))) throw new QaInputError('Gagal menyimpan variabel rahasia ke Keychain.');
      // A name can't be both plain and secret.
      for (const k of Object.keys(next)) delete env.variables[k];
    }
    if (index < 0) envs.push(env);
    else envs[index] = env;
    await this.write(this.envFile(), envs);
    return this.listEnvironments();
  }

  /** Connection of one database: its own host, or the environment's server. */
  private connection(env: QAEnvironment, db: QADatabase): QADbConnection {
    const server = env.dbServer;
    const host = db.host ?? server?.host;
    if (!host) throw new QaDbError(`Server database environment ${env.name} belum diatur.`);
    return { name: db.name, host, port: db.port ?? server?.port ?? 5432, user: db.user ?? server?.user ?? '', database: db.database, ssl: db.ssl ?? server?.ssl };
  }

  private async password(env: QAEnvironment, db?: QADatabase): Promise<string | undefined> {
    return ((db?.host && (await this.deps.readSecret(dbSecretKey(env.id, db.name)))) || (await this.deps.readSecret(serverSecretKey(env.id)))) ?? undefined;
  }

  /** Database by name or service (case-insensitive). */
  private findDb(env: QAEnvironment, name: string): QADatabase | undefined {
    const n = name.toLowerCase();
    return env.databases?.find((d) => d.name.toLowerCase() === n) ?? env.databases?.find((d) => d.service?.toLowerCase() === n);
  }

  /** Read-only query on one of the environment's databases. */
  private dbQuery(env: QAEnvironment): (name: string, sql: string) => Promise<QADbResult> {
    return async (name, sql) => {
      const db = this.findDb(env, name);
      if (!db) throw new QaDbError(`Database "${name}" tidak ada di environment ${env.name}.`);
      return (this.deps.db ?? REAL_DB).query(this.connection(env, db), await this.password(env, db), sql);
    };
  }

  private async savedEnv(envId: string): Promise<QAEnvironment> {
    const env = (await this.read<QAEnvironment[]>(this.envFile()))?.find((e) => e.id === envId);
    if (!env) throw new QaInputError('Environment tidak ditemukan; simpan dulu.');
    return env;
  }

  /** "Tes koneksi": the server (no name) or one mapped database. */
  async testDatabase(envId: string, name?: string): Promise<string> {
    const env = await this.savedEnv(envId);
    try {
      if (name) {
        const db = this.findDb(env, name);
        if (!db) throw new QaInputError('Database tidak ditemukan; simpan environment dulu.');
        return await (this.deps.db ?? REAL_DB).test(this.connection(env, db), await this.password(env, db));
      }
      if (!env.dbServer) throw new QaInputError('Isi server database dulu.');
      return await (this.deps.db ?? REAL_DB).test({ name: 'server', ...env.dbServer, database: 'postgres' }, await this.password(env));
    } catch (e) {
      throw new QaInputError((e as Error).message);
    }
  }

  /** Database names on the environment's server, to map services to them. */
  async listServerDatabases(envId: string): Promise<string[]> {
    const env = await this.savedEnv(envId);
    if (!env.dbServer) throw new QaInputError('Isi server database dulu.');
    try {
      return await (this.deps.db ?? REAL_DB).list({ name: 'server', ...env.dbServer, database: 'postgres' }, await this.password(env));
    } catch (e) {
      throw new QaInputError((e as Error).message);
    }
  }

  async deleteEnvironment(id: string): Promise<QAEnvironment[]> {
    const envs = (await this.read<QAEnvironment[]>(this.envFile())) ?? [];
    for (const d of envs.find((e) => e.id === id)?.databases ?? []) await this.deps.deleteSecret(dbSecretKey(id, d.name));
    await this.deps.deleteSecret(serverSecretKey(id));
    await this.write(
      this.envFile(),
      envs.filter((e) => e.id !== id),
    );
    await this.deps.deleteSecret(id);
    await this.deps.deleteSecret(`${id}:vars`);
    return this.listEnvironments();
  }

  // Suites ---------------------------------------------------------------------------------

  private suiteFile = (projectId: string) => join(this.dir, 'suites', `${this.projectId(projectId)}.json`);

  async getSuite(projectId: string): Promise<QASuite | null> {
    return (await this.read<QASuite>(this.suiteFile(projectId))) ?? null;
  }

  /**
   * Suites and runs used to be stored per TAD (same folders, keyed by the draft id). When a
   * project has no suite yet, it takes over the flows and run history of its TADs, once.
   */
  async adoptLegacy(projectId: string, projectName: string, draftIds: string[]): Promise<QASuite | null> {
    const id = this.projectId(projectId);
    const current = await this.getSuite(id);
    if (current) return current;
    const legacy: { draftId: string; suite: QASuite & { draftId?: string; tadTitle?: string } }[] = [];
    for (const draftId of draftIds.filter((d) => ID.test(d) && d !== id)) {
      const suite = await this.read<QASuite & { draftId?: string; tadTitle?: string }>(this.suiteFile(draftId));
      if (suite?.flows?.length) legacy.push({ draftId, suite });
    }
    if (!legacy.length) return null;
    const now = new Date().toISOString();
    const notes = legacy.map((l) => l.suite.notes).filter(Boolean).join('\n\n');
    const merged = await this.saveSuite({ projectId: id, projectName, flows: legacy.flatMap((l) => l.suite.flows), notes: notes || undefined, generatedAt: legacy[0].suite.generatedAt, ai: legacy[0].suite.ai, updatedAt: now });
    const archive = join(this.dir, 'suites', 'migrated');
    await mkdir(archive, { recursive: true, mode: 0o700 });
    for (const { draftId } of legacy) {
      await rename(this.suiteFile(draftId), join(archive, `${draftId}.json`)).catch(() => {});
      // Run history moves along (the old runs still say draftId/tadTitle; they are read as is).
      for (const name of await readdir(this.runDir(draftId)).catch(() => [] as string[])) {
        await mkdir(this.runDir(id), { recursive: true, mode: 0o700 });
        await rename(join(this.runDir(draftId), name), join(this.runDir(id), name)).catch(() => {});
      }
      await rm(this.runDir(draftId), { recursive: true, force: true });
    }
    return merged;
  }

  async saveSuite(suite: QASuite): Promise<QASuite> {
    const saved = { ...suite, projectId: this.projectId(suite.projectId), updatedAt: new Date().toISOString() };
    await this.write(this.suiteFile(saved.projectId), saved);
    return saved;
  }

  // Generation -----------------------------------------------------------------------------

  async generate(req: QAGenerateRequest): Promise<QAGenerateJob> {
    const projectId = this.projectId(req.projectId);
    if (!req.tasks?.length) throw new QaInputError('Pilih minimal satu task.');
    if (!req.ai?.provider) throw new QaInputError('Pilih provider AI.');
    const busy = [...this.jobs.values()].find((j) => j.projectId === projectId && j.status === 'running');
    if (busy) return busy;

    const job: QAGenerateJob & { cancel?: () => void } = { id: randomUUID(), projectId, status: 'running', startedAt: new Date().toISOString(), progress: 'Menyiapkan prompt…' };
    this.jobs.set(job.id, job);
    // The environment's databases: their schema lets the AI write real-data queries (never passwords).
    req = { ...req, databases: undefined };
    const env = req.environmentId ? (await this.read<QAEnvironment[]>(this.envFile()))?.find((e) => e.id === req.environmentId) : undefined;
    if (env?.databases?.length) {
      // Only the databases of the selected tasks' services (a project has many microservices).
      const wanted = new Set(req.tasks.map((t) => t.service?.toLowerCase()).filter(Boolean));
      let picked = env.databases.filter((d) => wanted.has((d.service ?? d.name).toLowerCase()));
      if (!picked.length && env.databases.length <= 3) picked = env.databases;
      picked = picked.slice(0, MAX_SCHEMA_DBS);
      if (picked.length) {
        job.progress = `Membaca skema ${picked.length} database…`;
        req.databases = await Promise.all(
          picked.map(async (d) => {
            try {
              return { name: d.name, service: d.service, schema: await (this.deps.db ?? REAL_DB).schema(this.connection(env, d), await this.password(env, d)) };
            } catch (e) {
              return { name: d.name, service: d.service, schema: '', error: (e as Error).message };
            }
          }),
        );
      }
    }
    // Empty working folder: the AI gets the TAD in the prompt and has nothing else to read.
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-qa-'));
    // The codebase (read-only): routes, payloads and responses are checked against the code.
    let codebase: { root: string; folders: string[] } | undefined;
    // Only the CLI agents can read files; API providers generate from the TAD alone.
    const canRead = req.ai.provider === 'claude' || req.ai.provider === 'antigravity';
    if (req.useCodebase !== false && canRead && this.deps.resolveServicesRoot) {
      try {
        const root = await this.deps.resolveServicesRoot(req.servicesRoot ?? '');
        const all = await readdir(root, { withFileTypes: true }).catch(() => []);
        const names = all.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
        const folders = [...new Set(req.tasks.map((t) => names.find((n) => n.toLowerCase() === (t.service ?? '').toLowerCase())).filter((n): n is string => Boolean(n)))];
        codebase = { root, folders };
        req.codebase = codebase;
      } catch {
        // No codebase folder: generate from the TAD alone.
      }
    }
    const changed = codebase && this.deps.watchRepos ? await this.deps.watchRepos(codebase.root).catch(() => undefined) : undefined;
    // Shown until the AI streams its own progress (a big prompt can take a few minutes).
    job.progress = `AI menyusun skenario${req.databases?.length ? ` dengan skema ${req.databases.length} database` : ''}… biasanya beberapa menit.`;
    const run = this.deps.runAi(req.ai, buildQaPrompt(req), {
      cwd,
      timeoutMs: GENERATE_TIMEOUT_MS,
      systemPrompt: QA_SYSTEM_PROMPT,
      readOnlyDirs: codebase ? [codebase.root] : [],
      onProgress: (text) => (job.progress = text.slice(0, 200)),
    });
    job.cancel = run.cancel;
    void run.done
      .then(async (outcome) => {
        if (job.status === 'cancelled') return;
        if (outcome.error) throw new Error(outcome.error);
        let parsed: ReturnType<typeof parseQaReply>;
        try {
          parsed = parseQaReply(outcome.reply, req.tasks.map((t) => t.title));
        } catch (e) {
          job.rawReply = outcome.reply.slice(0, 50_000);
          throw e;
        }
        const { flows } = parsed;
        let notes = parsed.notes;
        // The codebase is read-only: report any change found in a repo's working tree.
        const touched = changed ? await changed().catch(() => []) : [];
        if (touched.length) notes = `${notes ? `${notes}\n\n` : ''}PERINGATAN: working tree berubah selama generate di ${touched.join(', ')}. Periksa repo tersebut.`;
        const now = new Date().toISOString();
        const suite: QASuite = {
          projectId,
          projectName: req.projectName,
          flows: [...(req.existing ?? []), ...flows],
          notes,
          generatedAt: now,
          ai: req.ai,
          updatedAt: now,
        };
        job.suite = await this.saveSuite(suite);
        job.status = 'done';
      })
      .catch((e: Error) => {
        if (job.status === 'running') {
          job.status = 'error';
          job.error = e.message;
        }
      })
      .finally(() => {
        job.finishedAt ??= new Date().toISOString();
        job.cancel = undefined;
        void rm(cwd, { recursive: true, force: true });
      });
    return this.publicJob(job);
  }

  private publicJob(job: QAGenerateJob & { cancel?: () => void }): QAGenerateJob {
    const { cancel: _cancel, ...rest } = job;
    return rest;
  }

  getJob(id: string): QAGenerateJob | undefined {
    const job = this.jobs.get(id);
    return job && this.publicJob(job);
  }

  latestJob(projectId: string): QAGenerateJob | undefined {
    const all = [...this.jobs.values()].filter((j) => j.projectId === projectId);
    const job = all[all.length - 1];
    return job && this.publicJob(job);
  }

  cancelJob(id: string): QAGenerateJob | undefined {
    const job = this.jobs.get(id);
    if (job?.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.cancel?.();
    }
    return job && this.publicJob(job);
  }

  // Runs -----------------------------------------------------------------------------------

  private runDir = (projectId: string) => join(this.dir, 'runs', this.projectId(projectId));

  async startRun(req: QARunRequest): Promise<QARun> {
    const projectId = this.projectId(req.projectId);
    const active = [...this.runs.values()].find((r) => r.run.projectId === projectId && r.run.status === 'running');
    if (active) throw new QaInputError('Masih ada run E2E yang berjalan untuk TAD ini.');
    const suite = await this.getSuite(projectId);
    if (!suite) throw new QaInputError('Belum ada skenario E2E untuk TAD ini.');
    const env = (await this.read<QAEnvironment[]>(this.envFile()))?.find((e) => e.id === req.environmentId);
    if (!env) throw new QaInputError('Environment tidak ditemukan.');
    const flows: QAFlow[] = req.flowIds?.length ? suite.flows.filter((f) => req.flowIds!.includes(f.id)) : suite.flows.filter((f) => f.enabled);
    if (!flows.length) throw new QaInputError('Tidak ada flow yang dipilih.');
    const secret = env.auth.type === 'none' ? undefined : ((await this.deps.readSecret(env.id)) ?? undefined);
    const secretVariables = await this.secretVariables(env.id);

    const run: QARun = {
      id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`,
      projectId,
      projectName: suite.projectName,
      environment: { id: env.id, name: env.name, readOnly: env.readOnly },
      status: 'running',
      startedAt: new Date().toISOString(),
      flows: flows.map((f) => ({ flowId: f.id, name: f.name, category: f.category, taskTitles: f.taskTitles, status: 'pending', steps: [] })),
      summary: summarize([]),
    };
    const state = { run, cancelled: false };
    this.runs.set(run.id, state);

    void (async () => {
      // One journey: values extracted by a flow are available to the next ones.
      const carried = { values: {} as Record<string, string>, from: {} as Record<string, string> };
      for (const [i, flow] of flows.entries()) {
        if (state.cancelled) {
          run.flows[i].status = 'skipped';
          continue;
        }
        run.flows[i].status = 'running';
        run.flows[i] = await runFlow(flow, i, {
          env,
          secret,
          secretVariables,
          fetch: this.deps.fetch,
          query: env.databases?.length ? this.dbQuery(env) : undefined,
          carried,
          cancelled: () => state.cancelled,
          onStep: (fi, step) => {
            run.flows[fi].steps.push(step);
            run.summary = summarize(run.flows);
          },
        });
        run.summary = summarize(run.flows);
      }
      // Persist first, then flip the live status: a reader that sees "done" can rely on the file.
      const finished: QARun = { ...run, status: state.cancelled ? 'cancelled' : 'done', finishedAt: new Date().toISOString(), summary: summarize(run.flows) };
      await this.write(join(this.runDir(projectId), `${run.id}.json`), finished);
      Object.assign(run, finished);
      await this.pruneRuns(projectId);
    })().catch(() => {
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
    });
    return run;
  }

  private async pruneRuns(projectId: string) {
    const names = (await readdir(this.runDir(projectId)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - KEEP_RUNS))) await rm(join(this.runDir(projectId), n), { force: true });
  }

  async getRun(projectId: string, id: string): Promise<QARun | undefined> {
    const live = this.runs.get(id)?.run;
    if (live && live.projectId === projectId) return live;
    if (!ID.test(id)) return undefined;
    return this.read<QARun>(join(this.runDir(projectId), `${id}.json`));
  }

  async listRuns(projectId: string): Promise<QARun[]> {
    const names = (await readdir(this.runDir(projectId)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort().reverse();
    const stored = (await Promise.all(names.map((n) => this.read<QARun>(join(this.runDir(projectId), n))))).filter((r): r is QARun => Boolean(r));
    const live = [...this.runs.values()].map((r) => r.run).filter((r) => r.projectId === projectId && r.status === 'running');
    return [...live, ...stored.filter((r) => !live.some((l) => l.id === r.id))];
  }

  cancelRun(id: string): QARun | undefined {
    const state = this.runs.get(id);
    if (state && state.run.status === 'running') state.cancelled = true;
    return state?.run;
  }
}
