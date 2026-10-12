import { parseTaskTitle } from '../tad/template';
import { jiraDevStage } from '../tad/progress-report';
import { jiraKeysIn } from './checks';
import type { MrCheck, OutOfScope, Release, ReleaseReport, TicketCoverage } from './types';

/**
 * Puts the MR checks and the release's tickets together: which tickets reached a release MR,
 * which services have no MR into the target branch, titles that break the naming rule, and what
 * still blocks the release. Pure: the connector fetches, this decides.
 */

export interface ReleaseTicket {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  /** Service from the TAD row, else from the [TYPE][SERVICE][CODENAME] title. */
  service?: string;
  from: TicketCoverage['from'];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Words that only describe a repo, so "core-payment" and "core-payment-service" are one service. */
export const GENERIC_SUFFIXES = ['service', 'svc', 'api', 'be', 'backend', 'app', 'server'];

/**
 * Same service: equal once case and punctuation are ignored, or different only by a generic
 * word ("core-payment" = "Core Payment" = "core-payment-service"). Not "core-tcico" vs
 * "core-tcico-ultimate": those are two repos.
 */
export function sameService(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  const rest = long.startsWith(short) ? long.slice(short.length) : long.endsWith(short) ? long.slice(0, long.length - short.length) : null;
  return rest !== null && GENERIC_SUFFIXES.includes(rest);
}

/** Leading [TAG][TAG]… of a ticket title. */
export function ticketTags(summary: string): string[] {
  const m = summary.trim().match(/^(\s*\[[^\]]+\])+/);
  return m ? [...m[0].matchAll(/\[([^\]]+)\]/g)].map((x) => x[1].trim()) : [];
}

/** Platforms that stand in for the service in mobile/web titles like [IOS][CODENAME][UI] Nama. */
const PLATFORMS = new Set(['android', 'ios', 'flutter', 'mobile', 'mobilefe', 'web', 'webfe', 'cms', 'frontend', 'fe']);

/** Tickets with one of the release's CODENAMEs in any of their title tags. */
export function matchesCodename(summary: string, codenames: string[]): boolean {
  const want = new Set(codenames.map(norm));
  return ticketTags(summary).some((t) => want.has(norm(t)));
}

/**
 * Service a ticket belongs to: [TYPE][SERVICE][CODENAME] - Name → SERVICE; the mobile layout
 * [PLATFORM][CODENAME][KIND] Name → the platform (ANDROID, IOS…).
 */
export function ticketService(summary: string, codenames: string[] = []): string | undefined {
  const tags = ticketTags(summary);
  const want = new Set(codenames.map(norm));
  const at = tags.findIndex((t) => want.has(norm(t)));
  if (at >= 2) return tags[at - 1];
  if (at === 1 && PLATFORMS.has(norm(tags[0]))) return tags[0];
  return parseTaskTitle(summary)?.service;
}

/**
 * Jira keys an MR carries in its code: its commits (merge commits name the feature branches) and
 * its source branch. Not the MR title or description: a description listing tickets says nothing
 * about the code.
 */
export function codeKeys(c: MrCheck): string[] {
  return [...new Set([...Object.keys(c.keyCommits ?? {}), ...jiraKeysIn(c.sourceBranch)])];
}

const live = (c: MrCheck) => !c.error && (c.state === 'opened' || c.state === 'merged');

/**
 * @param extra summary/status of keys found in the code but not in the scope (fetched by the caller).
 */
