import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  ChangelogRequest,
  ConnectorError,
  ConnectorStatus,
  PreflightRequest,
  PreflightResponse,
  PublishRequest,
  PublishResponse,
} from '../src/lib/confluence/api-types.ts';
import { appendAudit, readAudit } from './audit.ts';
import { ConfluenceClient, ConfluenceError, type ConfluenceConfig } from './confluence.ts';
import { generateConfluenceChangelog } from './confluence-changelog.ts';
import type { StartGeneratorJobRequest } from '../src/lib/generator/types.ts';
import { generatorJobs, JobConflictError } from './generator-jobs.ts';
import { listProviders, startProviderRun, terminateProviderProcess } from './ai-providers.ts';
import { CoderError, CoderRuns, type CoderJira } from './coder-runs.ts';
import { syncCoderRun } from './coder-agent-sync.ts';
import type { CoderRun } from '../src/lib/coder/types.ts';
import type { StartCoderRunRequest } from '../src/lib/coder/types.ts';
import { getUsage } from './usage.ts';
import { agyReadAccess, grantAgyReadAccess } from './agy-settings.ts';
import { diffSnapshots, resolveServicesRoot, servicesInfo, snapshotRepos } from './services.ts';
import { SECRET_SERVICES, SettingsInputError, SettingsStore, applySettingsToEnv } from './settings.ts';
import { readEnvLocalVar } from './env-file.ts';
import type { AppSettings, SecretId, SettingsResponse } from '../src/lib/settings/types.ts';
import { EstimateInputError, EstimateManager } from './estimate/manager.ts';
import type { EstimateProject, EstimateRequest } from '../src/lib/estimate/types.ts';
import { deleteDoc, listDocs, saveDoc, unlockDoc } from './workspace-docs.ts';
import { PdfPasswordError } from './pdf-unlock.ts';
import { QA_KEYCHAIN_SERVICE, QaInputError, QaManager } from './qa/manager.ts';
import { normalizeEditedFlow } from './qa/generator.ts';
import { ReportInputError, ReportVps, type ReportSettings } from './report/vps.ts';
import { ManualMrError, ManualMrs } from './gitlab-manual.ts';
import { JiraLoadError, jiraCandidates, jiraLoads } from './estimate/jira-load.ts';
import { BugInputError, BugManager } from './bugs/manager.ts';
import { TraceInputError, TraceManager } from './trace/manager.ts';
import { syncTraceTurn } from './trace/agent-sync.ts';
import { TaskPeakStore } from './task-peaks.ts';
import { bugFixSpec } from './bugs/analysis.ts';
import { bugDraftId, type BugAnalyzeRequest, type BugCaseInput, type BugTicketRequest } from '../src/lib/bugs/types.ts';

const manualMrs = new ManualMrs();
import type { QAEnvironment, QAGenerateRequest, QARunRequest, QASuite } from '../src/lib/qa/types.ts';
import { isAiSelection } from '../src/lib/ai/types.ts';
import { isValidDraftId } from './generator-runner.ts';
import { DraftFileError, DraftFiles } from './drafts-store.ts';
import { renderCockpitContext, type CockpitState, type DraftForContext } from './cockpit-context.ts';
import { ConversationError, ConversationFiles } from './conversations-store.ts';
import { CONFLUENCE_SERVICE, JIRA_SERVICE, GITLAB_SERVICE, deleteKeychain, readKeychain, writeKeychain } from './keychain.ts';
import { transitionWithChecks, type TransitionRequest } from './jira-transition.ts';
import { TadTicketError, createTadTickets, ticketTemplate, validateTicketRequest } from './tad-tickets.ts';
import { GitLabClient, GitLabError, normalizeBaseUrl, parseMrUrl } from './gitlab.ts';
import type { WaDraftRequest, WaDraftResponse, WaSendRequest } from '../src/lib/whatsapp/types.ts';
import { AUDIENCES } from '../src/lib/whatsapp/types.ts';
import { draftReply } from './whatsapp/drafter.ts';
import { readTemplates, validateTemplates, writeTemplates } from './whatsapp/templates.ts';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { handleAssistantChat, type AssistantChatRequest } from './assistant.ts';
import { resolveRepoPath } from './git-review.ts';
import { checkClaudeCloudAuth, startClaudeCloudSession, sendClaudeCloudMessage, runClaudeUltrareview } from './claude-cloud.ts';
import { JiraClient, JiraError, type JiraConfig, type JiraStatus } from './jira.ts';
import { agentRuntime, type AgentRuntime } from './agent-runtime.ts';
import { AgentTaskError, isAgentTaskId, type AgentTask, type AgentTaskStatus, type AgentTaskStore } from './agent-tasks.ts';
import { REMOTE_DIR, remoteAccess, shutdownRemote, type RemoteAccess } from './remote/manager.ts';
import { connectorMobileData } from './remote/mobile-data.ts';
import { handleRemoteRoutes } from './remote/routes.ts';

/**
 * Local connector served by the Vite dev server under /api/connector. It holds the
 * Confluence token (read from the macOS Keychain) so the browser never sees it.
 * This is the stand-in for the Tauri/Go sidecar connector described in PLAN.md.
 */

const PREFIX = '/api/connector';
const MAX_BODY = 25 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Env = Record<string, string>;

/** Seams for tests; production reads the token from the Keychain and audits to ~/.tech-lead-cockpit. */
export interface ConnectorDeps {
  readToken: () => Promise<string | null>;
  appendAudit: typeof appendAudit;
  readAudit: typeof readAudit;
  logError: (message: string) => void;
  /** Agent Tasks list (local coding-agent runs); defaults to the process-wide store. */
  agentRuntime?: () => AgentRuntime;
  /** Code traces; defaults to the process-wide manager. Tests inject one with a fake AI. */
  traceManager?: (deps: ConnectorDeps) => TraceManager;
  /** Furthest stage per task (anti-regression); defaults to ~/.tech-lead-cockpit/task-peaks.json. */
  taskPeaks?: TaskPeakStore;
  /** E2E test manager; defaults to the process-wide singleton. */
  qa?: () => QaManager;
  /** Scheduled progress report (VPS over SSH); defaults to the process-wide instance. */
  report?: () => ReportVps;
  /** Effort estimate manager; defaults to the process-wide singleton. */
  estimate?: () => EstimateManager;
  /** Remote Access (phone over Tailscale); defaults to the process-wide instance. */
  remote?: () => RemoteAccess;
}

const defaultDeps: Omit<ConnectorDeps, 'logError'> = {
  readToken: () => readKeychain(CONFLUENCE_SERVICE),
  appendAudit,
  readAudit,
};

const settingsStore = new SettingsStore();

/** Env keys the Koneksi page writes, as settings, so settings.json stays the source of truth. */
function settingsPatchFromEnv(vars: Record<string, string>): Partial<AppSettings> {
  const patch: Record<string, Record<string, string>> = {};
  const put = (section: string, key: string, v?: string) => v !== undefined && ((patch[section] ??= {})[key] = v);
  put('confluence', 'baseUrl', vars.CONFLUENCE_BASE_URL);
  put('confluence', 'auth', vars.CONFLUENCE_AUTH);
  put('confluence', 'email', vars.CONFLUENCE_EMAIL);
  put('jira', 'baseUrl', vars.JIRA_BASE_URL);
  put('jira', 'auth', vars.JIRA_AUTH);
  put('jira', 'email', vars.JIRA_EMAIL);
  put('gitlab', 'baseUrl', vars.GITLAB_BASE_URL);
  return patch as Partial<AppSettings>;
}

async function updateEnvLocal(vars: Record<string, string>) {
  await settingsStore.update(settingsPatchFromEnv(vars)).catch(() => {});
  const envPath = path.resolve(process.cwd(), '.env.local');
  let content = '';
  try {
    content = await readFile(envPath, 'utf8');
  } catch {
    content = '';
  }

  for (const [key, val] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content = content.trimEnd() + `\n${key}=${val}\n`;
    }
  }

  await writeFile(envPath, content.trim() + '\n', 'utf8');
}

function flavorOf(env: Env): ConfluenceConfig['flavor'] {
  if (env.CONFLUENCE_FLAVOR === 'cloud' || env.CONFLUENCE_FLAVOR === 'datacenter') return env.CONFLUENCE_FLAVOR;
  return /\.atlassian\.net/i.test(env.CONFLUENCE_BASE_URL ?? '') ? 'cloud' : 'datacenter';
}

function jiraFlavorOf(env: Env, baseUrl: string): 'cloud' | 'datacenter' {
  if (env.JIRA_FLAVOR === 'cloud' || env.JIRA_FLAVOR === 'datacenter') return env.JIRA_FLAVOR;
  return /\.atlassian\.net/i.test(baseUrl) ? 'cloud' : 'datacenter';
}

async function loadConfig(env: Env, readToken: ConnectorDeps['readToken']): Promise<{ cfg?: ConfluenceConfig; status: ConnectorStatus }> {
  const baseUrl = (env.CONFLUENCE_BASE_URL ?? '').trim();
  const auth = env.CONFLUENCE_AUTH === 'basic' ? 'basic' : 'bearer';
  if (!baseUrl) {
    return { status: { configured: false, tokenPresent: false, error: 'URL Confluence belum diatur (Setup → Jira & Confluence).' } };
  }
  const flavor = flavorOf(env);
  const token = await readToken();
  const status: ConnectorStatus = { configured: false, flavor, baseUrl, auth, tokenPresent: Boolean(token) };
  if (!token) return { status: { ...status, error: 'Token belum ada di Keychain. Jalankan: npm run token:confluence' } };
  if (auth === 'basic' && !env.CONFLUENCE_EMAIL) return { status: { ...status, error: 'CONFLUENCE_EMAIL wajib untuk auth basic (Cloud).' } };
  return { cfg: { baseUrl, flavor, auth, email: env.CONFLUENCE_EMAIL, token }, status: { ...status, configured: true } };
}

async function loadJiraConfig(env: Env): Promise<{ cfg?: JiraConfig; status: JiraStatus }> {
  let baseUrl = (env.JIRA_BASE_URL ?? '').trim();
  if (!baseUrl && env.CONFLUENCE_BASE_URL) {
    baseUrl = env.CONFLUENCE_BASE_URL.replace(/\/wiki\/?$/, '').trim();
  }
  const email = (env.JIRA_EMAIL ?? env.CONFLUENCE_EMAIL ?? '').trim();
  const auth = (env.JIRA_AUTH === 'bearer' ? 'bearer' : 'basic') as 'basic' | 'bearer';

  if (!baseUrl) {
    return { status: { configured: false, tokenPresent: false, error: 'URL Jira belum diatur (Setup → Jira & Confluence).' } };
  }

  const flavor = jiraFlavorOf(env, baseUrl);
  let token = await readKeychain(JIRA_SERVICE);
  if (!token) {
    token = await readKeychain(CONFLUENCE_SERVICE);
  }

  const status: JiraStatus = {
    configured: false,
    flavor,
    baseUrl,
    auth,
    email: email || undefined,
    tokenPresent: Boolean(token),
  };

  if (!token) {
    return { status: { ...status, error: 'Token Jira belum ada di Keychain. Hubungkan lewat menu Koneksi.' } };
  }

  if (auth === 'basic' && !email) {
    return { status: { ...status, error: 'JIRA_EMAIL wajib untuk auth basic (Cloud).' } };
  }

  return {
    cfg: { baseUrl, flavor, auth, email, token },
    status: { ...status, configured: true },
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, body: ConnectorError) {
  send(res, status, body);
}

async function readJson<T>(req: IncomingMessage, maxBytes = MAX_BODY): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ConfluenceError('Payload terlalu besar.', 413, 'bad-request');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ConfluenceError('Body bukan JSON yang valid.', 400, 'bad-request');
  }
}

