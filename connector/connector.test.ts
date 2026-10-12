// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent, PublishRequest } from '../src/lib/confluence/api-types.ts';
import { connectorMiddleware } from './dev-connector.ts';

/** In-memory stand-in for Confluence Data Center (v1) and Cloud (v2 pages + v1 attachments). */
function mockConfluence() {
  type Page = { id: string; title: string; spaceKey: string; version: number; storage: string; parentId?: string; status?: 'current' | 'draft' };
  const state = {
    pages: new Map<string, Page>(),
    attachments: new Map<string, { id: string; filename: string; versions: number }>(),
    seq: 100,
    requests: [] as string[],
  };
  const space = { id: '9001', key: 'ENG', name: 'Engineering' };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const dc = (p: Page) => ({
    id: p.id,
    title: p.title,
    status: p.status ?? 'current',
    version: { number: p.version },
    space: { key: p.spaceKey },
    body: { storage: { value: p.storage } },
    _links: { webui: `/pages/viewpage.action?pageId=${p.id}` },
  });
  const cloud = (p: Page) => ({
    id: p.id,
    title: p.title,
    status: p.status ?? 'current',
    version: { number: p.version },
    body: { storage: { value: p.storage } },
    _links: { webui: `/spaces/${p.spaceKey}/pages/${p.id}` },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const cloudMode = url.pathname.startsWith('/wiki');
    const path = url.pathname.replace(/^\/wiki/, '');
    state.requests.push(`${req.method} ${url.pathname}`);

    const expectedAuth = cloudMode ? `Basic ${Buffer.from('me@corp.test:test-token').toString('base64')}` : 'Bearer test-token';
    if (req.headers.authorization !== expectedAuth) return json(res, 401, { message: 'unauthorized' });

    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && path === '/rest/api/user/current') return json(res, 200, { displayName: 'Test User' });
    if (req.method === 'GET' && path === `/rest/api/space/${space.key}`) return json(res, 200, space);
    if (req.method === 'GET' && path === '/api/v2/spaces') return json(res, 200, { results: url.searchParams.get('keys') === space.key ? [space] : [] });

    const findByTitle = (title: string | null) => [...state.pages.values()].filter((p) => p.title === title);
    if (req.method === 'GET' && path === '/rest/api/content/search') {
      const term = (url.searchParams.get('cql') ?? '').match(/title ~ "([^"]+)"/)?.[1]?.toLowerCase() ?? '';
      return json(res, 200, { results: [...state.pages.values()].filter((p) => p.title.toLowerCase().includes(term)).map(dc) });
    }
    if (req.method === 'GET' && path === '/rest/api/user') {
      return url.searchParams.get('accountId') === 'acc-1' || url.searchParams.get('key') === 'acc-1' ? json(res, 200, { displayName: 'Willy kurniawan' }) : json(res, 404, { message: 'no user' });
    }
    if (req.method === 'GET' && path === '/rest/api/content') {
      const statusFilter = url.searchParams.get('status') ?? 'current';
      return json(res, 200, { results: findByTitle(url.searchParams.get('title')).filter((p) => (p.status ?? 'current') === statusFilter).map(dc) });
    }
    if (req.method === 'GET' && path === '/api/v2/pages') {
      const statusFilter = url.searchParams.get('status') ?? 'current';
      return json(res, 200, { results: findByTitle(url.searchParams.get('title')).filter((p) => (p.status ?? 'current') === statusFilter).map(cloud) });
    }

    if ((m = path.match(/^\/(?:rest\/api\/content|api\/v2\/pages)\/(\d+)$/))) {
      const page = state.pages.get(m[1]);
      if (!page) return json(res, 404, { message: 'No content found' });
      if (req.method === 'GET') return json(res, 200, cloudMode ? cloud(page) : dc(page));
      if (req.method === 'PUT') {
        const b = JSON.parse((await body(req)).toString());
        const expectedNext = (b.status === 'draft' || page.status === 'draft') ? page.version : page.version + 1;
        if (b.version.number !== expectedNext) return json(res, 409, { message: 'Version mismatch' });
        Object.assign(page, {
          title: b.title,
          version: b.version.number,
          status: b.status ?? page.status ?? 'current',
          storage: cloudMode ? b.body.value : b.body.storage.value,
        });
        return json(res, 200, cloudMode ? cloud(page) : dc(page));
      }
    }

    if (req.method === 'POST' && (path === '/rest/api/content' || path === '/api/v2/pages')) {
      const b = JSON.parse((await body(req)).toString());
      if (findByTitle(b.title).length) return json(res, 400, { message: 'A page with this title already exists' });
      const page: Page = {
        id: String(++state.seq),
        title: b.title,
        spaceKey: space.key,
        status: b.status ?? 'current',
        version: 1,
        storage: cloudMode ? b.body.value : b.body.storage.value,
        parentId: cloudMode ? b.parentId : b.ancestors?.[0]?.id,
      };
      state.pages.set(page.id, page);
      return json(res, 200, cloudMode ? cloud(page) : dc(page));
    }

    if ((m = path.match(/^\/rest\/api\/content\/(\d+)\/child\/attachment(?:\/(\d+)\/data)?$/))) {
      const pageId = m[1];
      const page = state.pages.get(pageId);
      if (req.method === 'GET') {
        if (page?.status === 'draft') {
          return json(res, 404, {
            message: `com.atlassian.confluence.api.service.exceptions.api.NotFoundException: No content found with id : ContentId{id=${pageId}} and status [current], there is a content object with status : draft`,
          });
        }
        const a = state.attachments.get(`${pageId}/${url.searchParams.get('filename')}`);
        return json(res, 200, { results: a ? [{ id: a.id }] : [] });
      }
      if (req.headers['x-atlassian-token'] !== 'no-check') return json(res, 403, { message: 'XSRF check failed' });
      const raw = (await body(req)).toString('latin1');
      const filename = raw.match(/filename="([^"]+)"/)?.[1] ?? '';
      const key = `${pageId}/${filename}`;
      const existing = state.attachments.get(key);
      if (m[2]) existing!.versions++;
      else state.attachments.set(key, { id: String(++state.seq), filename, versions: 1 });
      return json(res, 200, { results: [] });
    }

    json(res, 404, { message: `mock: no route ${req.method} ${url.pathname}` });
  });

  return { server, state };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

