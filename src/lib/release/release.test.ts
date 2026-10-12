import { describe, expect, it } from 'vitest';
import type { MrDetail, MrFileChange } from '../gitlab/types';
import { planReleaseBranch, releaseBranchCommands, releaseBranchName } from './branch';
import { checkMr, envAddedIn, envReadsIn, isMigration, jiraKeysIn } from './checks';
import { buildReport, codeKeys, matchesCodename, sameService, ticketService, ticketTags, type ReleaseTicket } from './coverage';
import { releaseMarkdown } from './document';
import { mergeReleaseDoc, mrRefFromUrl, parseReleaseDoc } from './import';
import { shareMessageHtml, shareMessageText } from './share';
import type { MrCheck, Release } from './types';

const change = (newPath: string, diff: string, extra: Partial<MrFileChange> = {}): MrFileChange => ({ oldPath: newPath, newPath, newFile: false, renamedFile: false, deletedFile: false, diff, additions: 1, deletions: 0, ...extra });

const mr = (over: Partial<MrDetail> = {}): MrDetail =>
  ({
    ref: 'payments/core-payment!12',
    projectId: 1,
    projectPath: 'payments/core-payment',
    iid: 12,
    title: 'Release 2.4.0',
    state: 'opened',
    draft: false,
    author: { id: 1, username: 'budi', name: 'Budi' },
    sourceBranch: 'staging',
    targetBranch: 'master',
    webUrl: 'https://gitlab.example.com/payments/core-payment/-/merge_requests/12',
    createdAt: '',
    updatedAt: '',
    description: '',
    reviewers: [],
    assignees: [],
    labels: [],
    commits: [],
    changes: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    jiraKeys: [],
    risks: [],
    diffTruncated: false,
    ...over,
  }) as MrDetail;

const release = (over: Partial<Release> = {}): Release => ({
  id: 'r1',
  name: 'Switching',
  version: 'v2.4.0',
  date: '2026-10-20',
  status: 'draft',
  targetBranch: 'master',
  sourceBranch: 'staging',
  minApprovals: 1,
  projectIds: [],
  codenames: [],
  jiraKeys: [],
  services: [],
  items: [],
  steps: [],
  shares: [],
  accepted: [],
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '',
  ...over,
});

