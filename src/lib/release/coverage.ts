import { parseTaskTitle } from '../tad/template';
import { jiraDevStage } from '../tad/progress-report';
import { jiraKeysIn } from './checks';
import type { AiTicketVerdict, CodeEvidence, CodeSource, MrCheck, OutOfScope, Release, ReleaseReport, TicketCoverage } from './types';

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
  /** Endpoints from the ticket's TAD Detail Task, to find it in the code. */
  endpoints?: string[];
  /** The TAD Detail Task as plain text, for the AI. */
  detail?: string;
  /** The TAD row's service when the Jira title names another one (also checked). */
  alsoService?: string;
}

/** Type tags of front-end work, and the repo suffixes a front-end of a service goes by. */
const FRONT_TYPES = new Set(['frontend', 'fe', 'webfe', 'web', 'cms']);
export const FRONT_SUFFIXES = ['frontend', 'fe', 'web'];

/** A ticket's type: its first title tag, upper case ([BACKEND][X]… → BACKEND, [IOS][CODE]… → IOS). */
export const ticketType = (summary: string) => (ticketTags(summary)[0] ?? '').toUpperCase();

/** Is the ticket's type in the release's scope? No filter, or no type tag, = in. */
export function typeInScope(summary: string, types: string[] | undefined): boolean {
  if (!types?.length) return true;
  const t = ticketType(summary);
  return !t || types.some((x) => x.toUpperCase() === t);
}

/** A [FRONTEND]/[FE]/[WEB]/[CMS] ticket. */
export const isFrontTicket = (summary: string) => FRONT_TYPES.has(norm(ticketTags(summary)[0] ?? ''));

/**
 * Does the ticket belong to this service? The service its Jira title names, or the TAD row's (a
 * TAD row can put a worker task under the main service). A [FRONTEND][X] ticket belongs to X's
 * front-end repo (x-frontend, x-fe, x-web) and, when the release has one (`among`), only to it:
 * the back-end X is then not its service. `orNone`: a ticket naming no service matches.
 */
