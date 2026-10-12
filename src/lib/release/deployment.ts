import { JIRA_KEY } from './checks';
import { mrRefFromUrl, type ParsedReleaseDoc } from './import';
import type { DeployInfo, DeployPerson, MrCheck, Release, ReleaseReport, ReleaseService } from './types';

/**
 * The team's deployment page in Confluence, both ways: read an existing page (storage XHTML) into
 * a release, and write a release back as a page with the same layout — release info table,
 * Change Log, Deployment List (deploy order, then one table per service: Pre-deploy, Commit id,
 * Post-deploy, Failover Strategy, Updated by), Release List, Document Control, Post Deployment
 * Test and Post Deployment issues. String-based, so it runs in the browser and the connector.
 */

export const DEFAULT_ROLES = ['Supervisor', 'Tech Lead', 'QA', 'Cloud Platform Team', 'Product Lead'];
export const DEFAULT_FAILOVER = 'Rollback Instance Template';
const INFO_LABELS = new Set(['target release', 'actual release', 'deployment status', 'deployment impact', 'deployment room', 'issue/request link (if any)', 'issue/request link']);
const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const SQL_START = /^\s*(--|SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i;

/** "12 Agustus 2026" */
export function tanggal(date?: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS_ID[m - 1]} ${y}`;
}

export function deploymentTitle(release: Release): string {
  return release.date ? `Deployment ${tanggal(release.date)}` : `Deployment ${release.name}${release.version ? ` ${release.version}` : ''}`;
}

// Reading --------------------------------------------------------------------------------

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** Visible text of an XHTML fragment (macros' parameters and CDATA left out). */
export function textOf(x: string): string {
  return decode(
    x
      .replace(/<ac:parameter[\s\S]*?<\/ac:parameter>/g, ' ')
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
      .replace(/<ac:task-id>[\s\S]*?<\/ac:task-id>|<ac:task-uuid>[\s\S]*?<\/ac:task-uuid>|<ac:task-status>[\s\S]*?<\/ac:task-status>/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

interface Cell {
  head: boolean;
  html: string;
}

function rowsOf(table: string): Cell[][] {
  const rows: Cell[][] = [];
  for (const r of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells: Cell[] = [];
    for (const c of r[1].matchAll(/<t([hd])\b[^>]*?(?:\/>|>([\s\S]*?)<\/t\1>)/g)) cells.push({ head: c[1] === 'h', html: c[2] ?? '' });
    rows.push(cells);
  }
  return rows;
}

function people(html: string): DeployPerson[] {
  const out: DeployPerson[] = [];
  for (const m of html.matchAll(/<ri:user\b([^>]*?)\/?>/g)) {
    const accountId = m[1].match(/ri:account-id="([^"]*)"/)?.[1];
    const name = decode(m[1].match(/data-display-name="([^"]*)"/)?.[1] ?? '');
    if (accountId || name) out.push({ ...(accountId ? { accountId } : {}), name });
  }
  // Names typed as plain text next to the mentions.
  const rest = textOf(html.replace(/<ac:link>[\s\S]*?<\/ac:link>/g, ' '));
  for (const n of rest.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) out.push({ name: n });
  return out;
}

function statusMacro(html: string): { title?: string; colour?: string } {
  const m = html.match(/<ac:structured-macro\b[^>]*ac:name="status"[\s\S]*?<\/ac:structured-macro>/);
  if (!m) return {};
  return { title: decode(m[0].match(/<ac:parameter ac:name="title">([\s\S]*?)<\/ac:parameter>/)?.[1] ?? '').trim() || undefined, colour: m[0].match(/<ac:parameter ac:name="colour">([\s\S]*?)<\/ac:parameter>/)?.[1] };
}

/** Tasks and code blocks of a cell, in order; a code block belongs to the task before it. */
function tasksAndCode(html: string): { text: string; done: boolean; code: { language?: string; body: string }[] }[] {
  const out: { text: string; done: boolean; code: { language?: string; body: string }[] }[] = [];
  const re = /<ac:task>([\s\S]*?)<\/ac:task>|<ac:structured-macro\b[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      out.push({ text: textOf(m[1].match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/)?.[1] ?? ''), done: /<ac:task-status>\s*complete\s*</.test(m[1]), code: [] });
    } else {
      const body = m[2].match(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/)?.[1] ?? '';
      const language = m[2].match(/<ac:parameter ac:name="language">([\s\S]*?)<\/ac:parameter>/)?.[1];
      if (!out.length) out.push({ text: '', done: false, code: [] });
      out[out.length - 1].code.push({ ...(language ? { language } : {}), body });
    }
  }
  return out;
}

const isNa = (t: string) => !t || /^(n\/?a|-|tidak ada|none)$/i.test(t.trim());
const isEnvCode = (body: string) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/m.test(body) && !SQL_START.test(body);

export interface DeploymentService {
  name: string;
  order?: number;
  commitId?: string;
  /** The env code block as written in the page (values included). */
  envBlock?: string;
  envNames: string[];
  envDone: boolean;
  sql: { label: string; text: string; done: boolean }[];
  preDeploy: string[];
  postDeploy: string[];
  failover?: string;
  updatedBy?: DeployPerson;
}

export interface ParsedDeploymentDoc extends ParsedReleaseDoc {
  deploy: DeployInfo;
  serviceDetails: DeploymentService[];
}

/**
 * Reads a deployment page (Confluence storage). Returns null when the page does not have this
 * layout (no release info table and no per-service deployment tables), so the generic Markdown
 * reader can take over.
 */
export function parseDeploymentStorage(xhtml: string, pageTitle = ''): ParsedDeploymentDoc | null {
  const marks: { at: number; heading: string }[] = [...xhtml.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/g)].map((m) => ({ at: m.index!, heading: textOf(m[1]) }));
  const sectionAt = (at: number) => [...marks].reverse().find((m) => m.at < at)?.heading ?? '';
  const sectionBody = (re: RegExp) => {
    const i = marks.findIndex((m) => re.test(m.heading));
    if (i < 0) return '';
    return xhtml.slice(marks[i].at, marks[i + 1]?.at ?? xhtml.length);
  };
  const tables = [...xhtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)].map((m) => ({ at: m.index!, rows: rowsOf(m[1]) }));

  const deploy: DeployInfo = { roles: [], changeLog: [], testEvidence: [] };
  let date: string | undefined;
  const info = tables.find((t) => t.rows.some((r) => /^target release$/i.test(textOf(r[0]?.html ?? ''))));
  if (info) {
    for (const r of info.rows) {
      if (r.length < 2) continue;
      const label = textOf(r[0].html);
      const key = label.toLowerCase();
      const cell = r[1].html;
      if (key === 'target release') {
        date = cell.match(/<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
        deploy.targetTime = textOf(cell).match(/\b\d{1,2}[:.]\d{2}\b/)?.[0];
      } else if (key === 'actual release') deploy.actual = textOf(cell) || undefined;
      else if (key === 'deployment status') {
        const st = statusMacro(cell);
        deploy.statusTitle = st.title ?? (textOf(cell) || undefined);
        deploy.statusColour = st.colour;
      } else if (key === 'deployment impact') deploy.impact = statusMacro(cell).title ?? (textOf(cell) || undefined);
      else if (key === 'deployment room') deploy.room = textOf(cell) || undefined;
      else if (key.startsWith('issue/request link')) deploy.issueLink = cell.match(/href="([^"]+)"/)?.[1] ?? (textOf(cell) || undefined);
      else if (!INFO_LABELS.has(key)) deploy.roles.push({ label, people: people(cell) });
    }
  }

  const changeLog = tables.find((t) => /change\s*log/i.test(sectionAt(t.at)));
  for (const r of changeLog?.rows ?? []) {
    if (r.every((c) => c.head) || r.length < 2) continue;
    const details = textOf(r[1].html);
    const notes = textOf(r[2]?.html ?? '');
    if (details || notes) deploy.changeLog.push({ details, ...(notes ? { notes } : {}) });
  }

  // Deploy order from the info panel, then one table per service.
  const list = sectionBody(/deployment list/i);
  const order = [...(list.match(/<ac:structured-macro\b[^>]*ac:name="(?:info|note|panel)"[\s\S]*?<\/ac:structured-macro>/)?.[0] ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]).replace(/[`]/g, ''));
  const serviceDetails: DeploymentService[] = [];
  for (const t of tables.filter((x) => /deployment list/i.test(sectionAt(x.at)))) {
    const name = textOf(t.rows[0]?.[1]?.html ?? '');
    if (!name || !t.rows.some((r) => /pre-?deploy|commit/i.test(textOf(r[0]?.html ?? '')))) continue;
    const svc: DeploymentService = { name, envNames: [], envDone: false, sql: [], preDeploy: [], postDeploy: [] };
    const pos = order.findIndex((o) => o.toLowerCase() === name.toLowerCase());
    if (pos >= 0) svc.order = pos + 1;
    for (const r of t.rows.slice(1)) {
      const label = textOf(r[0]?.html ?? '').toLowerCase();
      const cell = r[1]?.html ?? '';
      if (/pre-?deploy/.test(label)) {
        const env: string[] = [];
        for (const task of tasksAndCode(cell)) {
          for (const code of task.code) {
            if (code.language?.toLowerCase() === 'sql' || (!isEnvCode(code.body) && SQL_START.test(code.body))) svc.sql.push({ label: task.text || code.body.trim().split('\n')[0].slice(0, 80), text: code.body.trim(), done: task.done });
            else if (isEnvCode(code.body)) {
              env.push(code.body.replace(/\s+$/, ''));
              svc.envDone = task.done;
            } else if (code.body.trim()) svc.preDeploy.push(`${task.text}: ${code.body.trim()}`);
          }
          if (!task.code.length && !isNa(task.text)) svc.preDeploy.push(task.text);
        }
        if (env.length) {
          svc.envBlock = env.join('\n');
          svc.envNames = [...new Set([...svc.envBlock.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/gm)].map((m) => m[1]))];
        }
      } else if (/commit/.test(label)) {
        const sha = (tasksAndCode(cell)[0]?.text || textOf(cell)).match(/\b[0-9a-f]{7,40}\b/i)?.[0];
        if (sha) svc.commitId = sha;
      } else if (/post-?deploy/.test(label)) {
        svc.postDeploy.push(...tasksAndCode(cell).map((x) => x.text).filter((x) => !isNa(x)));
        const plain = textOf(cell.replace(/<ac:task-list>[\s\S]*?<\/ac:task-list>/g, ''));
        if (plain && !isNa(plain)) svc.postDeploy.push(plain);
      } else if (/failover|rollback/.test(label)) svc.failover = textOf(cell) || undefined;
      else if (/updated by/.test(label)) svc.updatedBy = people(cell)[0];
    }
    serviceDetails.push(svc);
  }

  if (!info && !serviceDetails.length) return null;

  const releaseList = sectionBody(/release list/i);
  const listUrl = releaseList.match(/<a\b[^>]*href="([^"]+)"/)?.[1];
  if (listUrl) {
    const jql = decode(listUrl).match(/[?&]jql=([^&]+)/)?.[1];
    deploy.releaseList = { url: decode(listUrl), ...(jql ? { jql: decodeURIComponent(jql.replace(/\+/g, ' ')) } : {}) };
  }
  for (const m of sectionBody(/post deployment test/i).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) deploy.testEvidence.push({ url: decode(m[1]), title: textOf(m[2]) || decode(m[1]) });

  const plain = textOf(xhtml);
  const mrs: ParsedReleaseDoc['mrs'] = [];
  for (const u of decode(xhtml).match(/https?:\/\/[^\s"'<>]+?\/-\/merge_requests\/\d+/g) ?? []) {
    const m = mrRefFromUrl(u);
    if (m && !mrs.some((x) => x.projectPath === m.projectPath && x.iid === m.iid)) mrs.push(m);
  }
  const sorted = [...serviceDetails].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return {
    title: pageTitle || undefined,
    date,
    mrs,
    jiraKeys: [...new Set(plain.match(JIRA_KEY) ?? [])],
    env: [...new Set(serviceDetails.flatMap((s) => s.envNames))],
    sql: serviceDetails.flatMap((s) => s.sql.map((q) => ({ label: q.label, text: q.text }))),
    services: sorted.map((s, i) => ({ name: s.name, order: s.order ?? i + 1, mrUrls: [] })),
    deploySteps: [],
    rollbackSteps: [],
    deploy,
    serviceDetails: sorted,
  };
}

// Writing --------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s: string) => `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
const HEAD = 'data-highlight-colour="#f0f1f2"';

const STATUS_BY_RELEASE: Record<Release['status'], { title: string; colour: string }> = {
  draft: { title: 'DRAFT', colour: 'Grey' },
  review: { title: 'DOCUMENT APPROVAL', colour: 'Blue' },
  ready: { title: 'READY TO DEPLOY', colour: 'Yellow' },
  released: { title: 'DONE', colour: 'Green' },
  'rolled-back': { title: 'ROLLBACK', colour: 'Red' },
};

function status(title: string, colour?: string): string {
  return `<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">${esc(title)}</ac:parameter>${colour ? `<ac:parameter ac:name="colour">${esc(colour)}</ac:parameter>` : ''}</ac:structured-macro>`;
}

function mention(p: DeployPerson): string {
  return p.accountId ? `<ac:link><ri:user ri:account-id="${esc(p.accountId)}" /></ac:link>` : esc(p.name);
}

function code(body: string, language?: string): string {
  return `<ac:structured-macro ac:name="code" ac:schema-version="1">${language ? `<ac:parameter ac:name="language">${esc(language)}</ac:parameter>` : ''}<ac:parameter ac:name="wrap">true</ac:parameter><ac:plain-text-body>${cdata(body)}</ac:plain-text-body></ac:structured-macro>`;
}

/**
 * Commit id for a service, from the release data: the merged (else open) release MR's commit.
 * A commit id typed in only counts when the release has no checked MR for the service.
 */
export function serviceCommit(service: ReleaseService, checks: MrCheck[]): string | undefined {
  const mine = checks.filter((c) => service.mrs.some((m) => m.ref === c.ref) && !c.error && c.state !== 'closed');
  const merged = mine.find((c) => c.state === 'merged' && c.commitSha);
  return (merged ?? mine.find((c) => c.commitSha))?.commitSha ?? service.commitId;
}

/** Change Log rows from the release itself when none were written: one row for the release. */
export function changeLogRows(release: Release): { details: string; notes?: string }[] {
  const rows = release.deploy?.changeLog.filter((c) => c.details.trim() || c.notes?.trim()) ?? [];
  if (rows.length) return rows;
  return [{ details: release.name, notes: [release.version, release.codenames.join(', ')].filter(Boolean).join(' · ') || undefined }];
}

/** The env block for a service: the page's own block, plus `KEY=` for env found by the checks. */
export function serviceEnvBlock(release: Release, service: ReleaseService): { text: string; done: boolean } | null {
  const items = release.items.filter((i) => i.kind === 'env' && i.service === service.name);
  const block = service.envBlock?.replace(/\s+$/, '') ?? '';
  const present = new Set([...block.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/gm)].map((m) => m[1]));
  const extra = items.filter((i) => !present.has(i.label)).map((i) => `${i.label}=`);
  const text = [block, ...extra].filter(Boolean).join('\n');
  if (!text) return null;
  return { text, done: items.length > 0 && items.every((i) => i.done) };
}

