import { describe, expect, it } from 'vitest';
import type { MrFileChange } from '../gitlab/types';
import { taskEndpoints } from '../tad/task-links';
import { jiraKeysIn } from './checks';
import { belongsTo, buildReport, codeKeys, forCurrentServices, type ReleaseTicket } from './coverage';
import { endpointVariants, findEvidence, indexChanges, ticketTerms, unattributedFiles, withSharedEndpoints } from './evidence';
import { removeServices } from './import';
import type { MrCheck, Release } from './types';

const file = (path: string, added: string[], over: Partial<MrFileChange> = {}): MrFileChange => ({
  oldPath: path,
  newPath: path,
  newFile: true,
  renamedFile: false,
  deletedFile: false,
  diff: `@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join('\n')}`,
  additions: added.length,
  deletions: 0,
  ...over,
});

const CHANGES = [
  file('internal/handler/topup_channel_handler.go', ['func (h *Handler) GetDetailTopupChannel(c *gin.Context) {', '  res, err := h.svc.DetailTopupChannel(c, id)', '}']),
  file('internal/model/topup_transaction.go', ['type TopupTransaction struct {', '  ID int64', '}']),
  file('internal/router/router.go', ['  v1.POST("/topup/code", h.RequestCodeTopup)']),
  file('internal/worker/expiry.go', ['// runs every minute', 'func run() { expire(codes); notifyTopup() }']),
  file('go.sum', ['github.com/x/y v1.0.0 h1:abc']),
];