describe('MR checks', () => {
  it('finds env names added to .env-like files, not changed values', () => {
    expect(envAddedIn(['+PAYMENT_TIMEOUT_MS=3000', '+export SWITCH_URL=https://x', '-OLD_KEY=1', '+OLD_KEY=2', '+# comment'].join('\n'))).toEqual(['PAYMENT_TIMEOUT_MS', 'SWITCH_URL']);
  });

  it('finds env reads in Go, Node, Python, PHP, Java and config files, ignoring moved lines', () => {
    expect(envReadsIn('main.go', '+	url := os.Getenv("SWITCH_URL")\n+	cfg.Key = os.LookupEnv("API_KEY")')).toEqual(['SWITCH_URL', 'API_KEY']);
    expect(envReadsIn('a.ts', "+const t = process.env.TIMEOUT_MS ?? process.env['RETRY_MAX'];")).toEqual(['TIMEOUT_MS', 'RETRY_MAX']);
    expect(envReadsIn('a.py', '+x = os.getenv("DB_HOST")\n+y = os.environ["DB_PORT"]')).toEqual(['DB_HOST', 'DB_PORT']);
    expect(envReadsIn('a.php', "+$k = env('MIDTRANS_KEY');")).toEqual(['MIDTRANS_KEY']);
    expect(envReadsIn('A.java', '+String s = System.getenv("JWT_SECRET");')).toEqual(['JWT_SECRET']);
    expect(envReadsIn('config/app.yml', '+  url: ${SWITCH_URL:http://localhost}')).toEqual(['SWITCH_URL']);
    expect(envReadsIn('cfg.go', '+	Timeout int `env:"SWITCH_TIMEOUT"`')).toEqual(['SWITCH_TIMEOUT']);
    // A line that only moved is not a new read.
    expect(envReadsIn('main.go', '-x := os.Getenv("SAME")\n+x := os.Getenv("SAME")')).toEqual([]);
    // ${VAR} in code is template text, not an env read.
    expect(envReadsIn('a.ts', '+const s = `${USER_NAME}`;')).toEqual([]);
  });

  it('recognises migration files', () => {
    expect(isMigration('db/migrations/20261012_add_refund.up.sql')).toBe(true);
    expect(isMigration('src/main/resources/db/V3__refund.sql')).toBe(true);
    expect(isMigration('database/migrations/2026_10_12_000000_create_refunds.php')).toBe(true);
    expect(isMigration('scripts/fix_data.sql')).toBe(false);
  });

  it('summarises what an MR brings to the server', () => {
    const c = checkMr(
      mr({
        commits: [
          { id: '1', shortId: '1', title: 'MU-12 refund endpoint', authorName: 'Budi', createdAt: '' },
          { id: '2', shortId: '2', title: 'fix typo', authorName: 'Budi', createdAt: '' },
          { id: '3', shortId: '3', title: "Merge branch 'feature/MU-13' into 'staging'", authorName: 'Budi', createdAt: '' },
        ],
        changes: [
          change('.env.example', '+REFUND_LIMIT=5\n+SWITCH_URL='),
          change('internal/refund/handler.go', '+	limit := os.Getenv("REFUND_LIMIT")\n+	key := os.Getenv("REFUND_SIGNING_KEY")'),
          change('scripts/backfill_refund.sql', '+UPDATE refunds SET status = 1;', { newFile: true }),
          change('internal/models/refund.go', '+	Reason string'),
          change('tests/fixtures/seed.sql', '+INSERT 1'),
          change('old.sql', '', { deletedFile: true }),
        ],
        approvals: { approved: false, approvedBy: ['Citra'], required: 1, left: 0 },
        pipeline: { id: 1, status: 'success' },
      }),
    );
    expect(c).toMatchObject({
      envAdded: ['REFUND_LIMIT', 'SWITCH_URL'],
      envReadInCode: ['REFUND_SIGNING_KEY'],
      migrations: [],
      sqlOutside: ['scripts/backfill_refund.sql'],
      modelWithoutMigration: ['internal/models/refund.go'],
      commitsWithoutKey: ['fix typo'],
      approvals: { count: 1, by: ['Citra'], required: 1 },
      pipeline: 'success',
      diffTruncated: false,
    });
    expect(c.jiraKeys.sort()).toEqual(['MU-12', 'MU-13']);
    // With a migration in the MR, model changes are expected.
    const withMigration = checkMr(mr({ changes: [change('internal/models/refund.go', '+x'), change('db/migrations/0002_refund.up.sql', '+ALTER', { newFile: true }), change('db/migrations/0001_init.up.sql', '+x')] }));
    expect(withMigration.modelWithoutMigration).toEqual([]);
    expect(withMigration.migrations).toEqual(['db/migrations/0002_refund.up.sql', 'db/migrations/0001_init.up.sql (migrasi lama diubah)']);
  });

  it('reads Jira keys but not look-alikes such as UTF-8', () => {
    expect(jiraKeysIn('MU-1 UTF-8 ISO-8601 SHA-256 PAY-22')).toEqual(['MU-1', 'PAY-22']);
  });
});

const DOC = `# Rilis Switching Management

Versi: v2.4.0
Tanggal: 20 Oktober 2026

## Service

| No | Service | MR | PIC |
| --- | --- | --- | --- |
| 1 | core-payment | https://gitlab.example.com/payments/core-payment/-/merge_requests/12 | Budi |
| 2 | Mobile App | [MR](https://gitlab.example.com/mobile/app/-/merge_requests/7) | Dewi |

## Konfigurasi Env

- \`SWITCH_URL\` diisi URL partner
- PAYMENT_TIMEOUT_MS=3000

## Query

\`\`\`sql
ALTER TABLE refunds ADD COLUMN reason TEXT;
\`\`\`

## Langkah Deploy

1. Deploy core-payment
2. Jalankan migrasi
3. Deploy mobile app ke store

## Rollback

- Revert tag v2.3.9

Tiket: MU-12, MU-13. Encoding UTF-8.
`;

