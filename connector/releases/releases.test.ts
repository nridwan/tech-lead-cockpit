// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EstimateProject } from '../../src/lib/estimate/types.ts';
import type { MrDetail, MrSummary } from '../../src/lib/gitlab/types.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import { connectorMiddleware } from '../dev-connector.ts';
import { ReleaseManager, type ReleaseDeps } from './manager.ts';
import { projectPathFromRemote } from './repos.ts';
import { ReleaseInputError, ReleaseStore, validateRelease } from './store.ts';

const GL = 'https://gitlab.example.com';
const TAD = `# TAD

# Development Scope

| No | Service | Task Name | Jira Task |
| --- | --- | --- | --- |
| 1 | core-payment | [BACKEND][CORE-PAYMENT][SWITCHING] - Refund API | MU-12 |
`;

const summary = (path: string, iid: number, over: Partial<MrSummary & { description: string }> = {}): MrSummary & { description: string } => ({
  ref: `${path}!${iid}`,
  projectId: 1,
  projectPath: path,
  iid,
  title: 'Release',
  state: 'opened',
  draft: false,
  author: { id: 1, username: 'budi', name: 'Budi' },
  sourceBranch: 'staging',
  targetBranch: 'master',
  webUrl: `${GL}/${path}/-/merge_requests/${iid}`,
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z',
  description: '',
  ...over,
});

const detail = (s: MrSummary, over: Partial<MrDetail> = {}): MrDetail =>
  ({
    ...s,
    description: '',
    reviewers: [],
    assignees: [],
    labels: [],
    // Each fake MR's commit carries the Jira key of its title (MU-12 by default).
    commits: [
      { id: '1', shortId: '1', title: /MU-\d+/.test(s.title) ? s.title : 'MU-12 refund api', authorName: 'Budi', createdAt: '' },
      // core-payment also carries an older SWITCHING ticket and an unrelated one.
      ...(s.projectPath === 'payments/core-payment' ? [{ id: '2', shortId: '2', title: 'MU-88 retry refund', authorName: 'Budi', createdAt: '' }, { id: '3', shortId: '3', title: 'MU-77 banner promo', authorName: 'Budi', createdAt: '' }] : []),
    ],
    changes: [{ oldPath: '.env.example', newPath: '.env.example', newFile: false, renamedFile: false, deletedFile: false, diff: '+REFUND_LIMIT=5', additions: 1, deletions: 0 }],
    totals: { files: 1, additions: 1, deletions: 0 },
    jiraKeys: [],
    risks: [],
    diffTruncated: false,
    approvals: { approved: true, approvedBy: ['Citra'], required: 1, left: 0 },
    pipeline: { id: 1, status: 'success' },
    ...over,
  }) as MrDetail;

const issue = (key: string, summaryText: string, status = 'READY TO TEST'): JiraIssue => ({ id: key, key, summary: summaryText, status, statusCategory: 'indeterminate', issueType: 'Task', updated: '2026-10-12T00:00:00Z', url: `https://jira.example.com/browse/${key}` });

