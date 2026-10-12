import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RELEASE_STATUSES, type DeployInfo, type DeployPerson, type Release, type ReleaseItem, type ReleaseMrRef, type ReleaseService, type ReleaseStep } from '../../src/lib/release/types.ts';
import { DATA_DIR } from '../paths.ts';

/** Releases, one JSON file each (0600) under ~/.tech-lead-cockpit/releases/. */

export const RELEASES_DIR = join(DATA_DIR, 'releases');

export class ReleaseInputError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BRANCH = /^[\w./-]{1,100}$/;
const PATH = /^[\w.-]+(\/[\w.-]+)+$/;
const KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const id = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : randomUUID());
const date = (v: unknown) => (typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const arr = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const stamp = (v: unknown) => (typeof v === 'string' && v.length <= 40 ? v : undefined);

function person(p: unknown): DeployPerson | undefined {
  const x = p as Partial<DeployPerson> | undefined;
  const name = text(x?.name, 120);
  const accountId = text(x?.accountId, 128);
  if (!name && !accountId) return undefined;
  return { ...(accountId && /^[\w:.-]{1,128}$/.test(accountId) ? { accountId } : {}), name };
}
const lines = (v: unknown, max = 30) => arr<string>(v, max).map((l) => text(l, 500)).filter(Boolean);
const url2 = (v: unknown) => {
  const s = text(v, 2000);
  return /^https?:\/\//.test(s) ? s : undefined;
};

function validDeploy(raw: unknown): DeployInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Partial<DeployInfo>;
  const opt = (k: keyof DeployInfo, max: number) => (text(d[k], max) ? { [k]: text(d[k], max) } : {});
  const list = d.releaseList && typeof d.releaseList === 'object' ? { ...(url2(d.releaseList.url) ? { url: url2(d.releaseList.url) } : {}), ...(text(d.releaseList.jql, 2000) ? { jql: text(d.releaseList.jql, 2000) } : {}) } : undefined;
  return {
    ...opt('targetTime', 20),
    ...opt('actual', 60),
    ...opt('statusTitle', 60),
    ...opt('statusColour', 20),
    ...opt('impact', 60),
    ...opt('room', 120),
    ...opt('issueLink', 500),
    roles: arr<DeployInfo['roles'][number]>(d.roles, 20).flatMap((r) => (text(r?.label, 80) ? [{ label: text(r.label, 80), people: arr(r.people, 20).map(person).filter((p): p is DeployPerson => Boolean(p)) }] : [])),
    changeLog: arr<DeployInfo['changeLog'][number]>(d.changeLog, 100).flatMap((c) => (text(c?.details, 500) || text(c?.notes, 1000) ? [{ details: text(c.details, 500), ...(text(c.notes, 1000) ? { notes: text(c.notes, 1000) } : {}) }] : [])),
    ...(list && (list.url || list.jql) ? { releaseList: list } : {}),
    testEvidence: arr<DeployInfo['testEvidence'][number]>(d.testEvidence, 20).flatMap((e) => (url2(e?.url) ? [{ url: url2(e.url)!, title: text(e.title, 200) || url2(e.url)! }] : [])),
  };
}