describe('release document import', () => {
  it('reads version, date, services, MRs, tickets, env, SQL and steps from a document', () => {
    const d = parseReleaseDoc(DOC);
    expect(d).toMatchObject({ title: 'Rilis Switching Management', version: '2.4.0', date: '2026-10-20', jiraKeys: ['MU-12', 'MU-13'], deploySteps: ['Deploy core-payment', 'Jalankan migrasi', 'Deploy mobile app ke store'], rollbackSteps: ['Revert tag v2.3.9'] });
    expect(d.mrs.map((m) => `${m.projectPath}!${m.iid}`)).toEqual(['payments/core-payment!12', 'mobile/app!7']);
    expect(d.services).toEqual([
      { name: 'core-payment', pic: 'Budi', order: 1, mrUrls: ['https://gitlab.example.com/payments/core-payment/-/merge_requests/12'] },
      { name: 'Mobile App', pic: 'Dewi', order: 2, mrUrls: ['https://gitlab.example.com/mobile/app/-/merge_requests/7'] },
    ]);
    expect(d.env.sort()).toEqual(['PAYMENT_TIMEOUT_MS', 'SWITCH_URL']);
    expect(d.sql).toEqual([{ label: 'ALTER TABLE refunds ADD COLUMN reason TEXT;', text: 'ALTER TABLE refunds ADD COLUMN reason TEXT;' }]);
    expect(mrRefFromUrl('https://gitlab.example.com/a/b/c/-/merge_requests/3.')).toEqual({ projectPath: 'a/b/c', iid: 3, webUrl: 'https://gitlab.example.com/a/b/c/-/merge_requests/3' });
  });

  it('merges into a release without losing existing work', () => {
    const existing = release({
      version: '',
      services: [{ id: 's1', name: 'Core Payment', mrs: [], order: 1, pic: 'Andi' }],
      items: [{ id: 'i1', kind: 'env', label: 'SWITCH_URL', source: 'check', done: true }],
      steps: [{ id: 'st1', kind: 'deploy', text: 'Deploy core-payment', done: true }],
    });
    const merged = mergeReleaseDoc(existing, parseReleaseDoc(DOC), DOC, { kind: 'confluence', title: 'Rilis', pageId: '123' }, '2026-10-12T05:00:00Z');
    expect(merged.version).toBe('2.4.0');
    expect(merged.services.map((s) => [s.name, s.pic, s.mrs.map((m) => m.ref)])).toEqual([
      ['Core Payment', 'Andi', ['payments/core-payment!12']],
      ['Mobile App', 'Dewi', ['mobile/app!7']],
    ]);
    expect(merged.items.find((i) => i.label === 'SWITCH_URL')).toMatchObject({ done: true, source: 'check' });
    expect(merged.items.filter((i) => i.kind === 'sql')).toHaveLength(1);
    expect(merged.steps.filter((s) => s.kind === 'deploy').map((s) => [s.text, s.done])).toEqual([
      ['Deploy core-payment', true],
      ['Jalankan migrasi', false],
      ['Deploy mobile app ke store', false],
    ]);
    expect(merged.source).toMatchObject({ kind: 'confluence', pageId: '123', importedAt: '2026-10-12T05:00:00Z' });
    // Importing again adds nothing twice.
    const again = mergeReleaseDoc(merged, parseReleaseDoc(DOC), DOC, { kind: 'confluence', title: 'Rilis' });
    expect(again.items).toHaveLength(merged.items.length);
    expect(again.services.flatMap((s) => s.mrs)).toHaveLength(2);
  });
});

