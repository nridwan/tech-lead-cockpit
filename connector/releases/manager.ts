import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstimateProject } from '../../src/lib/estimate/types.ts';
import type { MrCommit, MrDetail, MrFileChange, MrSummary } from '../../src/lib/gitlab/types.ts';
import { mrTitle, newMrFormUrl } from '../../src/lib/release/mr.ts';
import { planReleaseBranch, releaseBranchName } from '../../src/lib/release/branch.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import { checkMr, isEnvOrConfigFile, jiraKeysIn } from '../../src/lib/release/checks.ts';
import { RELEASE_AI_SYSTEM, diffText, discoverPrompt, fileDelta, focusTerms, hunksText, parsePatchReply, patchPrompt, documentPrompt, parseDiscoverReply, parseDocumentReply, parsePicksReply, parseTicketsReply, picksPrompt, ticketsPrompt, type AiCommitInput, type AiDocService } from '../../src/lib/release/ai.ts';
import { isAiSelection, type AiSelection } from '../../src/lib/ai/types.ts';
import { foldEnvItems, serviceEnvBlock } from '../../src/lib/release/deployment.ts';
import { applyFileHunks, fileHunks, hunkNumber, hunkPath, jsonChanges, jsonProblem, locateRoutes, patchFile, resultDelta, type FileHunks } from '../../src/lib/release/patch.ts';
import { FRONT_SUFFIXES, belongsTo, buildReport, codeKeys, forCurrentServices, isFrontTicket, ticketType, typeInScope, matchesCodename, sameService, ticketService, type ReleaseTicket } from '../../src/lib/release/coverage.ts';
import { findEvidence, indexChanges, unattributedFiles, withSharedEndpoints, type FileText } from '../../src/lib/release/evidence.ts';
import { mergeReleaseDoc, parseReleaseDoc, serviceForPath, type ImportOptions } from '../../src/lib/release/import.ts';
import { parseDeploymentStorage } from '../../src/lib/release/deployment.ts';
import { shareMessageHtml, shareMessageText, type ShareOptions } from '../../src/lib/release/share.ts';
import type { AiTicketVerdict, CodeEvidence, ReleaseAiNeed, CodeSource, MrCheck, MrPlan, ReleaseAiJob, OutOfScope, Release, ReleaseItem, ReleaseReport, ReleaseService, ReleaseSource } from '../../src/lib/release/types.ts';
import { parseTaskTitle } from '../../src/lib/tad/template.ts';
import { parseScopeTasks, taskDetailText, taskEndpoints } from '../../src/lib/tad/task-links.ts';
import { matchRepo } from '../roster/git-activity.ts';
import { ReleaseInputError, ReleaseStore } from './store.ts';

/**
 * Release management in the connector: finds what belongs to a release (tickets from the TADs,
 * tickets with the release's CODENAMEs, keys from the release document), the MRs into the
 * target branch of each service, checks them, and posts the review request to Teams. GitLab and
 * Jira are only read; the one write is the Teams message the user confirmed.
 */

/** What release management needs from GitLab (reads, plus createMr after confirmation). */
export interface ReleaseGitLab {
  mrsToBranch(target: string, days?: number): Promise<(MrSummary & { description: string })[]>;
  mr(path: string, iid: number): Promise<MrDetail>;
  tokenScopes?(): Promise<string[] | undefined>;
  branchExists?(path: string, branch: string): Promise<boolean>;
  compare?(path: string, target: string, source: string): Promise<{ commits: MrCommit[]; changes: MrFileChange[]; truncated: boolean }>;
  openMrFor?(path: string, source: string, target: string): Promise<MrSummary | undefined>;
  createMr?(path: string, req: { source: string; target: string; title: string; description: string }): Promise<MrSummary>;
  createBranch?(path: string, branch: string, ref: string): Promise<void>;
  cherryPick?(path: string, sha: string, branch: string): Promise<{ id: string }>;
  rawFile?(path: string, filePath: string, ref: string): Promise<string | undefined>;
  commitFiles?(path: string, req: { branch: string; start: string; message: string; actions: { action: 'create' | 'update' | 'delete'; path: string; content?: string }[] }): Promise<{ id: string }>;
}

export interface ReleaseDeps {
  store: ReleaseStore;
  /** Where the last report per release is kept. */
  reportDir: string;
  gitlab: () => Promise<ReleaseGitLab | null>;
  /** GitLab web address, for the filled-in "new MR" form. */
  gitlabBaseUrl?: () => Promise<string>;
  jiraSearch: (jql: string, limit: number) => Promise<JiraIssue[]>;
  projects: () => Promise<EstimateProject[]>;
  drafts: () => Promise<{ id: string; markdown: string; scopePlan?: string }[]>;
  /** Repo folder → GitLab project path (from the Services repos' remotes). */
  repoPaths: () => Promise<Record<string, string>>;
  teamsSend: (chatId: string, html: string) => Promise<void>;
  /** Runs a text prompt on the chosen AI (no tools); for the AI check, pick and document fix. */
  runAi?: (ai: AiSelection, prompt: string, opts: { systemPrompt: string; timeoutMs: number }) => { done: Promise<{ reply: string; error?: string }>; cancel: () => void };
  now?: () => Date;
}

const AI_TIMEOUT_MS = 10 * 60_000;
const AI_MAX_COMMITS = 40;
const VERDICT_RANK = { tidak: 0, sebagian: 1, ada: 2 } as const;
type AiKind = ReleaseAiJob['kind'];
interface AiLive {
  job: ReleaseAiJob;
  cancel?: () => void;
  cancelled?: boolean;
}

const KEY_BATCH = 80;
const newId = () => crypto.randomUUID();

export class ReleaseManager {
  private readonly aiLive = new Map<string, AiLive>();
  /** Ticket types seen by the last ticket lookup per release (for the report's type filter). */
  private readonly lastTypes = new Map<string, NonNullable<ReleaseReport['types']>>();

  constructor(private readonly deps: ReleaseDeps) {}

  get store(): ReleaseStore {
    return this.deps.store;
  }

  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async get(id: string): Promise<Release> {
    const r = await this.deps.store.get(id);
    if (!r) throw new ReleaseInputError('Rilis tidak ditemukan.');
    return r;
  }

  /** TAD tasks of the release's projects: Jira keys, service, the CODENAMEs they use, and their endpoints. */
  private async tadTasks(release: Release): Promise<{ key: string; service: string; title: string; endpoints: string[]; detail: string }[]> {
    if (!release.projectIds.length) return [];
    const [projects, drafts] = await Promise.all([this.deps.projects(), this.deps.drafts()]);
    const draftIds = new Set(projects.filter((p) => release.projectIds.includes(p.id)).flatMap((p) => p.draftIds));
    return drafts
      .filter((d) => draftIds.has(d.id))
      .flatMap((d) =>
        parseScopeTasks(d.markdown, d.scopePlan).flatMap((t) => {
          const endpoints = taskEndpoints(d.markdown, t.title);
          const detail = taskDetailText(d.markdown, t.title);
          return t.jiraKeys.map((key) => ({ key, service: t.service || parseTaskTitle(t.title)?.service || '', title: t.title, endpoints, detail }));
        }),
      );
  }

  /** The release's CODENAMEs: typed in, plus those of its TAD task titles. */
  async codenames(release: Release): Promise<string[]> {
    const tad = await this.tadTasks(release);
    return [...new Set([...release.codenames, ...tad.map((t) => parseTaskTitle(t.title)?.codeName.toUpperCase()).filter((c): c is string => Boolean(c))])];
  }

