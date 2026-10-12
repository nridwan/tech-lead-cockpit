import type { MrCommit } from '../gitlab/types';
import { jiraKeysIn } from './checks';

/**
 * A clean release branch when the usual source (staging) also holds work outside the release:
 * start from the target (master) and cherry-pick only the scope's changes. Reads the source's
 * first-parent line oldest first; a merge commit counts with everything its branch brought in
 * (its title and the feature commits behind it), so one pick takes a whole feature.
 */

export interface BranchPick {
  sha: string;
  shortId: string;
  title: string;
  /** Merge commit: picked against its first parent (git cherry-pick -m 1). */
  merge: boolean;
  keys: string[];
  /** Picked by default (all its keys are in scope). */
  include: boolean;
  /** Why it is left out by default. */
  reason?: 'out-of-scope' | 'mixed' | 'no-key';
  outsideKeys: string[];
}

export interface ReleaseBranchPlan {
  base: string;
  branch: string;
  /** Every first-parent commit of the source, oldest first, with the default choice. */
  commits: BranchPick[];
}

/** First-parent line of the compared commits, newest first: the source's own history. */
function firstParentLine(commits: MrCommit[]): MrCommit[] {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Set(commits.flatMap((c) => c.parentIds ?? []));
  // The head is the commit no other compared commit points to; with several, the newest.
  const heads = commits.filter((c) => !children.has(c.id));
  let cur: MrCommit | undefined = heads.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const line: MrCommit[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    line.push(cur);
    cur = byId.get(cur.parentIds?.[0] ?? '');
  }
  return line;
}

/** Commits a merge brought in: reachable from its second parent without crossing the first-parent line. */
function mergedCommits(merge: MrCommit, byId: Map<string, MrCommit>, line: Set<string>): MrCommit[] {
  const out: MrCommit[] = [];
  const stack = [...(merge.parentIds ?? []).slice(1)];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || line.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    out.push(c);
    stack.push(...(c.parentIds ?? []));
  }
  return out;
}

export function planReleaseBranch(commits: MrCommit[], scopeKeys: Set<string>, opts: { base: string; branch: string }): ReleaseBranchPlan {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const line = firstParentLine(commits);
  const lineIds = new Set(line.map((c) => c.id));
  const picks: BranchPick[] = line.reverse().map((c) => {
    const merge = (c.parentIds?.length ?? 0) > 1;
    const brought = merge ? mergedCommits(c, byId, lineIds) : [];
    const keys = [...new Set([...jiraKeysIn(c.title), ...brought.flatMap((b) => jiraKeysIn(b.title))])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const outsideKeys = keys.filter((k) => !scopeKeys.has(k));
    const inside = keys.filter((k) => scopeKeys.has(k));
    const reason: BranchPick['reason'] = !keys.length ? 'no-key' : outsideKeys.length && inside.length ? 'mixed' : outsideKeys.length ? 'out-of-scope' : undefined;
    return { sha: c.id, shortId: c.shortId, title: c.title, merge, keys, include: !reason, ...(reason ? { reason } : {}), outsideKeys };
  });
  return { base: opts.base, branch: opts.branch, commits: picks };
}

const slugBranch = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Suggested release branch: release/<codename>[-<version>], else release/<version>, else
 * release/<release name>. Never the release date: dates move.
 */
export function releaseBranchName(release: { version: string; codenames: string[]; name: string }): string {
  const code = slugBranch(release.codenames[0] ?? '');
  const version = slugBranch(release.version);
  const name = code ? (version ? `${code}-${version}` : code) : version || slugBranch(release.name) || 'rilis';
  return `release/${name}`;
}

/** The same steps for a terminal, for teams that prefer to cherry-pick locally. */
export function releaseBranchCommands(plan: { base: string; branch: string }, picks: BranchPick[]): string {
  return [
    'git fetch origin',
    `git checkout -b ${plan.branch} origin/${plan.base}`,
    ...picks.map((p) => `git cherry-pick ${p.merge ? '-m 1 ' : ''}${p.sha}   # ${p.title.replace(/\s+/g, ' ').slice(0, 70)}`),
    `git push -u origin ${plan.branch}`,
  ].join('\n');
}