const check = (over: Partial<MrCheck> = {}): MrCheck => ({
  ref: 'payments/core-payment!12',
  title: 'Release',
  webUrl: 'https://gitlab.example.com/payments/core-payment/-/merge_requests/12',
  state: 'opened',
  draft: false,
  sourceBranch: 'staging',
  targetBranch: 'master',
  author: 'Budi',
  pipeline: 'success',
  approvals: { count: 1, by: ['Citra'] },
  envAdded: [],
  envReadInCode: [],
  migrations: [],
  sqlOutside: [],
  modelWithoutMigration: [],
  commitsWithoutKey: [],
  jiraKeys: ['MU-12'],
  keyCommits: { 'MU-12': ['MU-12 refund'] },
  diffTruncated: false,
  ...over,
});

describe('release report', () => {
  it('matches services and codenames loosely', () => {
    expect(sameService('core-payment', 'Core Payment')).toBe(true);
    expect(sameService('core-payment-service', 'core-payment')).toBe(true);
    expect(sameService('app', 'mobile-app-backend')).toBe(false);
    // Two repos that share a prefix are two services.
    expect(sameService('CORE-TCICO', 'CORE-TCICO-ULTIMATE')).toBe(false);
    expect(sameService('core-payment-api', 'Core Payment')).toBe(true);
    expect(matchesCodename('[BACKEND][CORE-PAYMENT][SWITCHING] - Refund', ['switching'])).toBe(true);
    expect(matchesCodename('Refund switching', ['SWITCHING'])).toBe(false);
    // Mobile layout: [PLATFORM][CODENAME][KIND] Name, no dash.
    expect(matchesCodename('[IOS][SWITCHING][UI] Membuat Halaman Topup', ['switching'])).toBe(true);
    expect(ticketService('[IOS][SWITCHING][UI] Membuat Halaman Topup', ['SWITCHING'])).toBe('IOS');
    expect(ticketService('[ANDROID][SWITCHING][API] Integrasi API', ['SWITCHING'])).toBe('ANDROID');
    expect(ticketService('[BACKEND][CORE-TCICO][SWITCHING] - Enhance API', ['SWITCHING'])).toBe('CORE-TCICO');
    expect(ticketService('[BACKEND][CORE-TCICO][SWITCHING] - Enhance API')).toBe('CORE-TCICO');
    expect(ticketTags('[A] [B][C] judul')).toEqual(['A', 'B', 'C']);
  });

  it('flags missing tickets, services without an MR, bad titles and MR blockers', () => {
    const r = release({ minApprovals: 2, services: [{ id: 's1', name: 'core-payment', mrs: [{ ref: 'payments/core-payment!12', projectPath: 'payments/core-payment', iid: 12, webUrl: 'u', via: 'auto' }], order: 1 }] });
    const tickets: ReleaseTicket[] = [
      { key: 'MU-12', summary: '[BACKEND][CORE-PAYMENT][SWITCHING] - Refund', status: 'READY TO TEST', statusCategory: 'indeterminate', service: 'core-payment', from: 'tad' },
      { key: 'MU-13', summary: '[MOBILE-FE][MOBILE-APP][SWITCHING] - Layar refund', status: 'In Progress', statusCategory: 'indeterminate', from: 'codename' },
      { key: 'MU-14', summary: 'perbaiki refund', status: 'To Do', statusCategory: 'new', from: 'release' },
    ];
    const rep = buildReport(r, tickets, [check({ hasConflicts: true, pipeline: 'failed' })], '2026-10-12T00:00:00Z');
    expect(rep.tickets.map((t) => [t.key, t.inMrs, t.devDone, t.service])).toEqual([
      ['MU-12', ['payments/core-payment!12'], true, 'core-payment'],
      ['MU-13', [], false, 'MOBILE-APP'],
      ['MU-14', [], false, undefined],
    ]);
    expect(rep.servicesWithoutMr).toEqual(['MOBILE-APP']);
    expect(rep.badTitles).toEqual([{ key: 'MU-14', summary: 'perbaiki refund' }]);
    expect(rep.warnings).toEqual([
      'payments/core-payment!12 punya konflik dengan master.',
      'payments/core-payment!12: pipeline failed.',
      'payments/core-payment!12: 1/2 approval.',
      '2 tiket scope belum ada di kode MR rilis mana pun.',
      '2 tiket belum selesai development di Jira.',
      'Service MOBILE-APP belum punya MR ke master.',
    ]);
  });
});

