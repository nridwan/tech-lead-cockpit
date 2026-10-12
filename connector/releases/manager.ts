import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstimateProject } from '../../src/lib/estimate/types.ts';
import type { MrCommit, MrDetail, MrFileChange, MrSummary } from '../../src/lib/gitlab/types.ts';
import { mrDescription, mrTitle, newMrFormUrl } from '../../src/lib/release/mr.ts';
import { planReleaseBranch, releaseBranchName } from '../../src/lib/release/branch.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import { checkMr, jiraKeysIn } from '../../src/lib/release/checks.ts';
import { buildReport, codeKeys, matchesCodename, sameService, ticketService, type ReleaseTicket } from '../../src/lib/release/coverage.ts';
import { mergeReleaseDoc, parseReleaseDoc, serviceForPath } from '../../src/lib/release/import.ts';
import { parseDeploymentStorage } from '../../src/lib/release/deployment.ts';
import { shareMessageHtml, shareMessageText, type ShareOptions } from '../../src/lib/release/share.ts';
import type { MrCheck, MrPlan, OutOfScope, Release, ReleaseItem, ReleaseReport, ReleaseService, ReleaseSource } from '../../src/lib/release/types.ts';
import { parseTaskTitle } from '../../src/lib/tad/template.ts';
import { parseScopeTasks } from '../../src/lib/tad/task-links.ts';
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
  now?: () => Date;
}

const KEY_BATCH = 80;
const newId = () => crypto.randomUUID();

export class ReleaseManager {
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

