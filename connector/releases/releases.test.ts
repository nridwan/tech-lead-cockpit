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
    // Env found in the code goes straight into each service's .env block of the document.
    expect(release.items).toEqual([]);
    expect(release.services.map((s) => [s.name, s.envBlock])).toEqual([
      ['core-payment', 'REFUND_LIMIT='],
      ['MOBILE-APP', 'REFUND_LIMIT='],
    ]);
    expect(await m.report(r.id)).toMatchObject({ releaseId: r.id });

    // Discovering again adds nothing twice; checking again keeps a value typed in the .env block.
    expect((await m.discover(r.id)).addedMrs).toBe(0);
    await m.store.save({ ...release, services: release.services.map((s) => ({ ...s, envBlock: 'REFUND_LIMIT=5' })) });
    expect((await m.check(r.id)).release.services[0].envBlock).toBe('REFUND_LIMIT=5');
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
    // The changed files come with their diff, for review before the MR exists.
    expect(plan.changes.map((c) => [c.newPath, c.diff])).toEqual([['.env.example', '+REFUND_LIMIT=5']]);
    expect(plan.warnings.some((w) => w.includes('MU-77'))).toBe(true);
    expect(plan.formUrl).toContain(`${GL}/payments/core-payment/-/merge_requests/new?`);
    expect(decodeURIComponent(plan.formUrl)).toContain('merge_request[target_branch]=master');
    expect(plan.description).toContain('- Env baru `REFUND_LIMIT` sudah diset di server');

    expect((await m.mrPlan(r.id, 's1', 'nope')).warnings).toContain('Branch nope tidak ada di payments/core-payment.');
    await expect(m.createMr(r.id, 's1', { sourceBranch: 'master', title: 'x', description: '' })).rejects.toThrow(/sama dengan branch target/);
    const created = await m.createMr(r.id, 's1', { sourceBranch: 'staging', title: plan.title, description: plan.description });
    expect(created).toMatchObject({ created: true, ref: 'payments/core-payment!40' });
    expect(created.release.services[0].mrs.map((x) => x.ref)).toEqual(['payments/core-payment!40']);
  });

  it('reads the code of a service without an MR from its source branch and finds tickets in it', async () => {
    // "Refund API" alone is one word; the TAD Detail Task's endpoint finds it.
    const tad = `${TAD}\n# Detail Task\n\n## [BACKEND][CORE-PAYMENT][SWITCHING] - Refund API\n\n#### Endpoint\nPOST /v1/payment/refund\n`;
    const m = manager({
      drafts: async () => [{ id: 'd1', markdown: tad }],
      gitlab: async () => ({
        mrsToBranch: async () => [],
        mr: async () => detail(summary('payments/core-payment', 12)),
        branchExists: async () => true,
        compare: async (_p, target, source) => ({
          commits: [{ id: '1', shortId: 'a1', title: 'feat: refund', authorName: 'Budi', createdAt: '' }],
          changes:
            source === 'release/switching' && target === 'master'
              ? [
                  { oldPath: 'api/refund.go', newPath: 'api/refund.go', newFile: true, renamedFile: false, deletedFile: false, diff: '+v1.POST("/payment/refund", RefundApi)\n+func RetryRefund() {}', additions: 2, deletions: 0 },
                  { oldPath: 'api/promo.go', newPath: 'promo/banner.go', newFile: true, renamedFile: false, deletedFile: false, diff: '+func Banner() {}', additions: 1, deletions: 0 },
                ]
              : [],
          truncated: false,
        }),
      }),
    });
    const r = await m.store.save({
      name: 'Switching',
      projectIds: ['p1'],
      services: [
        { id: 's1', name: 'core-payment', gitlabPath: 'payments/core-payment', sourceBranch: 'release/switching', mrs: [], order: 1 },
        { id: 's2', name: 'core-ledger', gitlabPath: 'payments/core-ledger', mrs: [], order: 2 },
      ],
    } as never);
    const { report } = await m.check(r.id);
    const ref = 'payments/core-payment@release/switching';
    // No commit carries a key: the tickets are found in the diff.
    expect(report.tickets.find((t) => t.key === 'MU-12')).toMatchObject({ inMrs: [ref], code: [{ ref, strength: 'strong', hits: [{ path: 'api/refund.go', match: '/payment/refund' }] }] });
    expect(report.sources).toEqual([
      { service: 'core-payment', ref, kind: 'branch', files: 2, unattributed: ['promo/banner.go'] },
      { service: 'core-ledger', ref: 'payments/core-ledger@staging', kind: 'branch', files: 0, unattributed: [] },
    ]);
    expect(report.warnings).toContain('core-ledger: staging tidak punya perubahan dibanding master.');
  });

  it('runs the AI check, pick and document fix in the background', async () => {
    const prompts: string[] = [];
    const replies: string[] = [];
    const runAi = (_ai: unknown, prompt: string) => {
      prompts.push(prompt);
      return { done: Promise.resolve({ reply: replies.shift() ?? '{}' }), cancel: () => {} };
    };
    const changes = [
      { oldPath: 'api/refund.go', newPath: 'api/refund.go', newFile: true, renamedFile: false, deletedFile: false, diff: '+func RefundApi() { db.Table("refund_logs") }', additions: 1, deletions: 0 },
      { oldPath: 'api/promo.go', newPath: 'api/promo.go', newFile: true, renamedFile: false, deletedFile: false, diff: '+func Promo() {}', additions: 1, deletions: 0 },
    ];
    const m = manager({
      runAi,
      gitlab: async () => ({
        mrsToBranch: async () => [],
        mr: async () => detail(summary('payments/core-payment', 12)),
        branchExists: async () => true,
        compare: async (_p, from, to) =>
          from === 'master'
            ? { commits: [{ id: 'c1c1c1c1aa', shortId: 'c1c1c1c1', title: 'refund', authorName: 'B', createdAt: '', parentIds: ['p0p0p0p0'] }, { id: 'c2c2c2c2bb', shortId: 'c2c2c2c2', title: 'promo', authorName: 'B', createdAt: '', parentIds: ['c1c1c1c1aa'] }], changes, truncated: false }
            : { commits: [], changes: [changes[to === 'c1c1c1c1aa' ? 0 : 1]], truncated: false },
      }),
    });
    const r = await m.store.save({ name: 'Switching', projectIds: ['p1'], services: [{ id: 's1', name: 'core-payment', gitlabPath: 'payments/core-payment', mrs: [], order: 1 }] } as never);
    const ai = { provider: 'claude' as const, model: 'x' };
    const settle = async (kind: 'tickets' | 'picks' | 'document', serviceId?: string) => {
      for (let i = 0; i < 50; i++) {
        const j = await m.aiJob(r.id, kind, serviceId);
        if (j && j.status !== 'running') return j;
        await new Promise((ok) => setTimeout(ok, 5));
      }
      throw new Error('job did not finish');
    };

    // Step one: the AI looks for services and MRs (nothing to add here).
    replies.push(JSON.stringify({ services: [], mrs: [] }));
    replies.push(
      JSON.stringify({
        tickets: [{ key: 'MU-12', verdict: 'ada', files: ['api/refund.go'], reason: 'RefundApi' }],
        unrelated: [{ path: 'api/promo.go', reason: 'promo bukan scope' }],
        needs: [
          { kind: 'sql', when: 'pre', label: 'Buat tabel refund_logs', detail: 'CREATE TABLE refund_logs (id bigint);', files: ['api/refund.go'] },
          { kind: 'env', when: 'pre', label: 'REFUND_MAX', files: [] },
          { kind: 'other', when: 'post', label: 'Smoke test refund', files: [] },
        ],
        risks: [{ path: 'api/promo.go', reason: 'kredensial di kode' }],
      }),
    );
    expect((await m.aiStart(r.id, 'tickets', { ai })).status).toBe('running');
    expect((await settle('tickets')).status).toBe('done');
    expect(prompts[0]).toContain('Tentukan service (repo) dan MR');
    expect(prompts[1]).toContain('MU-12');
    expect(prompts[1]).toContain('+func RefundApi()');
    const report = (await m.report(r.id))!;
    expect(report.ai?.model).toBe('claude/x');
    expect(report.tickets.find((t) => t.key === 'MU-12')).toMatchObject({ inMrs: ['payments/core-payment@staging'], ai: { verdict: 'ada' } });
    expect(report.sources?.[0].aiUnrelated).toEqual([{ path: 'api/promo.go', reason: 'promo bukan scope' }]);
    const saved = await m.get(r.id);
    // Straight into the document: the query in Pre-deploy, the env in the .env block.
    expect(saved.items.map((i) => [i.kind, i.label, i.source, i.detail])).toEqual([['sql', 'Buat tabel refund_logs', 'ai', 'CREATE TABLE refund_logs (id bigint);']]);
    expect(saved.services[0].envBlock).toBe('REFUND_MAX=');
    expect(saved.services[0].postDeploy).toEqual(['Smoke test refund']);
    expect(report.sources?.[0].aiRisks).toEqual([{ path: 'api/promo.go', reason: 'kredensial di kode' }]);

    // A second check replaces what the AI wrote before instead of piling up.
    replies.push(JSON.stringify({ services: [], mrs: [] }));
    replies.push(JSON.stringify({ tickets: [{ key: 'MU-12', verdict: 'ada', files: [], reason: 'x' }], needs: [{ kind: 'other', when: 'post', label: 'Cek log refund', files: [] }] }));
    await m.aiStart(r.id, 'tickets', { ai });
    await settle('tickets');
    const again = await m.get(r.id);
    expect(again.services[0].postDeploy).toEqual(['Cek log refund']);
    expect(again.items).toEqual([]);
    expect(again.services[0].envBlock).toBe('REFUND_MAX=');
    prompts.splice(1, 2);

    replies.push(JSON.stringify({ picks: [{ sha: 'c1c1c1c1aa', include: true, keys: ['MU-12'], reason: 'refund' }, { sha: 'c2c2c2c2', include: false, reason: 'promo' }], notes: [] }));
    await m.aiStart(r.id, 'picks', { ai, serviceId: 's1', sourceBranch: 'staging' });
    const picks = await settle('picks', 's1');
    expect(picks.picks?.map((p) => [p.sha, p.include])).toEqual([['c1c1c1c1aa', true], ['c2c2c2c2bb', false]]);
    // Each commit is read against its first parent.
    expect(prompts[2]).toContain('+func Promo() {}');

    replies.push(JSON.stringify({ services: [{ name: 'core-payment', envBlock: 'REFUND_MAX=' }], summary: ['REFUND_MAX ditambah'] }));
    // A document fix is only a proposal: the release does not change until the user applies it.
    const before = (await m.get(r.id)).services[0];
    await expect(m.aiStart(r.id, 'document', { ai })).rejects.toThrow(/instruksi/);
    await m.aiStart(r.id, 'document', { ai, instruction: 'lengkapi .env' });
    const doc = await settle('document');
    expect(doc.fixes).toEqual([{ serviceId: 's1', name: 'core-payment', envBlock: 'REFUND_MAX=' }]);
    expect(prompts[3]).toContain('Instruksi Tech Lead: lengkapi .env');
    expect((await m.get(r.id)).services[0]).toEqual(before);
  });

  it('creates a release branch from the target and stops at the first cherry-pick conflict', async () => {
    const calls: string[] = [];
    const m = manager({
      gitlab: async () => ({
        mrsToBranch: async () => [],
        mr: async () => detail(summary('payments/core-payment', 12)),
        branchExists: async (_p, b) => b === 'release/taken',
        createBranch: async (path, branch, ref) => void calls.push(`branch ${branch} from ${ref}`),
        cherryPick: async (_p, sha) => {
          if (sha === 'bbbbbbb') throw new Error('Sorry, we cannot cherry-pick this commit automatically.');
          calls.push(`pick ${sha}`);
          return { id: `new-${sha}` };
        },
      }),
    });
    const r = await m.store.save({ name: 'R', services: [{ id: 's1', name: 'core-payment', gitlabPath: 'payments/core-payment', mrs: [], order: 1 }] } as never);
    await expect(m.createReleaseBranch(r.id, 's1', { branch: 'release/taken', picks: [{ sha: 'aaaaaaa' }] })).rejects.toThrow(/sudah ada/);
    await expect(m.createReleaseBranch(r.id, 's1', { branch: 'master', picks: [{ sha: 'aaaaaaa' }] })).rejects.toThrow(/tidak valid/);
    const res = await m.createReleaseBranch(r.id, 's1', { branch: 'release/v2', picks: [{ sha: 'aaaaaaa' }, { sha: 'bbbbbbb', title: 'MU-13 limit' }, { sha: 'ccccccc' }] });
    expect(calls).toEqual(['branch release/v2 from master', 'pick aaaaaaa']);
    expect(res).toMatchObject({ branch: 'release/v2', picked: ['aaaaaaa'], failed: { sha: 'bbbbbbb', title: 'MU-13 limit' } });
    // The service now releases from the new branch.
    expect(res.release.services[0].sourceBranch).toBe('release/v2');
  });

  it('reports a missing GitLab connection instead of failing', async () => {
    const m = manager({ gitlab: async () => null });
    const r = await m.store.save({ name: 'X', projectIds: ['p1'] } as never);
    expect((await m.discover(r.id)).warnings).toContain('GitLab belum terhubung: MR tidak bisa dicari.');
  });

  it('imports a document and shares only release MRs to Teams', async () => {
    const m = manager();
    const r = await m.store.save({ name: 'Rilis' } as never);
    const doc = `# Rilis v2.4.0\n\n| Service | MR |\n| --- | --- |\n| core-payment | ${GL}/payments/core-payment/-/merge_requests/12 |\n`;
    // A service the release does not have is left out unless chosen.
    expect((await m.importDoc(r.id, doc, { kind: 'markdown', title: 'rilis.md' })).services).toEqual([]);
    const imported = await m.importDoc(r.id, doc, { kind: 'markdown', title: 'rilis.md' }, undefined, { addServices: ['core-payment'] });
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
    const imported = await (await call('/releases/import', { id: r.id, markdown: `| Service | MR |\n| --- | --- |\n| core | ${GL}/a/core/-/merge_requests/2 |`, source: { kind: 'markdown', title: 'doc.md' }, addServices: ['core'] })).json();
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