describe('scope check against the code', () => {
  const r = release({ services: [{ id: 's1', name: 'core-payment', mrs: [{ ref: 'payments/core-payment!12', projectPath: 'payments/core-payment', iid: 12, webUrl: 'u', via: 'auto' }], order: 1 }] });
  const scopeTickets: ReleaseTicket[] = [
    { key: 'MU-12', summary: '[BACKEND][CORE-PAYMENT][SWITCHING] - Refund', status: 'READY TO TEST', statusCategory: 'indeterminate', service: 'core-payment', from: 'tad' },
    { key: 'MU-13', summary: '[BACKEND][CORE-PAYMENT][SWITCHING] - Limit', status: 'READY TO TEST', statusCategory: 'indeterminate', service: 'core-payment', from: 'tad' },
  ];

  it('counts only keys in commits and the source branch, not the MR description', () => {
    const c = check({ jiraKeys: ['MU-12', 'MU-13'], keyCommits: { 'MU-12': ['MU-12 refund'] }, sourceBranch: 'staging' });
    expect(codeKeys(c)).toEqual(['MU-12']);
    expect(codeKeys(check({ keyCommits: {}, sourceBranch: 'feature/MU-13-limit' }))).toEqual(['MU-13']);
    const rep = buildReport(r, scopeTickets, [c]);
    expect(rep.tickets.find((t) => t.key === 'MU-13')!.inMrs).toEqual([]);
    expect(rep.scope).toMatchObject({ tickets: 2, inCode: 1, missing: 1, matched: false });
  });

  it('reports tickets carried along outside the scope, unless accepted on purpose', () => {
    const c = check({ keyCommits: { 'MU-12': ['MU-12 refund'], 'MU-13': ['MU-13 limit'], 'MU-50': ["Merge branch 'feature/MU-50-promo' into 'staging'", 'MU-50 promo'] } });
    const extra = new Map([['MU-50', { summary: '[BACKEND][CORE-PAYMENT][PROMO] - Diskon', status: 'In Progress' }]]);
    const rep = buildReport(r, scopeTickets, [c], '2026-10-12T00:00:00Z', extra);
    expect(rep.outOfScope).toEqual([{ key: 'MU-50', summary: '[BACKEND][CORE-PAYMENT][PROMO] - Diskon', status: 'In Progress', codename: 'PROMO', mrs: ['payments/core-payment!12'], commits: ["Merge branch 'feature/MU-50-promo' into 'staging'", 'MU-50 promo'] }]);
    expect(rep.scope).toMatchObject({ inCode: 2, missing: 0, carried: 1, matched: false });
    expect(rep.warnings).toContain('1 tiket di luar scope ikut terbawa: MU-50.');

    const accepted = buildReport({ ...r, accepted: [{ key: 'MU-50', note: 'hotfix ikut', at: '' }] }, scopeTickets, [c], '', extra);
    expect(accepted.outOfScope).toEqual([]);
    expect(accepted.scope).toMatchObject({ carried: 0, accepted: 1, matched: true });
  });

  it('is not matched while commits have no Jira key, and ignores closed MRs', () => {
    const rep = buildReport(r, scopeTickets, [check({ keyCommits: { 'MU-12': ['a'], 'MU-13': ['b'] }, commitsWithoutKey: ['fix typo'] })]);
    expect(rep.scope).toMatchObject({ commitsWithoutKey: 1, matched: false });
    expect(rep.warnings).toContain('1 commit tanpa Jira key: scope-nya tidak bisa dipastikan.');
    const closed = buildReport(r, scopeTickets, [check({ state: 'closed', keyCommits: { 'MU-99': ['x'] } })]);
    expect(closed.outOfScope).toEqual([]);
  });
});