  /** TAD tasks of the release's projects: Jira keys, service, and the CODENAMEs they use. */
  private async tadTasks(release: Release): Promise<{ key: string; service: string; title: string }[]> {
    if (!release.projectIds.length) return [];
    const [projects, drafts] = await Promise.all([this.deps.projects(), this.deps.drafts()]);
    const draftIds = new Set(projects.filter((p) => release.projectIds.includes(p.id)).flatMap((p) => p.draftIds));
    return drafts
      .filter((d) => draftIds.has(d.id))
      .flatMap((d) => parseScopeTasks(d.markdown, d.scopePlan))
      .flatMap((t) => t.jiraKeys.map((key) => ({ key, service: t.service || parseTaskTitle(t.title)?.service || '', title: t.title })));
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
      if (matchesCodename(i.summary, codenames)) tickets.push({ key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, service: ticketService(i.summary, codenames), from: 'codename' });
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
    const toTicket = (i: JiraIssue, from: ReleaseTicket['from'], service?: string): ReleaseTicket => ({ key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, service: service || ticketService(i.summary, codenames), from });
    const out: ReleaseTicket[] = [];
    const seen = new Set<string>();
    const push = (t: ReleaseTicket) => !seen.has(t.key) && (seen.add(t.key), out.push(t));
    for (const t of tad) {
      const i = byKey.get(t.key);
      push(i ? toTicket(i, 'tad', t.service) : { key: t.key, summary: t.title, status: 'Tidak ditemukan di Jira', service: t.service, from: 'tad' });
    }
    for (const i of byCodename) push(toTicket(i, 'codename'));
    for (const k of release.jiraKeys) {
      const i = byKey.get(k);
      if (i) push(toTicket(i, 'release'));
    }
    return { tickets: out, warnings };
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
    for (const name of [...new Set(tickets.map((t) => t.service).filter((s): s is string => Boolean(s)))]) {
      if (services.some((s) => sameService(s.name, name))) continue;
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
          const mentions = jiraKeysIn(`${mr.title} ${mr.sourceBranch} ${mr.description}`).some((k) => keys.has(k));
          const svc = services.find((s) => s.gitlabPath === mr.projectPath) ?? (mentions ? serviceForPath(services, mr.projectPath) : undefined);
          if (!svc && !mentions) continue;
          let target = svc;
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

  /** Checks every MR, refreshes the env/migration/SQL items and keeps the report. */
  async check(id: string): Promise<{ release: Release; report: ReleaseReport }> {
    const release = await this.get(id);
    const gitlab = await this.deps.gitlab();
    const checks: MrCheck[] = [];
    const refs = release.services.flatMap((s) => s.mrs);
    for (const m of refs) {
      if (!gitlab) {
        checks.push(blankCheck(m.ref, m.webUrl, m.title, release.targetBranch, 'GitLab belum terhubung.'));
        continue;
      }
      try {
        checks.push(checkMr(await gitlab.mr(m.projectPath, m.iid)));
      } catch (e) {
        checks.push(blankCheck(m.ref, m.webUrl, m.title, release.targetBranch, (e as Error).message));
      }
    }
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
    const { tickets, warnings } = await this.tickets(release);
    const live = checks.filter((c) => !c.error && c.state !== 'closed');
    const extra = await this.resolveOutside(release, tickets, live.flatMap(codeKeys), warnings);
    const report = buildReport(release, tickets, checks, this.now(), extra);
    report.warnings.unshift(...warnings);
    const saved = await this.deps.store.save({ ...release, items, services: release.services.map((s) => ({ ...s, mrs: s.mrs.map((m) => ({ ...m, title: checks.find((c) => c.ref === m.ref && !c.error)?.title ?? m.title })) })) });
    await this.saveReport(report);
    return { release: saved, report };
  }

  async report(id: string): Promise<ReleaseReport | null> {
    try {
      return JSON.parse(await readFile(join(this.deps.reportDir, `${(await this.get(id)).id}.json`), 'utf8')) as ReleaseReport;
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
  async importDoc(id: string, markdown: string, source: Omit<ReleaseSource, 'importedAt'>, storage?: string): Promise<Release> {
    const release = await this.get(id);
    if (!markdown.trim() && !storage?.trim()) throw new ReleaseInputError('Dokumen rilis kosong.');
    const doc = (storage && parseDeploymentStorage(storage, source.title)) || parseReleaseDoc(markdown);
    return this.deps.store.save(mergeReleaseDoc(release, doc, markdown, source, this.now()));
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
   * commits, files, env/migration/query findings, the service's tickets, a title and description,
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
    const keysInCode = codeKeys(c);
    const extra = await this.resolveOutside(release, all, keysInCode, warnings);
    const scopeKeys = new Set(all.map((t) => t.key));
    const accepted = new Set((release.accepted ?? []).map((a) => a.key));
    const outOfScope: OutOfScope[] = keysInCode
      .filter((k) => !scopeKeys.has(k) && !accepted.has(k))
      .map((k) => ({ key: k, ...(extra.get(k) ?? {}), ...(extra.get(k) && parseTaskTitle(extra.get(k)!.summary) ? { codename: parseTaskTitle(extra.get(k)!.summary)!.codeName } : {}), mrs: [], commits: c.keyCommits[k] ?? [] }));
    if (outOfScope.length) warnings.push(`${outOfScope.length} tiket di luar scope akan ikut terbawa dari ${source}: ${outOfScope.map((o) => o.key).join(', ')}.`);
    if (c.commitsWithoutKey.length) warnings.push(`${c.commitsWithoutKey.length} commit tanpa Jira key: scope-nya tidak bisa dipastikan.`);
    const tickets = all.filter((t) => t.service && sameService(t.service, service.name)).map((t) => ({ key: t.key, summary: t.summary, status: t.status, inSource: keysInCode.includes(t.key) }));
    const missing = tickets.filter((t) => !t.inSource);
    if (missing.length) warnings.push(`${missing.length} tiket ${service.name} tidak ada di commit ${source}: ${missing.map((t) => t.key).join(', ')}.`);
    const title = mrTitle(release, service);
    const description = mrDescription(release, service, { commits: cmp.commits, findings, tickets });
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
      outOfScope,
      title,
      description,
      formUrl: base ? newMrFormUrl(base, path, source, target, title, description) : '',
      ...(scopes ? { canCreate: scopes.includes('api') } : {}),
      releaseBranch: planReleaseBranch(cmp.commits, new Set([...scopeKeys, ...accepted]), { base: target, branch: releaseBranchName(release) }),
      warnings,
    };
  }

  /**
   * Creates the release MR in GitLab (the user confirmed in the UI) and adds it to the service.
   * An MR already open for the same branches is attached instead of creating a second one.
   */
  async createMr(id: string, serviceId: string, req: { sourceBranch: string; title: string; description: string }): Promise<{ release: Release; ref: string; webUrl: string; created: boolean }> {
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
    const mr = existing ?? (await gitlab.createMr(path, { source, target: release.targetBranch, title, description: req.description.slice(0, 50_000) }));
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

  private validRefs(release: Release, refs: string[]): string[] {
    const all = new Set(release.services.flatMap((s) => s.mrs.map((m) => m.ref)));
    const picked = [...new Set(refs ?? [])].filter((r) => all.has(r));
    if (!picked.length) throw new ReleaseInputError('Pilih minimal satu MR.');
    return picked;
  }
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