function validMr(m: Partial<ReleaseMrRef>): ReleaseMrRef | null {
  const projectPath = text(m.projectPath, 300);
  const iid = Math.floor(Number(m.iid));
  const webUrl = text(m.webUrl, 500);
  if (!PATH.test(projectPath) || !(iid > 0) || !/^https?:\/\//.test(webUrl)) return null;
  return { ref: `${projectPath}!${iid}`, projectPath, iid, webUrl, ...(m.title ? { title: text(m.title, 300) } : {}), via: m.via === 'manual' || m.via === 'import' ? m.via : 'auto' };
}

export function validateRelease(raw: Partial<Release>): Release {
  const name = text(raw.name, 120);
  if (!name) throw new ReleaseInputError('Nama rilis wajib diisi.');
  const targetBranch = text(raw.targetBranch, 100) || 'master';
  if (!BRANCH.test(targetBranch)) throw new ReleaseInputError('Nama branch target tidak valid.');
  const services: ReleaseService[] = arr<Partial<ReleaseService>>(raw.services, 60).flatMap((s, i) => {
    const sName = text(s.name, 100);
    if (!sName) return [];
    const gitlabPath = text(s.gitlabPath, 300);
    const seen = new Set<string>();
    const mrs = arr<Partial<ReleaseMrRef>>(s.mrs, 20)
      .map(validMr)
      .filter((m): m is ReleaseMrRef => Boolean(m) && !seen.has(m!.ref) && Boolean(seen.add(m!.ref)));
    const sourceBranch = text(s.sourceBranch, 100);
    const commitId = text(s.commitId, 64);
    const updatedBy = person(s.updatedBy);
    const deployFields = {
      ...(/^[0-9a-f]{7,40}$/i.test(commitId) ? { commitId } : {}),
      ...(typeof s.envBlock === 'string' && s.envBlock.trim() ? { envBlock: s.envBlock.slice(0, 50_000) } : {}),
      ...(lines(s.preDeploy).length ? { preDeploy: lines(s.preDeploy) } : {}),
      ...(lines(s.postDeploy).length ? { postDeploy: lines(s.postDeploy) } : {}),
      ...(text(s.failover, 300) ? { failover: text(s.failover, 300) } : {}),
      ...(updatedBy ? { updatedBy } : {}),
    };
    return [{ id: id(s.id), name: sName, ...(PATH.test(gitlabPath) ? { gitlabPath } : {}), ...(sourceBranch && BRANCH.test(sourceBranch) ? { sourceBranch } : {}), ...deployFields, mrs, order: Number.isInteger(s.order) && Number(s.order) > 0 ? Number(s.order) : i + 1, ...(s.pic ? { pic: text(s.pic, 80) } : {}), ...(s.note ? { note: text(s.note, 500) } : {}) }];
  });
  const items: ReleaseItem[] = arr<Partial<ReleaseItem>>(raw.items, 300).flatMap((it) => {
    const label = text(it.label, 300);
    if (!label || !['env', 'migration', 'sql'].includes(String(it.kind))) return [];
    return [{ id: id(it.id), kind: it.kind as ReleaseItem['kind'], label, ...(it.service ? { service: text(it.service, 100) } : {}), ...(it.detail ? { detail: text(it.detail, 20_000) } : {}), source: it.source === 'import' || it.source === 'manual' ? it.source : 'check', done: it.done === true, ...(it.done && stamp(it.doneAt) ? { doneAt: stamp(it.doneAt) } : {}) }];
  });
  const steps: ReleaseStep[] = arr<Partial<ReleaseStep>>(raw.steps, 200).flatMap((st) => {
    const t = text(st.text, 1_000);
    if (!t) return [];
    return [{ id: id(st.id), kind: st.kind === 'rollback' ? 'rollback' : 'deploy', text: t, ...(st.service ? { service: text(st.service, 100) } : {}), done: st.done === true, ...(st.done && stamp(st.doneAt) ? { doneAt: stamp(st.doneAt) } : {}) }];
  });
  const now = new Date().toISOString();
  const src = raw.source;
  const pub = raw.published;
  return {
    id: id(raw.id),
    name,
    version: text(raw.version, 40),
    ...(date(raw.date) ? { date: date(raw.date) } : {}),
    status: (RELEASE_STATUSES as readonly string[]).includes(String(raw.status)) ? raw.status! : 'draft',
    targetBranch,
    sourceBranch: BRANCH.test(text(raw.sourceBranch, 100)) ? text(raw.sourceBranch, 100) : 'staging',
    ...(text(raw.mrTitleTemplate, 150) ? { mrTitleTemplate: text(raw.mrTitleTemplate, 150) } : {}),
    minApprovals: Math.min(5, Math.max(0, Math.floor(Number(raw.minApprovals ?? 1)) || 0)),
    projectIds: [...new Set(arr<string>(raw.projectIds, 20).map(String).filter((p) => ID.test(p)))],
    codenames: [...new Set(arr<string>(raw.codenames, 20).map((c) => text(c, 40).toUpperCase()).filter((c) => /^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(c)))],
    jiraKeys: [...new Set(arr<string>(raw.jiraKeys, 500).map(String).filter((k) => KEY.test(k)))],
    services,
    items,
    steps,
    ...(typeof raw.docMarkdown === 'string' && raw.docMarkdown.trim() ? { docMarkdown: raw.docMarkdown.slice(0, 500_000) } : {}),
    ...(src && (src.kind === 'confluence' || src.kind === 'markdown')
      ? { source: { kind: src.kind, title: text(src.title, 200), ...(src.pageId && /^\d{1,20}$/.test(String(src.pageId)) ? { pageId: String(src.pageId) } : {}), ...(Number.isInteger(src.version) ? { version: Number(src.version) } : {}), ...(src.url ? { url: text(src.url, 500) } : {}), importedAt: stamp(src.importedAt) ?? now } }
      : {}),
    ...(raw.teamsChat?.id ? { teamsChat: { id: text(raw.teamsChat.id, 300), name: text(raw.teamsChat.name, 200) } } : {}),
    shares: arr<Release['shares'][number]>(raw.shares, 50).map((s) => ({ at: stamp(s.at) ?? now, chatId: text(s.chatId, 300), chatName: text(s.chatName, 200), mrRefs: arr<string>(s.mrRefs, 40).map((r) => text(r, 320)) })),
    ...(validDeploy(raw.deploy) ? { deploy: validDeploy(raw.deploy) } : {}),
    accepted: arr<Release['accepted'][number]>(raw.accepted, 200).flatMap((a) => (KEY.test(String(a?.key)) ? [{ key: String(a.key), ...(a.note ? { note: text(a.note, 300) } : {}), at: stamp(a.at) ?? now }] : [])),
    ...(pub?.pageId && /^\d{1,20}$/.test(String(pub.pageId)) ? { published: { pageId: String(pub.pageId), version: Math.max(1, Math.floor(Number(pub.version) || 1)), ...(pub.url ? { url: text(pub.url, 500) } : {}), at: stamp(pub.at) ?? now } } : {}),
    ...(raw.notes ? { notes: text(raw.notes, 5_000) } : {}),
    createdAt: stamp(raw.createdAt) ?? now,
    updatedAt: now,
  };
}

export class ReleaseStore {
  constructor(private readonly dir = RELEASES_DIR) {}

  async list(): Promise<Release[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: Release[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as Release);
      } catch {
        /* half-written file */
      }
    }
    return out.sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt));
  }

  async get(releaseId: string): Promise<Release | undefined> {
    if (!ID.test(releaseId)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.dir, `${releaseId}.json`), 'utf8')) as Release;
    } catch {
      return undefined;
    }
  }

  async save(raw: Partial<Release>): Promise<Release> {
    const release = validateRelease(raw);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${release.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(release, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    return release;
  }

  async remove(releaseId: string): Promise<void> {
    if (!ID.test(releaseId)) throw new ReleaseInputError('Id rilis tidak valid.');
    await rm(join(this.dir, `${releaseId}.json`), { force: true });
  }
}