/**
 * Blocks other websites open in the same browser from driving the connector:
 * requests must come from the app's own origin and carry a custom header, which a
 * cross-site page cannot add without a CORS preflight we never approve.
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  if (req.headers['x-tlc-client'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try {
    return ALLOWED_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function requireFields(body: object, fields: string[]) {
  const record = body as Record<string, unknown>;
  const missing = fields.filter((f) => typeof record[f] !== 'string' || !(record[f] as string).trim());
  if (missing.length) throw new ConfluenceError(`Field wajib kosong: ${missing.join(', ')}`, 400, 'bad-request');
}

export function devConnector(env: Env): Plugin {
  return {
    name: 'tlc-dev-connector',
    configureServer(server) {
      server.middlewares.use(connectorMiddleware(env, { ...defaultDeps, logError: (m) => server.config.logger.error(m) }));
      // Remote never outlives the connector: a dev-server stop or restart closes its listener.
      server.httpServer?.once('close', () => void shutdownRemote('connector-restart'));
      // Vitest also runs configureServer; resuming there would open a second socket with the same
      // credentials and kick the real dev server's WhatsApp session off.
      if (process.env.VITEST) return;
      // Loaded lazily: Baileys keeps sockets/timers alive, so only pull it in when WhatsApp is used.
      import('./whatsapp/session.ts')
        .then((m) => m.resumeWhatsAppIfLinked())
        .catch((e) => server.config.logger.error(`[whatsapp] ${(e as Error).message}`));
    },
  };
}

export function connectorMiddleware(env: Env, deps: ConnectorDeps) {
  // Settings from the wizard (migrated from .env.local on the first run) override env for this process.
  const ready = process.env.VITEST
    ? Promise.resolve()
    : settingsStore
        .load(env)
        .then(({ settings }) => applySettingsToEnv(settings, env, process.env))
        .catch((e) => deps.logError(`[settings] ${(e as Error).message}`));
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    await ready;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(PREFIX)) return next();
    if (!isTrustedRequest(req)) return fail(res, 403, { error: 'Request ditolak: origin tidak dikenal.' });

    const route = `${req.method} ${url.pathname.slice(PREFIX.length)}`;
    try {
      // Polled every few seconds: handled before loadConfig so it never touches the Keychain.
      if (url.pathname.startsWith(`${PREFIX}/remote/`)) return await handleRemoteRoutes(route, req, res, (deps.remote ?? (() => remoteFor(env, deps)))());
      if (url.pathname.startsWith(`${PREFIX}/wa/`)) return await handleWhatsApp(route, url, req, res, deps.appendAudit);
      if (url.pathname.startsWith(`${PREFIX}/teams/`)) return await handleTeams(route, url, req, res, deps.appendAudit);
      if (url.pathname === `${PREFIX}/agent-tasks` || url.pathname.startsWith(`${PREFIX}/agent-tasks/`)) {
        return await handleAgents(route, url, req, res, deps.agentRuntime ?? (() => agentRuntime()), env, deps);
      }
      if (url.pathname.startsWith(`${PREFIX}/chat/`)) return await handleGeneratorJobs(route, url, req, res);
      if (url.pathname === `${PREFIX}/bugs` || url.pathname.startsWith(`${PREFIX}/bugs/`)) return await handleBugs(route, url, req, res, env, deps);
      if (url.pathname === `${PREFIX}/traces` || url.pathname.startsWith(`${PREFIX}/traces/`)) return await handleTraces(route, url, req, res, deps);
      if (route === 'GET /progress/task-peaks') return send(res, 200, await (deps.taskPeaks ?? defaultTaskPeaks).read());
      if (route === 'POST /progress/task-peaks') {
        const body = await readJson<{ peaks?: Record<string, unknown> }>(req, 512 * 1024);
        return send(res, 200, await (deps.taskPeaks ?? defaultTaskPeaks).raise(body.peaks ?? {}));
      }
      if (url.pathname === `${PREFIX}/settings` || url.pathname.startsWith(`${PREFIX}/settings/`)) return await handleSettings(route, req, res, env);
      if (url.pathname.startsWith(`${PREFIX}/estimate/`)) return await handleEstimate(route, url, req, res, (deps.estimate ?? estimateManager)());
      if (url.pathname.startsWith(`${PREFIX}/report/`)) return await handleReport(route, req, res, (deps.report ?? (() => (reportVps ??= new ReportVps())))(), deps.appendAudit);
      if (url.pathname.startsWith(`${PREFIX}/qa/`)) return await handleQa(route, url, req, res, (deps.qa ?? qaManager)(), deps.appendAudit);
      if (route.endsWith(' /drafts') || url.pathname.startsWith(`${PREFIX}/drafts/`)) return await handleDrafts(route, req, res);
      if (url.pathname.startsWith(`${PREFIX}/assistant/conversations`)) return await handleConversations(route, url, req, res);
      if (url.pathname.startsWith(`${PREFIX}/gitlab/`)) return await handleGitLab(route, url, req, res, env);
      if (url.pathname.startsWith(`${PREFIX}/coder/`)) return await handleCoder(route, url, req, res, env, deps);
      if (route === 'GET /ai/providers') return send(res, 200, await listProviders());
      if (route === 'GET /ai/usage') return send(res, 200, await getUsage(url.searchParams.get('refresh') === '1'));
      if (route === 'GET /ai/services') {
        const info = await servicesInfo(url.searchParams.get('root') ?? undefined);
        const antigravity = info.exists ? await agyReadAccess(info.root) : { granted: false, settingsFile: '' };
        return send(res, 200, { ...info, antigravity });
      }
      if (route === 'POST /ai/antigravity/grant') {
        const { root } = await readJson<{ root?: string }>(req);
        let resolved: string;
        try {
          resolved = await resolveServicesRoot(root);
        } catch (e) {
          throw new ConfluenceError((e as Error).message, 400, 'bad-request');
        }
        await grantAgyReadAccess(resolved);
        return send(res, 200, await agyReadAccess(resolved));
      }
      if (route === 'POST /ai/assistant/chat') {
        const body = await readJson<AssistantChatRequest>(req);
        const cockpitContext = async (prompt: string) => renderCockpitContext(await gatherCockpitState(env, deps), prompt);
        return await handleAssistantChat(req, res, body, cockpitContext, conversationFiles);
      }
      if (route === 'GET /ai/claude-cloud/status') {
        return send(res, 200, await checkClaudeCloudAuth());
      }
      if (route === 'POST /ai/claude-cloud/start') {
        const body = await readJson<{ repo?: string; root?: string; prompt: string; mode?: 'cloud' | 'ultrareview'; target?: string }>(req);
        if (!body.prompt?.trim() && body.mode !== 'ultrareview') {
          throw new ConfluenceError('Parameter prompt wajib diisi.', 400, 'bad-request');
        }
        const { repoPath } = await resolveRepoPath(body.repo, body.root);
        if (body.mode === 'ultrareview') {
          return send(res, 200, await runClaudeUltrareview({ cwd: repoPath, target: body.target }));
        }
        return send(res, 200, await startClaudeCloudSession({ cwd: repoPath, prompt: body.prompt }));
      }
      if (route === 'POST /ai/claude-cloud/message') {
        const body = await readJson<{ sessionId: string; message: string }>(req);
        if (!body.sessionId?.trim() || !body.message?.trim()) {
          throw new ConfluenceError('Parameter sessionId dan message wajib diisi.', 400, 'bad-request');
        }
        return send(res, 200, await sendClaudeCloudMessage(body.sessionId, body.message));
      }
      if (route === 'POST /open-external') {
        const body = await readJson<{ url?: string }>(req);
        const trimmed = body.url?.trim();
        if (!trimmed || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('mailto:'))) {
          throw new ConfluenceError('URL tidak valid atau protokol tidak didukung.', 400, 'bad-request');
        }
        const opener = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', trimmed] : [trimmed];
        execFile(opener, args, (err) => {
          if (err) console.error('[open-external] error:', err);
        });
        return send(res, 200, { ok: true });
      }
      const { cfg, status } = await loadConfig(env, deps.readToken);

      if (route === 'GET /status') {
        if (!cfg) return send(res, 200, status);
        try {
          const user = await new ConfluenceClient(cfg).currentUser();
          return send(res, 200, { ...status, user });
        } catch (e) {
          return send(res, 200, { ...status, configured: false, error: (e as Error).message });
        }
      }

      if (route === 'POST /confluence/save-token') {
        const body = await readJson<{ token: string; baseUrl?: string; email?: string }>(req);
        if (!body.token?.trim()) throw new ConfluenceError('Token tidak boleh kosong.', 400, 'bad-request');
        await writeKeychain(CONFLUENCE_SERVICE, body.token.trim());
        const updates: Record<string, string> = {};
        if (body.baseUrl) {
          updates['CONFLUENCE_BASE_URL'] = body.baseUrl.trim();
          env['CONFLUENCE_BASE_URL'] = body.baseUrl.trim();
        }
        if (body.email) {
          updates['CONFLUENCE_EMAIL'] = body.email.trim();
          updates['CONFLUENCE_AUTH'] = 'basic';
          env['CONFLUENCE_EMAIL'] = body.email.trim();
          env['CONFLUENCE_AUTH'] = 'basic';
        }
        if (Object.keys(updates).length > 0) {
          await updateEnvLocal(updates);
        }
        return send(res, 200, { ok: true, message: 'Token Confluence berhasil disimpan ke Keychain.' });
      }

      if (route === 'POST /confluence/changelog') {
        const body = await readJson<ChangelogRequest>(req, 512 * 1024);
        try {
          const message = await generateConfluenceChangelog(body);
          return send(res, 200, { message });
        } catch (err) {
          throw new ConfluenceError((err as Error).message, 500, 'upstream');
        }
      }

      if (route === 'GET /jira/status') {
        const { cfg: jCfg, status: jStatus } = await loadJiraConfig(env);
        if (!jCfg) return send(res, 200, jStatus);
        try {
          const user = await new JiraClient(jCfg).currentUser();
          return send(res, 200, { ...jStatus, configured: true, user });
        } catch (e) {
          return send(res, 200, { ...jStatus, configured: false, error: (e as Error).message });
        }
      }

      if (route === 'POST /jira/save-token') {
        const body = await readJson<{ token: string; baseUrl?: string; email?: string; syncConfluence?: boolean }>(req);
        if (!body.token?.trim()) throw new JiraError('Token tidak boleh kosong.', 400, 'bad-request');
        await writeKeychain(JIRA_SERVICE, body.token.trim());

        const updates: Record<string, string> = {};
        if (body.baseUrl) {
          updates['JIRA_BASE_URL'] = body.baseUrl.trim();
          env['JIRA_BASE_URL'] = body.baseUrl.trim();
        }
        if (body.email) {
          updates['JIRA_EMAIL'] = body.email.trim();
          updates['JIRA_AUTH'] = 'basic';
          env['JIRA_EMAIL'] = body.email.trim();
          env['JIRA_AUTH'] = 'basic';
        }

        if (body.syncConfluence || body.baseUrl?.includes('atlassian.net')) {
          await writeKeychain(CONFLUENCE_SERVICE, body.token.trim());
          if (body.baseUrl) {
            const confUrl = body.baseUrl.replace(/\/+$/, '') + '/wiki';
            updates['CONFLUENCE_BASE_URL'] = confUrl;
            env['CONFLUENCE_BASE_URL'] = confUrl;
          }
          if (body.email) {
            updates['CONFLUENCE_EMAIL'] = body.email.trim();
            updates['CONFLUENCE_AUTH'] = 'basic';
            env['CONFLUENCE_EMAIL'] = body.email.trim();
            env['CONFLUENCE_AUTH'] = 'basic';
          }
        }

        if (Object.keys(updates).length > 0) {
          await updateEnvLocal(updates);
        }
        return send(res, 200, { ok: true, message: 'Token Jira berhasil disimpan ke Keychain.' });
      }

      if (route === 'GET /jira/issues') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const jql = url.searchParams.get('jql') || undefined;
        const max = Number(url.searchParams.get('maxResults')) || 25;
        const issues = await new JiraClient(jCfg).searchIssues(jql, max);
        return send(res, 200, issues);
      }

      if (route === 'GET /jira/issue') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const key = url.searchParams.get('key')?.trim();
        if (!key) throw new JiraError('Parameter key Jira wajib diisi.', 400, 'bad-request');
        const issue = await new JiraClient(jCfg).getIssue(key);
        return send(res, 200, issue);
      }

      if (route === 'GET /jira/users' || route === 'POST /jira/load' || route === 'POST /jira/candidates') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const client = new JiraClient(jCfg);
        if (route === 'GET /jira/users') {
          const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
          return send(res, 200, q.length < 1 ? [] : await client.searchUsers(q));
        }
        const body = await readJson<{ accountIds?: unknown; projectKeys?: unknown; excludeKeys?: unknown; defaultDays?: unknown; staleDays?: unknown }>(req, 256 * 1024);
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        const opts = { defaultDays: body.defaultDays === undefined ? undefined : Number(body.defaultDays), staleDays: body.staleDays === undefined ? undefined : Number(body.staleDays) };
        try {
          if (route === 'POST /jira/load') return send(res, 200, await jiraLoads(client, list(body.accountIds), list(body.excludeKeys), opts));
          return send(res, 200, await jiraCandidates(client, list(body.projectKeys), list(body.excludeKeys), opts));
        } catch (e) {
          if (e instanceof JiraLoadError) throw new JiraError(e.message, 400, 'bad-request');
          throw e;
        }
      }

      if (route === 'GET /jira/issue-types' || route === 'POST /jira/tad-template' || route === 'POST /jira/tad-tickets') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const client = new JiraClient(jCfg);
        if (route === 'GET /jira/issue-types') {
          const project = (url.searchParams.get('project') ?? '').trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9]{1,9}$/.test(project)) throw new JiraError('Project key Jira tidak valid.', 400, 'bad-request');
          return send(res, 200, await client.issueTypes(project));
        }
        const body = await readJson<Record<string, any>>(req, 2 * 1024 * 1024);
        if (route === 'POST /jira/tad-template') return send(res, 200, await ticketTemplate(client, Array.isArray(body.keys) ? body.keys.map(String) : []));
        try {
          return send(res, 200, await createTadTickets(client, validateTicketRequest(body), deps.appendAudit));
        } catch (e) {
          if (e instanceof TadTicketError) throw new JiraError(e.message, e.status, 'bad-request');
          throw e;
        }
      }

      if (route === 'GET /jira/projects') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const projects = await new JiraClient(jCfg).getProjects();
        return send(res, 200, projects);
      }

      if (route === 'GET /jira/transitions') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const key = url.searchParams.get('key')?.trim();
        if (!key) throw new JiraError('Parameter key Jira wajib diisi.', 400, 'bad-request');
        return send(res, 200, await new JiraClient(jCfg).getTransitions(key));
      }

      if (route === 'POST /jira/transition') {
        const { cfg: jCfg } = await loadJiraConfig(env);
        if (!jCfg) throw new JiraError('Jira belum dikonfigurasi.', 503, 'not-configured' as any);
        const body = await readJson<TransitionRequest>(req);
        requireFields(body, ['key', 'transitionId']);
        return send(res, 200, await transitionWithChecks(new JiraClient(jCfg), body, deps.appendAudit));
      }

      if (route === 'GET /audit') return send(res, 200, await deps.readAudit());

      if (!cfg) return fail(res, 503, { error: status.error ?? 'Connector belum dikonfigurasi.', code: 'not-configured' });
      const client = new ConfluenceClient(cfg);

      if (route === 'POST /confluence/preflight') {
        const body = await readJson<PreflightRequest>(req);
        requireFields(body, ['spaceKey', 'title']);
        const space = await client.getSpace(body.spaceKey.trim());
        const result: PreflightResponse = { space: { key: space.key, name: space.name } };
        if (body.parentId) result.parent = await client.getPage(body.parentId.trim(), space.key);
        if (body.pageId) {
          try {
            result.existing = await client.getPage(body.pageId, space.key);
          } catch (e) {
            // The page was deleted since the last publish; fall back to a title lookup.
            if (!(e instanceof ConfluenceError && e.code === 'not-found')) throw e;
          }
        }
        result.existing ??= (await client.findPage(space.key, body.title.trim())) ?? undefined;
        return send(res, 200, result);
      }

      if (route === 'GET /confluence/search') {
        const q = url.searchParams.get('q')?.trim() ?? '';
        if (q.length < 2) throw new ConfluenceError('Kata kunci minimal 2 karakter.', 400, 'bad-request');
        return send(res, 200, await client.searchPages(q, url.searchParams.get('space') ?? undefined));
      }

      const getJiraMentionFallback = async () => {
        try {
          const { cfg: jCfg } = await loadJiraConfig(env);
          if (!jCfg) return undefined;
          const jClient = new JiraClient(jCfg);
          return async (accountId: string) => {
            const u = await jClient.getUser(accountId);
            return u?.displayName ?? null;
          };
        } catch {
          return undefined;
        }
      };

      if (route === 'GET /confluence/page/version') {
        const id = url.searchParams.get('id')?.trim() ?? '';
        if (!/^\d{1,20}$/.test(id)) throw new ConfluenceError('ID halaman tidak valid.', 400, 'bad-request');
        return send(res, 200, await client.pageVersion(id));
      }

      if (route === 'GET /confluence/page/at') {
        const id = url.searchParams.get('id')?.trim() ?? '';
        const version = Number(url.searchParams.get('version'));
        if (!/^\d{1,20}$/.test(id) || !Number.isInteger(version) || version < 1) throw new ConfluenceError('ID atau versi halaman tidak valid.', 400, 'bad-request');
        const page = await client.pageAtVersion(id, version);
        const fallback = await getJiraMentionFallback();
        return send(res, 200, { ...page, storage: page.storage ? await client.withMentionNames(page.storage, fallback) : '' });
      }

      if (route === 'GET /confluence/users') {
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
        return send(res, 200, q.length < 1 ? [] : await client.searchUsers(q));
      }

      if (route === 'POST /confluence/users/resolve') {
        const body = await readJson<{ names?: unknown }>(req, 64 * 1024);
        const names = Array.isArray(body.names) ? body.names.map(String) : [];
        return send(res, 200, await client.resolveUserNames(names));
      }

      if (route === 'GET /confluence/page') {
        const id = url.searchParams.get('id')?.trim();
        const space = url.searchParams.get('space')?.trim();
        const title = url.searchParams.get('title')?.trim();
        let page;
        if (id) {
          if (!/^\d{1,20}$/.test(id)) throw new ConfluenceError('ID halaman tidak valid.', 400, 'bad-request');
          page = await client.getPage(id, space ?? '');
        } else if (space && title) {
          page = await client.findPage(space, title);
          if (!page) throw new ConfluenceError(`Halaman "${title}" tidak ditemukan di space ${space}.`, 404, 'not-found');
        } else {
          throw new ConfluenceError('Isi ID halaman, atau space dan judul.', 400, 'bad-request');
        }
        const fallback = await getJiraMentionFallback();
        return send(res, 200, { ...page, storage: page.storage ? await client.withMentionNames(page.storage, fallback) : '' });
      }

      if (route === 'POST /confluence/publish') {
        const body = await readJson<PublishRequest>(req);
        requireFields(body, ['spaceKey', 'title', 'storage']);
        return await publish(client, body, res, deps.appendAudit);
      }

      return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
    } catch (e) {
      if (e instanceof ConfluenceError) return fail(res, e.status, { error: e.message, code: e.code });
      if (e instanceof JiraError) return fail(res, e.status, { error: e.message, code: e.code });
      deps.logError(`[connector] ${(e as Error).message}`);
      return fail(res, 500, { error: 'Kesalahan internal connector.' });
    }
  };
}

const draftFiles = new DraftFiles();

/**
 * Coding agents. One manager per process (kept on globalThis so a Vite reload of this module
 * doesn't orphan running agents); its dependencies read the current env each time.
 */
