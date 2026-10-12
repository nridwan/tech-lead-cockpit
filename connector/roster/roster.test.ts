// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectorMiddleware } from '../dev-connector.ts';
import { validateProject } from '../estimate/manager.ts';
import { GitActivity, matchRepo, parseGitLog } from './git-activity.ts';
import { RosterInputError, RosterStore, validateMember } from './store.ts';

const LOG = ['citra@example.com\tCitra', 'CITRA@example.com\tCitra', 'budi@example.com\tBudi', 'bukan-email\tX', ''].join('\n');

describe('validateMember', () => {
  it('normalises e-mails, capacity and leave, and rejects bad input', () => {
    const m = validateMember({ name: ' Citra ', role: 'BACKEND', gitEmails: ['Citra@Example.com', 'citra@example.com', 'salah'], capacity: 0.75, leaves: [{ start: '2026-11-02', end: '2026-11-03', note: 'nikah' }, { start: '2026-10-20', end: '2026-10-20' }] });
    expect(m).toMatchObject({ name: 'Citra', gitEmails: ['citra@example.com'], capacity: 0.8, active: true });
    expect(m.leaves.map((l) => l.start)).toEqual(['2026-10-20', '2026-11-02']);
    expect(() => validateMember({ name: '', role: 'BACKEND' })).toThrow(RosterInputError);
    expect(() => validateMember({ name: 'X', role: 'QA' as never })).toThrow(/Role/);
    expect(() => validateMember({ name: 'X', role: 'BACKEND', leaves: [{ start: '2026-10-05', end: '2026-10-01' }] })).toThrow(/sebelum/);
  });
});

describe('RosterStore', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-roster-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves, updates, keeps one member per Jira account and removes', async () => {
    const file = join(dir, 'team-roster.json');
    const store = new RosterStore(file);
    expect(await store.list()).toEqual([]);
    let list = await store.save({ name: 'Budi', role: 'BACKEND', jira: { accountId: 'acc-1', displayName: 'Budi' } });
    const id = list[0].id;
    list = await store.save({ id, name: 'Budi S', role: 'MOBILE-FE', jira: { accountId: 'acc-1', displayName: 'Budi' } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: 'Budi S', role: 'MOBILE-FE' });
    await expect(store.save({ name: 'Lain', role: 'BACKEND', jira: { accountId: 'acc-1', displayName: 'Budi' } })).rejects.toThrow(/sudah dipakai/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // A fresh store reads the file back.
    expect((await new RosterStore(file).list())[0].name).toBe('Budi S');
    expect(await store.remove(id)).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8')).members).toEqual([]);
  });
});

describe('git activity', () => {
  it('parses author e-mails case-insensitively and skips junk', () => {
    const a = parseGitLog(LOG);
    expect([...a.entries()]).toEqual([
      ['citra@example.com', { name: 'Citra', commits: 2 }],
      ['budi@example.com', { name: 'Budi', commits: 1 }],
    ]);
  });

  it('matches service names from the TAD to repo folders', () => {
    const repos = ['core-payment', 'core-payment-gateway', 'mobile-app', 'cms-web', 'id'];
    expect(matchRepo('Core Payment', repos)).toBe('core-payment');
    expect(matchRepo('payment-gateway', repos)).toBe('core-payment-gateway');
    expect(matchRepo('mobile', repos)).toBe('mobile-app');
    expect(matchRepo('notification', repos)).toBeUndefined();
    expect(matchRepo('', repos)).toBeUndefined();
  });

  it('reads only git repos under the root, caches, and maps services to commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tlc-services-'));
    try {
      for (const r of ['core-payment', 'mobile-app']) await mkdir(join(root, r, '.git'), { recursive: true });
      await mkdir(join(root, 'not-a-repo'));
      const calls: string[] = [];
      let now = 0;
      const git = new GitActivity(
        async (repo, days) => (calls.push(`${repo.split('/').pop()}:${days}`), repo.endsWith('core-payment') ? LOG : 'dewi@example.com\tDewi\n'),
        () => now,
      );
      const act = await git.activity(root, ['Core Payment', 'notification', 'Core Payment'], 90);
      expect(act).toEqual({
        days: 90,
        services: [
          { service: 'Core Payment', repo: 'core-payment', total: 3, byEmail: { 'citra@example.com': 2, 'budi@example.com': 1 } },
          { service: 'notification', repo: undefined, total: 0, byEmail: {} },
        ],
      });
      expect((await git.authors(root, 90)).map((a) => [a.email, a.commits, a.repos])).toEqual([
        ['citra@example.com', 2, ['core-payment']],
        ['budi@example.com', 1, ['core-payment']],
        ['dewi@example.com', 1, ['mobile-app']],
      ]);
      expect(calls.sort()).toEqual(['core-payment:90', 'mobile-app:90']);
      now = 11 * 60 * 1000;
      await git.authors(root, 90);
      expect(calls).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('estimate projects keep the roster link', () => {
  it('keeps a valid memberId on developers and drops a bad one', () => {
    const p = validateProject({ name: 'P', startDate: '2026-10-05', developers: [{ id: 'd1', name: 'Andi', role: 'BACKEND', allocation: 1, memberId: 'm-1' }, { id: 'd2', name: 'X', role: 'BACKEND', allocation: 1, memberId: '../x' }] as never });
    expect(p.developers[0].memberId).toBe('m-1');
    expect(p.developers[1].memberId).toBeUndefined();
  });
});

describe('connector /roster routes', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-roster-routes-'));
    await mkdir(join(dir, 'services', 'core-payment', '.git'), { recursive: true });
    const store = new RosterStore(join(dir, 'team-roster.json'));
    const git = new GitActivity(async () => LOG);
    const handler = connectorMiddleware(
      {},
      {
        readToken: async () => null,
        appendAudit: async () => {},
        readAudit: async () => [],
        logError: () => {},
        roster: () => ({
          store,
          git,
          resolveRoot: async (input?: string) => {
            if (input === 'missing') throw new Error('Folder codebase tidak ditemukan: missing');
            return join(dir, 'services');
          },
        }),
      },
    );
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

  it('manages members and reports git activity', async () => {
    expect(await (await call('/roster')).json()).toEqual([]);
    expect((await call('/roster', { member: { name: '', role: 'BACKEND' } })).status).toBe(400);
    const list = await (await call('/roster', { member: { name: 'Citra', role: 'BACKEND', gitEmails: ['citra@example.com'] } })).json();
    expect(list[0].name).toBe('Citra');

    const authors = await (await call('/roster/git-authors?days=90')).json();
    expect(authors[0]).toMatchObject({ email: 'citra@example.com', commits: 2 });

    const act = await (await call('/roster/activity', { services: ['core-payment'], days: 3 })).json();
    // Fewer than 7 days falls back to the default window.
    expect(act).toMatchObject({ days: 180, services: [{ service: 'core-payment', repo: 'core-payment', total: 3 }] });
    expect(await (await call('/roster/activity', { services: ['x'], root: 'missing' })).json()).toMatchObject({ services: [], error: expect.stringContaining('tidak ditemukan') });
    expect((await call('/roster/git-authors?root=missing')).status).toBe(400);

    expect(await (await call('/roster/delete', { id: list[0].id })).json()).toEqual([]);
  });
});
