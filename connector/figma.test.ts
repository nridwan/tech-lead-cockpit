// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectorMiddleware } from './dev-connector.ts';
import { FigmaClient, FigmaError, FigmaManager, extractTexts, parseFigmaUrl, readFetchedSets, scaleFor, screenChoices, setIdFor, slug, type FigmaNode } from './figma.ts';
import { figmaContextLine, prepareGeneratorWorkspace } from './generator-runner.ts';

const KEY = 'AbCdEf1234567890XyZ';
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const text = (id: string, characters: string, x: number, y: number, visible?: boolean): FigmaNode => ({ id, name: characters, type: 'TEXT', characters, absoluteBoundingBox: box(x, y, 100, 20), visible });

const loginScreen: FigmaNode = {
  id: '10:1',
  name: 'Login',
  type: 'FRAME',
  absoluteBoundingBox: box(0, 0, 375, 812),
  children: [
    text('10:2', 'Masuk', 20, 40),
    text('10:3', 'Email', 20, 120),
    text('10:4', 'Kata sandi', 20, 200),
    { id: '10:5', name: 'Button', type: 'INSTANCE', absoluteBoundingBox: box(20, 700, 335, 48), children: [text('10:6', 'Masuk', 150, 712)] },
    text('10:7', 'Draft lama', 20, 300, false),
  ],
};
const otpScreen: FigmaNode = { id: '10:8', name: 'Verifikasi OTP', type: 'FRAME', absoluteBoundingBox: box(400, 0, 375, 812), children: [text('10:9', 'Masukkan kode OTP', 20, 40)] };
const section: FigmaNode = { id: '1:2', name: 'Switching Management', type: 'SECTION', absoluteBoundingBox: box(0, 0, 800, 900), children: [loginScreen, otpScreen, text('1:3', 'Catatan desainer', 0, -40)] };

describe('parseFigmaUrl', () => {
  it('reads design, file, proto and branch links with old and new node ids', () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/App?node-id=31698-69712&t=abc`)).toEqual({ fileKey: KEY, nodeId: '31698:69712' });
    expect(parseFigmaUrl(`https://www.figma.com/file/${KEY}/App?node-id=1%3A2`)).toEqual({ fileKey: KEY, nodeId: '1:2' });
    expect(parseFigmaUrl(`https://figma.com/proto/${KEY}/App?node-id=5-6&starting-point-node-id=5-6`)).toEqual({ fileKey: KEY, nodeId: '5:6' });
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/branch/BrAnCh1234567890/App?node-id=7-8`)).toEqual({ fileKey: 'BrAnCh1234567890', nodeId: '7:8' });
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/App`)).toEqual({ fileKey: KEY, nodeId: undefined });
  });

  it('rejects links that are not Figma files', () => {
    expect(parseFigmaUrl('https://example.com/design/abc')).toBeNull();
    expect(parseFigmaUrl(`http://www.figma.com/design/${KEY}/App`)).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/community/file/123')).toBeNull();
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/App?node-id=1-2;rm`)).toEqual({ fileKey: KEY, nodeId: '1:2;rm' });
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/App?node-id=../x`)).toBeNull();
    expect(parseFigmaUrl('bukan url')).toBeNull();
  });
});

describe('screen detection and text', () => {
  it('preselects the frames inside a section, opening nested groups', () => {
    const r = screenChoices({ ...section, children: [loginScreen, { id: '2:1', name: 'Group', type: 'GROUP', children: [otpScreen] }] });
    expect(r.screens.map((s) => [s.id, s.parent])).toEqual([
      ['10:1', 'Switching Management'],
      ['10:8', 'Group'],
    ]);
    expect(r.selected).toEqual(['10:1', '10:8']);
  });

  it('offers a frame and preselects its child screens only when they look like screens', () => {
    const board: FigmaNode = { id: '3:1', name: 'Flow', type: 'FRAME', absoluteBoundingBox: box(0, 0, 2000, 900), children: [loginScreen, otpScreen] };
    expect(screenChoices(board)).toMatchObject({ selected: ['10:1', '10:8'] });
    expect(screenChoices(board).screens[0].id).toBe('3:1');
    // A single screen with small layout frames inside is itself the screen.
    expect(screenChoices(loginScreen)).toEqual({ screens: [expect.objectContaining({ id: '10:1', width: 375, height: 812 })], selected: ['10:1'] });
  });

  it('extracts visible text in reading order without duplicates', () => {
    expect(extractTexts(loginScreen)).toEqual(['Masuk', 'Email', 'Kata sandi']);
    const row: FigmaNode = { id: '1', name: 'r', type: 'FRAME', children: [text('a', 'Kanan', 200, 10), text('b', 'Kiri', 10, 14), text('c', 'Bawah', 10, 60)] };
    expect(extractTexts(row)).toEqual(['Kiri', 'Kanan', 'Bawah']);
  });

  it('picks a render scale that keeps the long edge near 1568px', () => {
    expect(scaleFor(375, 812)).toBe(1.5);
    expect(scaleFor(1440, 3000)).toBe(0.5);
    expect(scaleFor(200, 300)).toBe(2);
    expect(scaleFor(0, 0)).toBe(1);
  });

  it('builds safe file and folder names', () => {
    expect(slug('Verifikasi OTP / Gagal!')).toBe('verifikasi-otp-gagal');
    expect(slug('***')).toBe('layar');
    expect(setIdFor({ fileKey: KEY, nodeId: 'I1:2;3:4' })).toBe(`${KEY}_I1-2-3-4`);
    expect(setIdFor({ fileKey: KEY })).toBe(`${KEY}_file`);
  });
});

