import { JIRA_KEY } from './checks';
import { sameService } from './coverage';
import type { Release, ReleaseItem, ReleaseMrRef, ReleaseService, ReleaseSource, ReleaseStep } from './types';

/**
 * Reads a release document (Markdown, also what a Confluence page converts to) without assuming
 * one template: MR links and Jira keys anywhere, env names and SQL blocks, a services table found
 * by its header, and the deploy / rollback steps found by their section heading.
 */

export interface ParsedReleaseDoc {
  title?: string;
  version?: string;
  date?: string;
  mrs: { projectPath: string; iid: number; webUrl: string }[];
  jiraKeys: string[];
  env: string[];
  sql: { label: string; text: string }[];
  services: { name: string; pic?: string; order?: number; mrUrls: string[] }[];
  deploySteps: string[];
  rollbackSteps: string[];
}

const MR_URL = /https?:\/\/[^\s)<>\]|"'`]+?\/-\/merge_requests\/\d+/g;
const MONTHS: Record<string, number> = { jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, agu: 8, agt: 8, agustus: 8, aug: 8, august: 8, sep: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11, des: 12, desember: 12, dec: 12, december: 12 };
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i;
const ENV_NAME = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,80})\b/g;

const pad = (n: number) => String(n).padStart(2, '0');

export function mrRefFromUrl(url: string): { projectPath: string; iid: number; webUrl: string } | null {
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  return m ? { projectPath: m[1], iid: Number(m[2]), webUrl: url.replace(/[.,;:]+$/, '') } : null;
}

function parseDate(text: string): string | undefined {
  const iso = text.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d\d)\b/);
  if (dmy) return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
  const named = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d\d)\b/);
  if (named && MONTHS[named[2].toLowerCase()]) return `${named[3]}-${pad(MONTHS[named[2].toLowerCase()])}-${pad(Number(named[1]))}`;
  return undefined;
}

/** Splits Markdown into sections by heading. */
function sections(md: string): { heading: string; body: string[] }[] {
  const out: { heading: string; body: string[] }[] = [{ heading: '', body: [] }];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ heading: h[1].trim(), body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out;
}