describe('validateRelease and store', () => {
  it('cleans input and rejects what cannot be a release', () => {
    const r = validateRelease({
      name: ' Rilis ',
      targetBranch: 'main',
      minApprovals: 9,
      codenames: ['switching', 'bad name!'],
      jiraKeys: ['MU-1', 'nope'],
      services: [{ id: 's', name: 'core', mrs: [{ projectPath: 'a/b', iid: 3, webUrl: `${GL}/a/b/-/merge_requests/3`, ref: 'x', via: 'auto' }, { projectPath: '../x', iid: 1, webUrl: 'u', ref: 'y', via: 'auto' }], order: 1 }],
    } as never);
    expect(r).toMatchObject({ name: 'Rilis', targetBranch: 'main', minApprovals: 5, codenames: ['SWITCHING'], jiraKeys: ['MU-1'], status: 'draft' });
    expect(r.services[0].mrs.map((m) => m.ref)).toEqual(['a/b!3']);
    expect(() => validateRelease({ name: '' })).toThrow(ReleaseInputError);
    expect(() => validateRelease({ name: 'x', targetBranch: 'bad branch' })).toThrow(/branch/);
  });

  it('saves one 0600 file per release and lists them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tlc-rel-'));
    try {
      const store = new ReleaseStore(dir);
      const a = await store.save({ name: 'A', date: '2026-10-20' } as never);
      await store.save({ name: 'B', date: '2026-11-01' } as never);
      expect((await store.list()).map((r) => r.name)).toEqual(['B', 'A']);
      expect((await stat(join(dir, `${a.id}.json`))).mode & 0o777).toBe(0o600);
      await store.remove(a.id);
      expect(await store.get(a.id)).toBeUndefined();
      await expect(store.remove('../x')).rejects.toThrow(ReleaseInputError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('projectPathFromRemote', () => {
  it('reads https, ssh and scp-style remotes for the configured host only', () => {
    expect(projectPathFromRemote('https://gitlab.example.com/payments/core-payment.git', GL)).toBe('payments/core-payment');
    expect(projectPathFromRemote('git@gitlab.example.com:payments/sub/core.git', GL)).toBe('payments/sub/core');
    expect(projectPathFromRemote('ssh://git@gitlab.example.com:2222/payments/core.git', GL)).toBe('payments/core');
    expect(projectPathFromRemote('https://github.com/acme/core.git', GL)).toBeUndefined();
    expect(projectPathFromRemote('https://host.example/gitlab/team/repo.git', 'https://host.example/gitlab')).toBe('team/repo');
  });
});

describe('ReleaseManager', () => {
  let dir = '';
  let sent: { chatId: string; html: string }[];
  let jql: string[];
  const project: EstimateProject = { id: 'p1', name: 'Switching', draftIds: ['d1'], startDate: '2026-10-05', skipCutiBersama: true, developers: [], tasks: [], createdAt: '', updatedAt: '' };

  const manager = (over: Partial<ReleaseDeps> = {}) => {
    const mrs = [summary('payments/core-payment', 12), summary('mobile/app', 7, { title: 'MU-13 layar refund' }), summary('other/repo', 1), summary('payments/core-payment', 3, { state: 'merged', updatedAt: '2026-01-01T00:00:00Z' })];
    return new ReleaseManager({
      store: new ReleaseStore(join(dir, 'releases')),
      reportDir: join(dir, 'reports'),
      gitlab: async () => ({ mrsToBranch: async () => mrs, mr: async (path, iid) => detail(mrs.find((m) => m.projectPath === path && m.iid === iid)!) }),
      jiraSearch: async (q) => {
        jql.push(q);
        if (q.startsWith('key in')) {
          const all = [issue('MU-12', '[BACKEND][CORE-PAYMENT][SWITCHING] - Refund API'), issue('MU-88', '[BACKEND][CORE-PAYMENT][SWITCHING] - Retry refund'), issue('MU-77', '[WEB-FE][PORTAL][PROMO] - Banner', 'In Progress')];
          return all.filter((i) => q.includes(i.key));
        }
        return [issue('MU-13', '[MOBILE-FE][MOBILE-APP][SWITCHING] - Layar refund', 'In Progress'), issue('MU-99', 'switching tanpa format')];
      },
      projects: async () => [project],
      drafts: async () => [{ id: 'd1', markdown: TAD }],
      repoPaths: async () => ({ 'core-payment': 'payments/core-payment', 'mobile-app': 'mobile/app' }),
      teamsSend: async (chatId, html) => void sent.push({ chatId, html }),
      now: () => new Date('2026-10-12T05:00:00Z'),
      ...over,
    });
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-relmgr-'));
    sent = [];
    jql = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collects tickets from the TAD and the codename, finds services and MRs, and checks them', async () => {
    const m = manager();
    const r = await m.store.save({ name: 'Switching', projectIds: ['p1'], createdAt: '2026-10-10T00:00:00Z' } as never);
    expect(await m.codenames(r)).toEqual(['SWITCHING']);

    const found = await m.discover(r.id);
    expect(found.warnings).toEqual([]);
    expect(found.release.services.map((s) => [s.name, s.gitlabPath, s.mrs.map((x) => x.ref)])).toEqual([
      ['core-payment', 'payments/core-payment', ['payments/core-payment!12']],
      ['MOBILE-APP', 'mobile/app', ['mobile/app!7']],
    ]);
    expect(found.addedMrs).toBe(2);
    expect(jql.some((q) => q.includes('summary ~ "SWITCHING"'))).toBe(true);

    const { release, report } = await m.check(r.id);
    // MU-88 is older than the codename search but has the release CODENAME: it joins the scope.
    expect(report.tickets.map((t) => [t.key, t.from, t.inMrs])).toEqual([
      ['MU-12', 'tad', ['payments/core-payment!12']],
      ['MU-13', 'codename', ['mobile/app!7']],
      ['MU-88', 'codename', ['payments/core-payment!12']],
    ]);
    expect(report.outOfScope).toEqual([{ key: 'MU-77', summary: '[WEB-FE][PORTAL][PROMO] - Banner', status: 'In Progress', codename: 'PROMO', mrs: ['payments/core-payment!12'], commits: ['MU-77 banner promo'] }]);
    expect(report.scope).toMatchObject({ tickets: 3, inCode: 3, carried: 1, matched: false });
    expect(report.mrs[0]).toMatchObject({ envAdded: ['REFUND_LIMIT'], approvals: { count: 1 } });
    expect(release.items.map((i) => [i.kind, i.label, i.service])).toEqual([
      ['env', 'REFUND_LIMIT', 'core-payment'],
      ['env', 'REFUND_LIMIT', 'MOBILE-APP'],
    ]);
    expect(await m.report(r.id)).toMatchObject({ releaseId: r.id });

    // Discovering again adds nothing twice, and checking keeps the done marks.
    expect((await m.discover(r.id)).addedMrs).toBe(0);
    await m.store.save({ ...release, items: release.items.map((i) => ({ ...i, done: true })) });
    expect((await m.check(r.id)).release.items.every((i) => i.done)).toBe(true);
  });

  it('plans a release MR: compare, findings, tickets, carried keys and the GitLab form', async () => {
    const m = manager({
      gitlabBaseUrl: async () => GL,
      gitlab: async () => ({
        mrsToBranch: async () => [],
        mr: async () => detail(summary('payments/core-payment', 12)),
        tokenScopes: async () => ['read_api'],
        branchExists: async (_p, b) => b !== 'nope',
        openMrFor: async () => undefined,
        compare: async () => ({
          commits: [
            { id: '1', shortId: 'a1', title: 'MU-12 refund api', authorName: 'Budi', createdAt: '' },
            { id: '2', shortId: 'b2', title: 'MU-77 banner promo', authorName: 'Budi', createdAt: '' },
          ],
          changes: [{ oldPath: '.env.example', newPath: '.env.example', newFile: false, renamedFile: false, deletedFile: false, diff: '+REFUND_LIMIT=5', additions: 1, deletions: 0 }],
          truncated: false,
        }),
        createMr: async (path, req) => summary(path, 40, { title: req.title, sourceBranch: req.source }),
      }),
    });
    const r = await m.store.save({ name: 'Switching', projectIds: ['p1'], services: [{ id: 's1', name: 'core-payment', gitlabPath: 'payments/core-payment', mrs: [], order: 1 }] } as never);
    const plan = await m.mrPlan(r.id, 's1');
    expect(plan).toMatchObject({ sourceBranch: 'staging', targetBranch: 'master', canCreate: false, files: 1, findings: { envAdded: ['REFUND_LIMIT'] }, tickets: [{ key: 'MU-12', inSource: true }] });
    expect(plan.outOfScope.map((o) => o.key)).toEqual(['MU-77']);
    expect(plan.warnings.some((w) => w.includes('MU-77'))).toBe(true);
    expect(plan.formUrl).toContain(`${GL}/payments/core-payment/-/merge_requests/new?`);
    expect(decodeURIComponent(plan.formUrl)).toContain('merge_request[target_branch]=master');
    expect(plan.description).toContain('- [ ] Env baru `REFUND_LIMIT` sudah diset di server');

    expect((await m.mrPlan(r.id, 's1', 'nope')).warnings).toContain('Branch nope tidak ada di payments/core-payment.');
    await expect(m.createMr(r.id, 's1', { sourceBranch: 'master', title: 'x', description: '' })).rejects.toThrow(/sama dengan branch target/);
    const created = await m.createMr(r.id, 's1', { sourceBranch: 'staging', title: plan.title, description: plan.description });
    expect(created).toMatchObject({ created: true, ref: 'payments/core-payment!40' });
    expect(created.release.services[0].mrs.map((x) => x.ref)).toEqual(['payments/core-payment!40']);
  });

  it('reports a missing GitLab connection instead of failing', async () => {
    const m = manager({ gitlab: async () => null });
    const r = await m.store.save({ name: 'X', projectIds: ['p1'] } as never);
    expect((await m.discover(r.id)).warnings).toContain('GitLab belum terhubung: MR tidak bisa dicari.');
  });

  it('imports a document and shares only release MRs to Teams', async () => {
    const m = manager();
    const r = await m.store.save({ name: 'Rilis' } as never);
    const imported = await m.importDoc(r.id, `# Rilis v2.4.0\n\n| Service | MR |\n| --- | --- |\n| core-payment | ${GL}/payments/core-payment/-/merge_requests/12 |\n`, { kind: 'markdown', title: 'rilis.md' });
    expect(imported.services[0].mrs[0].ref).toBe('payments/core-payment!12');
    await expect(m.importDoc(r.id, '  ', { kind: 'markdown', title: 'x' })).rejects.toThrow(/kosong/);

    await expect(m.share(r.id, { id: 'chat-1', name: 'Tim Payment' }, { mrRefs: ['other/repo!1'] })).rejects.toThrow(/minimal satu MR/);
    const preview = await m.sharePreview(r.id, { mrRefs: ['payments/core-payment!12'], deadline: 'Kamis' });
    expect(preview.text).toContain('review sebelum Kamis');
    const shared = await m.share(r.id, { id: 'chat-1', name: 'Tim Payment' }, { mrRefs: ['payments/core-payment!12'] });
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('chat-1');
    expect(sent[0].html).toContain('payments/core-payment!12');
    expect(shared).toMatchObject({ status: 'review', teamsChat: { id: 'chat-1', name: 'Tim Payment' }, shares: [{ chatName: 'Tim Payment', mrRefs: ['payments/core-payment!12'] }] });
  });
});

describe('connector /releases routes', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';
  const audits: { action: string; result: string }[] = [];
  let teamsFails = false;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-rel-routes-'));
    const releases = new ReleaseManager({
      store: new ReleaseStore(join(dir, 'releases')),
      reportDir: join(dir, 'reports'),
      gitlab: async () => null,
      jiraSearch: async () => [],
      projects: async () => [],
      drafts: async () => [],
      repoPaths: async () => ({}),
      teamsSend: async () => {
        if (teamsFails) throw new Error('Microsoft Teams belum terhubung.');
      },
    });
    const handler = connectorMiddleware({}, { readToken: async () => null, appendAudit: async (e) => void audits.push({ action: e.action, result: e.result }), readAudit: async () => [], logError: () => {}, releases: () => releases });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path: string, json?: unknown) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
    });

  it('creates, imports, previews, shares (audited) and deletes a release', async () => {
    expect((await call('/releases', { release: { name: '' } })).status).toBe(400);
    const r = await (await call('/releases', { release: { name: 'Rilis Oktober' } })).json();
    expect((await call('/releases/one?id=nope')).status).toBe(400);
    const imported = await (await call('/releases/import', { id: r.id, markdown: `| Service | MR |\n| --- | --- |\n| core | ${GL}/a/core/-/merge_requests/2 |`, source: { kind: 'markdown', title: 'doc.md' } })).json();
    expect(imported.services[0].mrs[0].ref).toBe('a/core!2');
    expect(await (await call('/releases/report?id=' + r.id)).json()).toEqual({ report: null });

    const preview = await (await call('/releases/share/preview', { id: r.id, mrRefs: ['a/core!2'] })).json();
    expect(preview.html).toContain('a/core!2');

    teamsFails = true;
    expect((await call('/releases/share', { id: r.id, chatId: 'c1', chatName: 'Grup', mrRefs: ['a/core!2'] })).status).toBe(502);
    teamsFails = false;
    const shared = await (await call('/releases/share', { id: r.id, chatId: 'c1', chatName: 'Grup', mrRefs: ['a/core!2'] })).json();
    expect(shared.shares).toHaveLength(1);
    expect(audits).toEqual([
      { action: 'teams.send', result: 'failure' },
      { action: 'teams.send', result: 'success' },
    ]);

    const checked = await (await call('/releases/check', { id: r.id })).json();
    expect(checked.report.mrs[0].error).toBe('GitLab belum terhubung.');
    expect(await (await call('/releases/delete', { id: r.id })).json()).toEqual([]);
  });
});