/** A tiny fake of the Figma REST API plus the image CDN. */
function fakeFigma(opts: { token?: string; rateLimitOnce?: boolean; version?: string } = {}) {
  const calls: string[] = [];
  let limited = false;
  const nodes: Record<string, FigmaNode> = { '1:2': section, '10:1': loginScreen, '10:8': otpScreen };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'cdn.example.test') return new Response(Buffer.from(`png:${u.pathname}`), { status: 200 });
    if (init?.headers?.['X-Figma-Token'] !== (opts.token ?? 'figd_good')) return json(403, { status: 403, err: 'Invalid token' });
    if (opts.rateLimitOnce && !limited) {
      limited = true;
      return json(429, { status: 429, err: 'Rate limit' }, { 'Retry-After': '2' });
    }
    if (u.pathname === '/v1/me') return json(200, { id: 'u1', handle: 'Tech Lead', email: 'lead@example.com' });
    const files = u.pathname.match(/^\/v1\/files\/([^/]+)(\/nodes)?$/);
    if (files && files[1] !== KEY) return json(404, { status: 404, err: 'Not found' });
    if (files?.[2]) {
      const ids = (u.searchParams.get('ids') ?? '').split(',');
      return json(200, { name: 'Aplikasi Mobile', lastModified: '2026-10-10T08:00:00Z', version: opts.version ?? '111', nodes: Object.fromEntries(ids.map((id) => [id, nodes[id] ? { document: nodes[id] } : null])) });
    }
    if (files) return json(200, { name: 'Aplikasi Mobile', lastModified: '2026-10-11T08:00:00Z', version: opts.version ?? '111', document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Halaman 1', type: 'CANVAS', children: [section] }] } });
    const images = u.pathname.match(/^\/v1\/images\/([^/]+)$/);
    if (images) {
      const ids = (u.searchParams.get('ids') ?? '').split(',');
      return json(200, { err: null, images: Object.fromEntries(ids.map((id) => [id, id === '10:8' ? null : `https://cdn.example.test/${id.replace(':', '_')}.png`])) });
    }
    return json(404, { err: 'unknown' });
  };
  return { fetchImpl, calls };
}