describe.each([
  { flavor: 'datacenter', env: (base: string) => ({ CONFLUENCE_BASE_URL: base, CONFLUENCE_AUTH: 'bearer' }) },
  {
    flavor: 'cloud',
    env: (base: string) => ({ CONFLUENCE_BASE_URL: `${base}/wiki`, CONFLUENCE_AUTH: 'basic', CONFLUENCE_EMAIL: 'me@corp.test', CONFLUENCE_FLAVOR: 'cloud' }),
  },
])('connector against Confluence $flavor', ({ env }) => {
  const mock = mockConfluence();
  let app: Server;
  let appUrl = '';
  let token: string | null = 'test-token';
  let audit: AuditEvent[] = [];

  beforeAll(async () => {
    const base = await listen(mock.server);
    const handler = connectorMiddleware(env(base), {
      readToken: async () => token,
      appendAudit: async (e) => void audit.push(e),
      readAudit: async () => audit,
      logError: () => {},
    });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    appUrl = await listen(app);
  });

  afterAll(() => {
    app.close();
    mock.server.close();
  });

  beforeEach(() => {
    token = 'test-token';
    audit = [];
  });

  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: init.json ? 'POST' : 'GET',
      body: init.json ? JSON.stringify(init.json) : undefined,
      ...init,
      headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', ...init.headers },
    });

  const publishReq = (over: Partial<PublishRequest> = {}): PublishRequest => ({
    spaceKey: 'ENG',
    title: 'TAD — Login',
    storage: '<p>v1</p>',
    attachments: [{ filename: 'tad-diagram-1.png', contentType: 'image/png', base64: PNG }],
    context: { draftId: 'd1', mrUrl: 'https://gitlab/x/-/merge_requests/1', jiraKeys: ['ABC-1'] },
    ...over,
  });

  it('reports the logged-in user', async () => {
    const status = await (await call('/status')).json();
    expect(status).toMatchObject({ configured: true, tokenPresent: true, user: 'Test User' });
  });

  it('creates a page with its diagram, then updates it with a version check', async () => {
    const pre = await (await call('/confluence/preflight', { json: { spaceKey: 'ENG', title: 'TAD — Login' } })).json();
    expect(pre).toMatchObject({ space: { key: 'ENG', name: 'Engineering' } });
    expect(pre.existing).toBeUndefined();

    const created = await call('/confluence/publish', { json: publishReq() });
    expect(created.status).toBe(200);
    const { page, action } = await created.json();
    expect(action).toBe('create');
    expect(page.version).toBe(1);
    expect(page.url).toContain(page.id);
    expect(mock.state.attachments.get(`${page.id}/tad-diagram-1.png`)?.versions).toBe(1);

    const pre2 = await (await call('/confluence/preflight', { json: { spaceKey: 'ENG', title: 'TAD — Login', pageId: page.id } })).json();
    expect(pre2.existing).toMatchObject({ id: page.id, version: 1, storage: '<p>v1</p>' });

    const updated = await call('/confluence/publish', { json: publishReq({ storage: '<p>v2</p>', pageId: page.id, expectedVersion: 1 }) });
    expect(updated.status).toBe(200);
    expect((await updated.json()).page.version).toBe(2);
    expect(mock.state.pages.get(page.id)?.storage).toBe('<p>v2</p>');
    expect(mock.state.attachments.get(`${page.id}/tad-diagram-1.png`)?.versions).toBe(2);

    expect(audit.map((a) => [a.action, a.result, a.versionBefore, a.versionAfter])).toEqual([
      ['confluence.create', 'success', undefined, 1],
      ['confluence.update', 'success', 1, 2],
    ]);
    expect(JSON.stringify(audit)).not.toContain('<p>');
  });

  it('saves page as draft without incrementing version, and allows subsequent publishing', async () => {
    // 1. Create initial page as draft
    const draftCreated = await call('/confluence/publish', {
      json: publishReq({ title: 'TAD — Draft Test', storage: '<p>draft v1</p>', asDraft: true }),
    });
    expect(draftCreated.status).toBe(200);
    const { page: draftPage, action: createAction, isDraft: isDraftCreated } = await draftCreated.json();
    expect(createAction).toBe('create');
    expect(isDraftCreated).toBe(true);
    expect(draftPage.version).toBe(1);
    expect(draftPage.status).toBe('draft');

    // 2. Update existing draft as draft (version must stay at 1)
    const draftUpdated = await call('/confluence/publish', {
      json: publishReq({
        title: 'TAD — Draft Test',
        storage: '<p>draft v1 edited</p>',
        pageId: draftPage.id,
        expectedVersion: 1,
        attachments: [{ filename: 'diagram.png', contentType: 'image/png', base64: PNG }],
        asDraft: true,
      }),
    });
    expect(draftUpdated.status).toBe(200);
    const { page: draftPage2, action: updateAction, isDraft: isDraftUpdated } = await draftUpdated.json();
    expect(updateAction).toBe('update');
    expect(isDraftUpdated).toBe(true);
    expect(draftPage2.version).toBe(1); // Not incremented!
    expect(draftPage2.status).toBe('draft');

    // 3. Publish the draft (status becomes current)
    const published = await call('/confluence/publish', {
      json: publishReq({
        title: 'TAD — Draft Test',
        storage: '<p>published v1</p>',
        pageId: draftPage.id,
        expectedVersion: 1,
        asDraft: false,
      }),
    });
    expect(published.status).toBe(200);
    const { page: publishedPage, isDraft: isPublishedDraft } = await published.json();
    expect(isPublishedDraft).toBe(false);
    expect(publishedPage.version).toBe(1);
    expect(publishedPage.status).toBe('current');
  });

  it('searches pages and imports one with mention names resolved', async () => {
    const created = await (await call('/confluence/publish', { json: publishReq({ title: 'TAD - Import Me', storage: '<p>Author <ac:link><ri:user ri:account-id="acc-1" /></ac:link> dan <ac:link><ri:user ri:account-id="ghost" /></ac:link></p>' }) })).json();
    const found = await (await call('/confluence/search?q=import')).json();
    expect(found.map((p: { title: string }) => p.title)).toContain('TAD - Import Me');
    expect(found[0].storage).toBeUndefined();

    const page = await (await call(`/confluence/page?id=${created.page.id}`)).json();
    expect(page.storage).toContain('ri:account-id="acc-1" data-display-name="Willy kurniawan"');
    expect(page.storage).toContain('ri:account-id="ghost" /');
    expect((await call('/confluence/page?id=abc')).status).toBe(400);
    expect((await call('/confluence/search?q=a')).status).toBe(400);
  });

  it('refuses to overwrite a page that changed after the review', async () => {
    const page = [...mock.state.pages.values()].find((p) => p.title === 'TAD — Login')!;
    page.version = 7; // someone edited it in Confluence
    const res = await call('/confluence/publish', { json: publishReq({ storage: '<p>mine</p>', pageId: page.id, expectedVersion: 2 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', currentVersion: 7 });
    expect(page.storage).not.toBe('<p>mine</p>');
    expect(audit[0]).toMatchObject({ result: 'failure', error: 'version-conflict' });
  });

  it('does not silently create a duplicate when the title already exists', async () => {
    const res = await call('/confluence/publish', { json: publishReq() });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('exists');
  });

  it('rejects requests without the client header or from another origin', async () => {
    expect((await call('/status', { headers: { 'X-TLC-Client': '' } })).status).toBe(403);
    expect((await call('/confluence/publish', { json: publishReq(), headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('validates generator job requests without starting the CLI', async () => {
    const bad = await call('/chat/jobs', { json: { draftId: '../../etc', prompt: 'x', tadMarkdown: '# TAD' } });
    expect(bad.status).toBe(400);
    expect((await call('/chat/jobs', { json: { draftId: 'abc', prompt: '', tadMarkdown: '# TAD' } })).status).toBe(400);
    expect((await call('/chat/jobs?id=does-not-exist')).status).toBe(404);
    expect((await call('/chat/jobs/cancel', { json: { id: 'does-not-exist' } })).status).toBe(404);
  });

  it('explains a missing token and blocks writes', async () => {
    token = null;
    const status = await (await call('/status')).json();
    expect(status.tokenPresent).toBe(false);
    expect(status.error).toContain('npm run token:confluence');
    const res = await call('/confluence/publish', { json: publishReq({ title: 'Other' }) });
    expect(res.status).toBe(503);
  });
});