describe('ticket found in the code', () => {
  const files = indexChanges(CHANGES);

  it('reads the words of a ticket name, dropping kinds of work and translating Indonesian', () => {
    expect(ticketTerms('[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel')).toEqual([['detail'], ['topup'], ['channel']]);
    expect(ticketTerms('[BACKEND][CORE-TOPUP][TOKO] - Develop API Request Kode Topup Mobile')).toEqual([['kode', 'code'], ['topup']]);
  });

  it('finds a name held by one identifier, path or route as strong evidence', () => {
    expect(findEvidence({ key: 'MU-1', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel' }, files)).toEqual({
      strength: 'strong',
      hits: [{ path: 'internal/handler/topup_channel_handler.go', match: 'GetDetailTopupChannel' }],
    });
    // Struct names and file paths count; "Model" is a hint, never required.
    expect(findEvidence({ key: 'MU-2', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop Model Topup Transaction' }, files)?.strength).toBe('strong');
    // Indonesian "Kode" matches the code's "Code".
    expect(findEvidence({ key: 'MU-3', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Request Kode Topup Mobile' }, files)?.hits[0]).toEqual({ path: 'internal/router/router.go', match: 'topup/code' });
  });

  it('marks words spread over one file as weak, and finds nothing for other work', () => {
    const weak = findEvidence({ key: 'MU-4', summary: '[BACKEND][GO-WORKER][TOKO] - Develop Scheduler Expire Notify Topup' }, files);
    expect(weak).toEqual({ strength: 'weak', hits: [{ path: 'internal/worker/expiry.go', match: 'expire + notify + topup' }] });
    expect(findEvidence({ key: 'MU-5', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Refund Balance' }, files)).toBeUndefined();
    // One word cannot tell tickets apart.
    expect(findEvidence({ key: 'MU-6', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Topup' }, files)).toBeUndefined();
  });

  it('uses the TAD endpoint, also under a router group prefix', () => {
    expect(endpointVariants('POST /v1/topup/code/{id}')).toEqual(['/v1/topup/code', '/topup/code']);
    expect(findEvidence({ key: 'MU-7', summary: '[BACKEND][CORE-TOPUP][TOKO] - Penyesuaian', endpoints: ['/api/v1/topup/code'] }, files)?.hits[0]).toEqual({ path: 'internal/router/router.go', match: '/topup/code' });
  });

  it("finds a gateway route through the backend ticket of the same feature", () => {
    const gateway = indexChanges([
      file('config/gateway.json', ['    "endpoint": "/v1/shop/mobile/topup/request",', '    "endpoint": "/v1/shop/mobile/topup/channel/{id}",']),
    ]);
    const tickets = withSharedEndpoints([
      { key: 'MU-10', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Request Kode Topup Mobile', endpoints: ['POST /v1/shop/mobile/topup/request'] },
      { key: 'MU-11', summary: '[BACKEND][GATEWAY][TOKO] - Register API Request Kode Topup Mobile' },
      { key: 'MU-12', summary: '[BACKEND][GATEWAY][TOKO] - Register API Get Detail Topup Channel Mobile' },
    ]);
    // Same words ("kode topup"): the gateway ticket takes the backend endpoint.
    expect(tickets[1].endpoints).toEqual(['POST /v1/shop/mobile/topup/request']);
    expect(findEvidence(tickets[1], gateway)).toEqual({ strength: 'strong', hits: [{ path: 'config/gateway.json', match: '/v1/shop/mobile/topup/request' }] });
    // No backend twin with an endpoint: the route misses "detail" but has the hint "mobile".
    expect(tickets[2].endpoints).toBeUndefined();
    expect(findEvidence(tickets[2], gateway)).toEqual({ strength: 'weak', hits: [{ path: 'config/gateway.json', match: 'v1/shop/mobile/topup/channel/' }] });
  });

  it('does not count a test file alone as the feature', () => {
    const onlyTest = indexChanges([file('internal/handler/refund_test.go', ['func TestRefundBalance(t *testing.T) {}'])]);
    expect(findEvidence({ key: 'MU-8', summary: '[BACKEND][X][Y] - Develop API Refund Balance' }, onlyTest)?.strength).toBe('weak');
  });

  it('lists changed files no ticket accounts for', () => {
    const e = findEvidence({ key: 'MU-1', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel' }, files)!;
    const summary = '[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel';
    expect(unattributedFiles(CHANGES, [{ summary, evidence: e }])).toEqual(['internal/model/topup_transaction.go', 'internal/router/router.go', 'internal/worker/expiry.go', 'go.sum']);
    // A sibling of the match named after the feature belongs to it; an unrelated sibling does not.
    const more = [...CHANGES, file('internal/handler/topup_dto.go', ['type Dto struct{}']), file('internal/handler/refund.go', ['func Refund() {}'])];
    expect(unattributedFiles(more, [{ summary, evidence: e }])).toContain('internal/handler/refund.go');
    expect(unattributedFiles(more, [{ summary, evidence: e }])).not.toContain('internal/handler/topup_dto.go');
  });

  it('reads endpoints from a TAD Detail Task section', () => {
    const md = ['## [BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel', '#### Endpoint', 'GET /v1/topup/channel/detail', '#### File', 'internal/handler/x.go', '## Lain', '/v1/other/path'].join('\n');
    expect(taskEndpoints(md, '[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel')).toEqual(['/v1/topup/channel/detail']);
  });
});

describe('Jira keys in commits and branches', () => {
  it('reads keys glued by underscores and lowercase branch keys of the scope projects', () => {
    expect(jiraKeysIn('[MU-1859_MU-1860] API Get Detail')).toEqual(['MU-1859', 'MU-1860']);
    expect(jiraKeysIn('feature/MU-12-x, UTF-8, MU-123456789')).toEqual(['MU-12']);
    const c = { keyCommits: {}, sourceBranch: 'feature/mu-77-topup' } as unknown as MrCheck;
    expect(codeKeys(c)).toEqual([]);
    expect(codeKeys(c, ['MU'])).toEqual(['MU-77']);
  });
});

const release = (over: Partial<Release> = {}): Release => ({
  id: 'r1', name: 'Rilis', version: '', status: 'draft', targetBranch: 'master', sourceBranch: 'staging', minApprovals: 1, projectIds: [], codenames: ['TOKO'], jiraKeys: [],
  services: [{ id: 's1', name: 'core-topup', gitlabPath: 'backend/core-topup', mrs: [], order: 1 }],
  items: [], steps: [], shares: [], accepted: [], createdAt: '', updatedAt: '',
  ...over,
} as Release);

describe('ticket service', () => {
  it('matches the TAD service or the one the title names', () => {
    const t = { service: 'CORE-TOPUP-ULTIMATE', alsoService: 'GO-WORKER' };
    expect(belongsTo(t, 'go-worker')).toBe(true);
    expect(belongsTo(t, 'core-topup-ultimate')).toBe(true);
    expect(belongsTo(t, 'core-topup')).toBe(false);
    expect(belongsTo({}, 'x')).toBe(false);
    expect(belongsTo({}, 'x', true)).toBe(true);
  });

  it('is not "no repo" when the title service is in the release', () => {
    const rep = buildReport(release({ services: [{ id: 's9', name: 'go-worker', mrs: [], order: 1 }] }), [{ key: 'MU-9', summary: '[BACKEND][GO-WORKER][TOKO] - Scheduler', status: 'Done', service: 'CORE-TOPUP', alsoService: 'GO-WORKER', from: 'tad' }], []);
    expect(rep.tickets[0].noRepo).toBeUndefined();
  });
});

describe('report from the code', () => {
  const tickets: ReleaseTicket[] = [
    { key: 'MU-1', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Get Detail Topup Channel', status: 'Done', statusCategory: 'done', service: 'core-topup', from: 'tad' },
    { key: 'MU-4', summary: '[BACKEND][CORE-TOPUP][TOKO] - Scheduler Expire Notify Topup', status: 'Done', statusCategory: 'done', service: 'core-topup', from: 'tad' },
    { key: 'MU-5', summary: '[BACKEND][CORE-TOPUP][TOKO] - Develop API Refund Balance', status: 'Done', statusCategory: 'done', service: 'core-topup', from: 'tad' },
  ];

  it('counts strong evidence as in the code, weak as unsure, and the rest as missing', () => {
    const ref = 'backend/core-topup@staging';
    const evidence = new Map([
      ['MU-1', [{ ref, strength: 'strong' as const, hits: [{ path: 'a.go', match: 'GetDetailTopupChannel' }] }]],
      ['MU-4', [{ ref, strength: 'weak' as const, hits: [{ path: 'b.go', match: 'expire + notify + topup' }] }]],
    ]);
    const rep = buildReport(release(), tickets, [], '', new Map(), { sources: [{ service: 'core-topup', ref, kind: 'branch', files: 3, unattributed: [] }], evidence });
    expect(rep.tickets.map((t) => [t.key, t.inMrs, Boolean(t.unsure)])).toEqual([
      ['MU-1', [ref], false],
      ['MU-4', [], true],
      ['MU-5', [], false],
    ]);
    expect(rep.scope).toMatchObject({ inCode: 1, unsure: 1, missing: 1, matched: false });
    expect(rep.warnings).toContain('1 tiket perlu dicek manual (cocok samar, atau AI ragu): MU-4.');
    expect(rep.sources).toHaveLength(1);
  });

  it('says when a source branch brings nothing', () => {
    const rep = buildReport(release(), [], [], '', new Map(), { sources: [{ service: 'core-topup', ref: 'backend/core-topup@release/toko', kind: 'branch', files: 0, unattributed: [] }], evidence: new Map() });
    expect(rep.warnings).toContain('core-topup: release/toko tidak punya perubahan dibanding master.');
  });

  it('forgets what a kept report said about services removed since', () => {
    const r = release();
    const old = buildReport({ ...r, services: [...r.services, { id: 's9', name: 'core-other', mrs: [], order: 2 }] }, [], [], '');
    expect(old.servicesWithoutMr).toEqual(['core-topup', 'core-other']);
    const now = forCurrentServices(r, old);
    expect(now.servicesWithoutMr).toEqual(['core-topup']);
    expect(now.warnings.some((w) => w.includes('core-other'))).toBe(false);
  });

  it('removes items of a removed service whatever case they were written in', () => {
    const r = release({
      services: [
        { id: 's1', name: 'CORE-TOPUP', mrs: [], order: 1 },
        { id: 's2', name: 'CORE-OTHER', mrs: [], order: 2 },
      ],
      items: [
        { id: 'i1', kind: 'env', label: 'A', service: 'core-other', source: 'import', done: false },
        { id: 'i2', kind: 'env', label: 'B', service: 'core-topup', source: 'import', done: false },
      ],
    });
    expect(removeServices(r, ['s2']).items.map((i) => i.id)).toEqual(['i2']);
  });
});
