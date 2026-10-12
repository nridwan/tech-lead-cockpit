import { parseTaskTitle } from '../tad/template';
import { jiraDevStage } from '../tad/progress-report';
import type { MrCheck, Release, ReleaseReport, TicketCoverage } from './types';

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

/** Same service, allowing "core-payment" vs "Core Payment" vs "core-payment-service". */
export function sameService(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y) && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
}

/** Tickets whose CODENAME is one of the release's (case- and punctuation-insensitive). */
export function matchesCodename(summary: string, codenames: string[]): boolean {
  const parsed = parseTaskTitle(summary);
  return Boolean(parsed && codenames.some((c) => norm(c) === norm(parsed.codeName)));
}

export function buildReport(release: Release, tickets: ReleaseTicket[], checks: MrCheck[], now = new Date().toISOString()): ReleaseReport {
  const seen = new Set<string>();
  const coverage: TicketCoverage[] = [];
  const badTitles: ReleaseReport['badTitles'] = [];
  for (const t of tickets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const parsed = parseTaskTitle(t.summary);
    if (!parsed && t.from !== 'tad') badTitles.push({ key: t.key, summary: t.summary });
    coverage.push({
      key: t.key,
      summary: t.summary,
      status: t.status,
      service: t.service || parsed?.service,
      from: t.from,
      inMrs: checks.filter((c) => c.jiraKeys.includes(t.key)).map((c) => c.ref),
      devDone: jiraDevStage({ status: t.status, statusCategory: t.statusCategory } as Parameters<typeof jiraDevStage>[0]) === 'merged',
    });
  }

  // A service needs a live MR (open or merged) into the target branch.
  const live = new Set(checks.filter((c) => c.state === 'opened' || c.state === 'merged').map((c) => c.ref));
  const touched = [...new Set([...release.services.map((s) => s.name), ...coverage.map((c) => c.service).filter((s): s is string => Boolean(s))])];
  const servicesWithoutMr = touched.filter((name) => {
    const svc = release.services.find((s) => sameService(s.name, name));
    return !svc || !svc.mrs.some((m) => live.has(m.ref) || !checks.some((c) => c.ref === m.ref));
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
  const missing = coverage.filter((c) => !c.inMrs.length);
  if (missing.length) warnings.push(`${missing.length} tiket belum ada di MR rilis mana pun.`);
  const notDone = coverage.filter((c) => !c.devDone);
  if (notDone.length) warnings.push(`${notDone.length} tiket belum selesai development di Jira.`);
  for (const s of servicesWithoutMr) warnings.push(`Service ${s} belum punya MR ke ${release.targetBranch}.`);

  return { releaseId: release.id, checkedAt: now, mrs: checks, tickets: coverage, servicesWithoutMr, badTitles, warnings };
}