export function buildReport(release: Release, tickets: ReleaseTicket[], checks: MrCheck[], now = new Date().toISOString(), extra: Map<string, { summary: string; status: string }> = new Map()): ReleaseReport {
  const keysByMr = new Map(checks.filter(live).map((c) => [c.ref, new Set(codeKeys(c))]));
  const seen = new Set<string>();
  const coverage: TicketCoverage[] = [];
  const badTitles: ReleaseReport['badTitles'] = [];
  for (const t of tickets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const parsed = parseTaskTitle(t.summary);
    // Tags in another order (e.g. mobile [IOS][CODENAME][UI]) are a convention, not a broken title.
    if (!parsed && t.from !== 'tad' && ticketTags(t.summary).length < 3) badTitles.push({ key: t.key, summary: t.summary });
    coverage.push({
      key: t.key,
      summary: t.summary,
      status: t.status,
      service: t.service || parsed?.service,
      from: t.from,
      inMrs: [...keysByMr].filter(([, keys]) => keys.has(t.key)).map(([ref]) => ref),
      devDone: jiraDevStage({ status: t.status, statusCategory: t.statusCategory } as Parameters<typeof jiraDevStage>[0]) === 'merged',
    });
  }

  // A service needs a live MR (open or merged) into the target branch.
  const liveRefs = new Set(checks.filter((c) => c.state === 'opened' || c.state === 'merged').map((c) => c.ref));
  const touched = [...new Set([...release.services.map((s) => s.name), ...coverage.map((c) => c.service).filter((s): s is string => Boolean(s))])];
  const servicesWithoutMr = touched.filter((name) => {
    const svc = release.services.find((s) => sameService(s.name, name));
    return !svc || !svc.mrs.some((m) => liveRefs.has(m.ref) || !checks.some((c) => c.ref === m.ref));
  });

  const warnings: string[] = [];
  for (const c of checks) {
    if (c.error) {
      warnings.push(`${c.ref}: ${c.error}`);
      continue;
    }
    if (c.targetBranch !== release.targetBranch) warnings.push(`${c.ref} menuju ${c.targetBranch}, bukan ${release.targetBranch}.`);
    if (c.state === 'closed') warnings.push(`${c.ref} sudah ditutup tanpa merge.`);
    if (c.state !== 'opened') continue;
    if (c.draft) warnings.push(`${c.ref} masih draft.`);
    if (c.hasConflicts) warnings.push(`${c.ref} punya konflik dengan ${c.targetBranch}.`);
    if (c.pipeline && !['success', 'skipped', 'manual'].includes(c.pipeline)) warnings.push(`${c.ref}: pipeline ${c.pipeline}.`);
    if (c.approvals.count < release.minApprovals) warnings.push(`${c.ref}: ${c.approvals.count}/${release.minApprovals} approval.`);
  }
  // Changes carried along: keys in the code that are not in the scope.
  const inScope = new Set(coverage.map((c) => c.key));
  const accepted = new Set((release.accepted ?? []).map((a) => a.key));
  const carried = new Map<string, OutOfScope>();
  for (const c of checks.filter(live)) {
    for (const key of keysByMr.get(c.ref) ?? []) {
      if (inScope.has(key)) continue;
      const info = extra.get(key);
      const o = carried.get(key) ?? { key, ...(info ? { summary: info.summary, status: info.status } : {}), ...(info && parseTaskTitle(info.summary) ? { codename: parseTaskTitle(info.summary)!.codeName } : {}), mrs: [], commits: [] };
      o.mrs.push(c.ref);
      for (const t of c.keyCommits?.[key] ?? []) if (o.commits.length < 5 && !o.commits.includes(t)) o.commits.push(t);
      carried.set(key, o);
    }
  }
  const outOfScope = [...carried.values()].filter((o) => !accepted.has(o.key)).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const commitsWithoutKey = checks.filter(live).reduce((n, c) => n + c.commitsWithoutKey.length, 0);
  const missing = coverage.filter((c) => !c.inMrs.length);
  if (missing.length) warnings.push(`${missing.length} tiket scope belum ada di kode MR rilis mana pun.`);
  if (outOfScope.length) warnings.push(`${outOfScope.length} tiket di luar scope ikut terbawa: ${outOfScope.map((o) => o.key).join(', ')}.`);
  if (commitsWithoutKey) warnings.push(`${commitsWithoutKey} commit tanpa Jira key: scope-nya tidak bisa dipastikan.`);
  const notDone = coverage.filter((c) => !c.devDone);
  if (notDone.length) warnings.push(`${notDone.length} tiket belum selesai development di Jira.`);
  for (const s of servicesWithoutMr) warnings.push(`Service ${s} belum punya MR ke ${release.targetBranch}.`);

  const scope = {
    tickets: coverage.length,
    inCode: coverage.length - missing.length,
    missing: missing.length,
    carried: outOfScope.length,
    accepted: [...carried.keys()].filter((k) => accepted.has(k)).length,
    commitsWithoutKey,
    matched: coverage.length > 0 && !missing.length && !outOfScope.length && !commitsWithoutKey,
  };
  return { releaseId: release.id, checkedAt: now, mrs: checks, tickets: coverage, servicesWithoutMr, badTitles, outOfScope, scope, warnings };
}