export interface DeploymentOptions {
  jiraBaseUrl?: string;
}

/** The release as a deployment page in Confluence storage format. */
export function deploymentStorage(release: Release, report?: ReleaseReport | null, opts: DeploymentOptions = {}): string {
  const d: DeployInfo = release.deploy ?? { roles: [], changeLog: [], testEvidence: [] };
  const checks = report?.mrs ?? [];
  let taskId = 0;
  const tasks = (list: { text: string; done?: boolean; after?: string }[]) =>
    list
      .map((t) => `<ac:task-list><ac:task><ac:task-id>${++taskId}</ac:task-id><ac:task-status>${t.done ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${esc(t.text)}</ac:task-body></ac:task></ac:task-list>${t.after ?? ''}`)
      .join('');
  const out: string[] = [];

  // Release info.
  const st = d.statusTitle ? { title: d.statusTitle, colour: d.statusColour } : STATUS_BY_RELEASE[release.status];
  const roles = d.roles.length ? d.roles : DEFAULT_ROLES.map((label) => ({ label, people: [] }));
  const issue = d.issueLink ? (/^https?:\/\//.test(d.issueLink) ? `<a href="${esc(d.issueLink)}">${esc(d.issueLink)}</a>` : esc(d.issueLink)) : '';
  out.push(
    '<table data-table-width="760" data-layout="center"><colgroup><col style="width: 380.0px;" /><col style="width: 380.0px;" /></colgroup><tbody>',
    `<tr><th><p>Target Release</p></th><td><p>${release.date ? `<time datetime="${release.date}" /> ` : ''}${esc(d.targetTime ?? '')}</p></td></tr>`,
    `<tr><th><p>Actual Release</p></th><td><p>${esc(d.actual ?? 'TBA')}</p></td></tr>`,
    `<tr><th><p>Deployment Status</p></th><td><p>${status(st.title, st.colour)}</p></td></tr>`,
    `<tr><th><p>Deployment Impact</p></th><td><p>${status(d.impact ?? '-')}</p></td></tr>`,
    ...roles.map((r) => `<tr><th><p>${esc(r.label)}</p></th><td><p>${r.people.map(mention).join(' ')}</p></td></tr>`),
    `<tr><th><p>Deployment Room</p></th><td><p>${esc(d.room ?? '')}</p></td></tr>`,
    `<tr><th><p>Issue/Request Link (if any)</p></th><td><p>${issue}</p></td></tr>`,
    '</tbody></table>',
  );

  // Change log.
  out.push(
    '<h2><ac:emoticon ac:name="dart" ac:emoji-shortname=":dart:" ac:emoji-id="1f3af" ac:emoji-fallback="🎯" /> Change Log</h2>',
    '<table data-table-width="760" data-layout="default"><colgroup><col style="width: 92.0px;" /><col style="width: 342.0px;" /><col style="width: 324.0px;" /></colgroup><tbody>',
    '<tr><th><p><strong>No.</strong></p></th><th><p><strong>Details</strong></p></th><th><p><strong>Notes</strong></p></th></tr>',
    ...changeLogRows(release).map((c, i) => `<tr><td><p>${i + 1}</p></td><td><p>${esc(c.details)}</p></td><td><p>${esc(c.notes ?? '')}</p></td></tr>`),
    '</tbody></table>',
  );

  // Deployment list: order, then one table per service.
  const services = [...release.services].sort((a, b) => a.order - b.order);
  out.push(
    '<h2><ac:emoticon ac:name="blue-star" ac:emoji-shortname=":note:" ac:emoji-id="atlassian-note" ac:emoji-fallback=":note:" /> Deployment List</h2>',
    `<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:rich-text-body><p><strong>Urutan deploy:</strong></p><ol>${services.map((s) => `<li><p>${esc(s.name)}</p></li>`).join('')}</ol></ac:rich-text-body></ac:structured-macro>`,
  );
  for (const s of services) {
    const pre: { text: string; done?: boolean; after?: string }[] = [];
    const env = serviceEnvBlock(release, s);
    if (env) pre.push({ text: 'Update .env', done: env.done, after: code(env.text) });
    for (const m of release.items.filter((i) => i.kind === 'migration' && i.service === s.name)) pre.push({ text: `Jalankan migrasi ${m.label}`, done: m.done });
    for (const q of release.items.filter((i) => i.kind === 'sql' && i.service === s.name)) pre.push({ text: q.detail ? q.label : `Jalankan query ${q.label}`, done: q.done, ...(q.detail ? { after: code(q.detail, 'sql') } : {}) });
    for (const p of s.preDeploy ?? []) pre.push({ text: p });
    const post = (s.postDeploy ?? []).map((text) => ({ text }));
    const rollback = release.steps.filter((x) => x.kind === 'rollback' && x.service === s.name).map((x) => x.text);
    out.push(
      '<table data-table-width="760" data-layout="center"><colgroup><col style="width: 233.0px;" /><col style="width: 527.0px;" /></colgroup><tbody>',
      `<tr><th><p /></th><th ${HEAD}><p><code>${esc(s.name)}</code></p></th></tr>`,
      `<tr><th ${HEAD}><p>Pre-deploy</p></th><td>${tasks(pre.length ? pre : [{ text: 'N/A' }])}</td></tr>`,
      `<tr><th ${HEAD}><p>Commit id</p></th><td>${tasks([{ text: serviceCommit(s, checks) ?? 'TBA' }])}</td></tr>`,
      `<tr><th ${HEAD}><p>Post-deploy</p></th><td>${tasks(post.length ? post : [{ text: 'N/A' }])}</td></tr>`,
      `<tr><th ${HEAD}><p>Failover Strategy</p></th><td><p>${esc(s.failover ?? (rollback.join('; ') || DEFAULT_FAILOVER))}</p></td></tr>`,
      `<tr><th ${HEAD}><p>Updated by</p></th><td><p>${s.updatedBy ? mention(s.updatedBy) : ''}</p></td></tr>`,
      '</tbody></table>',
    );
  }

  // Release list: the Jira issues of the release.
  const keys = [...new Set([...(report?.tickets.map((t) => t.key) ?? []), ...release.jiraKeys])];
  const jql = d.releaseList?.jql ?? (keys.length ? `key in (${keys.join(', ')}) ORDER BY created ASC` : '');
  const base = opts.jiraBaseUrl?.replace(/\/+$/, '');
  const listUrl = jql && base ? `${base}/issues/?jql=${encodeURIComponent(jql)}` : d.releaseList?.url;
  out.push(
    '<h2><ac:emoticon ac:name="rocket" ac:emoji-shortname=":rocket:" ac:emoji-id="1f680" ac:emoji-fallback="🚀" /> Release List</h2>',
    listUrl ? `<p><a href="${esc(listUrl)}" data-card-appearance="block">${esc(listUrl)}</a></p>` : jql ? `<p><code>${esc(jql)}</code></p>` : '<p />',
  );

  out.push('<h2>Document Control</h2><p /><ac:structured-macro ac:name="page-signatures" ac:schema-version="1" data-layout="default" /><p />');
  out.push('<h2>Post Deployment Test</h2><p><strong>Evidence link:</strong></p>', ...d.testEvidence.map((e) => `<p><a href="${esc(e.url)}">${esc(e.title)}</a></p>`), '<p />');

  const grey = 'data-highlight-colour="var(--ds-background-accent-gray-subtlest, #F4F5F7)"';
  out.push(
    '<h2><ac:emoticon ac:name="blue-star" ac:emoji-shortname=":bomb:" ac:emoji-id="1f4a3" ac:emoji-fallback="💣" /> Post Deployment issues</h2>',
    '<table data-table-width="998" data-layout="default"><colgroup><col /><col style="width: 134.0px;" /><col style="width: 195.0px;" /><col style="width: 186.0px;" /><col style="width: 186.0px;" /><col style="width: 111.0px;" /><col style="width: 139.0px;" /></colgroup><tbody>',
    `<tr><th class="numberingColumn" />${['Date', 'Issues', 'Rootcause', 'Solution', 'Status', 'Datetime'].map((h) => `<th ${grey}><p><strong>${h}</strong></p></th>`).join('')}</tr>`,
    ...[1, 2, 3, 4].map((n) => `<tr><td class="numberingColumn">${n}</td>${'<td><p /></td>'.repeat(6)}</tr>`),
    '</tbody></table>',
  );
  return out.join('');
}