describe('release MR title', () => {
  it("follows the team's format and a per-release template", async () => {
    const { mrTitle } = await import('./mr');
    const svc = { id: 's', name: 'core-auth', mrs: [], order: 1 };
    expect(mrTitle(release({ name: 'Cashin Toko' }), svc)).toBe('[MASTER] - Cashin Toko');
    expect(mrTitle(release({ name: 'Cashin Toko', targetBranch: 'main' }), svc)).toBe('[MAIN] - Cashin Toko');
    expect(mrTitle(release({ name: 'Cashin Toko', version: 'v2.4.0', codenames: ['CASHIN-TOKO'], mrTitleTemplate: '[{TARGET}][{SERVICE}] {CODENAME} {VERSION}' }), svc)).toBe('[MASTER][core-auth] CASHIN-TOKO v2.4.0');
    // An empty placeholder at the end leaves no dangling separator.
    expect(mrTitle(release({ name: 'Cashin Toko', version: '', mrTitleTemplate: '[{TARGET}] - {RELEASE} - {VERSION}' }), svc)).toBe('[MASTER] - Cashin Toko');
    expect(mrTitle(release({ name: 'Cashin Toko', mrTitleTemplate: '[{TARGET}] - {RELEASE} - {VERSION}' }), svc)).toBe('[MASTER] - Cashin Toko - v2.4.0');
  });
});

describe('release branch plan', () => {
  // staging (first parent, oldest → newest):
  //   m1 = merge feature/MU-12 (commits f1 "refund api", f2 "fix") → in scope
  //   d1 = direct "MU-50 banner promo"                         → out of scope
  //   m2 = merge feature/MU-13 + MU-60 (f3 "MU-13 limit", f4 "MU-60 promo") → mixed
  //   d2 = "hotfix typo"                                        → no key
  //   m3 = merge feature/MU-14 (f5 "wip")                       → in scope by the merge title
  const c = (id: string, title: string, parentIds: string[], createdAt: string) => ({ id, shortId: id, title, authorName: 'x', createdAt, parentIds });
  const commits = [
    c('m3', "Merge branch 'feature/MU-14-report' into 'staging'", ['d2', 'f5'], '2026-10-10T09:00:00Z'),
    c('f5', 'wip', ['base'], '2026-10-10T08:00:00Z'),
    c('d2', 'hotfix typo', ['m2'], '2026-10-09T09:00:00Z'),
    c('m2', "Merge branch 'feature/limit' into 'staging'", ['d1', 'f4'], '2026-10-08T09:00:00Z'),
    c('f4', 'MU-60 promo', ['f3'], '2026-10-08T08:00:00Z'),
    c('f3', 'MU-13 limit', ['base'], '2026-10-08T07:00:00Z'),
    c('d1', 'MU-50 banner promo', ['m1'], '2026-10-07T09:00:00Z'),
    c('m1', "Merge branch 'feature/MU-12-refund' into 'staging'", ['base', 'f2'], '2026-10-06T09:00:00Z'),
    c('f2', 'fix', ['f1'], '2026-10-06T08:00:00Z'),
    c('f1', 'refund api', ['base'], '2026-10-06T07:00:00Z'),
  ];

  it('walks the first-parent line oldest first and judges each merge with what it brought in', () => {
    const plan = planReleaseBranch(commits, new Set(['MU-12', 'MU-13', 'MU-14']), { base: 'master', branch: 'release/v2.4.0' });
    expect(plan.commits.map((p) => [p.sha, p.merge, p.include, p.reason ?? '', p.keys.join(',')])).toEqual([
      ['m1', true, true, '', 'MU-12'],
      ['d1', false, false, 'out-of-scope', 'MU-50'],
      ['m2', true, false, 'mixed', 'MU-13,MU-60'],
      ['d2', false, false, 'no-key', ''],
      ['m3', true, true, '', 'MU-14'],
    ]);
    expect(plan.commits[2].outsideKeys).toEqual(['MU-60']);
  });

  it('gives terminal commands with -m 1 for merges, and a branch name', () => {
    const plan = planReleaseBranch(commits, new Set(['MU-12', 'MU-14']), { base: 'master', branch: 'release/v2.4.0' });
    const cmd = releaseBranchCommands(plan, plan.commits.filter((p) => p.include));
    expect(cmd.split('\n')).toEqual([
      'git fetch origin',
      'git checkout -b release/v2.4.0 origin/master',
      "git cherry-pick -m 1 m1   # Merge branch 'feature/MU-12-refund' into 'staging'",
      "git cherry-pick -m 1 m3   # Merge branch 'feature/MU-14-report' into 'staging'",
      'git push -u origin release/v2.4.0',
    ]);
    expect(releaseBranchName({ version: '', codenames: ['CASHIN-TOKO'], name: 'Rilis' })).toBe('release/cashin-toko');
    expect(releaseBranchName({ version: 'v2.4.0', codenames: ['CASHIN-TOKO'], name: 'Rilis' })).toBe('release/cashin-toko-v2.4.0');
    expect(releaseBranchName({ version: 'v2.4.0', codenames: [], name: 'Rilis' })).toBe('release/v2.4.0');
    expect(releaseBranchName({ version: '', codenames: [], name: 'Rilis Oktober' })).toBe('release/rilis-oktober');
  });
});