const coderGlobal = globalThis as typeof globalThis & {
  __tlcCoder?: CoderRuns;
  __tlcCoderModule?: symbol;
  __tlcCoderEnv?: { env: Env; deps: ConnectorDeps };
};
/** Identifies this load of the module: after an edit, an idle manager is rebuilt with the new code. */
const CODER_MODULE = Symbol('coder-module');

/** Mirror of a coding run in the shared Agent Tasks list (store from the agent runtime). */
async function syncCoderRunToAgentTasks(run: CoderRun): Promise<string | undefined> {
  const ctx = coderGlobal.__tlcCoderEnv;
  if (!ctx) return undefined;
  let store: AgentRuntime['store'];
  try {
    store = (ctx.deps.agentRuntime ?? (() => agentRuntime()))().store;
  } catch {
    return undefined; // Agent Tasks unavailable: the run itself is unaffected.
  }
  return syncCoderRun(store, run);
}

function coderRuns(env: Env, deps: ConnectorDeps): CoderRuns {
  coderGlobal.__tlcCoderEnv = { env, deps };
  const existing = coderGlobal.__tlcCoder;
  // A manager from an older load may predate hasActive(); then check its live processes directly.
  const busy = existing && (typeof existing.hasActive === 'function' ? existing.hasActive() : ((existing as unknown as { live?: Map<string, unknown> }).live?.size ?? 0) > 0);
  if (existing && coderGlobal.__tlcCoderModule !== CODER_MODULE && !busy) {
    coderGlobal.__tlcCoder = undefined;
  }
  coderGlobal.__tlcCoderModule ??= CODER_MODULE;
  if (!coderGlobal.__tlcCoder) coderGlobal.__tlcCoderModule = CODER_MODULE;
  coderGlobal.__tlcCoder ??= new CoderRuns({
    servicesRoot: () => resolveServicesRoot(undefined),
    sink: { sync: syncCoderRunToAgentTasks },
    runAi: (sel, prompt, opts) => {
      const run = startProviderRun(sel, 'edit', prompt, opts);
      return { done: run.done, cancel: () => (run.child ? terminateProviderProcess(run.child) : run.abort?.()) };
    },
    jira: async (): Promise<CoderJira | undefined> => {
      const ctx = coderGlobal.__tlcCoderEnv!;
      const { cfg } = await loadJiraConfig(ctx.env);
      if (!cfg) return undefined;
      const jc = new JiraClient(cfg);
      return {
        status: async (key) => {
          const issue = await jc.getIssue(key);
          return { status: issue.status, statusCategory: issue.statusCategory };
        },
        transitions: (key) => jc.getTransitions(key),
        move: (key, transitionId, context) => transitionWithChecks(jc, { key, transitionId, ...context }, ctx.deps.appendAudit),
      };
    },
  });
  return coderGlobal.__tlcCoder;
}

