import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstimateProject } from '../../src/lib/estimate/types.ts';
import type { MrDetail, MrSummary } from '../../src/lib/gitlab/types.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import { checkMr, jiraKeysIn } from '../../src/lib/release/checks.ts';
import { buildReport, matchesCodename, sameService, type ReleaseTicket } from '../../src/lib/release/coverage.ts';
import { mergeReleaseDoc, parseReleaseDoc, serviceForPath } from '../../src/lib/release/import.ts';
import { shareMessageHtml, shareMessageText, type ShareOptions } from '../../src/lib/release/share.ts';
import type { MrCheck, Release, ReleaseItem, ReleaseReport, ReleaseService, ReleaseSource } from '../../src/lib/release/types.ts';
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

export interface ReleaseDeps {
  store: ReleaseStore;
  /** Where the last report per release is kept. */
  reportDir: string;
  gitlab: () => Promise<{ mrsToBranch(target: string, days?: number): Promise<(MrSummary & { description: string })[]>; mr(path: string, iid: number): Promise<MrDetail> } | null>;
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
    const toTicket = (i: JiraIssue, from: ReleaseTicket['from'], service?: string): ReleaseTicket => ({ key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, service: service || parseTaskTitle(i.summary)?.service, from });
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
    const report = buildReport(release, tickets, checks, this.now());
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

  async importDoc(id: string, markdown: string, source: Omit<ReleaseSource, 'importedAt'>): Promise<Release> {
    const release = await this.get(id);
    if (!markdown.trim()) throw new ReleaseInputError('Dokumen rilis kosong.');
    return this.deps.store.save(mergeReleaseDoc(release, parseReleaseDoc(markdown), markdown, source, this.now()));
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

  private validRefs(release: Release, refs: string[]): string[] {
    const all = new Set(release.services.flatMap((s) => s.mrs.map((m) => m.ref)));
    const picked = [...new Set(refs ?? [])].filter((r) => all.has(r));
    if (!picked.length) throw new ReleaseInputError('Pilih minimal satu MR.');
    return picked;
  }
}

function blankCheck(ref: string, webUrl: string, title: string | undefined, targetBranch: string, error: string): MrCheck {
  return { ref, title: title ?? ref, webUrl, state: 'opened', draft: false, sourceBranch: '', targetBranch, author: '', approvals: { count: 0, by: [] }, envAdded: [], envReadInCode: [], migrations: [], sqlOutside: [], modelWithoutMigration: [], commitsWithoutKey: [], jiraKeys: [], diffTruncated: false, error };
}