describe('FigmaClient', () => {
  it('maps auth, not found and rate limit errors to clear messages', async () => {
    const { fetchImpl } = fakeFigma();
    await expect(new FigmaClient({ token: 'salah', fetch: fetchImpl }).me()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(new FigmaClient({ token: 'figd_good', fetch: fetchImpl }).nodes('ZzZz1234567890ZzZz', ['1:2'])).rejects.toMatchObject({ code: 'not-found' });
  });

  it('waits for Retry-After once on 429 and then succeeds', async () => {
    const { fetchImpl } = fakeFigma({ rateLimitOnce: true });
    const waits: number[] = [];
    const me = await new FigmaClient({ token: 'figd_good', fetch: fetchImpl, sleep: async (ms) => void waits.push(ms) }).me();
    expect(me.handle).toBe('Tech Lead');
    expect(waits).toEqual([2000]);
  });
});

describe('FigmaManager', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-figma-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const manager = (token: string | null = 'figd_good', fake = fakeFigma()) =>
    new FigmaManager({ readToken: async () => token, workspaceFor: (id) => join(dir, id), fetch: fake.fetchImpl, sleep: async () => {}, now: () => new Date('2026-10-12T05:00:00Z') });

  it('reports status without a token and with one', async () => {
    expect(await manager(null).status()).toMatchObject({ configured: false, tokenPresent: false });
    expect(await manager().status()).toMatchObject({ configured: true, user: { handle: 'Tech Lead' } });
    expect(await manager('salah').status()).toMatchObject({ configured: false, tokenPresent: true });
    await expect(manager(null).listScreens(`https://www.figma.com/design/${KEY}/App?node-id=1-2`)).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('lists the screens of a linked section and of a whole file', async () => {
    const list = await manager().listScreens(`https://www.figma.com/design/${KEY}/App?node-id=1-2`);
    expect(list).toMatchObject({ fileKey: KEY, nodeId: '1:2', nodeName: 'Switching Management', fileName: 'Aplikasi Mobile', selected: ['10:1', '10:8'] });
    const whole = await manager().listScreens(`https://www.figma.com/design/${KEY}/App`);
    expect(whole).toMatchObject({ wholeFile: true, selected: [] });
    expect(whole.screens.map((s) => s.id)).toEqual(['10:1', '10:8']);
    await expect(manager().listScreens('https://example.com/x')).rejects.toBeInstanceOf(FigmaError);
  });

  it('writes screenshots, index.md and a manifest into the draft workspace, replacing an earlier fetch', async () => {
    const fake = fakeFigma();
    const m = manager('figd_good', fake);
    const url = `https://www.figma.com/design/${KEY}/App?node-id=1-2`;
    const set = await m.fetchScreens({ draftId: 'draft-1', url, title: 'Switching', screenIds: ['10:1', '10:8', '10:1'] });
    const folder = join(dir, 'draft-1', 'figma', `${KEY}_1-2`);
    expect(set.screens).toEqual([
      { id: '10:1', name: 'Login', width: 375, height: 812, image: '01-login.png', textCount: 3 },
      { id: '10:8', name: 'Verifikasi OTP', width: 375, height: 812, image: undefined, textCount: 1 },
    ]);
    expect((await readdir(folder)).sort()).toEqual(['01-login.png', 'index.md', 'manifest.json']);
    expect((await readFile(join(folder, '01-login.png'))).toString()).toBe('png:/10_1.png');
    const index = await readFile(join(folder, 'index.md'), 'utf8');
    expect(index).toContain('# Figma: Switching (Aplikasi Mobile)');
    expect(index).toContain(`Gambar: figma/${KEY}_1-2/01-login.png (375×812)`);
    expect(index).toContain('- Kata sandi');
    expect(index).toContain('Gambar: tidak bisa dirender oleh Figma.');
    expect(index).not.toContain('Draft lama');
    // Mobile screens render at 1.5x; the token never goes to the image CDN.
    expect(fake.calls.some((c) => c.includes('/v1/images/') && c.includes('scale=1.5'))).toBe(true);

    await m.fetchScreens({ draftId: 'draft-1', url, screenIds: ['10:8'] });
    expect((await readdir(folder)).sort()).toEqual(['index.md', 'manifest.json']);
    expect(await m.listFetched('draft-1')).toHaveLength(1);
  });

  it('validates the selection before calling Figma', async () => {
    const m = manager();
    const url = `https://www.figma.com/design/${KEY}/App?node-id=1-2`;
    await expect(m.fetchScreens({ draftId: 'd', url, screenIds: [] })).rejects.toThrow(/minimal satu layar/);
    await expect(m.fetchScreens({ draftId: 'd', url, screenIds: Array.from({ length: 31 }, (_, i) => `1:${i}`) })).rejects.toThrow(/Maksimal 30/);
    await expect(m.fetchScreens({ draftId: 'd', url, screenIds: ['99:99'] })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('flags sets whose Figma file changed, deletes sets and serves only its own images', async () => {
    const url = `https://www.figma.com/design/${KEY}/App?node-id=1-2`;
    await manager().fetchScreens({ draftId: 'd', url, screenIds: ['10:1'] });
    expect((await manager().checkStale('d'))[0].stale).toBeUndefined();
    const changed = await manager('figd_good', fakeFigma({ version: '222' })).checkStale('d');
    expect(changed[0]).toMatchObject({ stale: true, currentVersion: '222' });
    expect((await manager().image('d', `${KEY}_1-2`, '01-login.png')).length).toBeGreaterThan(0);
    await expect(manager().image('d', `${KEY}_1-2`, '../manifest.json')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(manager().image('d', '../x', '01-login.png')).rejects.toMatchObject({ code: 'bad-request' });
    expect(await manager().deleteFetched('d', `${KEY}_1-2`)).toEqual([]);
    await expect(manager().deleteFetched('d', '../..')).rejects.toMatchObject({ code: 'bad-request' });
  });
});

describe('generator prompt', () => {
  it('points CLI providers at the screenshots and text-only providers at index.md', () => {
    const sets = [{ id: `${KEY}_1-2`, url: 'u', fileKey: KEY, fileName: 'Aplikasi Mobile', title: 'Switching', version: '1', lastModified: '', fetchedAt: '', screens: [{ id: '10:1', name: 'Login', width: 1, height: 1, textCount: 0 }], stale: true }];
    const cli = figmaContextLine(sets, 'claude');
    expect(cli).toContain(`figma/${KEY}_1-2/index.md (Switching, Aplikasi Mobile, 1 layar, desain sudah berubah sejak diambil)`);
    expect(cli).toContain('buka gambar PNG');
    expect(figmaContextLine(sets, '9router')).toContain('Jangan membuka file PNG');
  });

  it('mentions figma/ in the instructions once screens were fetched', async () => {
    const draftId = `figma-${Date.now()}`;
    const figmaLinks = [{ title: 'Switching', url: `https://www.figma.com/design/${KEY}/App?node-id=1-2` }];
    const before = await prepareGeneratorWorkspace({ draftId, prompt: 'x', tadMarkdown: '# TAD', figmaLinks });
    try {
      expect(before.instructions).toContain('Kamu tidak bisa membuka Figma');
      // Fetch into the same workspace the generator uses.
      const m = new FigmaManager({ readToken: async () => 'figd_good', workspaceFor: () => before.workspaceDir, fetch: fakeFigma().fetchImpl, sleep: async () => {} });
      await m.fetchScreens({ draftId, url: figmaLinks[0].url, screenIds: ['10:1'] });
      expect(await readFetchedSets(join(before.workspaceDir, 'figma'))).toHaveLength(1);
      const after = await prepareGeneratorWorkspace({ draftId, prompt: 'x', tadMarkdown: '# TAD', figmaLinks });
      expect(after.instructions).toContain(`figma/${KEY}_1-2/index.md`);
      expect(after.instructions).not.toContain('Kamu tidak bisa membuka Figma; cantumkan');
    } finally {
      await rm(before.workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('connector /figma routes', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-figma-routes-'));
    const figma = new FigmaManager({ readToken: async () => 'figd_good', workspaceFor: (id) => join(dir, id), fetch: fakeFigma().fetchImpl, sleep: async () => {} });
    const handler = connectorMiddleware({}, { readToken: async () => null, appendAudit: async () => {}, readAudit: async () => [], logError: () => {}, figma: () => figma });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path: string, json?: unknown, headers: Record<string, string> = { 'X-TLC-Client': '1' }) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', ...headers },
    });

  it('lists screens, fetches them into the draft, serves thumbnails and deletes', async () => {
    expect(await (await call('/figma/status')).json()).toMatchObject({ configured: true });
    const url = `https://www.figma.com/design/${KEY}/App?node-id=1-2`;
    const list = await (await call(`/figma/screens?url=${encodeURIComponent(url)}`)).json();
    expect(list.selected).toEqual(['10:1', '10:8']);

    expect((await call('/figma/fetch', { draftId: '../x', url, screenIds: ['10:1'] })).status).toBe(400);
    const fetched = await (await call('/figma/fetch', { draftId: 'draft-9', url, screenIds: ['10:1'] })).json();
    expect(fetched.set.screens[0].image).toBe('01-login.png');
    expect(fetched.sets).toHaveLength(1);

    const img = await call(`/figma/image?draftId=draft-9&set=${KEY}_1-2&name=01-login.png`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await img.text()).startsWith('png:')).toBe(true);
    // An <img> from another page cannot send the client header.
    expect((await call(`/figma/image?draftId=draft-9&set=${KEY}_1-2&name=01-login.png`, undefined, {})).status).toBe(403);

    expect(await (await call('/figma/fetched?draftId=draft-9&check=1')).json()).toHaveLength(1);
    expect(await (await call('/figma/fetched/delete', { draftId: 'draft-9', id: `${KEY}_1-2` })).json()).toEqual([]);
  });

  it('rejects an invalid token before saving it', async () => {
    const res = await call('/figma/save-token', { token: 'salah' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Token Figma tidak valid/);
    expect((await call('/figma/save-token', { token: '' })).status).toBe(400);
  });
});
