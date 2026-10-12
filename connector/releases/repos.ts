import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * GitLab project path of every repo in the Services folder, from its `origin` remote (read-only:
 * `git remote get-url`). Lets a service name from the tickets find its MRs without setup.
 */

export type RemoteRunner = (repo: string) => Promise<string>;

export const runRemote: RemoteRunner = (repo) =>
  new Promise((done) => {
    const child = execFile('git', ['-C', repo, 'remote', 'get-url', 'origin'], { timeout: 10_000 }, (err, stdout) => done(err ? '' : stdout.trim()));
    child.stdin?.end();
  });

/**
 * group/sub/repo from https://host/group/sub/repo(.git), git@host:group/repo(.git) or
 * ssh://git@host:port/group/repo.git; only for the configured GitLab host.
 */
export function projectPathFromRemote(remote: string, gitlabBaseUrl: string): string | undefined {
  let host = '';
  try {
    host = new URL(gitlabBaseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const r = remote.trim();
  let m = r.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (!m) m = r.match(/^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (!m || m[1].toLowerCase() !== host) return undefined;
  // A GitLab under a sub path (https://host/gitlab/group/repo) keeps the sub path out.
  const base = new URL(gitlabBaseUrl).pathname.replace(/^\/+|\/+$/g, '');
  const path = base && m[2].startsWith(`${base}/`) ? m[2].slice(base.length + 1) : m[2];
  return /^[\w.-]+(\/[\w.-]+)+$/.test(path) ? path : undefined;
}

/** Repo folder name → GitLab project path. */
export async function repoProjectPaths(root: string, gitlabBaseUrl: string, run: RemoteRunner = runRemote): Promise<Record<string, string>> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Record<string, string> = {};
  const repos: string[] = [];
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && (await stat(join(root, e.name, '.git')).catch(() => null))) repos.push(e.name);
  for (let i = 0; i < repos.length; i += 8) {
    await Promise.all(
      repos.slice(i, i + 8).map(async (name) => {
        const path = projectPathFromRemote(await run(join(root, name)), gitlabBaseUrl);
        if (path) out[name] = path;
      }),
    );
  }
  return out;
}
