import { describe, expect, it } from 'vitest';
import { deploymentStorage, deploymentTitle, parseDeploymentStorage, serviceCommit, serviceEnvBlock, tanggal } from './deployment';
import { releaseMarkdown } from './document';
import { importPreview, mergeReleaseDoc, removeServices, resetDocumentData, servicesOutsideScope } from './import';
import type { MrCheck, Release } from './types';

// A generic page with the same layout as the team's deployment pages.
const task = (id: number, text: string, done = false) =>
  `<ac:task-list><ac:task><ac:task-id>${id}</ac:task-id><ac:task-uuid>u${id}</ac:task-uuid><ac:task-status>${done ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body><span class="placeholder-inline-tasks">${text}</span></ac:task-body></ac:task></ac:task-list>`;
const code = (body: string, lang?: string) => `<ac:structured-macro ac:name="code" ac:schema-version="1">${lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : ''}<ac:parameter ac:name="wrap">true</ac:parameter><ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
const user = (id: string, name: string) => `<ac:link><ri:user ri:account-id="${id}" ri:local-id="x" data-display-name="${name}" /></ac:link>`;
const H = 'data-highlight-colour="#f0f1f2"';
const svcTable = (name: string, pre: string, sha: string, post = task(90, 'N/A')) =>
  `<table data-table-width="760" data-layout="center"><tbody><tr><th><p /></th><th ${H}><p><code>${name}</code></p></th></tr>` +
  `<tr><th ${H}><p>Pre-deploy</p></th><td>${pre}</td></tr><tr><th ${H}><p>Commit id</p></th><td>${task(80, sha)}</td></tr>` +
  `<tr><th ${H}><p>Post-deploy</p></th><td>${post}</td></tr><tr><th ${H}><p>Failover Strategy</p></th><td><p>Rollback Instance Template</p></td></tr>` +
  `<tr><th ${H}><p>Updated by</p></th><td><p>${user('acc-dev', 'Dev Satu')} </p></td></tr></tbody></table>`;

const PAGE =
  '<table data-table-width="760" data-layout="center"><tbody>' +
  '<tr><th><p>Target Release&nbsp;</p></th><td><p><time datetime="2026-08-12" /> 06:00</p></td></tr>' +
  '<tr><th><p>Actual Release</p></th><td><p>TBA</p></td></tr>' +
  '<tr><th><p>Deployment Status&nbsp;</p></th><td><p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">DOCUMENT APPROVAL</ac:parameter><ac:parameter ac:name="colour">Blue</ac:parameter></ac:structured-macro></p></td></tr>' +
  '<tr><th><p>Deployment Impact</p></th><td><p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">-</ac:parameter></ac:structured-macro></p></td></tr>' +
  `<tr><th><p>Supervisor</p></th><td><p>${user('acc-sup', 'Super Visor')}</p></td></tr>` +
  `<tr><th><p>QA</p></th><td><p>${user('acc-qa', 'Qa Satu')} , Qa Dua</p></td></tr>` +
  '<tr><th><p>Deployment Room</p></th><td><p>Ruang Deploy</p></td></tr>' +
  '<tr><th><p>Issue/Request Link (if any)</p></th><td><p /></td></tr></tbody></table>' +
  '<h2><ac:emoticon ac:name="dart" /> Change Log</h2><table><tbody><tr><th><p><strong>No.</strong></p></th><th><p><strong>Details</strong></p></th><th><p><strong>Notes</strong></p></th></tr>' +
  '<tr><td><ol start="1"><li><p /></li></ol></td><td><p>OTP via WhatsApp</p></td><td><p>Fitur login baru</p></td></tr></tbody></table>' +
  '<h2><br /><ac:emoticon ac:name="blue-star" /> Deployment List</h2>' +
  '<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:rich-text-body><p><strong>Urutan deploy:</strong></p><ol start="1"><li><p>core-auth</p></li><li><p>core-report</p></li><li><p>edge-gateway</p></li></ol></ac:rich-text-body></ac:structured-macro>' +
  svcTable('core-report', task(1, 'Update Table') + code('-- tambah kolom\nALTER TABLE report ADD COLUMN channel TEXT;', 'sql'), 'abbc55d617761b1b6d21a81c4ec948e187ef46b4') +
  svcTable('core-auth', task(2, 'Update .env', true) + code('# OTP\nOTP_URL="https://otp.example.com"\nOTP_KEY=secret-value'), '5f794d713b8303e52af3456a6bf768ba57b03ae7', task(3, 'Restart worker OTP')) +
  svcTable('edge-gateway', task(4, 'N/A'), '504b8d680c91ecdd87982341c8a6ae94843970d2') +
  '<h2>Release List</h2><a href="https://jira.example.com/issues/?jql=fixVersion%20IN%20(12094)%20ORDER%20BY%20created%20ASC" data-card-appearance="block">x</a>' +
  '<h2>Document Control</h2><p /><ac:structured-macro ac:name="page-signatures" ac:schema-version="1" data-layout="default" /><p />' +
  '<h2>Post Deployment Test</h2><p><strong>Evidence link:</strong></p><p><a href="https://wiki.example.com/x/AB">Sanity Test Agustus</a></p>' +
  '<h2>Post Deployment issues</h2><table><tbody><tr><th class="numberingColumn" /><th><p><strong>Date</strong></p></th></tr></tbody></table>';

const release = (over: Partial<Release> = {}): Release => ({
  id: 'r1',
  name: 'Rilis Agustus',
  version: '',
  status: 'review',
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
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('reading a deployment page', () => {
  it('reads release info, roles, change log, deploy order, per-service rows, release list and evidence', () => {
    const d = parseDeploymentStorage(PAGE, 'Deployment 12 Agustus 2026')!;
    expect(d.date).toBe('2026-08-12');
    expect(d.deploy).toMatchObject({ targetTime: '06:00', actual: 'TBA', statusTitle: 'DOCUMENT APPROVAL', statusColour: 'Blue', impact: '-', room: 'Ruang Deploy', changeLog: [{ details: 'OTP via WhatsApp', notes: 'Fitur login baru' }], releaseList: { jql: 'fixVersion IN (12094) ORDER BY created ASC' }, testEvidence: [{ title: 'Sanity Test Agustus', url: 'https://wiki.example.com/x/AB' }] });
    expect(d.deploy.issueLink).toBeUndefined();
    expect(d.deploy.roles).toEqual([
      { label: 'Supervisor', people: [{ accountId: 'acc-sup', name: 'Super Visor' }] },
      { label: 'QA', people: [{ accountId: 'acc-qa', name: 'Qa Satu' }, { name: 'Qa Dua' }] },
    ]);
    // Ordered by the deploy order, not by table position.
    expect(d.serviceDetails.map((s) => [s.order, s.name, s.commitId?.slice(0, 7)])).toEqual([
      [1, 'core-auth', '5f794d7'],
      [2, 'core-report', 'abbc55d'],
      [3, 'edge-gateway', '504b8d6'],
    ]);
    const auth = d.serviceDetails[0];
    expect(auth).toMatchObject({ envNames: ['OTP_URL', 'OTP_KEY'], envDone: true, postDeploy: ['Restart worker OTP'], failover: 'Rollback Instance Template', updatedBy: { accountId: 'acc-dev', name: 'Dev Satu' } });
    expect(auth.envBlock).toBe('# OTP\nOTP_URL="https://otp.example.com"\nOTP_KEY=secret-value');
    expect(d.serviceDetails[1].sql).toEqual([{ label: 'Update Table', text: '-- tambah kolom\nALTER TABLE report ADD COLUMN channel TEXT;', done: false }]);
    expect(d.serviceDetails[2]).toMatchObject({ preDeploy: [], postDeploy: [], envNames: [], sql: [] });
  });

  it('returns null for a page without this layout', () => {
    expect(parseDeploymentStorage('<h1>PRD</h1><p>Isi biasa</p><table><tbody><tr><th>A</th><td>B</td></tr></tbody></table>')).toBeNull();
  });

  it('merges only into the release: its services get the details, release data is never replaced', () => {
    const existing = release({ services: [{ id: 's', name: 'core-report', mrs: [], order: 1, commitId: '1111111' }], items: [{ id: 'i', kind: 'env', label: 'OTP_KEY', source: 'check', done: false }] });
    const doc = parseDeploymentStorage(PAGE, 'Deployment 12 Agustus 2026')!;
    expect(importPreview(existing, doc)).toMatchObject({ matched: [{ doc: 'core-report', release: 'core-report' }], notInRelease: ['core-auth', 'edge-gateway'] });

    const plain = mergeReleaseDoc(existing, doc, '', { kind: 'confluence', title: 'x' });
    // Services of another release are not added; the release's own service gets its details.
    expect(plain.services.map((s) => [s.name, s.commitId])).toEqual([['core-report', '1111111']]);
    expect(plain.items.map((i) => [i.kind, i.label, i.service ?? '', i.done])).toEqual([
      ['env', 'OTP_KEY', '', false],
      ['sql', 'Update Table', 'core-report', false],
    ]);
    // People and fixed info come over; change log, release list, evidence and status do not.
    expect(plain.deploy).toEqual({ roles: doc.deploy.roles, changeLog: [], testEvidence: [], targetTime: '06:00', impact: '-', room: 'Ruang Deploy' });
    expect(plain.date).toBe('2026-08-12');

    const chosen = mergeReleaseDoc(existing, doc, '', { kind: 'confluence', title: 'x' }, undefined, { addServices: ['core-auth'] });
    expect(chosen.services.map((s) => [s.order, s.name, s.commitId ?? ''])).toEqual([
      [1, 'core-report', '1111111'],
      [2, 'core-auth', ''],
    ]);
    // Done marks of the other page do not carry over.
    expect(chosen.items.filter((i) => i.service === 'core-auth').map((i) => [i.label, i.done])).toEqual([
      ['OTP_KEY', false],
      ['OTP_URL', false],
    ]);
    expect(chosen.services[1]).toMatchObject({ postDeploy: ['Restart worker OTP'], failover: 'Rollback Instance Template', updatedBy: { accountId: 'acc-dev' } });
  });

  it('finds leftover services, removes them with their items, and resets document data', () => {
    const r = release({
      services: [
        { id: 'a', name: 'core-auth', mrs: [{ ref: 'g/core-auth!1', projectPath: 'g/core-auth', iid: 1, webUrl: 'u', via: 'auto' }], order: 1, commitId: 'abc1234' },
        { id: 'b', name: 'core-qr', mrs: [], order: 2 },
        { id: 'c', name: 'core-report', mrs: [], order: 3 },
      ],
      items: [{ id: 'i', kind: 'env', label: 'QR_KEY', service: 'core-qr', source: 'import', done: false }],
      deploy: { roles: [{ label: 'QA', people: [{ name: 'Qa' }] }], changeLog: [{ details: 'lama' }], testEvidence: [{ title: 't', url: 'https://x' }], releaseList: { jql: 'fixVersion = 1' }, statusTitle: 'DONE', room: 'Ruang' },
    });
    expect(servicesOutsideScope(r, null)).toEqual([]);
    const outside = servicesOutsideScope(r, { tickets: [{ service: 'CORE-REPORT' }] });
    expect(outside.map((s) => s.name)).toEqual(['core-qr']);
    const cleaned = removeServices(r, outside.map((s) => s.id));
    expect(cleaned.services.map((s) => [s.order, s.name])).toEqual([
      [1, 'core-auth'],
      [2, 'core-report'],
    ]);
    expect(cleaned.items).toEqual([]);
    const reset = resetDocumentData(cleaned);
    expect(reset.services[0].commitId).toBeUndefined();
    expect(reset.deploy).toEqual({ roles: [{ label: 'QA', people: [{ name: 'Qa' }] }], changeLog: [], testEvidence: [], room: 'Ruang' });
  });
});

describe('writing a deployment page', () => {
  // Each service has its release MR: only then does the document carry its deploy details.
  const withMrs = (r: Release): Release => ({ ...r, services: r.services.map((s) => ({ ...s, mrs: [{ ref: `g/${s.name}!1`, projectPath: `g/${s.name}`, iid: 1, webUrl: 'https://gitlab.example.com/x', via: 'auto' as const }] })) });
  const imported = withMrs(mergeReleaseDoc(release(), parseDeploymentStorage(PAGE, 'x')!, '', { kind: 'confluence', title: 'x' }, undefined, { addServices: ['core-auth', 'core-report', 'edge-gateway'] }));

  it('round-trips: what Cockpit writes reads back the same', () => {
    const xhtml = deploymentStorage(imported, null, { jiraBaseUrl: 'https://jira.example.com' });
    const again = parseDeploymentStorage(xhtml, 'x')!;
    // Commit ids come from the release's MRs, not from the imported page (none here: TBA).
    expect(again.serviceDetails.map((s) => [s.name, s.commitId, s.envNames, s.sql.length, s.postDeploy])).toEqual([
      ['core-auth', undefined, ['OTP_URL', 'OTP_KEY'], 0, ['Restart worker OTP']],
      ['core-report', undefined, [], 1, []],
      ['edge-gateway', undefined, [], 0, []],
    ]);
    expect(again.serviceDetails[0].envBlock).toBe(imported.services[0].envBlock);
    // Change Log and status follow the release; the imported page's ones are not carried over.
    expect(again.deploy).toMatchObject({ targetTime: '06:00', statusTitle: 'DOCUMENT APPROVAL', changeLog: [{ details: 'Rilis Agustus' }] });
    expect(again.deploy.releaseList).toBeUndefined();
    expect(again.deploy.roles.map((r) => [r.label, r.people.map((p) => p.accountId ?? p.name)])).toEqual([
      ['Supervisor', ['acc-sup']],
      ['QA', ['acc-qa', 'Qa Dua']],
    ]);
    expect(xhtml).toContain('ac:name="page-signatures"');
    expect(xhtml).toContain('<th class="numberingColumn" />');
  });

  it('fills a new release from the checks: env as KEY=, migrations, commit from the merged MR, default roles', () => {
    const r = release({
      date: '2026-10-20',
      status: 'ready',
      jiraKeys: ['MU-1'],
      services: [{ id: 's1', name: 'core-payment', mrs: [{ ref: 'p/core!1', projectPath: 'p/core', iid: 1, webUrl: 'u', via: 'auto' }], order: 1 }],
      items: [
        { id: 'a', kind: 'env', label: 'REFUND_LIMIT', service: 'core-payment', source: 'check', done: false },
        { id: 'b', kind: 'migration', label: 'db/migrations/2_refund.up.sql', service: 'core-payment', source: 'check', done: true },
      ],
      steps: [{ id: 'st', kind: 'rollback', text: 'Revert ke tag v2.3', service: 'core-payment', done: false }],
    });
    const checks = [{ ref: 'p/core!1', state: 'merged', commitSha: 'deadbeefcafe', mrs: [] } as unknown as MrCheck];
    expect(serviceCommit(r.services[0], checks)).toBe('deadbeefcafe');
    expect(serviceEnvBlock(r, r.services[0])).toEqual({ text: 'REFUND_LIMIT=', done: false });
    const xhtml = deploymentStorage(r, { mrs: checks, tickets: [] } as never, { jiraBaseUrl: 'https://jira.example.com/' });
    const back = parseDeploymentStorage(xhtml)!;
    expect(back.serviceDetails[0]).toMatchObject({ commitId: 'deadbeefcafe', envNames: ['REFUND_LIMIT'], failover: 'Revert ke tag v2.3' });
    expect(back.serviceDetails[0].preDeploy).toEqual(['Jalankan migrasi db/migrations/2_refund.up.sql']);
    expect(back.deploy.statusTitle).toBe('READY TO DEPLOY');
    expect(back.deploy.roles.map((x) => x.label)).toEqual(['Supervisor', 'Tech Lead', 'QA', 'Cloud Platform Team', 'Product Lead']);
    expect(xhtml).toContain('https://jira.example.com/issues/?jql=key%20in%20(MU-1)%20ORDER%20BY%20created%20ASC');
    expect(xhtml).toContain('<time datetime="2026-10-20" />');
  });

  it('says "Menunggu MR" instead of details for a service without a release MR', () => {
    const r = release({ services: [{ id: 's', name: 'go-worker', mrs: [], order: 1, envBlock: 'A=1', preDeploy: ['Restart'] }] });
    const xhtml = deploymentStorage(r);
    expect(xhtml).toContain('Menunggu MR ke master');
    expect(xhtml).not.toContain('Restart');
    expect(xhtml).not.toContain('A=1');
    expect(releaseMarkdown(r)).toContain('Menunggu MR ke master');
  });

  it('fills the commit id only once the release MR is merged, and renders a Confluence-like preview', async () => {
    const svc = { id: 's1', name: 'core-payment', mrs: [{ ref: 'p/core!1', projectPath: 'p/core', iid: 1, webUrl: 'u', via: 'auto' as const }], order: 1, commitId: 'old0000' };
    // Still in review: TBA, not the head or a typed sha.
    expect(serviceCommit(svc, [{ ref: 'p/core!1', state: 'opened', commitSha: 'head1234' } as unknown as MrCheck])).toBeUndefined();
    expect(serviceCommit(svc, [])).toBeUndefined();
    expect(serviceCommit(svc, [{ ref: 'p/core!1', state: 'merged', commitSha: 'merge999' } as unknown as MrCheck])).toBe('merge999');
    // Written by "Generate dokumen" from the merged MR, when no check is at hand.
    expect(serviceCommit({ ...svc, releaseCommit: 'gen1234' }, [])).toBe('gen1234');
    const { storageToPreviewHtml } = await import('./preview');
    const html = storageToPreviewHtml(deploymentStorage(imported), new Map([['acc-sup', 'Super Visor']]));
    expect(html).toContain('<span class="lozenge lz-blue">DOCUMENT APPROVAL</span>');
    expect(html).toContain('<span class="mention">@Super Visor</span>');
    expect(html).toContain('<li class="task"><span class="box">☐</span> Update .env</li>');
    expect(html).toContain('<span class="date">');
    expect(html).toMatch(/<pre><code[^>]*>-- tambah kolom/);
    expect(html).not.toMatch(/<\/?ac:|<\/?ri:/);
    expect(storageToPreviewHtml('<p>x</p><script>alert(1)</script><img src=x onerror=alert(1)>')).not.toMatch(/script|onerror/);
  });

  it('escapes text, keeps CDATA safe, and names the page by date', () => {
    const r = withMrs(release({ date: '2026-08-12', services: [{ id: 's', name: 'svc <x>', mrs: [], order: 1, envBlock: 'A="]]>"' }] }));
    const xhtml = deploymentStorage(r);
    expect(xhtml).toContain('<code>svc &lt;x&gt;</code>');
    expect(xhtml).toContain('<![CDATA[A="]]]]><![CDATA[>"]]>');
    expect(deploymentTitle(r)).toBe('Deployment 12 Agustus 2026');
    expect(tanggal('2026-01-05')).toBe('5 Januari 2026');
    expect(releaseMarkdown(imported)).toContain('### `core-auth`');
  });
});