describe('share message and document', () => {
  const r = release({
    services: [
      { id: 's2', name: 'mobile-app', mrs: [{ ref: 'mobile/app!7', projectPath: 'mobile/app', iid: 7, webUrl: 'https://gitlab.example.com/mobile/app/-/merge_requests/7', title: 'Layar <refund>', via: 'auto' }], order: 2 },
      { id: 's1', name: 'core-payment', mrs: [{ ref: 'payments/core-payment!12', projectPath: 'payments/core-payment', iid: 12, webUrl: 'https://gitlab.example.com/payments/core-payment/-/merge_requests/12', via: 'auto' }], order: 1 },
    ],
  });
  const checks = [check({ envAdded: ['A_B'], migrations: ['db/migrations/1.sql'], title: 'Release <script>' })];

  it('builds an escaped HTML message in deploy order with what each MR brings', () => {
    const html = shareMessageHtml(r, checks, { mrRefs: ['mobile/app!7', 'payments/core-payment!12'], deadline: 'Kamis 16.00', reviewers: ['Citra & Dewi'], note: 'Cek <b>migrasi</b>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('Release &lt;script&gt;');
    expect(html).toContain('<b>Citra &amp; Dewi</b>');
    expect(html).toContain('Cek &lt;b&gt;migrasi&lt;/b&gt;');
    expect(html.indexOf('core-payment')).toBeLessThan(html.indexOf('mobile-app'));
    expect(html).toContain('1 env baru, 1 migrasi');
    expect(html).toContain('<a href="https://gitlab.example.com/payments/core-payment/-/merge_requests/12">payments/core-payment!12</a>');
    const text = shareMessageText(r, checks, { mrRefs: ['payments/core-payment!12'], reminder: true });
    expect(text.split('\n')[0]).toBe('Pengingat review MR rilis: Switching v2.4.0');
    expect(text).not.toContain('mobile/app');
  });

  it('renders the release document in the deployment layout', () => {
    const md = releaseMarkdown({ ...r, items: [{ id: 'i', kind: 'env', label: 'A_B', service: 'core-payment', source: 'check', done: true }], steps: [{ id: 's', kind: 'rollback', text: 'Revert tag', service: 'core-payment', done: false }] }, null);
    expect(md).toContain('# Deployment 20 Oktober 2026');
    expect(md).toContain('> 1. core-payment');
    expect(md).toContain('- [x] Update .env');
    expect(md).toContain('A_B=');
    expect(md).toContain('**Failover Strategy**: Revert tag');
    expect(md).toContain('## 💣 Post Deployment issues');
  });
});