export function belongsTo(t: { service?: string; alsoService?: string; summary?: string }, name: string, orNone = false, among: string[] = []): boolean {
  if (!t.service && !t.alsoService) return orNone;
  const front = Boolean(t.summary) && isFrontTicket(t.summary!);
  const frontOf = (x: string, n: string) => FRONT_SUFFIXES.some((sfx) => sameService(`${x}-${sfx}`, n));
  return [t.service, t.alsoService].some((x) => {
    if (!x) return false;
    if (front && frontOf(x, name)) return true;
    if (!sameService(x, name)) return false;
    return !(front && among.some((n) => frontOf(x, n)));
  });
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
 * Jira keys an MR carries in its commits (merge commits name the feature branches) and its source
 * branch. Not the MR title or description: a description listing tickets says nothing about the
 * code. Branch names are often lowercase (feature/mu-1859-x): with `prefixes` (the scope's Jira
 * projects) those count too.
 */
export function codeKeys(c: MrCheck, prefixes: Iterable<string> = []): string[] {
  const known = new Set(prefixes);
  const lower = known.size ? jiraKeysIn(c.sourceBranch.toUpperCase()).filter((k) => known.has(k.split('-')[0])) : [];
  return [...new Set([...Object.keys(c.keyCommits ?? {}), ...jiraKeysIn(c.sourceBranch), ...lower])];
}

/** What the connector read from the code: per service source, and per ticket key what showed. */
export interface CodeFindings {
  sources: CodeSource[];
  evidence: Map<string, CodeEvidence[]>;
  /** AI verdicts per ticket key: they decide over the pattern match. */
  ai?: Map<string, AiTicketVerdict>;
}

const live = (c: MrCheck) => !c.error && (c.state === 'opened' || c.state === 'merged');

/**
 * @param extra summary/status of keys found in the code but not in the scope (fetched by the caller).
 */
export function buildReport(
  release: Release,
  tickets: ReleaseTicket[],
  checks: MrCheck[],
  now = new Date().toISOString(),
  extra: Map<string, { summary: string; status: string }> = new Map(),
  code: CodeFindings = { sources: [], evidence: new Map() },
): ReleaseReport {
  const prefixes = new Set(tickets.map((t) => t.key.split('-')[0]));
  const keysByMr = new Map(checks.filter(live).map((c) => [c.ref, new Set(codeKeys(c, prefixes))]));
  const seen = new Set<string>();
  const coverage: TicketCoverage[] = [];
  const badTitles: ReleaseReport['badTitles'] = [];
  for (const t of tickets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    const parsed = parseTaskTitle(t.summary);
    // Tags in another order (e.g. mobile [IOS][CODENAME][UI]) are a convention, not a broken title.
    if (!parsed && t.from !== 'tad' && ticketTags(t.summary).length < 3) badTitles.push({ key: t.key, summary: t.summary });
    const service = t.service || parsed?.service;
    const evidence = code.evidence.get(t.key) ?? [];
    const byKey = [...keysByMr].filter(([, keys]) => keys.has(t.key)).map(([ref]) => ref);
    // The code decides; a key in a commit only adds where it is.
    const found = [...new Set([...evidence.filter((e) => e.strength === 'strong').map((e) => e.ref), ...byKey])];
    const names = release.services.map((s) => s.name);
    const noRepo = Boolean(service || t.alsoService) && !release.services.some((s) => belongsTo({ service, alsoService: t.alsoService, summary: t.summary }, s.name, false, names));
    // The AI's reading decides when there is one: "ada" is in the code, "sebagian" needs a look,
    // "tidak" is missing unless the pattern match found it (then the two disagree: needs a look).
    const ai = code.ai?.get(t.key);
    const own = release.services.filter((s) => belongsTo({ service, alsoService: t.alsoService, summary: t.summary }, s.name, false, names)).map((s) => s.name);
    const aiRefs = (code.sources ?? []).filter((x) => own.includes(x.service) && !x.error).map((x) => x.ref);
    const inMrs = !ai ? found : ai.verdict === 'ada' ? [...new Set([...found, ...(found.length ? [] : aiRefs.slice(0, 1))])] : [];
    const unsure = !ai ? !found.length && evidence.length > 0 : ai.verdict === 'sebagian' || (ai.verdict === 'tidak' && found.length > 0);
    coverage.push({
      key: t.key,
      summary: t.summary,
      status: t.status,
      service,
      ...(t.alsoService ? { alsoService: t.alsoService } : {}),
      from: t.from,
      inMrs,
      ...(evidence.length ? { code: evidence } : {}),
      ...(byKey.length ? { byKey } : {}),
      ...(unsure ? { unsure: true } : {}),
      ...(noRepo ? { noRepo: true } : {}),
      ...(ai ? { ai } : {}),
      devDone: jiraDevStage({ status: t.status, statusCategory: t.statusCategory } as Parameters<typeof jiraDevStage>[0]) === 'merged',
    });
  }

  // Each release service needs a live MR (open or merged) into the target branch. Services only
  // named by tickets are not in the release: they are reported as tickets without a repo.
  const liveRefs = new Set(checks.filter((c) => c.state === 'opened' || c.state === 'merged').map((c) => c.ref));
  const servicesWithoutMr = release.services.filter((svc) => !svc.mrs.some((m) => liveRefs.has(m.ref) || !checks.some((c) => c.ref === m.ref))).map((s) => s.name);

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
  const missing = coverage.filter((c) => !c.inMrs.length && !c.unsure && !c.noRepo);
  const unsure = coverage.filter((c) => c.unsure && !c.noRepo);
  const noRepo = coverage.filter((c) => c.noRepo);
  if (missing.length) warnings.push(`${missing.length} tiket scope tidak terlihat di kode yang akan dirilis: ${missing.map((c) => c.key).join(', ')}.`);
  if (unsure.length) warnings.push(`${unsure.length} tiket perlu dicek manual (cocok samar, atau AI ragu): ${unsure.map((c) => c.key).join(', ')}.`);
  if (noRepo.length) {
    const names = [...new Set(noRepo.map((c) => c.service!))];
    warnings.push(`${noRepo.length} tiket untuk ${names.join(', ')} tidak punya service di rilis ini: tidak dicek ke kode.`);
  }
  if (outOfScope.length) warnings.push(`${outOfScope.length} tiket di luar scope ikut terbawa: ${outOfScope.map((o) => o.key).join(', ')}.`);
  for (const src of code.sources) {
    if (src.error) warnings.push(`${src.service}: kode tidak terbaca (${src.error}).`);
    else if (src.kind === 'branch' && !src.files) warnings.push(`${src.service}: ${src.ref.split('@')[1]} tidak punya perubahan dibanding ${release.targetBranch}.`);
  }
  const notDone = coverage.filter((c) => !c.devDone);
  if (notDone.length) warnings.push(`${notDone.length} tiket belum selesai development di Jira.`);
  for (const s of servicesWithoutMr) warnings.push(`Service ${s} belum punya MR ke ${release.targetBranch}.`);

  const scope = {
    tickets: coverage.length,
    inCode: coverage.filter((c) => c.inMrs.length).length,
    missing: missing.length,
    carried: outOfScope.length,
    accepted: [...carried.keys()].filter((k) => accepted.has(k)).length,
    commitsWithoutKey,
    unsure: unsure.length,
    noRepo: noRepo.length,
    matched: coverage.length > 0 && !missing.length && !unsure.length && !outOfScope.length,
  };
  return { releaseId: release.id, checkedAt: now, mrs: checks, tickets: coverage, servicesWithoutMr, sources: code.sources, badTitles, outOfScope, scope, warnings };
}

/**
 * A kept report after services left the release: what it said about those services no longer
 * applies (their missing MR, their code). Ticket lines stay until the next check.
 */
export function forCurrentServices(release: Release, report: ReleaseReport): ReleaseReport {
  const inRelease = (name: string) => release.services.some((s) => sameService(s.name, name));
  const gone = (report.servicesWithoutMr ?? []).filter((n) => !inRelease(n));
  const sources = (report.sources ?? []).filter((s) => inRelease(s.service));
  if (!gone.length && sources.length === (report.sources ?? []).length) return report;
  return {
    ...report,
    servicesWithoutMr: report.servicesWithoutMr.filter((n) => !gone.includes(n)),
    sources,
    warnings: report.warnings.filter((w) => !gone.some((n) => w.startsWith(`Service ${n} `))),
  };
}