  private async issuesByKeys(keys: string[]): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    const list = [...new Set(keys)];
    for (let i = 0; i < list.length; i += KEY_BATCH) out.push(...(await this.deps.jiraSearch(`key in (${list.slice(i, i + KEY_BATCH).join(',')})`, KEY_BATCH)));
    return out;
  }

  /**
   * Keys found in the code but not in the scope: their Jira summary and status, and the ones
   * whose CODENAME belongs to the release (older than the codename search reaches) join the scope.
   */
  private async resolveOutside(release: Release, tickets: ReleaseTicket[], keys: string[], warnings: string[]): Promise<Map<string, { summary: string; status: string }>> {
    const inScope = new Set(tickets.map((t) => t.key));
    const outside = [...new Set(keys)].filter((k) => !inScope.has(k));
    const extra = new Map<string, { summary: string; status: string }>();
    if (!outside.length) return extra;
    let issues: JiraIssue[] = [];
    try {
      issues = await this.issuesByKeys(outside);
    } catch (e) {
      warnings.push(`Judul tiket di luar scope tidak termuat: ${(e as Error).message}`);
    }
    const codenames = await this.codenames(release);
    for (const i of issues) {
      if (matchesCodename(i.summary, codenames) && typeInScope(i.summary, release.ticketTypes)) tickets.push({ key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, service: ticketService(i.summary, codenames), from: 'codename' });
      else extra.set(i.key, { summary: i.summary, status: i.status });
    }
    return extra;
  }

  /** Every ticket of the release, with where it came from (TAD first, then CODENAME, then the document). */
  async tickets(release: Release): Promise<{ tickets: ReleaseTicket[]; warnings: string[] }> {
    const warnings: string[] = [];
    const tad = await this.tadTasks(release);
    const codenames = await this.codenames(release);
    const byKey = new Map<string, JiraIssue>();
    try {
      for (const i of await this.issuesByKeys([...tad.map((t) => t.key), ...release.jiraKeys])) byKey.set(i.key, i);
    } catch (e) {
      warnings.push(`Tiket Jira tidak termuat: ${(e as Error).message}`);
    }
    const byCodename: JiraIssue[] = [];
    if (codenames.length) {
      try {
        // Jira text search ignores the brackets: search loosely, then match the CODENAME exactly.
        const text = codenames.map((c) => `summary ~ "${c.replace(/["\\]/g, '')}"`).join(' OR ');
        const found = await this.deps.jiraSearch(`(${text}) AND updated >= -180d ORDER BY updated DESC`, 100);
        byCodename.push(...found.filter((i) => matchesCodename(i.summary, codenames)));
      } catch (e) {
        warnings.push(`Pencarian tiket per codename gagal: ${(e as Error).message}`);
      }
    }
    // The service is what the Jira title says ([TYPE][SERVICE][CODENAME]); the TAD row's service
    // only fills in when the title names none, and is also checked when it differs.
    const toTicket = (i: JiraIssue, from: ReleaseTicket['from'], tadService?: string): ReleaseTicket => {
      const named = ticketService(i.summary, codenames);
      const service = named || tadService;
      const also = named && tadService && !sameService(named, tadService) ? tadService : undefined;
      return { key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, service, ...(also ? { alsoService: also } : {}), from };
    };
    const out: ReleaseTicket[] = [];
    const seen = new Set<string>();
    const push = (t: ReleaseTicket) => !seen.has(t.key) && (seen.add(t.key), out.push(t));
    for (const t of tad) {
      const i = byKey.get(t.key);
      const base: ReleaseTicket = i ? toTicket(i, 'tad', t.service) : { key: t.key, summary: t.title, status: 'Tidak ditemukan di Jira', service: t.service, from: 'tad' };
      push({ ...base, ...(t.endpoints.length ? { endpoints: t.endpoints } : {}), ...(t.detail ? { detail: t.detail } : {}) });
    }
    for (const i of byCodename) push(toTicket(i, 'codename'));
    for (const k of release.jiraKeys) {
      const i = byKey.get(k);
      if (i) push(toTicket(i, 'release'));
    }
    // The release's ticket types: tickets of other types (e.g. FRONTEND in a back-end release) are left out.
    const types = new Map<string, number>();
    for (const t of out) {
      const ty = ticketType(t.summary);
      if (ty) types.set(ty, (types.get(ty) ?? 0) + 1);
    }
    this.lastTypes.set(release.id, [...types].map(([type, count]) => ({ type, count, excluded: !typeInScope(`[${type}]`, release.ticketTypes) })));
    return { tickets: out.filter((t) => typeInScope(t.summary, release.ticketTypes)), warnings };
  }

  /**
   * Fills the release: services touched by its tickets (with their GitLab project from the repo
   * remotes) and the MRs into the target branch of those projects. Open MRs, and MRs merged since
   * shortly before the release was created, are added; nothing is removed.
   */
  async discover(id: string): Promise<{ release: Release; addedMrs: number; addedServices: number; warnings: string[] }> {
    const release = await this.get(id);
    const { tickets, warnings } = await this.tickets(release);
    const services: ReleaseService[] = release.services.map((s) => ({ ...s, mrs: [...s.mrs] }));
    const repoPaths = await this.deps.repoPaths().catch(() => ({}) as Record<string, string>);
    const folders = Object.keys(repoPaths);
    let addedServices = 0;
    const ignored = release.ignoredServices ?? [];
    // A front-end ticket's service is X's front-end repo when there is one (not the back-end X).
    const home = (t: ReleaseTicket, x?: string) => (x && isFrontTicket(t.summary) ? (folders.find((f) => FRONT_SUFFIXES.some((sfx) => sameService(`${x}-${sfx}`, f))) ?? x) : x);
    for (const name of [...new Set(tickets.flatMap((t) => [home(t, t.service), home(t, t.alsoService)]).filter((s): s is string => Boolean(s)))]) {
      if (services.some((s) => sameService(s.name, name)) || ignored.some((n) => sameService(n, name))) continue;
      services.push({ id: newId(), name, mrs: [], order: services.length + 1 });
      addedServices++;
    }
    for (const s of services) {
      if (s.gitlabPath) continue;
      const folder = matchRepo(s.name, folders);
      if (folder) s.gitlabPath = repoPaths[folder];
    }

    let addedMrs = 0;
    const gitlab = await this.deps.gitlab();
    if (!gitlab) warnings.push('GitLab belum terhubung: MR tidak bisa dicari.');
    else {
      const since = new Date(new Date(release.createdAt).getTime() - 7 * 86_400_000).toISOString();
      const keys = new Set(tickets.map((t) => t.key));
      try {
        for (const mr of await gitlab.mrsToBranch(release.targetBranch, 30)) {
          if (mr.state === 'merged' && mr.updatedAt < since) continue;
          // The MR's own branch and title, not its description: a description listing tickets
          // (or copied from another release) says nothing about the repo.
          const mentions = jiraKeysIn(`${mr.title} ${mr.sourceBranch}`).some((k) => keys.has(k));
          const svc = services.find((s) => s.gitlabPath === mr.projectPath) ?? (mentions ? serviceForPath(services, mr.projectPath) : undefined);
          if (!svc && !mentions) continue;
          let target = svc;
          if (!target && ignored.some((n) => sameService(n, mr.projectPath.split('/').pop() ?? ''))) continue;
          if (!target) {
            // An MR that mentions a release ticket in a repo no service maps to: a new service.
            target = { id: newId(), name: mr.projectPath.split('/').pop() ?? mr.projectPath, gitlabPath: mr.projectPath, mrs: [], order: services.length + 1 };
            services.push(target);
            addedServices++;
          }
          target.gitlabPath ??= mr.projectPath;
          if (target.mrs.some((m) => m.ref === mr.ref)) continue;
          target.mrs.push({ ref: mr.ref, projectPath: mr.projectPath, iid: mr.iid, webUrl: mr.webUrl, title: mr.title, via: 'auto' });
          addedMrs++;
        }
      } catch (e) {
        warnings.push(`Mencari MR di GitLab gagal: ${(e as Error).message}`);
      }
    }
    const saved = await this.deps.store.save({ ...release, services });
    return { release: saved, addedMrs, addedServices, warnings };
  }

  /**
   * Reads the code of every service: checks every MR, takes its live MRs' diffs, or the compare
   * of its source branch with the target when it has no MR yet; then the tickets, and where the
   * pattern match finds them. Shared by the check and the AI check.
   */
  private async readCode(release: Release): Promise<CodeRead> {
    const gitlab = await this.deps.gitlab();
    const checks: MrCheck[] = [];
    const diffs = new Map<string, FileText[]>();
    const changed = new Map<string, MrFileChange[]>();
    const commits = new Map<string, string[]>();
    for (const m of release.services.flatMap((s) => s.mrs)) {
      if (!gitlab) {
        checks.push(blankCheck(m.ref, m.webUrl, m.title, release.targetBranch, 'GitLab belum terhubung.'));
        continue;
      }
      try {
        const detail = await gitlab.mr(m.projectPath, m.iid);
        checks.push(checkMr(detail));
        if (detail.state === 'opened' || detail.state === 'merged') {
          diffs.set(m.ref, indexChanges(detail.changes));
          changed.set(m.ref, detail.changes);
          commits.set(m.ref, detail.commits.map((c) => c.title));
        }
      } catch (e) {
        checks.push(blankCheck(m.ref, m.webUrl, m.title, release.targetBranch, (e as Error).message));
      }
    }

    // The code of each service: its live MRs, else what its source branch would bring.
    const sources: CodeSource[] = [];
    const serviceRefs = new Map<string, string[]>();
    for (const s of release.services) {
      const live = s.mrs.filter((m) => diffs.has(m.ref)).map((m) => m.ref);
      if (live.length) {
        serviceRefs.set(s.id, live);
        for (const ref of live) sources.push({ service: s.name, ref, kind: 'mr', files: changed.get(ref)!.length, unattributed: [] });
        continue;
      }
      if (!s.gitlabPath || !gitlab?.compare) continue;
      const branch = (s.sourceBranch || release.sourceBranch || 'staging').trim();
      const ref = `${s.gitlabPath}@${branch}`;
      try {
        if (gitlab.branchExists && !(await gitlab.branchExists(s.gitlabPath, branch))) throw new Error(`branch ${branch} tidak ada`);
        const cmp = await gitlab.compare(s.gitlabPath, release.targetBranch, branch);
        diffs.set(ref, indexChanges(cmp.changes));
        changed.set(ref, cmp.changes);
        commits.set(ref, cmp.commits.map((c) => c.title));
        serviceRefs.set(s.id, [ref]);
        sources.push({ service: s.name, ref, kind: 'branch', files: cmp.changes.length, unattributed: [] });
      } catch (e) {
        sources.push({ service: s.name, ref, kind: 'branch', files: 0, unattributed: [], error: (e as Error).message });
      }
    }

    const { tickets, warnings } = await this.tickets(release);
    const live = checks.filter((c) => !c.error && c.state !== 'closed');
    const prefixes = new Set(tickets.map((t) => t.key.split('-')[0]));
    const extra = await this.resolveOutside(release, tickets, live.flatMap((c) => codeKeys(c, prefixes)), warnings);

    // Each ticket is looked for in the code of its own service (all services when it names none).
    const evidence = new Map<string, CodeEvidence[]>();
    const byRef = new Map<string, { summary: string; evidence: CodeEvidence }[]>();
    for (const t of withSharedEndpoints(tickets)) {
      for (const s of release.services.filter((x) => belongsTo(t, x.name, true, release.services.map((x) => x.name)))) {
        for (const ref of serviceRefs.get(s.id) ?? []) {
          const found = findEvidence({ key: t.key, summary: t.summary, endpoints: t.endpoints }, diffs.get(ref)!);
          if (!found) continue;
          const e = { ref, ...found };
          evidence.set(t.key, [...(evidence.get(t.key) ?? []), e]);
          byRef.set(ref, [...(byRef.get(ref) ?? []), { summary: t.summary, evidence: e }]);
        }
      }
    }
    for (const src of sources) if (!src.error) src.unattributed = unattributedFiles(changed.get(src.ref) ?? [], byRef.get(src.ref) ?? []).slice(0, 30);
    return { checks, changed, commits, sources, serviceRefs, tickets, warnings, extra, evidence };
  }

  /** env/migration/SQL items the pattern check found in the live MRs (kept done marks). */
  private checkItems(release: Release, checks: MrCheck[]): ReleaseItem[] {
    const items: ReleaseItem[] = [...release.items];
    const add = (kind: ReleaseItem['kind'], label: string, service: string) => {
      if (!items.some((i) => i.kind === kind && i.label === label && (i.service ?? service) === service)) items.push({ id: newId(), kind, label, service, source: 'check', done: false });
    };
    for (const s of release.services) {
      for (const m of s.mrs) {
        const c = checks.find((x) => x.ref === m.ref);
        if (!c || c.error || c.state === 'closed') continue;
        for (const e of c.envAdded) add('env', e, s.name);
        for (const p of c.migrations) add('migration', p, s.name);
        for (const p of c.sqlOutside) add('sql', p, s.name);
      }
    }
    return items;
  }

  private async finishCheck(release: Release, code: CodeRead, items: ReleaseItem[], ai?: AiRead): Promise<{ release: Release; report: ReleaseReport }> {
    const report = buildReport(release, code.tickets, code.checks, this.now(), code.extra, { sources: code.sources, evidence: code.evidence, ...(ai ? { ai: ai.tickets } : {}) });
    const types = this.lastTypes.get(release.id);
    if (types?.length) report.types = types;
    if (ai) {
      report.ai = { model: ai.model, errors: ai.errors };
      for (const src of report.sources ?? []) {
        const u = ai.unrelated.get(src.service);
        if (u) src.aiUnrelated = u;
        const r = ai.risks.get(src.service);
        if (r?.length) src.aiRisks = r;
        const p = ai.pending.get(src.service);
        if (p?.length) src.aiPending = p;
      }
      report.warnings.unshift(...ai.errors);
    }
    report.warnings.unshift(...code.warnings);
    const fresh = await this.get(release.id);
    const saved = await this.deps.store.save(foldEnvItems({
      ...fresh,
      items,
      services: fresh.services.map((s) => {
        const steps = ai?.steps.get(s.name);
        return {
          ...s,
          mrs: s.mrs.map((m) => ({ ...m, title: code.checks.find((c) => c.ref === m.ref && !c.error)?.title ?? m.title })),
          // The AI writes these steps: each check replaces the last one's, never piles up.
          ...(steps ? { preDeploy: addLines([], steps.pre), postDeploy: addLines([], steps.post) } : {}),
        };
      }),
    }));
    await this.saveReport(report);
    return { release: saved, report };
  }

  /** Checks every MR, reads every service's code, finds the tickets in it and keeps the report. */
  async check(id: string): Promise<{ release: Release; report: ReleaseReport }> {
    const release = await this.get(id);
    const code = await this.readCode(release);
    return this.finishCheck(release, code, this.checkItems(release, code.checks));
  }

  async report(id: string): Promise<ReleaseReport | null> {
    try {
      const release = await this.get(id);
      return forCurrentServices(release, JSON.parse(await readFile(join(this.deps.reportDir, `${release.id}.json`), 'utf8')) as ReleaseReport);
    } catch {
      return null;
    }
  }

  private async saveReport(r: ReleaseReport) {
    await mkdir(this.deps.reportDir, { recursive: true, mode: 0o700 });
    const file = join(this.deps.reportDir, `${r.releaseId}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(r), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  /** A Confluence page's storage, when given, is read as a deployment page first (exact layout). */
  async importDoc(id: string, markdown: string, source: Omit<ReleaseSource, 'importedAt'>, storage?: string, opts: ImportOptions = {}): Promise<Release> {
    const release = await this.get(id);
    if (!markdown.trim() && !storage?.trim()) throw new ReleaseInputError('Dokumen rilis kosong.');
    const doc = (storage && parseDeploymentStorage(storage, source.title)) || parseReleaseDoc(markdown);
    return this.deps.store.save(mergeReleaseDoc(release, doc, markdown, source, this.now(), opts));
  }

  async sharePreview(id: string, opts: ShareOptions): Promise<{ text: string; html: string }> {
    const release = await this.get(id);
    const checks = (await this.report(id))?.mrs ?? [];
    const refs = this.validRefs(release, opts.mrRefs);
    return { text: shareMessageText(release, checks, { ...opts, mrRefs: refs }), html: shareMessageHtml(release, checks, { ...opts, mrRefs: refs }) };
  }

  async share(id: string, chat: { id: string; name: string }, opts: ShareOptions): Promise<Release> {
    const release = await this.get(id);
    const refs = this.validRefs(release, opts.mrRefs);
    if (!chat.id) throw new ReleaseInputError('Pilih grup atau channel Teams.');
    const checks = (await this.report(id))?.mrs ?? [];
    await this.deps.teamsSend(chat.id, shareMessageHtml(release, checks, { ...opts, mrRefs: refs }));
    return this.deps.store.save({
      ...release,
      teamsChat: { id: chat.id, name: chat.name },
      shares: [...release.shares, { at: this.now(), chatId: chat.id, chatName: chat.name, mrRefs: refs }].slice(-50),
      status: release.status === 'draft' ? 'review' : release.status,
    });
  }

  private service(release: Release, serviceId: string): ReleaseService {
    const s = release.services.find((x) => x.id === serviceId);
    if (!s) throw new ReleaseInputError('Service tidak ditemukan di rilis ini.');
    if (!s.gitlabPath) throw new ReleaseInputError(`Isi path GitLab untuk ${s.name} dulu (group/repo).`);
    return s;
  }

  /**
   * What a new MR from the source branch into the target branch of one service would contain:
   * commits, files, env/migration/query findings, the service's tickets, a title (no description),
   * and the filled-in GitLab form. Only reads GitLab.
   */
  async mrPlan(id: string, serviceId: string, sourceBranch?: string): Promise<MrPlan> {
    const release = await this.get(id);
    const service = this.service(release, serviceId);
    const path = service.gitlabPath!;
    const source = (sourceBranch || service.sourceBranch || release.sourceBranch || 'staging').trim();
    const target = release.targetBranch;
    if (!/^[\w./-]{1,100}$/.test(source)) throw new ReleaseInputError('Nama branch sumber tidak valid.');
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.compare || !gitlab.branchExists) throw new ReleaseInputError('GitLab belum terhubung.');
    const warnings: string[] = [];
    const [sourceExists, targetExists, scopes, existing] = await Promise.all([
      gitlab.branchExists(path, source),
      gitlab.branchExists(path, target),
      gitlab.tokenScopes?.() ?? Promise.resolve(undefined),
      gitlab.openMrFor?.(path, source, target).catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    if (!sourceExists) warnings.push(`Branch ${source} tidak ada di ${path}.`);
    if (!targetExists) warnings.push(`Branch ${target} tidak ada di ${path}.`);
    const cmp = sourceExists && targetExists ? await gitlab.compare(path, target, source) : { commits: [], changes: [], truncated: false };
    if (sourceExists && targetExists && !cmp.commits.length) warnings.push(`${source} tidak punya commit baru dibanding ${target}: tidak ada yang perlu di-merge.`);
    const pseudo = { ref: '', title: '', webUrl: '', state: 'opened', draft: false, author: { id: 0, username: '', name: '' }, sourceBranch: source, targetBranch: target, description: '', commits: cmp.commits, changes: cmp.changes, diffTruncated: cmp.truncated } as unknown as MrDetail;
    const c = checkMr(pseudo);
    const findings = { envAdded: c.envAdded, envReadInCode: c.envReadInCode, migrations: c.migrations, sqlOutside: c.sqlOutside, modelWithoutMigration: c.modelWithoutMigration, commitsWithoutKey: c.commitsWithoutKey, jiraKeys: c.jiraKeys };
    const { tickets: all, warnings: tw } = await this.tickets(release).catch((e: Error) => ({ tickets: [] as ReleaseTicket[], warnings: [e.message] }));
    warnings.push(...tw);
    const keysInCode = codeKeys(c, new Set(all.map((t) => t.key.split('-')[0])));
    const extra = await this.resolveOutside(release, all, keysInCode, warnings);
    const scopeKeys = new Set(all.map((t) => t.key));
    const accepted = new Set((release.accepted ?? []).map((a) => a.key));
    const outOfScope: OutOfScope[] = keysInCode
      .filter((k) => !scopeKeys.has(k) && !accepted.has(k))
      .map((k) => ({ key: k, ...(extra.get(k) ?? {}), ...(extra.get(k) && parseTaskTitle(extra.get(k)!.summary) ? { codename: parseTaskTitle(extra.get(k)!.summary)!.codeName } : {}), mrs: [], commits: c.keyCommits[k] ?? [] }));
    if (outOfScope.length) warnings.push(`${outOfScope.length} tiket di luar scope akan ikut terbawa dari ${source}: ${outOfScope.map((o) => o.key).join(', ')}.`);
    // Tickets are found in the diff itself; a key in a commit only supports it.
    const files = indexChanges(cmp.changes);
    const ref = `${path}@${source}`;
    const tickets = withSharedEndpoints(all)
      .filter((t) => belongsTo(t, service.name, false, release.services.map((x) => x.name)))
      .map((t) => {
        const found = findEvidence({ key: t.key, summary: t.summary, endpoints: t.endpoints }, files);
        const byKey = keysInCode.includes(t.key);
        const inSource = found?.strength === 'strong' || byKey;
        return { key: t.key, summary: t.summary, status: t.status, inSource, ...(found ? { code: { ref, ...found } } : {}), ...(byKey ? { byKey } : {}), ...(!inSource && found ? { unsure: true } : {}) };
      });
    const missing = tickets.filter((t) => !t.inSource && !t.unsure);
    const unsure = tickets.filter((t) => t.unsure);
    if (missing.length) warnings.push(`${missing.length} tiket ${service.name} tidak terlihat di kode ${source}: ${missing.map((t) => t.key).join(', ')}.`);
    if (unsure.length) warnings.push(`${unsure.length} tiket hanya cocok samar di kode ${source}, cek manual: ${unsure.map((t) => t.key).join(', ')}.`);
    const unattributed = unattributedFiles(cmp.changes, tickets.flatMap((t) => (t.code ? [{ summary: t.summary, evidence: t.code }] : []))).slice(0, 50);
    const title = mrTitle(release, service);
    const base = (await this.deps.gitlabBaseUrl?.().catch(() => '')) ?? '';
    return {
      serviceId,
      projectPath: path,
      sourceBranch: source,
      targetBranch: target,
      sourceExists,
      targetExists,
      ...(existing ? { existing: { ref: existing.ref, webUrl: existing.webUrl, title: existing.title } } : {}),
      commits: cmp.commits.map((x) => ({ shortId: x.shortId, title: x.title })),
      files: cmp.changes.length,
      changes: capDiffs(cmp.changes),
      truncated: cmp.truncated,
      findings,
      tickets,
      unattributed,
      outOfScope,
      title,
      formUrl: base ? newMrFormUrl(base, path, source, target, title) : '',
      ...(scopes ? { canCreate: scopes.includes('api') } : {}),
      releaseBranch: planReleaseBranch(cmp.commits, new Set([...scopeKeys, ...accepted]), { base: target, branch: releaseBranchName(release) }),
      warnings,
    };
  }

  /**
   * Creates the release MR in GitLab (the user confirmed in the UI) and adds it to the service.
   * An MR already open for the same branches is attached instead of creating a second one.
   */
  async createMr(id: string, serviceId: string, req: { sourceBranch: string; title: string }): Promise<{ release: Release; ref: string; webUrl: string; created: boolean }> {
    const release = await this.get(id);
    const service = this.service(release, serviceId);
    const path = service.gitlabPath!;
    const source = req.sourceBranch.trim();
    const title = req.title.trim().slice(0, 250);
    if (!/^[\w./-]{1,100}$/.test(source)) throw new ReleaseInputError('Nama branch sumber tidak valid.');
    if (!title) throw new ReleaseInputError('Judul MR wajib diisi.');
    if (source === release.targetBranch) throw new ReleaseInputError('Branch sumber sama dengan branch target.');
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.createMr) throw new ReleaseInputError('GitLab belum terhubung.');
    const existing = await gitlab.openMrFor?.(path, source, release.targetBranch).catch(() => undefined);
    const mr = existing ?? (await gitlab.createMr(path, { source, target: release.targetBranch, title, description: '' }));
    const services = release.services.map((s) =>
      s.id === serviceId && !s.mrs.some((m) => m.ref === mr.ref) ? { ...s, mrs: [...s.mrs, { ref: mr.ref, projectPath: mr.projectPath, iid: mr.iid, webUrl: mr.webUrl, title: mr.title, via: 'manual' as const }] } : s,
    );
    // Remember the branch this service released from (a release branch, or another than the default).
    const saved = await this.deps.store.save({ ...release, services: services.map((s) => (s.id === serviceId ? { ...s, sourceBranch: source } : s)) });
    return { release: saved, ref: mr.ref, webUrl: mr.webUrl, created: !existing };
  }

  /**
   * Creates a release branch from the target and cherry-picks the chosen commits in order (the
   * user confirmed). Stops at the first failure (usually a conflict) and says which commit; what
   * was picked stays on the branch. The service then releases from that branch.
   */
  async createReleaseBranch(id: string, serviceId: string, req: { branch: string; picks: { sha: string; title?: string }[] }): Promise<{ release: Release; branch: string; picked: string[]; failed?: { sha: string; title?: string; error: string } }> {
    const release = await this.get(id);
    const service = this.service(release, serviceId);
    const path = service.gitlabPath!;
    const branch = req.branch.trim();
    if (!/^[\w./-]{1,100}$/.test(branch) || branch === release.targetBranch) throw new ReleaseInputError('Nama branch rilis tidak valid.');
    if (!req.picks.length) throw new ReleaseInputError('Pilih minimal satu commit untuk branch rilis.');
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.createBranch || !gitlab.cherryPick || !gitlab.branchExists) throw new ReleaseInputError('GitLab belum terhubung.');
    if (await gitlab.branchExists(path, branch)) throw new ReleaseInputError(`Branch ${branch} sudah ada di ${path}. Pakai nama lain, atau pakai branch itu sebagai branch sumber.`);
    await gitlab.createBranch(path, branch, release.targetBranch);
    const picked: string[] = [];
    let failed: { sha: string; title?: string; error: string } | undefined;
    for (const p of req.picks) {
      try {
        await gitlab.cherryPick(path, p.sha, branch);
        picked.push(p.sha);
      } catch (e) {
        failed = { sha: p.sha, title: p.title, error: (e as Error).message };
        break;
      }
    }
    const saved = await this.deps.store.save({ ...release, services: release.services.map((s) => (s.id === serviceId ? { ...s, sourceBranch: branch } : s)) });
    return { release: saved, branch, picked, ...(failed ? { failed } : {}) };
  }

  // ---- AI jobs: read the tickets and deploy needs, pick release-branch commits, fix the document.

  private aiKey(releaseId: string, kind: AiKind, serviceId?: string) {
    return `${releaseId}.ai-${kind}${(kind === 'picks' || kind === 'mr' || kind === 'patch') && serviceId ? `-${serviceId}` : ''}`;
  }

  private async saveAiJob(job: ReleaseAiJob) {
    await mkdir(this.deps.reportDir, { recursive: true, mode: 0o700 });
    const file = join(this.deps.reportDir, `${this.aiKey(job.releaseId, job.kind, job.serviceId)}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  /** The latest AI job of this kind (live progress while it runs); null when none ran. */
  async aiJob(id: string, kind: AiKind, serviceId?: string): Promise<ReleaseAiJob | null> {
    const release = await this.get(id);
    const key = this.aiKey(release.id, kind, serviceId);
    const live = this.aiLive.get(key);
    if (live) return { ...live.job };
    try {
      const job = JSON.parse(await readFile(join(this.deps.reportDir, `${key}.json`), 'utf8')) as ReleaseAiJob;
      // Left running by a connector restart.
      if (job.status === 'running') return { ...job, status: 'error', error: 'Terhenti karena connector dimulai ulang. Jalankan lagi.', progress: undefined };
      return job;
    } catch {
      return null;
    }
  }

  async aiCancel(id: string, kind: AiKind, serviceId?: string): Promise<ReleaseAiJob | null> {
    const live = this.aiLive.get(this.aiKey((await this.get(id)).id, kind, serviceId));
    if (live) {
      live.cancelled = true;
      live.cancel?.();
    }
    return this.aiJob(id, kind, serviceId);
  }

  /**
   * Starts an AI job in the background and returns it as running. `tickets` re-reads all code
   * and lets the AI judge every ticket and list every deploy need (env, SQL, migrations, other
   * steps); `picks` chooses release-branch commits for one service; `document` proposes fixes
   * to the deployment document from an instruction. Only GitLab and the AI are read; the
   * document fixes are applied by the user.
   */
  async aiStart(id: string, kind: AiKind, opts: { ai: AiSelection; serviceId?: string; sourceBranch?: string; instruction?: string }): Promise<ReleaseAiJob> {
    const release = await this.get(id);
    if (!this.deps.runAi) throw new ReleaseInputError('AI belum tersedia di connector ini.');
    if (!['tickets', 'picks', 'document', 'mr', 'patch', 'discover'].includes(kind)) throw new ReleaseInputError('Jenis cek AI tidak valid.');
    if (!isAiSelection(opts.ai)) throw new ReleaseInputError('Pilihan AI tidak valid.');
    if (kind === 'picks' || kind === 'mr' || kind === 'patch') this.service(release, opts.serviceId ?? '');
    const instruction = (opts.instruction ?? '').trim().slice(0, 4000);
    if (kind === 'document' && !instruction) throw new ReleaseInputError('Tulis instruksi perbaikan dokumen dulu.');
    const source = (opts.sourceBranch ?? '').trim();
    if (source && !/^[\w./-]{1,100}$/.test(source)) throw new ReleaseInputError('Nama branch sumber tidak valid.');
    const key = this.aiKey(release.id, kind, opts.serviceId);
    if (this.aiLive.has(key)) throw new ReleaseInputError('Cek AI yang sama masih berjalan; tunggu atau batalkan dulu.');
    const job: ReleaseAiJob = {
      id: newId(),
      releaseId: release.id,
      kind,
      ...(kind === 'picks' || kind === 'mr' || kind === 'patch' ? { serviceId: opts.serviceId, ...(source ? { sourceBranch: source } : {}) } : {}),
      ...(instruction && (kind === 'picks' || kind === 'document' || kind === 'patch') ? { instruction } : {}),
      model: opts.ai.model ? `${opts.ai.provider}/${opts.ai.model}` : opts.ai.provider,
      status: 'running',
      progress: 'Menyiapkan…',
      createdAt: this.now(),
    };
    const live: AiLive = { job };
    this.aiLive.set(key, live);
    await this.saveAiJob(job);
    void this.runAiJob(live, opts.ai, instruction).finally(() => this.aiLive.delete(key));
    return { ...job };
  }

  private async runAiJob(live: AiLive, ai: AiSelection, instruction: string) {
    const job = live.job;
    try {
      if (job.kind === 'tickets') await this.aiTickets(live, ai);
      else if (job.kind === 'discover') live.job.notes = await this.aiDiscover(live, ai);
      else if (job.kind === 'picks') await this.aiPicks(live, ai, instruction);
      else if (job.kind === 'mr') await this.aiMr(live, ai);
      else if (job.kind === 'patch') await this.aiPatch(live, ai, instruction);
      else await this.aiDocument(live, ai, instruction);
      if (live.cancelled) throw new Error('Dibatalkan.');
      await this.finishAiJob(job, { status: 'done' });
    } catch (e) {
      await this.finishAiJob(job, { status: live.cancelled ? 'cancelled' : 'error', error: live.cancelled ? 'Dibatalkan.' : (e as Error).message });
    }
  }

  /** Saves the final state first, then shows it: whoever sees "done" can read the result. */
  private async finishAiJob(job: ReleaseAiJob, patch: Pick<ReleaseAiJob, 'status'> & Partial<ReleaseAiJob>) {
    const final: ReleaseAiJob = { ...job, ...patch, progress: undefined, finishedAt: this.now() };
    await this.saveAiJob(final).catch(() => {});
    Object.assign(job, final);
  }

  /**
   * Files whose diff GitLab left out (too big, collapsed): their real changes from the two
   * versions of the file, so the AI still sees e.g. a route added to a large config.
   */
  private async fillMissingDiffs(path: string, from: string, to: string, changes: MrFileChange[]): Promise<MrFileChange[]> {
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.rawFile) return changes;
    let budget = 12;
    return Promise.all(
      changes.map(async (c) => {
        if (c.diff || !c.truncated || budget <= 0 || BINARY_PATH.test(c.newPath)) return c;
        budget--;
        const [before, after] = await Promise.all([
          c.newFile ? Promise.resolve('') : gitlab.rawFile!(path, c.oldPath, from).catch(() => undefined),
          c.deletedFile ? Promise.resolve('') : gitlab.rawFile!(path, c.newPath, to).catch(() => undefined),
        ]);
        if (before === undefined || after === undefined) return c;
        const diff = fileDelta(before, after);
        return diff ? { ...c, diff } : c;
      }),
    );
  }

  /** One AI call; the reply text, or an error message. Cancelling stops the call. */
  private async ask(live: AiLive, ai: AiSelection, prompt: string): Promise<{ reply: string; error?: string }> {
    if (live.cancelled) throw new Error('Dibatalkan.');
    const run = this.deps.runAi!(ai, prompt, { systemPrompt: RELEASE_AI_SYSTEM, timeoutMs: AI_TIMEOUT_MS });
    live.cancel = run.cancel;
    const out = await run.done;
    live.cancel = undefined;
    if (live.cancelled) throw new Error('Dibatalkan.');
    return out;
  }

  /**
   * "Cari service & MR": the AI picks the services (repos) and MRs of the release from the
   * tickets, the repos and the MRs into the target. Only additions; services the user removed
   * are never added back. Falls back to the plain search when the AI fails.
   */
  private async aiDiscover(live: AiLive, ai: AiSelection): Promise<string[]> {
    const release = await this.get(live.job.releaseId);
    live.job.progress = 'Mencari tiket, repo, dan MR rilis…';
    const { tickets } = await this.tickets(release);
    const repoPaths = await this.deps.repoPaths().catch(() => ({}) as Record<string, string>);
    const gitlab = await this.deps.gitlab();
    const notes: string[] = [];
    let mrs: (MrSummary & { description: string })[] = [];
    if (!gitlab) notes.push('GitLab belum terhubung: MR tidak bisa dicari.');
    else {
      try {
        const since = new Date(new Date(release.createdAt).getTime() - 7 * 86_400_000).toISOString();
        mrs = (await gitlab.mrsToBranch(release.targetBranch, 30)).filter((m) => m.state === 'opened' || (m.state === 'merged' && m.updatedAt >= since));
      } catch (e) {
        notes.push(`Mencari MR di GitLab gagal: ${(e as Error).message}`);
      }
    }
    const ignored = release.ignoredServices ?? [];
    const keys = new Set(tickets.map((t) => t.key));
    const names = [...release.services.map((s) => s.name), ...tickets.flatMap((t) => [t.service ?? '', t.alsoService ?? ''])].filter(Boolean);
    const paths = new Set(release.services.map((s) => s.gitlabPath).filter(Boolean));
    // Candidates: MRs of the release's repos, of repos named like a ticket's service, or naming a ticket.
    const candidates = mrs
      .filter((m) => !ignored.some((n) => sameService(n, m.projectPath.split('/').pop() ?? '')))
      .filter((m) => paths.has(m.projectPath) || names.some((n) => sameService(n, m.projectPath.split('/').pop() ?? '')) || jiraKeysIn(`${m.title} ${m.sourceBranch}`).some((k) => keys.has(k)))
      .slice(0, 80);
    if (!tickets.length && !candidates.length) return [...notes, 'Tidak ada tiket maupun MR kandidat: tentukan proyek, codename, atau tiket tambahan dulu.'];
    const out = await this.ask(
      live,
      ai,
      discoverPrompt({
        release: release.name,
        target: release.targetBranch,
        tickets: tickets.map((t) => ({ key: t.key, summary: t.summary, service: [t.service, t.alsoService].filter(Boolean).join(' / ') || undefined })),
        repos: repoPaths,
        services: release.services.map((s) => ({ name: s.name, gitlabPath: s.gitlabPath, mrs: s.mrs.map((m) => m.ref) })),
        ignored,
        mrs: candidates.map((m) => ({ ref: m.ref, projectPath: m.projectPath, title: m.title, sourceBranch: m.sourceBranch, state: m.state, updatedAt: m.updatedAt })),
      }),
    );
    const found = out.error ? null : parseDiscoverReply(out.reply, Object.values(repoPaths), candidates.map((m) => m.ref));
    if (!found) {
      notes.push(`AI gagal mencari service & MR (${out.error ?? 'jawaban tidak terbaca'}); dipakai pencarian biasa.`);
      const plain = await this.discover(release.id);
      return [...notes, ...plain.warnings];
    }
    const fresh = await this.get(release.id);
    const services: ReleaseService[] = fresh.services.map((s) => ({ ...s, mrs: [...s.mrs] }));
    let added = 0;
    for (const p of found.services) {
      if (ignored.some((n) => sameService(n, p.name))) continue;
      const existing = services.find((s) => sameService(s.name, p.name) || (p.gitlabPath && s.gitlabPath === p.gitlabPath));
      if (existing) {
        existing.gitlabPath ??= p.gitlabPath;
        continue;
      }
      services.push({ id: newId(), name: p.name, ...(p.gitlabPath ? { gitlabPath: p.gitlabPath } : {}), mrs: [], order: services.length + 1 });
      added++;
    }
    let addedMrs = 0;
    for (const p of found.mrs) {
      const mr = candidates.find((m) => m.ref === p.ref)!;
      const svc = services.find((s) => s.gitlabPath === mr.projectPath) ?? services.find((s) => sameService(s.name, p.service));
      if (!svc || svc.mrs.some((m) => m.ref === mr.ref)) continue;
      svc.gitlabPath ??= mr.projectPath;
      svc.mrs.push({ ref: mr.ref, projectPath: mr.projectPath, iid: mr.iid, webUrl: mr.webUrl, title: mr.title, via: 'auto' });
      addedMrs++;
    }
    if (added || addedMrs) await this.deps.store.save({ ...fresh, services });
    notes.unshift(`AI menambah ${added} service dan ${addedMrs} MR.`);
    return notes;
  }

  private async aiTickets(live: AiLive, ai: AiSelection) {
    const release = await this.get(live.job.releaseId);
    live.job.progress = 'Membaca kode semua service dari GitLab…';
    const code = await this.readCode(release);
    let items = this.checkItems(release, code.checks);
    const read: AiRead = { model: live.job.model, tickets: new Map(), unrelated: new Map(), risks: new Map(), pending: new Map(), errors: [], steps: new Map() };
    const services = release.services.filter((s) => (code.serviceRefs.get(s.id) ?? []).length);
    for (const [i, s] of services.entries()) {
      const refs = code.serviceRefs.get(s.id)!;
      const tickets = code.tickets.filter((t) => belongsTo(t, s.name, true, release.services.map((x) => x.name)));
      const changes = refs.flatMap((r) => code.changed.get(r) ?? []);
      if (!changes.length) continue;
      live.job.progress = `AI membaca ${s.name} (${i + 1}/${services.length})…`;
      const focus = focusTerms(withSharedEndpoints(code.tickets).filter((t) => belongsTo(t, s.name, true, release.services.map((x) => x.name))).flatMap((t) => [...(t.endpoints ?? []), t.detail ?? '']));
      const texts: string[] = [];
      for (const r of refs) {
        // A live MR: its branches; a service without one: target ... its source branch.
        const mr = code.checks.find((c) => c.ref === r);
        const [repo, branch] = mr ? [r.split('!')[0], mr.sourceBranch] : r.split('@');
        const full = await this.fillMissingDiffs(repo, mr?.targetBranch || release.targetBranch, branch, code.changed.get(r) ?? []);
        texts.push(diffText(full, Math.floor(180_000 / refs.length), refs.length > 1 ? `${r}: ` : '', focus).text);
      }
      const diff = texts.join('\n\n');
      const prompt = ticketsPrompt({ service: s.name, target: release.targetBranch, refs, tickets: tickets.map((t) => ({ key: t.key, summary: t.summary, detail: t.detail })), commits: refs.flatMap((r) => code.commits.get(r) ?? []), diff });
      const out = await this.ask(live, ai, prompt);
      if (out.error) {
        read.errors.push(`${s.name}: AI gagal (${out.error}).`);
        continue;
      }
      const parsed = parseTicketsReply(out.reply, tickets.map((t) => t.key), changes.map((c) => c.newPath));
      if (!parsed) {
        read.errors.push(`${s.name}: jawaban AI tidak terbaca sebagai JSON.`);
        continue;
      }
      for (const [key, v] of parsed.tickets) {
        const prev = read.tickets.get(key);
        if (!prev || VERDICT_RANK[v.verdict] > VERDICT_RANK[prev.verdict]) read.tickets.set(key, v);
      }
      read.unrelated.set(s.name, parsed.unrelated);
      read.risks.set(s.name, parsed.risks);
      // This check's queries replace those of the last AI check for the service.
      items = items.filter((x) => !(x.source === 'ai' && x.service && sameService(x.service, s.name)));
      // The document holds what the release MR brings. Without one, the needs are only a preview.
      if (!refs.every((r) => code.sources.find((x) => x.ref === r)?.kind === 'mr')) {
        read.pending.set(s.name, parsed.needs);
        continue;
      }
      const steps = { pre: [] as string[], post: [] as string[] };
      for (const n of parsed.needs) {
        const note = [n.kind === 'env' ? n.detail : '', n.files.length ? `File: ${n.files.join(', ')}` : ''].filter(Boolean).join(' · ').slice(0, 1000);
        if (n.kind === 'other') {
          steps[n.when].push(n.label);
          continue;
        }
        const same = items.find((x) => x.kind === n.kind && sameService(x.service ?? s.name, s.name) && (x.label.toLowerCase() === n.label.toLowerCase() || n.files.includes(x.label)));
        if (same) {
          // A query file the pattern check listed: the AI adds the SQL it found in it.
          if (n.kind === 'sql' && n.detail && !same.detail) same.detail = n.detail;
          if (note && !same.note) same.note = note;
          continue;
        }
        items.push({ id: newId(), kind: n.kind, label: n.label, service: s.name, ...(n.detail && n.kind !== 'env' ? { detail: n.detail } : {}), ...(note ? { note } : {}), source: 'ai', done: false });
      }
      read.steps.set(s.name, steps);
    }
    if (live.cancelled) return;
    live.job.progress = 'Menyusun laporan…';
    await this.finishCheck(release, code, items, read);
    live.job.notes = read.errors;
  }

  private async aiPicks(live: AiLive, ai: AiSelection, instruction: string) {
    const release = await this.get(live.job.releaseId);
    const service = this.service(release, live.job.serviceId ?? '');
    const path = service.gitlabPath!;
    const source = live.job.sourceBranch || service.sourceBranch || release.sourceBranch || 'staging';
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.compare) throw new Error('GitLab belum terhubung.');
    live.job.progress = `Membaca commit ${source}…`;
    const cmp = await gitlab.compare(path, release.targetBranch, source);
    const { tickets: all } = await this.tickets(release);
    const tickets = withSharedEndpoints(all).filter((t) => belongsTo(t, service.name, false, release.services.map((x) => x.name)));
    const focus = focusTerms([...tickets.flatMap((t) => [...(t.endpoints ?? []), t.detail ?? '']), instruction]);
    const plan = planReleaseBranch(cmp.commits, new Set(all.map((t) => t.key)), { base: release.targetBranch, branch: releaseBranchName(release) });
    const line = plan.commits.slice(-AI_MAX_COMMITS);
    if (!line.length) throw new Error(`${source} tidak punya commit baru dibanding ${release.targetBranch}.`);
    const per = Math.max(6_000, Math.floor(180_000 / line.length));
    const commits: AiCommitInput[] = [];
    for (const [i, c] of line.entries()) {
      live.job.progress = `Membaca perubahan commit ${i + 1}/${line.length}…`;
      if (live.cancelled) return;
      const parent = cmp.commits.find((x) => x.id === c.sha)?.parentIds?.[0];
      // A commit against its first parent: for a merge, the whole feature it brought in.
      const d = parent ? await gitlab.compare(path, parent, c.sha).catch(() => null) : null;
      if (d) d.changes = await this.fillMissingDiffs(path, parent!, c.sha, d.changes);
      commits.push({ sha: c.sha, shortId: c.shortId, title: c.title, merge: c.merge, brought: c.merge ? d?.commits.map((x) => x.title).filter((t) => t !== c.title) : undefined, diff: d ? diffText(d.changes, per, '', focus).text : '(perubahan tidak terbaca)' });
    }
    live.job.progress = 'AI memilih commit…';
    const out = await this.ask(live, ai, picksPrompt({ repo: path, source, target: release.targetBranch, tickets: tickets.map((t) => ({ key: t.key, summary: t.summary, detail: t.detail })), commits, instruction }));
    if (out.error) throw new Error(`AI gagal: ${out.error}`);
    const parsed = parsePicksReply(out.reply, line.map((c) => c.sha));
    if (!parsed) throw new Error('Jawaban AI tidak terbaca sebagai JSON.');
    live.job.picks = parsed.picks;
    live.job.notes = [...(plan.commits.length > line.length ? [`Hanya ${line.length} commit terbaru yang dibaca AI dari ${plan.commits.length}.`] : []), ...parsed.notes];
  }

  /**
   * Before a release MR exists: the AI reads what the source branch would bring into the target
   * for one service, judges the service's tickets, and lists changes without a ticket (also
   * endpoints registered without one) and what the server needs.
   */
  private async aiMr(live: AiLive, ai: AiSelection) {
    const release = await this.get(live.job.releaseId);
    const service = this.service(release, live.job.serviceId ?? '');
    const path = service.gitlabPath!;
    const source = live.job.sourceBranch || service.sourceBranch || release.sourceBranch || 'staging';
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.compare) throw new Error('GitLab belum terhubung.');
    live.job.progress = `Membaca perubahan ${source} → ${release.targetBranch}…`;
    const cmp = await gitlab.compare(path, release.targetBranch, source);
    if (!cmp.changes.length) throw new Error(`${source} tidak punya perubahan dibanding ${release.targetBranch}.`);
    const { tickets: all } = await this.tickets(release);
    const tickets = withSharedEndpoints(all).filter((t) => belongsTo(t, service.name, false, release.services.map((x) => x.name)));
    const focus = focusTerms(tickets.flatMap((t) => [...(t.endpoints ?? []), t.detail ?? '']));
    cmp.changes = await this.fillMissingDiffs(path, release.targetBranch, source, cmp.changes);
    live.job.progress = 'AI membaca diff…';
    const ref = `${path}@${source}`;
    const out = await this.ask(live, ai, ticketsPrompt({ service: service.name, target: release.targetBranch, refs: [ref], tickets: tickets.map((t) => ({ key: t.key, summary: t.summary, detail: t.detail })), commits: cmp.commits.map((c) => c.title), diff: diffText(cmp.changes, undefined, '', focus).text }));
    if (out.error) throw new Error(`AI gagal: ${out.error}`);
    const parsed = parseTicketsReply(out.reply, tickets.map((t) => t.key), cmp.changes.map((c) => c.newPath));
    if (!parsed) throw new Error('Jawaban AI tidak terbaca sebagai JSON.');
    live.job.verdicts = tickets.flatMap((t) => (parsed.tickets.has(t.key) ? [{ key: t.key, ...parsed.tickets.get(t.key)! }] : []));
    live.job.unrelated = parsed.unrelated;
    live.job.needs = parsed.needs;
    live.job.risks = parsed.risks;
  }

  /**
   * Every changed file of target → source split in hunks (file contents read from GitLab, compared
   * without spaces). Binary/lock files and files too big to read are skipped.
   */
  private async patchFiles(path: string, target: string, source: string): Promise<{ files: { path: string; oldPath: string; status: 'new' | 'deleted' | 'modified'; fh: FileHunks }[]; skipped: string[] }> {
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.compare || !gitlab.rawFile) throw new Error('GitLab belum terhubung.');
    const cmp = await gitlab.compare(path, target, source);
    const files: { path: string; oldPath: string; status: 'new' | 'deleted' | 'modified'; fh: FileHunks }[] = [];
    const skipped: string[] = [];
    for (const c of cmp.changes.slice(0, 80)) {
      if (BINARY_PATH.test(c.newPath)) {
        skipped.push(c.newPath);
        continue;
      }
      const [before, after] = await Promise.all([c.newFile ? Promise.resolve(undefined) : gitlab.rawFile(path, c.oldPath, target).catch(() => null), c.deletedFile ? Promise.resolve(undefined) : gitlab.rawFile(path, c.newPath, source).catch(() => null)]);
      if (before === null || after === null || (!c.newFile && before === undefined) || (!c.deletedFile && after === undefined)) {
        skipped.push(c.newPath);
        continue;
      }
      const fh = fileHunks(before, after);
      if (fh.hunks.length) files.push({ path: c.newPath, oldPath: c.oldPath, status: c.newFile ? 'new' : c.deletedFile ? 'deleted' : 'modified', fh });
    }
    skipped.push(...cmp.changes.slice(80).map((c) => c.newPath));
    return { files, skipped };
  }

  /** The AI picks the hunks of target → source that belong to the scope or the instruction. */
  private async aiPatch(live: AiLive, ai: AiSelection, instruction: string) {
    const release = await this.get(live.job.releaseId);
    const service = this.service(release, live.job.serviceId ?? '');
    const path = service.gitlabPath!;
    const source = live.job.sourceBranch || service.sourceBranch || release.sourceBranch || 'staging';
    live.job.progress = `Membaca file yang berubah ${release.targetBranch} → ${source}…`;
    const { files, skipped } = await this.patchFiles(path, release.targetBranch, source);
    if (!files.length) throw new Error(`${source} tidak punya perubahan yang bisa dipilih dibanding ${release.targetBranch}.`);
    const { tickets: all } = await this.tickets(release);
    const tickets = withSharedEndpoints(all).filter((t) => belongsTo(t, service.name, false, release.services.map((x) => x.name)));
    const focus = focusTerms([...tickets.flatMap((t) => [...(t.endpoints ?? []), t.detail ?? '']), instruction]);
    const patch = files.map((f) => patchFile(f.path, f.status, f.fh));
    live.job.progress = `AI memilih perubahan (${patch.reduce((n, f) => n + f.hunks.length, 0)} hunk)…`;
    const out = await this.ask(live, ai, patchPrompt({ repo: path, source, target: release.targetBranch, tickets: tickets.map((t) => ({ key: t.key, summary: t.summary, detail: t.detail })), hunks: hunksText(patch, undefined, focus), instruction }));
    if (out.error) throw new Error(`AI gagal: ${out.error}`);
    const parsed = parsePatchReply(out.reply, patch.flatMap((f) => f.hunks.map((h) => h.id)));
    if (!parsed) throw new Error('Jawaban AI tidak terbaca sebagai JSON.');
    for (const f of patch) for (const h of f.hunks) if (parsed.chosen.has(h.id)) Object.assign(h, { include: true, ...parsed.chosen.get(h.id) });
    live.job.patch = { files: patch, skipped };
    // Routes the Tech Lead named: say plainly whether they are already in the target.
    const located = locateRoutes(instruction, files).map((r) =>
      r.where === 'target'
        ? `${r.path} sudah ada di ${release.targetBranch} (${r.file} baris ${r.line}): tidak perlu dibawa.`
        : r.where === 'none'
          ? `${r.path} tidak ditemukan di perubahan ${source} maupun di versi ${release.targetBranch} file yang berubah.`
          : `${r.path} ada di perubahan ${r.file}.`,
    );
    live.job.notes = [...located, ...(skipped.length ? [`${skipped.length} file tidak bisa dipilih per hunk (biner/lock/terlalu besar): ${skipped.slice(0, 8).join(', ')}.`] : []), ...parsed.notes];
  }

  private async aiDocument(live: AiLive, ai: AiSelection, instruction: string) {
    const release = await this.get(live.job.releaseId);
    live.job.progress = 'Membaca kode semua service dari GitLab…';
    const code = await this.readCode(release);
    // Only services with a release MR: the document is about the code proposed for the release.
    const withMr = release.services.filter((s) => (code.serviceRefs.get(s.id) ?? []).some((r) => code.sources.find((x) => x.ref === r)?.kind === 'mr'));
    if (!withMr.length) throw new Error(`Belum ada MR rilis ke ${release.targetBranch}: dokumen diisi setelah MR dibuat.`);
    const services: AiDocService[] = withMr.map((s) => {
      const changes = (code.serviceRefs.get(s.id) ?? []).flatMap((r) => code.changed.get(r) ?? []);
      const pseudo = { ref: '', title: '', webUrl: '', state: 'opened', draft: false, author: { id: 0, username: '', name: '' }, sourceBranch: '', targetBranch: release.targetBranch, description: '', commits: [], changes, diffTruncated: false } as unknown as MrDetail;
      const c = checkMr(pseudo);
      return {
        name: s.name,
        envBlock: serviceEnvBlock(release, s)?.text,
        preDeploy: s.preDeploy,
        postDeploy: s.postDeploy,
        failover: s.failover,
        queries: release.items.filter((i) => i.kind === 'sql' && i.service?.toLowerCase() === s.name.toLowerCase()).map((i) => ({ label: i.label, ...(i.detail ? { sql: i.detail } : {}) })),
        code: { envAdded: c.envAdded, envReadInCode: c.envReadInCode, migrations: c.migrations, sql: c.sqlOutside, envDiff: diffText(changes.filter((x) => isEnvOrConfigFile(x.newPath)), 20_000).text },
      };
    });
    live.job.progress = 'AI memperbaiki dokumen…';
    const out = await this.ask(live, ai, documentPrompt({ instruction, release: release.name, services }));
    if (out.error) throw new Error(`AI gagal: ${out.error}`);
    const parsed = parseDocumentReply(out.reply, withMr);
    if (!parsed) throw new Error('Jawaban AI tidak terbaca sebagai JSON.');
    live.job.fixes = parsed.fixes;
    live.job.notes = parsed.summary;
  }

  /** The chosen hunks applied, without writing: per file the result's changes vs the target and JSON problems. */
  async previewPatch(id: string, serviceId: string, req: { sourceBranch: string; hunks: string[] }): Promise<{ files: { path: string; status: string; diff: string; problem?: string; changes?: string[] }[] }> {
    const release = await this.get(id);
    const service = this.service(release, serviceId);
    const source = req.sourceBranch.trim();
    if (!/^[\w./-]{1,100}$/.test(source)) throw new ReleaseInputError('Nama branch sumber tidak valid.');
    const { files } = await this.patchFiles(service.gitlabPath!, release.targetBranch, source);
    return { files: this.applyPatch(files, req.hunks, source).map((a) => ({ path: a.path, status: a.action, diff: a.preview, ...(a.problem ? { problem: a.problem } : {}), ...(a.changes ? { changes: a.changes } : {}) })) };
  }

  /** Chosen hunks → file actions, each with a short +/− preview vs the target and a JSON check. */
  private applyPatch(files: { path: string; oldPath: string; status: 'new' | 'deleted' | 'modified'; fh: FileHunks }[], hunks: string[], source: string) {
    const byPath = new Map<string, Set<number>>();
    for (const h of hunks) byPath.set(hunkPath(h), (byPath.get(hunkPath(h)) ?? new Set()).add(hunkNumber(h)));
    const out: { action: 'create' | 'update' | 'delete'; path: string; content?: string; preview: string; problem?: string; changes?: string[] }[] = [];
    for (const [p, chosen] of byPath) {
      const f = files.find((x) => x.path === p);
      if (!f) throw new ReleaseInputError(`${p} sudah tidak berubah di ${source}; susun ulang perubahan.`);
      if (f.status === 'deleted') {
        out.push({ action: 'delete', path: f.oldPath, preview: '(file dihapus)' });
        continue;
      }
      const content = applyFileHunks(f.fh, chosen, p);
      const target = f.fh.diff.filter((l) => l.type !== 'add').map((l) => l.text).join('\n');
      const problem = jsonProblem(p, content);
      const changes = /\.json$/i.test(p) && !problem ? jsonChanges(f.status === 'new' ? '' : target, content) : undefined;
      out.push({ action: f.status === 'new' ? 'create' : 'update', path: p, content, preview: resultDelta(f.status === 'new' ? '' : target, content).slice(0, 60_000), ...(problem ? { problem } : {}), ...(changes ? { changes } : {}) });
    }
    return out;
  }

  /**
   * A release branch from the target with only the chosen hunks of target → source applied, in
   * one commit (the user confirmed). Reads the files again, so the result matches the branches
   * now; a .json file that would no longer parse stops it unless `force`.
   */
  async createPatchBranch(id: string, serviceId: string, req: { branch: string; sourceBranch: string; hunks: string[]; force?: boolean }): Promise<{ release: Release; branch: string; files: string[]; commit: string }> {
    const release = await this.get(id);
    const service = this.service(release, serviceId);
    const path = service.gitlabPath!;
    const branch = req.branch.trim();
    const source = req.sourceBranch.trim();
    if (!/^[\w./-]{1,100}$/.test(branch) || branch === release.targetBranch) throw new ReleaseInputError('Nama branch rilis tidak valid.');
    if (!/^[\w./-]{1,100}$/.test(source)) throw new ReleaseInputError('Nama branch sumber tidak valid.');
    if (!req.hunks.length) throw new ReleaseInputError('Pilih minimal satu perubahan.');
    const gitlab = await this.deps.gitlab();
    if (!gitlab?.commitFiles || !gitlab.branchExists) throw new ReleaseInputError('GitLab belum terhubung.');
    if (await gitlab.branchExists(path, branch)) throw new ReleaseInputError(`Branch ${branch} sudah ada di ${path}. Pakai nama lain.`);
    const { files } = await this.patchFiles(path, release.targetBranch, source);
    const applied = this.applyPatch(files, req.hunks, source);
    const actions = applied.map(({ action, path: p, content }) => ({ action, path: p, ...(content !== undefined ? { content } : {}) }));
    const problems = applied.flatMap((a) => (a.problem ? [a.problem] : []));
    if (problems.length && !req.force) throw new ReleaseInputError(`${problems.join(' ')} Pilih juga hunk pasangannya (koma/kurung), atau buat tetap bila memang disengaja.`);
    const { tickets } = await this.tickets(release);
    const keys = tickets.filter((t) => belongsTo(t, service.name, false, release.services.map((x) => x.name))).map((t) => t.key);
    const message = `Rilis ${release.name}: perubahan pilihan dari ${source}${keys.length ? `\n\nJira: ${keys.join(', ')}` : ''}`;
    const commit = await gitlab.commitFiles(path, { branch, start: release.targetBranch, message, actions });
    const saved = await this.deps.store.save({ ...release, services: release.services.map((s) => (s.id === serviceId ? { ...s, sourceBranch: branch } : s)) });
    return { release: saved, branch, files: actions.map((a) => a.path), commit: commit.id };
  }

  private validRefs(release: Release, refs: string[]): string[] {
    const all = new Set(release.services.flatMap((s) => s.mrs.map((m) => m.ref)));
    const picked = [...new Set(refs ?? [])].filter((r) => all.has(r));
    if (!picked.length) throw new ReleaseInputError('Pilih minimal satu MR.');
    return picked;
  }
}

