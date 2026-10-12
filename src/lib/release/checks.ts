import type { MrDetail } from '../gitlab/types';
import type { MrCheck } from './types';

/**
 * What a release MR brings to the server, from its diff and commits. No AI: file paths and
 * patterns only, so the result is predictable and the same on every run.
 */

export const JIRA_KEY = /\b(?!(?:UTF|ISO|SHA|TLS|SSL|HTTP|RFC|PCI|AES|RSA|MD|CVE)-)[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

/** .env, .env.example, .env.staging.sample, config/env.example, … */
const ENV_FILE = /(^|\/)(\.env(\.[\w-]+)*|[\w-]*\.?env\.(example|sample|template|dist))$/i;
const ENV_LINE = /^\+\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/;
const ENV_LINE_REMOVED = /^-\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/;

/** Ways code reads an env variable, across the usual stacks. */
const ENV_READS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{1,80})\b/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{1,80})['"]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{1,80})\b/g,
  /os\.(?:Getenv|LookupEnv)\("([A-Z][A-Z0-9_]{1,80})"\)/g,
  /os\.(?:getenv|environ\.get)\(\s*['"]([A-Z][A-Z0-9_]{1,80})['"]/g,
  /os\.environ\[['"]([A-Z][A-Z0-9_]{1,80})['"]\]/g,
  /\b(?:env|getenv)\(\s*['"]([A-Z][A-Z0-9_]{1,80})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{1,80})"\)/g,
  /\b(?:env|envconfig):"([A-Z][A-Z0-9_]{1,80})[",]/g,
];
/** ${VAR} / ${VAR:default} in config files. */
const CONFIG_FILE = /\.(ya?ml|properties|toml|ini|conf)$/i;
const CONFIG_READ = /\$\{([A-Z][A-Z0-9_]{1,80})(?::[^}]*)?\}/g;

const MIGRATION_DIR = /(^|\/)(migrations?|migrate|db\/migrate|database\/migrations|flyway|liquibase|changelogs?|prisma\/migrations|alembic\/versions)\//i;
const MIGRATION_FILE = /(^|\/)(V\d+(\.\d+)*__[^/]+\.sql|\d{6,}[_-][^/]+\.(sql|go|js|ts|py|php|rb))$/i;
const TEST_DIR = /(^|\/)(test|tests|__tests__|testdata|fixtures?|mocks?)\//i;
const MODEL_PATH = /(^|\/)(models?|entit(y|ies)|schemas?)\/|\.(model|entity)\.(ts|js)$|_model\.go$/i;

export const isMigration = (path: string) => MIGRATION_DIR.test(path) || MIGRATION_FILE.test(path);

const uniq = (xs: string[]) => [...new Set(xs)];

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
}

export function jiraKeysIn(text: string): string[] {
  return uniq(text.match(JIRA_KEY) ?? []);
}

/** Env names a diff of a .env-like file adds (a changed value is not new). */
export function envAddedIn(diff: string): string[] {
  const lines = diff.split('\n');
  const removed = new Set(lines.map((l) => l.match(ENV_LINE_REMOVED)?.[1]).filter(Boolean) as string[]);
  return uniq(lines.map((l) => l.match(ENV_LINE)?.[1]).filter((k): k is string => Boolean(k) && !removed.has(k!)));
}

/** Env names a code diff starts reading. */
export function envReadsIn(path: string, diff: string): string[] {
  const out: string[] = [];
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).join('\n');
  const patterns = CONFIG_FILE.test(path) ? [...ENV_READS, CONFIG_READ] : ENV_READS;
  for (const line of addedLines(diff)) {
    for (const re of patterns) {
      for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
        // Moved lines (also removed in the same diff) are not new reads.
        if (!removed.includes(m[1])) out.push(m[1]);
      }
    }
  }
  return uniq(out);
}

export function checkMr(mr: MrDetail): MrCheck {
  const live = mr.changes.filter((c) => !c.deletedFile);
  const envAdded = uniq(live.filter((c) => ENV_FILE.test(c.newPath)).flatMap((c) => envAddedIn(c.diff)));
  const envReadInCode = uniq(live.filter((c) => !ENV_FILE.test(c.newPath)).flatMap((c) => envReadsIn(c.newPath, c.diff))).filter((k) => !envAdded.includes(k));
  const migrations = live.filter((c) => isMigration(c.newPath)).map((c) => (c.newFile ? c.newPath : `${c.newPath} (migrasi lama diubah)`));
  const sqlOutside = live.filter((c) => /\.sql$/i.test(c.newPath) && !isMigration(c.newPath) && !TEST_DIR.test(c.newPath)).map((c) => c.newPath);
  const modelWithoutMigration = migrations.length ? [] : live.filter((c) => MODEL_PATH.test(c.newPath) && !TEST_DIR.test(c.newPath)).map((c) => c.newPath).slice(0, 10);
  const commitsWithoutKey = mr.commits.filter((c) => !/^Merge\b/i.test(c.title) && !jiraKeysIn(c.title).length).map((c) => c.title);
  const jiraKeys = jiraKeysIn([mr.title, mr.sourceBranch, mr.description ?? '', ...mr.commits.map((c) => c.title)].join('\n'));
  const keyCommits: Record<string, string[]> = {};
  for (const c of mr.commits) {
    for (const k of jiraKeysIn(c.title)) {
      const list = (keyCommits[k] ??= []);
      if (list.length < 5) list.push(c.title);
    }
  }
  return {
    ref: mr.ref,
    title: mr.title,
    webUrl: mr.webUrl,
    state: mr.state,
    draft: mr.draft,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    author: mr.author.name,
    pipeline: mr.pipeline?.status,
    approvals: { count: mr.approvals?.approvedBy.length ?? 0, by: mr.approvals?.approvedBy ?? [], required: mr.approvals?.required },
    hasConflicts: mr.hasConflicts,
    envAdded,
    envReadInCode,
    migrations,
    sqlOutside,
    modelWithoutMigration,
    commitsWithoutKey,
    jiraKeys,
    keyCommits,
    diffTruncated: mr.diffTruncated || mr.changes.some((c) => c.truncated),
  };
}