/** Pipe tables in a block of lines: header cells and rows. */
function tables(lines: string[]): { header: string[]; rows: string[][] }[] {
  const out: { header: string[]; rows: string[][] }[] = [];
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const header = cells(lines[i]).map((c) => c.replace(/[*_`]/g, ''));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push(cells(lines[j]));
    out.push({ header, rows });
    i = j - 1;
  }
  return out;
}

const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();

function listItems(lines: string[]): string[] {
  return lines
    .map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map(plain)
    .filter(Boolean);
}

export function parseReleaseDoc(md: string): ParsedReleaseDoc {
  const secs = sections(md);
  const title = md.match(/^#\s+(.+)$/m)?.[1].trim();
  const head = md.slice(0, 3000);
  const version = (head.match(/\b(?:versi|version|release|rilis)\b[^\n\dv]{0,20}v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?)/i) ?? head.match(/\bv(\d+\.\d+(?:\.\d+)?)\b/))?.[1];
  const date = parseDate(head);

  const mrs: ParsedReleaseDoc['mrs'] = [];
  for (const url of md.match(MR_URL) ?? []) {
    const m = mrRefFromUrl(url);
    if (m && !mrs.some((x) => x.projectPath === m.projectPath && x.iid === m.iid)) mrs.push(m);
  }
  const jiraKeys = [...new Set(md.replace(MR_URL, ' ').match(JIRA_KEY) ?? [])];

  // SQL: fenced blocks marked sql or starting with a statement.
  const sql: ParsedReleaseDoc['sql'] = [];
  for (const m of md.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    const text = m[2].trim();
    if (m[1].toLowerCase() === 'sql' || SQL_START.test(text)) sql.push({ label: text.split('\n')[0].slice(0, 80), text });
  }

  // Env: KEY=value lines anywhere, and UPPER_SNAKE names in env/config sections.
  const env = new Set<string>();
  for (const m of md.matchAll(/^\s*(?:[-*]\s+)?`?(?:export\s+)?([A-Z][A-Z0-9_]{2,80})`?\s*[=:]\s*\S/gm)) if (m[1].includes('_')) env.add(m[1]);
  const services = new Map<string, ParsedReleaseDoc['services'][number]>();
  const deploySteps: string[] = [];
  const rollbackSteps: string[] = [];
  for (const s of secs) {
    const h = s.heading.toLowerCase();
    const body = s.body.filter((l) => !/^\s*```/.test(l));
    if (/\benv\b|environment|konfigurasi|config|variable|variabel/.test(h)) for (const l of body) for (const m of l.matchAll(ENV_NAME)) env.add(m[1]);
    if (/rollback|revert/.test(h)) rollbackSteps.push(...listItems(body));
    else if (/deploy|langkah|step|runbook|prosedur|eksekusi|release plan|rencana rilis/.test(h)) deploySteps.push(...listItems(body));
    for (const t of tables(s.body)) {
      const col = (re: RegExp) => t.header.findIndex((c) => re.test(c));
      const nameCol = col(/service|repo|aplikasi|application|project|modul|module/i);
      if (nameCol < 0) continue;
      const picCol = col(/\bpic\b|owner|penanggung|developer|dev\b/i);
      const orderCol = col(/^(no|urut(an)?|order|#|step)$/i);
      for (const row of t.rows) {
        const name = plain(row[nameCol] ?? '');
        if (!name || /^-+$/.test(name)) continue;
        const key = name.toLowerCase();
        const prev = services.get(key);
        const order = orderCol >= 0 ? Number(plain(row[orderCol] ?? '')) : NaN;
        services.set(key, {
          name: prev?.name ?? name,
          pic: prev?.pic ?? (picCol >= 0 ? plain(row[picCol] ?? '') || undefined : undefined),
          order: prev?.order ?? (Number.isFinite(order) && order > 0 ? order : undefined),
          mrUrls: [...new Set([...(prev?.mrUrls ?? []), ...(row.join(' ').match(MR_URL) ?? [])])],
        });
      }
    }
  }
  return { title, version, date, mrs, jiraKeys, env: [...env], sql, services: [...services.values()], deploySteps, rollbackSteps };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Service of a release that an MR belongs to (by GitLab path, else repo name in the path). */
export function serviceForPath(services: ReleaseService[], projectPath: string): ReleaseService | undefined {
  const repo = norm(projectPath.split('/').pop() ?? '');
  return services.find((s) => s.gitlabPath === projectPath) ?? services.find((s) => norm(s.name) === repo);
}

export interface ImportOptions {
  /** Services of the document that are not in the release and that the user chose to add. */
  addServices?: string[];
  /** Add the document's Jira keys to the release scope. */
  addKeys?: boolean;
}

export interface ImportPreview {
  /** Document services that are release services (they get the document's details). */
  matched: { doc: string; release: string }[];
  /** Document services the release does not have (left out unless chosen). */
  notInRelease: string[];
  /** Jira keys in the document that are not in the release's extra keys. */
  keys: string[];
}

const docServiceNames = (doc: ParsedReleaseDoc) => {
  const dep = doc as Partial<import('./deployment').ParsedDeploymentDoc>;
  return [...new Set([...doc.services.map((s) => s.name), ...(dep.serviceDetails ?? []).map((s) => s.name)])];
};

/** What an import would do to a release, for the confirmation in the import dialog. */
export function importPreview(release: Release, doc: ParsedReleaseDoc): ImportPreview {
  const matched: ImportPreview['matched'] = [];
  const notInRelease: string[] = [];
  for (const name of docServiceNames(doc)) {
    const svc = release.services.find((s) => sameService(s.name, name));
    if (svc) matched.push({ doc: name, release: svc.name });
    else notInRelease.push(name);
  }
  return { matched, notInRelease, keys: doc.jiraKeys.filter((k) => !release.jiraKeys.includes(k)) };
}

/**
 * Merges a document into a release. The document follows the release, not the other way round:
 * release data (services in scope, MRs and their commits, Change Log, Release List, status) is
 * never replaced by the document. Taken from the document: what Cockpit cannot derive — the
 * people per role, deployment room and release time (when empty), and, for services that are in
 * the release, their env block, pre/post-deploy notes, failover and "updated by". Services and
 * tickets the release does not have are added only when chosen (`opts`).
 */
export function mergeReleaseDoc(release: Release, doc: ParsedReleaseDoc, markdown: string, source: Omit<ReleaseSource, 'importedAt'>, now = new Date().toISOString(), opts: ImportOptions = {}): Release {
  const services = release.services.map((s) => ({ ...s, mrs: [...s.mrs] }));
  const chosen = new Set((opts.addServices ?? []).map(norm));
  const target = (name: string): ReleaseService | undefined => {
    const existing = services.find((s) => sameService(s.name, name));
    if (existing) return existing;
    if (!chosen.has(norm(name))) return undefined;
    const s: ReleaseService = { id: newId(), name, mrs: [], order: services.length + 1 };
    services.push(s);
    return s;
  };

  for (const s of doc.services) {
    const svc = target(s.name);
    if (svc && s.pic) svc.pic ??= s.pic;
  }
  for (const m of doc.mrs) {
    const ref = `${m.projectPath}!${m.iid}`;
    if (services.some((s) => s.mrs.some((x) => x.ref === ref))) continue;
    const row = doc.services.find((s) => s.mrUrls.some((u) => mrRefFromUrl(u)?.iid === m.iid && mrRefFromUrl(u)?.projectPath === m.projectPath));
    const svc = (row && target(row.name)) ?? serviceForPath(services, m.projectPath) ?? target(m.projectPath.split('/').pop() ?? m.projectPath);
    if (!svc) continue;
    svc.gitlabPath ??= m.projectPath;
    const mr: ReleaseMrRef = { ref, projectPath: m.projectPath, iid: m.iid, webUrl: m.webUrl, via: 'import' };
    svc.mrs.push(mr);
  }

  const items: ReleaseItem[] = [...release.items];
  const steps: ReleaseStep[] = [...release.steps];
  const dep = doc as Partial<import('./deployment').ParsedDeploymentDoc>;
  if (!dep.serviceDetails) {
    // A free-form document: its env, queries and steps belong to this release.
    const hasItem = (kind: ReleaseItem['kind'], label: string) => items.some((i) => i.kind === kind && i.label === label);
    for (const e of doc.env) if (!hasItem('env', e)) items.push({ id: newId(), kind: 'env', label: e, source: 'import', done: false });
    for (const q of doc.sql) if (!items.some((i) => i.kind === 'sql' && i.detail === q.text)) items.push({ id: newId(), kind: 'sql', label: q.label, detail: q.text, source: 'import', done: false });
    const addSteps = (kind: ReleaseStep['kind'], texts: string[]) => {
      for (const text of texts) if (!steps.some((s) => s.kind === kind && norm(s.text) === norm(text))) steps.push({ id: newId(), kind, text, done: false });
    };
    addSteps('deploy', doc.deploySteps);
    addSteps('rollback', doc.rollbackSteps);
  }

  // A deployment page: people and fixed info, then details of the release's own services.
  let deploy = release.deploy;
  if (dep.deploy) {
    const cur = release.deploy ?? { roles: [], changeLog: [], testEvidence: [] };
    const d = dep.deploy;
    deploy = {
      ...cur,
      targetTime: cur.targetTime ?? d.targetTime,
      impact: cur.impact ?? d.impact,
      room: cur.room ?? d.room,
      roles: d.roles.length ? d.roles.map((r) => ({ label: r.label, people: r.people.length ? r.people : (cur.roles.find((x) => x.label === r.label)?.people ?? []) })) : cur.roles,
    };
  }
  for (const s of dep.serviceDetails ?? []) {
    const svc = target(s.name);
    if (!svc) continue;
    svc.envBlock ??= s.envBlock;
    svc.failover ??= s.failover;
    svc.updatedBy ??= s.updatedBy;
    if (s.preDeploy.length) svc.preDeploy = [...new Set([...(svc.preDeploy ?? []), ...s.preDeploy])];
    if (s.postDeploy.length) svc.postDeploy = [...new Set([...(svc.postDeploy ?? []), ...s.postDeploy])];
    // Done marks of another page say nothing about this release: imported items start open.
    for (const e of s.envNames) {
      const it = items.find((i) => i.kind === 'env' && i.label === e && (!i.service || i.service === svc.name));
      if (it) it.service ??= svc.name;
      else items.push({ id: newId(), kind: 'env', label: e, service: svc.name, source: 'import', done: false });
    }
    for (const q of s.sql) {
      const it = items.find((i) => i.kind === 'sql' && i.detail === q.text);
      if (it) it.service ??= svc.name;
      else items.push({ id: newId(), kind: 'sql', label: q.label, detail: q.text, service: svc.name, source: 'import', done: false });
    }
  }

  return {
    ...release,
    ...(deploy ? { deploy } : {}),
    name: release.name || doc.title || release.name,
    version: release.version || doc.version || '',
    date: release.date ?? doc.date,
    jiraKeys: opts.addKeys ? [...new Set([...release.jiraKeys, ...doc.jiraKeys])] : release.jiraKeys,
    services: services.sort((a, b) => a.order - b.order).map((s, i) => ({ ...s, order: i + 1 })),
    items,
    steps,
    docMarkdown: markdown,
    source: { ...source, importedAt: now },
  };
}

/**
 * Services with no release MR that no scope ticket points to (needs a report): what an older
 * import (or a typo) left behind.
 */
export function servicesOutsideScope(release: Release, report: { tickets: { service?: string }[] } | null | undefined): ReleaseService[] {
  if (!report) return [];
  return release.services.filter((s) => !s.mrs.length && !report.tickets.some((t) => t.service && sameService(t.service, s.name)));
}

/** Removes services (and their checklist items) from a release. */
export function removeServices(release: Release, ids: string[]): Release {
  const gone = new Set(ids);
  const names = new Set(release.services.filter((s) => gone.has(s.id)).map((s) => s.name));
  return {
    ...release,
    services: release.services.filter((s) => !gone.has(s.id)).map((s, i) => ({ ...s, order: i + 1 })),
    items: release.items.filter((i) => !i.service || !names.has(i.service)),
    steps: release.steps.filter((x) => !x.service || !names.has(x.service)),
  };
}

/**
 * Clears what a deployment page of another release may have put in: Change Log, Release List,
 * test evidence, status, actual time, issue link and typed commit ids. The document then follows
 * the release again. People per role and the deployment room stay.
 */
export function resetDocumentData(release: Release): Release {
  const d = release.deploy;
  return {
    ...release,
    services: release.services.map(({ commitId: _c, ...s }) => s),
    ...(d ? { deploy: { roles: d.roles, changeLog: [], testEvidence: [], ...(d.room ? { room: d.room } : {}), ...(d.targetTime ? { targetTime: d.targetTime } : {}), ...(d.impact ? { impact: d.impact } : {}) } } : {}),
  };
}