/** Files whose content says nothing to a reviewer (no line diff is computed for them). */
const BINARY_PATH = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|war|so|dll|exe|bin|woff2?|ttf|eot|mp4|mp3|lock)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/i;

/** What readCode gathered for one release. */
interface CodeRead {
  checks: MrCheck[];
  changed: Map<string, MrFileChange[]>;
  commits: Map<string, string[]>;
  sources: CodeSource[];
  serviceRefs: Map<string, string[]>;
  tickets: ReleaseTicket[];
  warnings: string[];
  extra: Map<string, { summary: string; status: string }>;
  evidence: Map<string, CodeEvidence[]>;
}

/** What the AI check found, per ticket and per service. */
interface AiRead {
  model: string;
  tickets: Map<string, AiTicketVerdict>;
  unrelated: Map<string, { path: string; reason: string }[]>;
  risks: Map<string, { path: string; reason: string }[]>;
  pending: Map<string, ReleaseAiNeed[]>;
  errors: string[];
  steps: Map<string, { pre: string[]; post: string[] }>;
}

/** Adds lines that are not there yet (case-insensitive), keeping the order. */
function addLines(current: string[] | undefined, more: string[]): string[] {
  const out = [...(current ?? [])];
  for (const l of more) if (!out.some((x) => x.trim().toLowerCase() === l.trim().toLowerCase())) out.push(l);
  return out.slice(0, 40);
}

/** Diffs for the review in the UI, at most ~1.5 MB in total; bigger ones are listed without a diff. */
const PLAN_DIFF_BUDGET = 1_500_000;
function capDiffs(changes: MrFileChange[]): MrFileChange[] {
  let left = PLAN_DIFF_BUDGET;
  return changes.map((c) => {
    if (c.diff.length > left) return { ...c, diff: '', truncated: true };
    left -= c.diff.length;
    return c;
  });
}

function blankCheck(ref: string, webUrl: string, title: string | undefined, targetBranch: string, error: string): MrCheck {
  return { ref, title: title ?? ref, webUrl, state: 'opened', draft: false, sourceBranch: '', targetBranch, author: '', approvals: { count: 0, by: [] }, envAdded: [], envReadInCode: [], migrations: [], sqlOutside: [], modelWithoutMigration: [], commitsWithoutKey: [], jiraKeys: [], keyCommits: {}, diffTruncated: false, error };
}