async function handleCoder(route: string, url: URL, req: IncomingMessage, res: ServerResponse, env: Env, deps: ConnectorDeps) {
  const coder = coderRuns(env, deps);
  try {
    if (route === 'GET /coder/state') return send(res, 200, await coder.list());
    if (route === 'GET /coder/repos') return send(res, 200, (await servicesInfo(undefined)).services);
    if (route === 'POST /coder/settings') return send(res, 200, await coder.updateSettings(await readJson(req)));
    if (route === 'POST /coder/runs') {
      const { requests } = await readJson<{ requests?: StartCoderRunRequest[] }>(req);
      if (!Array.isArray(requests) || !requests.length || requests.length > 20) throw new CoderError('Pilih 1–20 task.');
      for (const r of requests) {
        if (r.profile !== 'backend' && r.profile !== 'frontend') throw new CoderError('Profil harus backend atau frontend.');
        if (r.kind !== undefined && r.kind !== 'task' && r.kind !== 'bugfix') throw new CoderError('Jenis run tidak dikenal.');
      }
      return send(res, 200, await coder.start(requests));
    }
    if (route === 'GET /coder/runs/diff') return send(res, 200, await coder.diff(url.searchParams.get('id') ?? ''));
    const body = route.startsWith('POST /coder/runs/') ? await readJson<{ id?: string; feedback?: string; syncTarget?: boolean; review?: any }>(req) : {};
    const id = body.id ?? '';
    if (route === 'POST /coder/runs/push') {
      const base = { ts: new Date().toISOString(), action: 'coder.push' as const, spaceKey: 'GitLab', title: id, attachments: 0 };
      try {
        const run = await coder.push(id);
        await deps.appendAudit({ ...base, title: `${run.repo} ${run.branch}`, result: 'success', jiraKeys: run.jiraKey ? [run.jiraKey] : undefined, headSha: run.headSha, mrUrl: run.mrCreateUrl }).catch(() => {});
        return send(res, 200, run);
      } catch (e) {
        await deps.appendAudit({ ...base, result: 'failure', error: (e as Error).message }).catch(() => {});
        throw e;
      }
    }
    if (route === 'POST /coder/runs/revise') return send(res, 200, await coder.revise(id, body.feedback ?? '', { syncTarget: body.syncTarget }));
    if (route === 'POST /coder/runs/resume') return send(res, 200, await coder.resume(id, body.feedback));
    if (route === 'POST /coder/runs/sync-local') return send(res, 200, await coder.syncLocal(id));
    if (route === 'POST /coder/runs/test') return send(res, 200, await coder.runTestsOnly(id));
    if (route === 'POST /coder/runs/flow-tests') return send(res, 200, await coder.generateTadFlowTests(id, body.feedback));
    if (route === 'POST /coder/runs/review') return send(res, 200, await coder.saveAiReview(id, body.review));
    if (route === 'POST /coder/runs/cancel') return send(res, 200, await coder.cancel(id));
    if (route === 'POST /coder/runs/complete') return send(res, 200, await coder.markCompleted(id, body.feedback));
    if (route === 'POST /coder/runs/remove') {
      await coder.remove(id);
      return send(res, 200, { ok: true });
    }
  } catch (e) {
    if (e instanceof CoderError) return fail(res, e.status, { error: e.message, code: e.status === 404 ? 'not-found' : 'bad-request' });
    throw e;
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

async function loadGitLab(env: Env): Promise<{ client?: GitLabClient; baseUrl: string; tokenPresent: boolean }> {
  // No built-in host: the URL comes from the setup wizard (or Koneksi).
  const baseUrl = normalizeBaseUrl(env.GITLAB_BASE_URL || '');
  const token = await readKeychain(GITLAB_SERVICE);
  return { client: token && baseUrl ? new GitLabClient({ baseUrl, token }) : undefined, baseUrl, tokenPresent: Boolean(token) };
}

/** Read-only GitLab MR review. The only write is saving the user's own token to the Keychain. */
async function handleGitLab(route: string, url: URL, req: IncomingMessage, res: ServerResponse, env: Env) {
  try {
    if (route === 'POST /gitlab/save-token') {
      const body = await readJson<{ token?: string; baseUrl?: string }>(req);
      const token = body.token?.trim();
      if (!token) throw new GitLabError('Token tidak boleh kosong.', 400, 'bad-request');
      const baseUrl = normalizeBaseUrl(body.baseUrl?.trim() || env.GITLAB_BASE_URL || '');
      if (!/^https:\/\//.test(baseUrl)) throw new GitLabError('Base URL GitLab harus https://', 400, 'bad-request');
      // Check before saving so a typo doesn't replace a working token.
      const me = await new GitLabClient({ baseUrl, token }).currentUser();
      if (!(await writeKeychain(GITLAB_SERVICE, token))) throw new GitLabError('Gagal menyimpan ke Keychain.', 500, 'upstream');
      if (baseUrl !== env.GITLAB_BASE_URL) {
        env.GITLAB_BASE_URL = baseUrl;
        await updateEnvLocal({ GITLAB_BASE_URL: baseUrl });
      }
      return send(res, 200, { ok: true, user: me });
    }

    const { client, baseUrl, tokenPresent } = await loadGitLab(env);
    if (route === 'GET /gitlab/status') {
      if (!client) return send(res, 200, { configured: false, baseUrl, tokenPresent, error: baseUrl ? 'Token GitLab belum disimpan.' : 'URL GitLab belum diatur (Setup).' });
      try {
        const [user, version] = await Promise.all([client.currentUser(), client.version()]);
        return send(res, 200, { configured: true, baseUrl, tokenPresent, user, version });
      } catch (e) {
        return send(res, 200, { configured: false, baseUrl, tokenPresent, error: (e as Error).message });
      }
    }
    if (route === 'GET /gitlab/manual-mrs') return send(res, 200, await manualMrs.all());
    if (!client) throw new GitLabError('Token GitLab belum disimpan. Buka halaman Koneksi.', 400, 'bad-request');

    if (route === 'POST /gitlab/manual-mrs' || route === 'POST /gitlab/manual-mrs/delete') {
      const body = await readJson<{ key?: string; url?: string; ref?: string }>(req, 16 * 1024);
      const key = String(body.key ?? '').trim();
      try {
        if (route === 'POST /gitlab/manual-mrs/delete') return send(res, 200, await manualMrs.remove(key, String(body.ref ?? '')));
        const ref = parseMrUrl(String(body.url ?? ''), baseUrl);
        if (!ref) throw new ManualMrError(`Link bukan MR di ${baseUrl}.`);
        return send(res, 200, await manualMrs.add(key, ref, client));
      } catch (e) {
        if (e instanceof ManualMrError) throw new GitLabError(e.message, 400, 'bad-request');
        throw e;
      }
    }

    if (route === 'GET /gitlab/mrs') {
      const scope = url.searchParams.get('scope');
      if (scope !== 'all' && scope !== 'reviewer' && scope !== 'assigned' && scope !== 'created') throw new GitLabError('scope tidak valid.', 400, 'bad-request');
      return send(res, 200, await client.listMrs(scope, await client.currentUser()));
    }
    if (route === 'GET /gitlab/mrs/by-keys') {
      const keys = (url.searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter((k) => /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(k));
      return send(res, 200, await manualMrs.merge(keys, await client.mrsForKeys(keys), client));
    }
    if (route === 'GET /gitlab/mr') {
      const link = url.searchParams.get('url');
      const ref = link
        ? parseMrUrl(link, baseUrl)
        : { projectPath: url.searchParams.get('project') ?? '', iid: Number(url.searchParams.get('iid')) };
      if (!ref || !ref.projectPath || !Number.isInteger(ref.iid) || ref.iid <= 0) {
        throw new GitLabError(link ? `Link bukan MR di ${baseUrl}.` : 'project dan iid wajib diisi.', 400, 'bad-request');
      }
      return send(res, 200, await client.mr(ref.projectPath, ref.iid));
    }
  } catch (e) {
    if (e instanceof GitLabError) return fail(res, e.status, { error: e.message, code: e.code === 'forbidden' ? 'unauthorized' : e.code });
    throw e;
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}
const conversationFiles = new ConversationFiles();

async function handleConversations(route: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  try {
    if (route === 'GET /assistant/conversations') return send(res, 200, await conversationFiles.list());
    if (route === 'GET /assistant/conversations/one') {
      const c = await conversationFiles.get(url.searchParams.get('id') ?? '');
      return c ? send(res, 200, c) : fail(res, 404, { error: 'Percakapan tidak ditemukan.', code: 'not-found' });
    }
    if (route === 'POST /assistant/conversations/update') {
      const body = await readJson<{ id?: string; title?: string; pinned?: boolean }>(req);
      return send(res, 200, await conversationFiles.update(body.id ?? '', body));
    }
    if (route === 'POST /assistant/conversations/delete') {
      await conversationFiles.remove((await readJson<{ id?: string }>(req)).id ?? '');
      return send(res, 200, { ok: true });
    }
  } catch (e) {
    if (e instanceof ConversationError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

// Listing providers spawns the CLIs; the Assistant only needs a recent answer.
let providersCache: { at: number; value: Awaited<ReturnType<typeof listProviders>> } | undefined;

/** Everything the Assistant may need to know about the current Cockpit; each source is best-effort. */
async function gatherCockpitState(env: Env, deps: ConnectorDeps): Promise<CockpitState> {
  const providers = async () => {
    if (!providersCache || Date.now() - providersCache.at > 5 * 60_000) providersCache = { at: Date.now(), value: await listProviders() };
    return providersCache.value;
  };
  const [confluence, jira, teams, wa, ai, usage, drafts] = await Promise.all([
    withTimeout(loadConfig(env, deps.readToken), 3_000),
    withTimeout(loadJiraConfig(env), 3_000),
    withTimeout(import('./teams/session.ts').then((m) => m.teamsSession.getStatus()), 4_000),
    withTimeout(import('./whatsapp/session.ts').then((m) => m.whatsapp().getStatus()), 2_000),
    withTimeout(providers(), 8_000),
    withTimeout(getUsage(false), 3_000),
    withTimeout(draftFiles.list(), 3_000),
  ]);
  const [settings, services] = await Promise.all([withTimeout(settingsStore.load(env).then((r) => r.settings), 2_000), withTimeout(servicesInfo(undefined), 3_000)]);
  return {
    now: new Date(),
    runtime: process.env.TLC_RUNTIME === 'desktop' ? 'desktop' : 'browser',
    confluence: confluence && { configured: confluence.status.configured, baseUrl: confluence.status.baseUrl, error: confluence.status.error },
    jira: jira && { configured: Boolean(jira.cfg), baseUrl: jira.status.baseUrl, error: jira.status.error },
    teams: teams && { connected: teams.connected, user: teams.user ? `${teams.user.displayName} <${teams.user.email}>` : undefined, error: teams.error },
    whatsapp: wa && { connection: wa.connection, me: wa.me?.name, error: wa.error },
    ai: ai?.map((p) => ({ id: p.id, label: p.label, available: p.available, note: p.note ?? p.warning })),
    usage,
    drafts: (drafts ?? []) as DraftForContext[],
    workspace: {
      orgName: settings?.general.orgName || undefined,
      servicesRoot: services?.root ?? settings?.workspace.servicesRoot,
      serviceCount: services?.exists ? services.services.length : undefined,
      servicesError: services && !services.exists ? (services.error ?? 'folder tidak ditemukan') : undefined,
      defaultBaseBranch: settings?.workspace.defaultBaseBranch || undefined,
      defaultAi: settings ? `${settings.ai.defaultProvider}${settings.ai.defaultModel ? ` · ${settings.ai.defaultModel}` : ''}` : undefined,
      inferhubModel: settings?.ai.inferhub.model || undefined,
    },
  };
}

async function handleDrafts(route: string, req: IncomingMessage, res: ServerResponse) {
  try {
    if (route === 'GET /drafts') return send(res, 200, await draftFiles.list());
    if (route === 'POST /drafts/save') {
      await draftFiles.save((await readJson<{ draft?: unknown }>(req)).draft);
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /drafts/delete') {
      await draftFiles.remove((await readJson<{ id?: unknown }>(req)).id);
      return send(res, 200, { ok: true });
    }
  } catch (e) {
    if (e instanceof DraftFileError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

const qaGlobal = globalThis as typeof globalThis & { __tlcQa?: QaManager; __tlcQaModule?: symbol };
const QA_MODULE = Symbol('qa-module');

/**
 * One manager per process, kept on globalThis so a Vite reload doesn't orphan running jobs; an
 * idle manager from an older load is rebuilt so edits to the runner/generator take effect.
 */
function qaManager(): QaManager {
  const existing = qaGlobal.__tlcQa;
  // A manager from an older load may predate isBusy(); treat it as idle then.
  if (existing && qaGlobal.__tlcQaModule !== QA_MODULE && !(typeof existing.isBusy === 'function' && existing.isBusy())) qaGlobal.__tlcQa = undefined;
  if (!qaGlobal.__tlcQa) qaGlobal.__tlcQaModule = QA_MODULE;
  qaGlobal.__tlcQa ??= new QaManager({
    readSecret: (key) => readKeychain(QA_KEYCHAIN_SERVICE, `env:${key}`),
    writeSecret: (key, value) => writeKeychain(QA_KEYCHAIN_SERVICE, value, `env:${key}`),
    deleteSecret: (key) => deleteKeychain(QA_KEYCHAIN_SERVICE, `env:${key}`),
    // With a codebase the AI needs file tools (Services stays read-only and is checked); otherwise plain text.
    resolveServicesRoot: (input) => resolveServicesRoot(input || undefined),
    watchRepos: async (root) => {
      const before = await snapshotRepos(root);
      return async () => diffSnapshots(before, await snapshotRepos(root)).map((c) => c.repo);
    },
    runAi: (ai, prompt, opts) => {
      const edit = Boolean(opts.readOnlyDirs?.length);
      // Edit mode has no system prompt of its own: it goes first in the prompt.
      const run = startProviderRun(ai, edit ? 'edit' : 'text', edit ? `${opts.systemPrompt}\n\n---\n\n${prompt}` : prompt, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        systemPrompt: opts.systemPrompt,
        readOnlyDirs: opts.readOnlyDirs,
        onEvent: (e) => {
          if (e.kind !== 'text' && e.text) opts.onProgress(e.text);
          else if (e.kind === 'text') opts.onProgress('AI sedang menulis skenario…');
        },
      });
      return { done: run.done, cancel: () => (run.child ? terminateProviderProcess(run.child) : run.abort?.()) };
    },
  });
  return qaGlobal.__tlcQa;
}

async function handleQa(route: string, url: URL, req: IncomingMessage, res: ServerResponse, qa: QaManager, audit: ConnectorDeps['appendAudit']) {
  try {
    if (route === 'GET /qa/environments') return send(res, 200, await qa.listEnvironments());
    if (route === 'POST /qa/environments') {
      const body = await readJson<{ environment: Partial<QAEnvironment>; secret?: string; secretVariables?: Record<string, string>; dbPasswords?: Record<string, string>; dbServerPassword?: string }>(req, 512 * 1024);
      if (body.secret !== undefined && typeof body.secret !== 'string') throw new QaInputError('Token harus berupa teks.');
      if (body.dbServerPassword !== undefined && typeof body.dbServerPassword !== 'string') throw new QaInputError('Password harus berupa teks.');
      return send(res, 200, await qa.saveEnvironment(body.environment ?? {}, body.secret, body.secretVariables, body.dbPasswords, body.dbServerPassword));
    }
    if (route === 'POST /qa/db/test') {
      const body = await readJson<{ environmentId?: string; name?: string }>(req, 16 * 1024);
      return send(res, 200, { version: await qa.testDatabase(String(body.environmentId ?? ''), body.name ? String(body.name) : undefined) });
    }
    if (route === 'POST /qa/db/list') {
      const body = await readJson<{ environmentId?: string }>(req, 16 * 1024);
      return send(res, 200, { databases: await qa.listServerDatabases(String(body.environmentId ?? '')) });
    }
    if (route === 'POST /qa/environments/delete') {
      const body = await readJson<{ id?: string }>(req, 16 * 1024);
      return send(res, 200, await qa.deleteEnvironment(String(body.id ?? '')));
    }
    if (route === 'GET /qa/suite') {
      const projectId = url.searchParams.get('projectId') ?? '';
      // Opening a project adopts the per-TAD suites from before projects existed.
      const draftIds = (url.searchParams.get('draftIds') ?? '').split(',').filter(Boolean);
      const suite = draftIds.length ? await qa.adoptLegacy(projectId, url.searchParams.get('projectName') ?? 'Proyek', draftIds) : await qa.getSuite(projectId);
      return send(res, 200, { suite });
    }
    if (route === 'POST /qa/suite') {
      const body = await readJson<{ suite: QASuite }>(req, 4 * 1024 * 1024);
      const suite = body.suite;
      if (!suite || !Array.isArray(suite.flows)) throw new QaInputError('Suite tidak valid.');
      const flows = suite.flows.map((f, i) => {
        try {
          return normalizeEditedFlow(f);
        } catch (e) {
          throw new QaInputError(`Flow #${i + 1}: ${(e as Error).message}`);
        }
      });
      return send(res, 200, { suite: await qa.saveSuite({ ...suite, flows, projectName: String(suite.projectName ?? '').slice(0, 300) }) });
    }
    if (route === 'POST /qa/generate') {
      const body = await readJson<QAGenerateRequest>(req, 4 * 1024 * 1024);
      if (!isAiSelection(body.ai)) throw new QaInputError('Pilihan AI tidak valid.');
      let existing;
      try {
        existing = Array.isArray(body.existing) ? body.existing.map((f) => normalizeEditedFlow(f)) : undefined;
      } catch (e) {
        throw new QaInputError((e as Error).message);
      }
      const tasks = (Array.isArray(body.tasks) ? body.tasks : []).slice(0, 50).map((t) => ({
        title: String(t.title ?? '').slice(0, 300),
        tadTitle: t.tadTitle ? String(t.tadTitle).slice(0, 300) : undefined,
        service: t.service ? String(t.service).slice(0, 100) : undefined,
        jiraKey: t.jiraKey ? String(t.jiraKey).slice(0, 30) : undefined,
        spec: String(t.spec ?? ''),
      }));
      return send(res, 202, await qa.generate({ ...body, tasks, existing, categories: Array.isArray(body.categories) ? body.categories : [] }));
    }
    if (route === 'GET /qa/generate') {
      const id = url.searchParams.get('id');
      const projectId = url.searchParams.get('projectId');
      const job = id ? qa.getJob(id) : projectId ? qa.latestJob(projectId) : undefined;
      return send(res, 200, { job: job ?? null });
    }
    if (route === 'POST /qa/generate/cancel') {
      const body = await readJson<{ id?: string }>(req, 16 * 1024);
      return send(res, 200, { job: qa.cancelJob(String(body.id ?? '')) ?? null });
    }
    if (route === 'POST /qa/runs') {
      const body = await readJson<QARunRequest>(req, 256 * 1024);
      const run = await qa.startRun(body);
      await audit({
        ts: new Date().toISOString(),
        action: 'qa.run',
        result: 'success',
        spaceKey: run.environment.name,
        title: `${run.projectName} (${run.flows.length} flow)`,
        attachments: 0,
      }).catch(() => {});
      return send(res, 202, run);
    }
    if (route === 'GET /qa/runs') return send(res, 200, await qa.listRuns(url.searchParams.get('projectId') ?? ''));
    if (route === 'GET /qa/runs/one') {
      const run = await qa.getRun(url.searchParams.get('projectId') ?? '', url.searchParams.get('id') ?? '');
      if (!run) return fail(res, 404, { error: 'Run tidak ditemukan.', code: 'not-found' });
      return send(res, 200, run);
    }
    if (route === 'POST /qa/runs/cancel') {
      const body = await readJson<{ id?: string }>(req, 16 * 1024);
      return send(res, 200, { run: qa.cancelRun(String(body.id ?? '')) ?? null });
    }
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof QaInputError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
}

const estimateGlobal = globalThis as typeof globalThis & { __tlcEstimate?: EstimateManager; __tlcEstimateModule?: symbol };
const ESTIMATE_MODULE = Symbol('estimate-module');

/** Same lifecycle as the QA manager: rebuilt after a reload unless an AI job is running. */
function estimateManager(): EstimateManager {
  const existing = estimateGlobal.__tlcEstimate;
  if (existing && estimateGlobal.__tlcEstimateModule !== ESTIMATE_MODULE && !(typeof existing.isBusy === 'function' && existing.isBusy())) estimateGlobal.__tlcEstimate = undefined;
  if (!estimateGlobal.__tlcEstimate) estimateGlobal.__tlcEstimateModule = ESTIMATE_MODULE;
  estimateGlobal.__tlcEstimate ??= new EstimateManager({
    resolveServicesRoot: (input) => resolveServicesRoot(input),
    draftTitle: async (id) => {
      const draft = (await draftFiles.list()).find((d) => d.id === id);
      return draft?.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    },
    watchRepos: async (root) => {
      const before = await snapshotRepos(root);
      return async () => diffSnapshots(before, await snapshotRepos(root)).map((c) => c.repo);
    },
    runAi: (ai, prompt, opts) => {
      // With a codebase the AI needs file tools (read-only on Services); without one, plain text.
      const run = startProviderRun(ai, opts.readOnlyDirs.length ? 'edit' : 'text', prompt, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        readOnlyDirs: opts.readOnlyDirs,
        onEvent: (e) => opts.onProgress(e.kind === 'text' ? 'AI sedang menyusun estimasi…' : e.text),
      });
      return { done: run.done, cancel: () => (run.child ? terminateProviderProcess(run.child) : run.abort?.()) };
    },
  });
  return estimateGlobal.__tlcEstimate;
}

async function handleEstimate(route: string, url: URL, req: IncomingMessage, res: ServerResponse, est: EstimateManager) {
  try {
    if (route === 'GET /estimate/holidays') return send(res, 200, await est.holidays());
    if (route === 'POST /estimate/holidays') {
      const body = await readJson<{ holidays?: unknown; reset?: boolean }>(req, 512 * 1024);
      return send(res, 200, body.reset ? await est.resetHolidays() : await est.saveHolidays(body.holidays));
    }
    if (route === 'GET /estimate/projects') return send(res, 200, await est.listProjects());
    if (route === 'GET /estimate/projects/one') {
      const project = await est.project(url.searchParams.get('id') ?? '');
      if (!project) return fail(res, 404, { error: 'Proyek tidak ditemukan.', code: 'not-found' });
      return send(res, 200, project);
    }
    if (route === 'POST /estimate/projects') {
      const body = await readJson<{ project: Partial<EstimateProject> }>(req, 4 * 1024 * 1024);
      return send(res, 200, await est.saveProject(body.project ?? {}));
    }
    if (route === 'POST /estimate/projects/delete') {
      const body = await readJson<{ id?: string }>(req, 16 * 1024);
      await est.deleteProject(String(body.id ?? ''));
      return send(res, 200, await est.listProjects());
    }
    if (route === 'POST /estimate/ai') {
      const body = await readJson<EstimateRequest>(req, 4 * 1024 * 1024);
      if (!isAiSelection(body.ai)) throw new EstimateInputError('Pilihan AI tidak valid.');
      return send(res, 202, await est.start(body));
    }
    if (route === 'GET /estimate/ai') {
      const id = url.searchParams.get('id');
      const projectId = url.searchParams.get('projectId');
      return send(res, 200, { job: (id ? est.job(id) : projectId ? est.latestJob(projectId) : undefined) ?? null });
    }
    if (route === 'POST /estimate/ai/cancel') {
      const body = await readJson<{ id?: string }>(req, 16 * 1024);
      return send(res, 200, { job: est.cancel(String(body.id ?? '')) ?? null });
    }
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof EstimateInputError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
}

let reportVps: ReportVps | undefined;

async function handleReport(route: string, req: IncomingMessage, res: ServerResponse, vps: ReportVps, audit: ConnectorDeps['appendAudit']) {
  const record = (action: 'report.install' | 'report.send', title: string, result: 'success' | 'failure', error?: string) =>
    audit({ ts: new Date().toISOString(), action, result, spaceKey: 'VPS', title, attachments: 0, ...(error ? { error } : {}) }).catch(() => {});
  try {
    if (route === 'GET /report/settings') return send(res, 200, await vps.settings());
    if (route === 'POST /report/settings') {
      const body = await readJson<{ settings?: Partial<ReportSettings> }>(req, 64 * 1024);
      return send(res, 200, await vps.saveSettings(body.settings ?? {}));
    }
    if (route === 'POST /report/sync') {
      const body = await readJson<{ snapshot?: unknown }>(req, 6 * 1024 * 1024);
      return send(res, 200, await vps.sync(body.snapshot));
    }
    if (route === 'POST /report/install') {
      try {
        const r = await vps.install();
        await record('report.install', `Jadwal ${r.settings.installed?.times.join(', ')} WIB (${r.settings.installed?.jobs.map((j) => j.cron).join(' | ')}) → ${r.settings.installed?.deliver}`, 'success');
        return send(res, 200, r);
      } catch (e) {
        await record('report.install', 'Pasang laporan terjadwal', 'failure', (e as Error).message);
        throw e;
      }
    }
    if (route === 'POST /report/preview') return send(res, 200, await vps.preview());
    if (route === 'POST /report/send-now') {
      try {
        const output = await vps.sendNow();
        await record('report.send', 'Kirim laporan progres sekarang', 'success');
        return send(res, 200, { output });
      } catch (e) {
        await record('report.send', 'Kirim laporan progres sekarang', 'failure', (e as Error).message);
        throw e;
      }
    }
    if (route === 'GET /report/status') return send(res, 200, { status: await vps.status() });
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof ReportInputError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
}

const bugGlobal = globalThis as typeof globalThis & { __tlcBugs?: BugManager; __tlcBugsModule?: symbol };
const BUGS_MODULE = Symbol('bugs-module');

/** Same lifecycle as the other managers: rebuilt after a reload unless an analysis is running. */
function bugManager(env: Env): BugManager {
  const existing = bugGlobal.__tlcBugs;
  if (existing && bugGlobal.__tlcBugsModule !== BUGS_MODULE && !(typeof existing.isBusy === 'function' && existing.isBusy())) bugGlobal.__tlcBugs = undefined;
  if (!bugGlobal.__tlcBugs) bugGlobal.__tlcBugsModule = BUGS_MODULE;
  bugGlobal.__tlcBugs ??= new BugManager({
    resolveServicesRoot: (input) => resolveServicesRoot(input || undefined),
    listServices: async (root) => (await servicesInfo(root)).services,
    watchRepos: async (root) => {
      const before = await snapshotRepos(root);
      return async () => diffSnapshots(before, await snapshotRepos(root)).map((c) => c.repo);
    },
    // File tools are needed to read logs/ and the codebase; writes stay inside the temp folder.
    runAi: (ai, prompt, opts) => {
      const run = startProviderRun(ai, 'edit', prompt, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        readOnlyDirs: opts.readOnlyDirs,
        onEvent: (e) => opts.onProgress(e.kind === 'text' ? 'AI sedang menyusun analisa…' : e.text),
      });
      return { done: run.done, cancel: () => (run.child ? terminateProviderProcess(run.child) : run.abort?.()) };
    },
    jira: async () => {
      const { cfg } = await loadJiraConfig(env);
      return cfg ? new JiraClient(cfg) : null;
    },
  });
  return bugGlobal.__tlcBugs;
}

/** One store per process, so concurrent raises are serialized. */
const defaultTaskPeaks = new TaskPeakStore();

const traceGlobal = globalThis as typeof globalThis & { __tlcTraces?: TraceManager; __tlcTracesModule?: symbol };
const TRACES_MODULE = Symbol('traces-module');

/** Same lifecycle as the other managers: rebuilt after a reload unless a trace is running. */
function traceManager(deps: ConnectorDeps): TraceManager {
  const existing = traceGlobal.__tlcTraces;
  if (existing && traceGlobal.__tlcTracesModule !== TRACES_MODULE && !(typeof existing.isBusy === 'function' && existing.isBusy())) traceGlobal.__tlcTraces = undefined;
  if (!traceGlobal.__tlcTraces) traceGlobal.__tlcTracesModule = TRACES_MODULE;
  traceGlobal.__tlcTraces ??= new TraceManager({
    resolveServicesRoot: (input) => resolveServicesRoot(input || undefined),
    watchRepos: async (root) => {
      const before = await snapshotRepos(root);
      return async () => diffSnapshots(before, await snapshotRepos(root)).map((c) => c.repo);
    },
    // File tools are needed to read the codebase; writes stay inside the temp folder.
    runAi: (ai, prompt, opts) => {
      const run = startProviderRun(ai, 'edit', prompt, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        readOnlyDirs: opts.readOnlyDirs,
        onEvent: (e) => opts.onProgress(e.kind === 'text' ? 'AI sedang menyusun jawaban…' : e.text),
      });
      return { done: run.done, cancel: () => (run.child ? terminateProviderProcess(run.child) : run.abort?.()) };
    },
    sink: (trace, turn) => syncTraceTurn((deps.agentRuntime ?? (() => agentRuntime()))().store, trace, turn),
  });
  return traceGlobal.__tlcTraces;
}

async function handleTraces(route: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps) {
  const traces = (deps.traceManager ?? traceManager)(deps);
  try {
    if (route === 'GET /traces') return send(res, 200, await traces.list());
    if (route === 'GET /traces/one') return send(res, 200, await traces.get(url.searchParams.get('id') ?? ''));
    if (!route.startsWith('POST ')) return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
    const body = await readJson<Record<string, unknown>>(req, 256 * 1024);
    if (route === 'POST /traces') {
      if (!isAiSelection(body.ai)) throw new TraceInputError('Pilihan AI tidak valid.');
      const traceId = typeof body.traceId === 'string' && body.traceId ? body.traceId : undefined;
      return send(res, 202, await traces.ask({ traceId, question: String(body.question ?? ''), ai: body.ai, servicesRoot: typeof body.servicesRoot === 'string' ? body.servicesRoot : undefined }));
    }
    if (route === 'POST /traces/cancel') return send(res, 200, await traces.cancel(String(body.id ?? '')));
    if (route === 'POST /traces/delete') {
      await traces.remove(String(body.id ?? ''));
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof TraceInputError) throw new ConfluenceError(e.message, e.status, e.status === 404 ? 'not-found' : e.status === 409 ? 'conflict' : 'bad-request');
    throw e;
  }
}

async function handleBugs(route: string, url: URL, req: IncomingMessage, res: ServerResponse, env: Env, deps: ConnectorDeps) {
  const bugs = bugManager(env);
  try {
    if (route === 'GET /bugs') return send(res, 200, await bugs.list());
    if (route === 'GET /bugs/one') return send(res, 200, await bugs.get(url.searchParams.get('id') ?? ''));
    if (route === 'GET /bugs/logs/read') return send(res, 200, await bugs.readLog(url.searchParams.get('id') ?? '', url.searchParams.get('name') ?? ''));
    if (route === 'GET /bugs/jobs') return send(res, 200, bugs.jobsList());
    if (route === 'GET /bugs/analyze') {
      const id = url.searchParams.get('id');
      const caseId = url.searchParams.get('caseId');
      return send(res, 200, { job: (id ? bugs.job(id) : caseId ? bugs.latestJob(caseId) : undefined) ?? null });
    }
    if (route === 'GET /bugs/jira-types') {
      const project = (url.searchParams.get('project') ?? '').trim();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(project)) throw new BugInputError('Project key Jira tidak valid.');
      const { cfg } = await loadJiraConfig(env);
      if (!cfg) throw new BugInputError('Jira belum dikonfigurasi.');
      return send(res, 200, await new JiraClient(cfg).issueTypes(project));
    }
    if (!route.startsWith('POST ')) return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });

    const body = await readJson<Record<string, any>>(req, 12 * 1024 * 1024);
    if (route === 'POST /bugs') return send(res, 200, await bugs.create(body.case as Partial<BugCaseInput>));
    if (route === 'POST /bugs/update') return send(res, 200, await bugs.update(String(body.id ?? ''), body.case as Partial<BugCaseInput>));
    if (route === 'POST /bugs/delete') return send(res, 200, (await bugs.remove(String(body.id ?? '')), { ok: true }));
    if (route === 'POST /bugs/logs') return send(res, 200, await bugs.addLog(String(body.id ?? ''), String(body.name ?? ''), String(body.text ?? '')));
    if (route === 'POST /bugs/logs/delete') return send(res, 200, await bugs.removeLog(String(body.id ?? ''), String(body.name ?? '')));
    if (route === 'POST /bugs/status') return send(res, 200, await bugs.setStatus(String(body.id ?? ''), body.status));
    if (route === 'POST /bugs/analyze') {
      const r = body as BugAnalyzeRequest;
      if (!isAiSelection(r.ai)) throw new BugInputError('Pilihan AI tidak valid.');
      return send(res, 202, await bugs.analyze({ caseId: String(r.caseId ?? ''), ai: r.ai, useCodebase: r.useCodebase !== false, servicesRoot: r.servicesRoot, instructions: r.instructions }));
    }
    if (route === 'POST /bugs/analyze/cancel') return send(res, 200, { job: (await bugs.cancel(String(body.id ?? ''))) ?? null });
    if (route === 'POST /bugs/tasks/add') return send(res, 200, await bugs.addTask(String(body.caseId ?? ''), body.task ?? {}));
    if (route === 'POST /bugs/tasks/update') return send(res, 200, await bugs.updateTask(String(body.caseId ?? ''), String(body.taskId ?? ''), body.task ?? {}));
    if (route === 'POST /bugs/tasks/delete') return send(res, 200, await bugs.removeTask(String(body.caseId ?? ''), String(body.taskId ?? '')));
    if (route === 'POST /bugs/tasks/status') return send(res, 200, await bugs.setTaskStatus(String(body.caseId ?? ''), String(body.taskId ?? ''), body.status));
    if (route === 'POST /bugs/ticket') {
      const r = body as BugTicketRequest;
      try {
        const { case: c, task } = await bugs.createTicket(r);
        await deps.appendAudit({ ts: new Date().toISOString(), action: 'bug.ticket', result: 'success', spaceKey: r.projectKey, title: `${task.jira?.key} ${r.summary}`.slice(0, 200), attachments: 0, jiraKeys: task.jira ? [task.jira.key] : undefined }).catch(() => {});
        return send(res, 200, c);
      } catch (e) {
        await deps.appendAudit({ ts: new Date().toISOString(), action: 'bug.ticket', result: 'failure', spaceKey: String(r.projectKey ?? ''), title: String(r.summary ?? '').slice(0, 200), attachments: 0, error: (e as Error).message }).catch(() => {});
        throw e;
      }
    }
    if (route === 'POST /bugs/fix') {
      const { case: c, task } = await bugs.fixTarget(String(body.caseId ?? ''), String(body.taskId ?? ''));
      const profile = body.profile === 'frontend' || body.profile === 'backend' ? body.profile : task.profile;
      const [run] = await coderRuns(env, deps).start([
        {
          draftId: bugDraftId(c.id),
          tadTitle: `Bug: ${c.title}`,
          taskTitle: `[BUGFIX][${task.repo.toUpperCase()}] - ${task.title}`,
          jiraKey: task.jira?.key,
          profile,
          repo: task.repo,
          baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
          targetBranch: typeof body.targetBranch === 'string' ? body.targetBranch : undefined,
          spec: bugFixSpec(c, task),
          kind: 'bugfix',
        },
      ]);
      return send(res, 200, { case: await bugs.attachRun(c.id, task.id, run.id), run });
    }
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof BugInputError || e instanceof CoderError) throw new ConfluenceError(e.message, 400, 'bad-request');
    if (e instanceof JiraError) throw e;
    throw e;
  }
}

const SECRET_IDS = Object.keys(SECRET_SERVICES) as SecretId[];
/** Env keys that still hold values the wizard has not taken over (shown as a hint, never the values). */
const ENV_SECRET_KEYS = ['INFERHUB_API_KEY', 'NINEROUTER_API_KEY'];

async function settingsResponse(env: Env, migrated = false): Promise<SettingsResponse> {
  const { settings } = await settingsStore.load(env);
  const secrets = Object.fromEntries(await Promise.all(SECRET_IDS.map(async (id) => [id, Boolean(await readKeychain(SECRET_SERVICES[id]))]))) as Record<SecretId, boolean>;
  const envOnly = ENV_SECRET_KEYS.filter((k) => readEnvLocalVar(k, env));
  return { settings, secrets, envOnly, migrated };
}

/** The setup wizard: plain settings to settings.json, tokens to the Keychain. */
async function handleSettings(route: string, req: IncomingMessage, res: ServerResponse, env: Env) {
  try {
    if (route === 'GET /settings') return send(res, 200, await settingsResponse(env));
    if (route === 'POST /settings') {
      const body = await readJson<{ settings?: Partial<AppSettings> }>(req, 256 * 1024);
      const next = await settingsStore.update(body.settings ?? {}, env);
      applySettingsToEnv(next, env, process.env);
      return send(res, 200, await settingsResponse(env));
    }
    if (route === 'POST /settings/secret') {
      const body = await readJson<{ id?: string; value?: string }>(req, 64 * 1024);
      const id = body.id as SecretId;
      if (!SECRET_IDS.includes(id)) throw new SettingsInputError('Jenis token tidak dikenal.');
      const value = String(body.value ?? '').trim();
      if (!value) {
        await deleteKeychain(SECRET_SERVICES[id]);
      } else if (!(await writeKeychain(SECRET_SERVICES[id], value))) {
        throw new SettingsInputError('Gagal menyimpan token ke Keychain.');
      }
      // A key in .env.local would win over the Keychain for these providers: drop it from this process.
      if (id === 'inferhub') delete env.INFERHUB_API_KEY;
      if (id === 'ninerouter') delete env.NINEROUTER_API_KEY;
      return send(res, 200, await settingsResponse(env));
    }
    return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof SettingsInputError) throw new ConfluenceError(e.message, 400, 'bad-request');
    throw e;
  }
}

async function handleGeneratorJobs(route: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  const jobs = generatorJobs();
  if (route === 'POST /chat/jobs') {
    const body = await readJson<StartGeneratorJobRequest>(req);
    requireFields(body, ['draftId', 'prompt', 'tadMarkdown']);
    if (!isValidDraftId(body.draftId)) throw new ConfluenceError('draftId tidak valid.', 400, 'bad-request');
    try {
      return send(res, 202, await jobs.start(body));
    } catch (e) {
      if (e instanceof JobConflictError) return send(res, 409, { error: e.message, code: 'conflict', job: e.job });
      if (/Folder codebase/.test((e as Error).message)) throw new ConfluenceError((e as Error).message, 400, 'bad-request');
      throw e;
    }
  }
  if (route === 'GET /chat/docs' || route === 'POST /chat/docs' || route === 'POST /chat/docs/delete' || route === 'POST /chat/docs/unlock') {
    const draftId = route === 'GET /chat/docs' ? url.searchParams.get('draftId') : undefined;
    const body: { draftId?: string; name?: string; base64?: string; password?: string } = route === 'GET /chat/docs' ? {} : await readJson(req);
    const id = draftId ?? body.draftId;
    if (!isValidDraftId(id)) throw new ConfluenceError('draftId tidak valid.', 400, 'bad-request');
    try {
      if (route === 'POST /chat/docs') await saveDoc(id, body.name ?? '', body.base64 ?? '', body.password ?? '');
      if (route === 'POST /chat/docs/delete') await deleteDoc(id, body.name ?? '');
      if (route === 'POST /chat/docs/unlock') await unlockDoc(id, body.name ?? '', body.password ?? '');
    } catch (e) {
      if (e instanceof PdfPasswordError) return fail(res, 422, { error: e.message, code: e.code });
      throw new ConfluenceError((e as Error).message, 400, 'bad-request');
    }
    return send(res, 200, await listDocs(id));
  }
  if (route === 'GET /chat/jobs') {
    const id = url.searchParams.get('id');
    const draftId = url.searchParams.get('draftId');
    const job = id ? jobs.get(id) : draftId && isValidDraftId(draftId) ? jobs.latestForDraft(draftId) : undefined;
    if (!job) return fail(res, 404, { error: 'Job tidak ditemukan.', code: 'not-found' });
    return send(res, 200, job);
  }
  if (route === 'POST /chat/jobs/cancel') {
    const { id } = await readJson<{ id?: string }>(req);
    const job = typeof id === 'string' ? jobs.cancel(id) : undefined;
    if (!job) return fail(res, 404, { error: 'Job tidak ditemukan.', code: 'not-found' });
    return send(res, 200, job);
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

// Prompts are capped at 20 000 chars by the store; this leaves room for multi-byte text.
const AGENT_MAX_BODY = 128 * 1024;
const AGENT_LIST_MAX = 500;
const AGENT_REASON_MAX = 2_000;
const AGENT_STATUS_TIMEOUT_MS = 5_000;
const AGENT_TASK_ROUTE = /^(GET|POST) \/agent-tasks\/([^/]+)(?:\/(start|cancel|retry|stop|steer|approval|complete|resolve))?$/;

/** Bounded JSON object body; an empty body (Content-Length: 0) counts as `{}`. */
async function readAgentBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = req.headers['content-length'] === '0' ? {} : await readJson<unknown>(req, AGENT_MAX_BODY);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConfluenceError('Body harus berupa objek JSON.', 400, 'bad-request');
  return body as Record<string, unknown>;
}

function optionalText(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new ConfluenceError(`Field ${field} harus berupa teks maksimal ${max} karakter.`, 400, 'bad-request');
  return value;
}

/** Maps task-store errors onto HTTP. */
function agentError(e: unknown): unknown {
  if (e instanceof AgentTaskError) {
    if (e.code === 'not_found') return new ConfluenceError(e.message, 404, 'not-found');
    if (e.code === 'invalid_state') return new ConfluenceError(e.message, 409, 'conflict');
    if (e.code === 'limit') return new ConfluenceError(e.message, 429, 'conflict');
    return new ConfluenceError(e.message, 400, 'bad-request');
  }
  return e;
}

let lastGitLabSync = 0;

async function syncMergedTasksFromGitLab(store: Pick<AgentTaskStore, 'list' | 'update'>, env: Env, deps: ConnectorDeps): Promise<number> {
  let updatedCount = 0;
  try {
    const { client } = await loadGitLab(env);
    if (!client) return 0;
    const tasks = await store.list({ status: ['blocked', 'running', 'queued', 'pending'] });
    const jiraKeys = [...new Set(tasks.map((t) => t.links?.jiraKey).filter((k): k is string => Boolean(k)))];
    if (!jiraKeys.length) return 0;

    const mrsByKey = await client.mrsForKeys(jiraKeys);
    const coder = coderRuns(env, deps);

    for (const task of tasks) {
      const key = task.links?.jiraKey;
      if (!key) continue;
      const taskMrs = mrsByKey[key] ?? [];
      const mergedMr = taskMrs.find(
        (m) => m.state === 'merged' && (!task.links?.branch || m.sourceBranch === task.links.branch || m.ref.includes(key)),
      );
      if (mergedMr) {
        const runId = task.links?.coderRunId;
        if (runId) {
          try {
            await coder.markCompleted(runId, `MR ${mergedMr.ref} sudah merged di GitLab.`);
          } catch {}
        }
        await store.update(task.id, {
          status: 'completed',
          progress: { message: `🟢 Selesai: MR ${mergedMr.ref} sudah merged di GitLab` },
          links: { ...task.links, mrUrl: mergedMr.webUrl },
        });
        updatedCount++;
      }
    }
  } catch (err) {
    console.warn('[syncMergedTasksFromGitLab] error:', err);
  }
  return updatedCount;
}

async function handleAgents(route: string, url: URL, req: IncomingMessage, res: ServerResponse, getRuntime: () => AgentRuntime, env: Env, deps: ConnectorDeps) {
  try {
    const rt = getRuntime();

    if (route === 'GET /agent-tasks') {
      const forceSync = url.searchParams.get('sync') === '1';
      const now = Date.now();
      if (forceSync || now - lastGitLabSync > 15_000) {
        lastGitLabSync = now;
        await syncMergedTasksFromGitLab(rt.store, env, deps);
      }
      const status = url.searchParams.get('status');
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam === null ? 100 : Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > AGENT_LIST_MAX) throw new ConfluenceError(`limit harus 0–${AGENT_LIST_MAX}.`, 400, 'bad-request');
      // Only Cockpit's own coding agents; tasks left over from the removed remote runner stay hidden.
      const tasks = (await rt.store.list({ status: status ? (status.split(',') as AgentTaskStatus[]) : undefined, limit: AGENT_LIST_MAX })).filter((t) => t.runner === 'local');
      return send(res, 200, { tasks: tasks.slice(0, limit) });
    }
    if (route === 'POST /agent-tasks/sync-mrs') {
      const updated = await syncMergedTasksFromGitLab(rt.store, env, deps);
      return send(res, 200, { ok: true, updated });
    }

    const m = AGENT_TASK_ROUTE.exec(route);
    if (!m) return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
    const [, method, id, action] = m;
    if ((method === 'GET') !== (action === undefined)) return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
    if (!isAgentTaskId(id)) throw new ConfluenceError('Id task tidak valid.', 400, 'bad-request');
    const requireTask = async (): Promise<AgentTask> => {
      const task = await rt.store.get(id);
      if (!task || task.runner !== 'local') throw new ConfluenceError('Task tidak ditemukan.', 404, 'not-found');
      return task;
    };

    const current = await requireTask();
    if (current.kind === 'trace') return await traceTaskAction(res, req, rt, current, method, action, deps);

    // Local coding tasks are driven by coder-runs.
    const coder = coderRuns(env, deps);
    const runId = current.links?.coderRunId ?? '';
    const run = coder.get(runId);
    if (method === 'GET') {
      const events = (run?.events ?? []).map((e) => ({ at: e.at, event: `local.${e.kind}`, data: JSON.stringify(e.text) }));
      return send(res, 200, { task: current, events, coderRun: run });
    }
    const body = await readAgentBody(req);
    try {
      switch (action) {
        case 'cancel':
        case 'stop':
          await coder.cancel(runId);
          return send(res, 200, { task: await requireTask() });
        case 'steer':
          // For a coding agent, an instruction after it stopped is a revision request.
          if (typeof body.message !== 'string') throw new ConfluenceError('Field message wajib berupa teks.', 400, 'bad-request');
          await coder.revise(runId, body.message);
          return send(res, 200, { ok: true });
        case 'complete':
        case 'resolve': {
          const reason = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'Ditandai selesai oleh user.';
          if (runId) {
            try {
              await coder.markCompleted(runId, reason);
            } catch {}
          }
          await rt.store.update(id, { status: 'completed', progress: { message: reason } });
          return send(res, 200, { task: await requireTask() });
        }
        default:
          throw new ConfluenceError('Task agent coding dikelola dari panel Agent (Task Board / Bug Tracing): push, revisi, atau batal.', 409, 'conflict');
      }
    } catch (e) {
      if (e instanceof CoderError) throw new ConfluenceError(e.message, e.status, e.status === 404 ? 'not-found' : 'bad-request');
      throw e;
    }
  } catch (e) {
    throw agentError(e);
  }
}

/** Agent Tasks actions on a trace question: cancel, ask a follow-up (steer), or mark done. */
async function traceTaskAction(res: ServerResponse, req: IncomingMessage, rt: AgentRuntime, task: AgentTask, method: string, action: string | undefined, deps: ConnectorDeps) {
  const traces = (deps.traceManager ?? traceManager)(deps);
  const traceId = task.links?.traceId ?? '';
  try {
    if (method === 'GET') {
      const trace = await traces.get(traceId).catch(() => null);
      return send(res, 200, { task, events: [], trace });
    }
    const body = await readAgentBody(req);
    switch (action) {
      case 'cancel':
      case 'stop':
        await traces.cancel(traceId);
        return send(res, 200, { task: (await rt.store.get(task.id)) ?? task });
      case 'steer': {
        if (typeof body.message !== 'string') throw new ConfluenceError('Field message wajib berupa teks.', 400, 'bad-request');
        const trace = await traces.get(traceId);
        const ai = trace.turns.at(-1)?.ai;
        if (!ai) throw new ConfluenceError('Trace belum punya pertanyaan.', 409, 'conflict');
        await traces.ask({ traceId, question: body.message, ai });
        return send(res, 200, { ok: true });
      }
      case 'complete':
      case 'resolve': {
        const reason = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'Ditandai selesai oleh user.';
        await rt.store.update(task.id, { status: 'completed', progress: { message: reason } });
        return send(res, 200, { task: (await rt.store.get(task.id)) ?? task });
      }
      default:
        throw new ConfluenceError('Aksi ini tidak tersedia untuk trace.', 409, 'conflict');
    }
  } catch (e) {
    if (e instanceof TraceInputError) throw new ConfluenceError(e.message, e.status, e.status === 404 ? 'not-found' : e.status === 409 ? 'conflict' : 'bad-request');
    throw e;
  }
}

const JID =/^[\w.:-]{1,80}@(s\.whatsapp\.net|g\.us|lid)$/;

async function handleWhatsApp(route: string, url: URL, req: IncomingMessage, res: ServerResponse, appendAudit: ConnectorDeps['appendAudit']) {
  const { whatsapp, WaSendError } = await import('./whatsapp/session.ts');
  const wa = whatsapp();
  const jidParam = (jid: unknown): string => {
    if (typeof jid !== 'string' || !JID.test(jid)) throw new ConfluenceError('Chat tidak valid.', 400, 'bad-request');
    return jid;
  };

  if (route === 'GET /wa/status') return send(res, 200, await wa.getStatus());
  if (route === 'POST /wa/connect') {
    await wa.connect();
    return send(res, 200, await wa.getStatus());
  }
  if (route === 'POST /wa/logout') {
    await wa.logout();
    return send(res, 200, await wa.getStatus());
  }
  if (route === 'GET /wa/chats') return send(res, 200, wa.store.listChats());
  if (route === 'GET /wa/messages') {
    const jid = jidParam(url.searchParams.get('jid'));
    // Local unread counter only: no read receipt is sent to the other side.
    wa.store.markRead(jid);
    return send(res, 200, wa.store.listMessages(jid));
  }
  if (route === 'GET /wa/templates') return send(res, 200, await readTemplates());
  if (route === 'PUT /wa/templates') {
    try {
      const templates = validateTemplates(await readJson<unknown>(req));
      await writeTemplates(templates);
      return send(res, 200, templates);
    } catch (e) {
      if (e instanceof ConfluenceError) throw e;
      throw new ConfluenceError((e as Error).message, 400, 'bad-request');
    }
  }
  if (route === 'POST /wa/contact') {
    const body = await readJson<{ jid: string; name: string }>(req);
    const jid = jidParam(body.jid);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name) {
      wa.store.setName(jid, name, true);
    }
    return send(res, 200, { ok: true, name: wa.store.nameOf(jid) });
  }
  if (route === 'POST /wa/draft') {
    const body = await readJson<WaDraftRequest>(req);
    const jid = jidParam(body.jid);
    if (!AUDIENCES.some((a) => a.id === body.audience)) throw new ConfluenceError('Audience tidak valid.', 400, 'bad-request');
    const chat = wa.store.listChats().find((c) => c.jid === jid);
    const customChatName = typeof body.chatName === 'string' && body.chatName.trim() ? body.chatName.trim() : undefined;
    const chatName = customChatName || (chat ? chat.name : wa.store.nameOf(jid) || jid.split('@')[0]);
    const isGroup = chat ? chat.isGroup : jid.endsWith('@g.us');
    try {
      const draft = await draftReply({
        chatName,
        isGroup,
        audience: body.audience,
        messages: wa.store.listMessages(jid),
        template: typeof body.template === 'string' ? body.template.slice(0, 4096) : undefined,
        instruction: typeof body.instruction === 'string' ? body.instruction.slice(0, 1000) : undefined,
      }, isAiSelection(body.ai) ? body.ai : undefined);
      const response: WaDraftResponse = { draft };
      return send(res, 200, response);
    } catch (e) {
      throw new ConfluenceError(`Gagal membuat draft: ${(e as Error).message}`, 502, 'upstream');
    }
  }
  if (route === 'POST /wa/send') {
    const body = await readJson<WaSendRequest>(req);
    const jid = jidParam(body.jid);
    const chatName = wa.store.nameOf(jid);
    const base = { ts: new Date().toISOString(), action: 'whatsapp.send' as const, spaceKey: 'WhatsApp', title: chatName, attachments: body.attachment ? 1 : 0 };
    try {
      await wa.send(jid, typeof body.text === 'string' ? body.text : '', body.attachment);
    } catch (e) {
      // Metadata only: the message text is never written to the audit log.
      await appendAudit({ ...base, result: 'failure', error: (e as Error).message }).catch(() => {});
      if (e instanceof WaSendError) throw new ConfluenceError(e.message, e.status, 'bad-request');
      throw e;
    }
    await appendAudit({ ...base, result: 'success' }).catch(() => {});
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

async function handleTeams(route: string, url: URL, req: IncomingMessage, res: ServerResponse, appendAudit: ConnectorDeps['appendAudit']) {
  const { teamsSession } = await import('./teams/session.ts');

  if (route === 'GET /teams/status') return send(res, 200, await teamsSession.getStatus());
  if (route === 'POST /teams/login') {
    const body = ((await readJson<{ tenantId?: string; clientId?: string }>(req).catch(() => ({}))) || {}) as {
      tenantId?: string;
      clientId?: string;
    };
    try {
      const auth = await teamsSession.startDeviceCodeLogin(body.tenantId, body.clientId);
      return send(res, 200, auth);
    } catch (e) {
      throw new ConfluenceError((e as Error).message, 400, 'bad-request');
    }
  }
  if (route === 'POST /teams/login/cancel') {
    teamsSession.cancelLogin();
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /teams/logout') {
    await teamsSession.clearAuth();
    return send(res, 200, await teamsSession.getStatus());
  }
  if (route === 'GET /teams/chats') {
    try {
      return send(res, 200, await teamsSession.getChats({ fresh: url.searchParams.get('fresh') === '1' }));
    } catch (e) {
      throw new ConfluenceError((e as Error).message, 502, 'upstream');
    }
  }
  if (route === 'GET /teams/messages') {
    const chatId = url.searchParams.get('chatId')?.trim();
    if (!chatId) throw new ConfluenceError('chatId wajib diisi.', 400, 'bad-request');
    try {
      return send(res, 200, await teamsSession.getMessages(chatId));
    } catch (e) {
      throw new ConfluenceError((e as Error).message, 502, 'upstream');
    }
  }
  if (route === 'POST /teams/send') {
    const body = await readJson<{ chatId: string; content?: string; attachment?: any }>(req);
    if (!body.chatId) throw new ConfluenceError('chatId wajib diisi.', 400, 'bad-request');
    if (!body.content?.trim() && !body.attachment) {
      throw new ConfluenceError('Pesan atau lampiran wajib diisi.', 400, 'bad-request');
    }
    const base = { ts: new Date().toISOString(), action: 'teams.send' as const, spaceKey: 'Microsoft Teams', title: body.chatId, attachments: body.attachment ? 1 : 0 };
    try {
      const result = await teamsSession.sendMessage(body.chatId, body.content || '', body.attachment);
      await appendAudit({ ...base, result: 'success' }).catch(() => {});
      return send(res, 200, result);
    } catch (e) {
      await appendAudit({ ...base, result: 'failure', error: (e as Error).message }).catch(() => {});
      throw new ConfluenceError((e as Error).message, 502, 'upstream');
    }
  }
  if (route === 'POST /teams/draft') {
    const body = await readJson<any>(req);
    requireFields(body, ['chatId']);
    try {
      return send(res, 200, await teamsSession.draftReply(body));
    } catch (e) {
      throw new ConfluenceError((e as Error).message, 502, 'upstream');
    }
  }
  return fail(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
}

async function publish(client: ConfluenceClient, body: PublishRequest, res: ServerResponse, appendAudit: ConnectorDeps['appendAudit']) {
  const spaceKey = body.spaceKey.trim();
  const title = body.title.trim();
  const isUpdate = Boolean(body.pageId);
  const isDraft = Boolean(body.asDraft);
  const audit = {
    action: isUpdate ? ('confluence.update' as const) : ('confluence.create' as const),
    spaceKey,
    title,
    pageId: body.pageId,
    attachments: body.attachments?.length ?? 0,
    mrUrl: body.context?.mrUrl,
    jiraKeys: body.context?.jiraKeys,
    isDraft,
  };
  let actor: string | undefined;
  let versionBefore: number | undefined;

  try {
    actor = await client.currentUser().catch(() => undefined);
    const uploads = (body.attachments ?? []).map((a) => ({ ...a, data: Buffer.from(a.base64, 'base64') }));
    let page;

    if (isUpdate) {
      const current = await client.getPage(body.pageId!, spaceKey);
      versionBefore = current.version;
      if (body.expectedVersion === undefined || current.version !== body.expectedVersion) {
        await appendAudit({ ...audit, ts: new Date().toISOString(), result: 'failure', actor, versionBefore, error: 'version-conflict' });
        return fail(res, 409, {
          error: `Halaman sudah berubah di Confluence (versi ${current.version}, yang kamu review versi ${body.expectedVersion ?? '-'}). Cek ulang sebelum publish.`,
          code: 'conflict',
          currentVersion: current.version,
          page: { ...current, storage: undefined },
        });
      }
      // Upload first so the updated page never references a missing image.
      for (const a of uploads) await client.upsertAttachment(current.id, a.filename, a.data, a.contentType);

      let targetVersion: number;
      if (isDraft) {
        targetVersion = current.version;
      } else if (current.status === 'draft') {
        targetVersion = current.version;
      } else {
        targetVersion = current.version + 1;
      }
      const status = isDraft ? 'draft' : 'current';

      page = await client.updatePage({
        id: current.id,
        spaceKey,
        title,
        storage: body.storage,
        version: targetVersion,
        status,
        message: body.versionMessage,
      });
    } else {
      const existing = await client.findPage(spaceKey, title);
      if (existing) {
        return fail(res, 409, { error: `Halaman "${title}" sudah ada di space ${spaceKey}. Pilih update atau ganti judul.`, code: 'exists', page: { ...existing, storage: undefined } });
      }
      const status = isDraft ? 'draft' : 'current';
      page = await client.createPage({
        spaceKey,
        title,
        parentId: body.parentId?.trim() || undefined,
        storage: body.storage,
        status,
      });
      for (const a of uploads) await client.upsertAttachment(page.id, a.filename, a.data, a.contentType);
    }

    await appendAudit({ ...audit, ts: new Date().toISOString(), result: 'success', actor, pageId: page.id, versionBefore, versionAfter: page.version });
    const response: PublishResponse = {
      page: { ...page, storage: undefined },
      action: isUpdate ? 'update' : 'create',
      isDraft,
    };
    return send(res, 200, response);
  } catch (e) {
    await appendAudit({ ...audit, ts: new Date().toISOString(), result: 'failure', actor, versionBefore, error: (e as Error).message }).catch(() => {});
    throw e;
  }
}

/** The process-wide Remote Access, fed by the same stores and clients as the desktop views. */
function remoteFor(env: Env, deps: ConnectorDeps): RemoteAccess {
  return remoteAccess({
    appendAudit: deps.appendAudit,
    log: deps.logError,
    data: connectorMobileData({
      dir: REMOTE_DIR,
      taskPeaks: deps.taskPeaks ?? defaultTaskPeaks,
      projects: () => (deps.estimate ?? estimateManager)().listProjects(),
      holidays: async () => (await (deps.estimate ?? estimateManager)().holidays()).holidays,
      drafts: async () => (await draftFiles.list()) as { id: string; markdown: string; scopePlan?: string }[],
      jiraIssues: async (keys) => {
        const { cfg } = await loadJiraConfig(env);
        if (!cfg) throw new Error('Jira belum dikonfigurasi.');
        const client = new JiraClient(cfg);
        const out: Awaited<ReturnType<JiraClient['searchIssues']>> = [];
        for (let i = 0; i < keys.length; i += 100) out.push(...(await client.searchIssues(`key in (${keys.slice(i, i + 100).join(',')})`, 100)));
        return out;
      },
      gitlabMrsForKeys: async (keys) => {
        const { client } = await loadGitLab(env);
        return client ? manualMrs.merge(keys, await client.mrsForKeys(keys), client) : null;
      },
      openMrs: async () => {
        const { client } = await loadGitLab(env);
        if (!client) return [];
        const me = await client.currentUser();
        const lists = await Promise.all((['reviewer', 'assigned', 'created'] as const).map((scope) => client.listMrs(scope, me).catch(() => [])));
        return lists.flat();
      },
      agentTasks: async () => (await (deps.agentRuntime ?? (() => agentRuntime()))().store.list({ limit: 200 })).filter((t) => t.runner === 'local'),
      qaRuns: (projectId) => (deps.qa ?? qaManager)().listRuns(projectId),
      reportTargets: async () => (await remoteFor(env, deps).settings()).reportTargets,
      sendWhatsApp: async (jid, text) => {
        const { whatsapp } = await import('./whatsapp/session.ts');
        await whatsapp().send(jid, text);
      },
    }),
  });
}
