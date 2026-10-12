import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityResponse, GitAuthor, ServiceActivity } from '../../src/lib/roster/types.ts';

/**
 * Who worked where recently, from the Services repos' git history (read-only: `git log` only).
 * Used as a familiarity signal when recommending people for a project, never as a verdict.
 */

export const DEFAULT_DAYS = 180;
const CACHE_MS = 10 * 60 * 1000;

/** Commits per author e-mail in one repo. */
export type RepoAuthors = Map<string, { name: string; commits: number }>;
export type GitLogRunner = (repo: string, days: number) => Promise<string>;

export const runGitLog: GitLogRunner = (repo, days) =>
  new Promise((done) => {
    const child = execFile('git', ['-C', repo, 'log', '--all', '--no-merges', `--since=${days}.days.ago`, '--format=%ae%x09%an'], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => done(err ? '' : stdout));
    child.stdin?.end();
  });

export function parseGitLog(out: string): RepoAuthors {
  const authors: RepoAuthors = new Map();
  for (const line of out.split('\n')) {
    const [rawEmail, ...rest] = line.split('\t');
    const email = rawEmail?.trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    const a = authors.get(email) ?? { name: rest.join('\t').trim() || email, commits: 0 };
    a.commits++;
    authors.set(email, a);
  }
  return authors;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Repo folder for a service name from the TAD ("Core Payment", "core-payment-service", …):
 * exact match after normalising, else the closest folder that contains the name or is contained
 * in it.
 */
export function matchRepo(service: string, repos: string[]): string | undefined {
  const s = norm(service);
  if (!s) return undefined;
  const exact = repos.find((r) => norm(r) === s);
  if (exact) return exact;
  const near = repos.filter((r) => {
    const n = norm(r);
    return n.length >= 3 && (n.includes(s) || s.includes(n));
  });
  return near.sort((a, b) => Math.abs(norm(a).length - s.length) - Math.abs(norm(b).length - s.length) || a.localeCompare(b))[0];
}

export class GitActivity {
  private cache = new Map<string, { at: number; repos: Map<string, RepoAuthors> }>();

  constructor(
    private readonly run: GitLogRunner = runGitLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Authors per git repo directly under the root, cached for a few minutes. */
  async repos(root: string, days = DEFAULT_DAYS): Promise<Map<string, RepoAuthors>> {
    const key = `${root}|${days}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.repos;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const names: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && (await stat(join(root, e.name, '.git')).catch(() => null))) names.push(e.name);
    }
    const repos = new Map<string, RepoAuthors>();
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(names.slice(i, i + 8).map(async (n) => repos.set(n, parseGitLog(await this.run(join(root, n), days)))));
    }
    this.cache.set(key, { at: this.now(), repos });
    return repos;
  }

  /** Everyone who committed recently, most active first (to map git e-mails to roster members). */
  async authors(root: string, days = DEFAULT_DAYS): Promise<GitAuthor[]> {
    const byEmail = new Map<string, GitAuthor>();
    for (const [repo, authors] of await this.repos(root, days)) {
      for (const [email, a] of authors) {
        const g = byEmail.get(email) ?? { email, name: a.name, commits: 0, repos: [] };
        g.commits += a.commits;
        g.repos.push(repo);
        byEmail.set(email, g);
      }
    }
    return [...byEmail.values()].sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email)).slice(0, 500);
  }

  /** Commits per e-mail in the repo of each service. */
  async activity(root: string, services: string[], days = DEFAULT_DAYS): Promise<ActivityResponse> {
    const repos = await this.repos(root, days);
    const names = [...repos.keys()];
    const out: ServiceActivity[] = [];
    for (const service of [...new Set(services.map((s) => s.trim()).filter(Boolean))].slice(0, 50)) {
      const repo = matchRepo(service, names);
      const authors = repo ? repos.get(repo)! : new Map();
      const byEmail: Record<string, number> = {};
      let total = 0;
      for (const [email, a] of authors) {
        byEmail[email] = a.commits;
        total += a.commits;
      }
      out.push({ service, repo, total, byEmail });
    }
    return { days, services: out };
  }
}
