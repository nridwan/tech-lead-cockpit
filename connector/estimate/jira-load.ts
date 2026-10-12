import type { DeveloperJiraLoad, JiraCandidate, JiraLoadIssue } from '../../src/lib/estimate/types.ts';
import { jiraDevStage } from '../../src/lib/tad/progress-report.ts';

/**
 * Workload already on a developer's plate in Jira: their open issues outside the project, in
 * working days. Remaining estimate first, then original estimate, else a default per issue
 * (most tickets carry no estimate). Jira counts 8 hours per day by default. Teams rarely close
 * tickets, so issues not updated for `staleDays` and epics (containers, not work) are skipped;
 * the result is an indication the Tech Lead can still correct per developer.
 *
 * Jira puts statuses like READY TO TEST, IN QA or IN REVIEW TL in its "In Progress" category, but
 * development is finished there. The status rules of the progress report (jiraDevStage) decide:
 * tickets past development are listed apart and never count as load or as "in progress".
 */

const ACCOUNT = /^[\w.@:-]{1,128}$/;
const PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
export const LOAD_FIELDS = ['summary', 'status', 'assignee', 'duedate', 'timeestimate', 'timeoriginalestimate', 'issuetype'];
const HOURS_PER_DAY = 8;
const MAX_ISSUES = 1_000;

export class JiraLoadError extends Error {}

export interface JiraSearch {
  searchRaw(jql: string, fields: string[], limit?: number): Promise<any[]>;
  assignableUsers(projectKeys: string[]): Promise<{ accountId: string; displayName: string; emailAddress?: string }[]>;
}

const round = (d: number) => Math.max(0.5, Math.round(d * 2) / 2);

/** Days an open issue still needs, and where the number came from. */
export function issueLoadDays(fields: { timeestimate?: number | null; timeoriginalestimate?: number | null }, defaultDays: number): Pick<JiraLoadIssue, 'estimateDays' | 'source'> {
  if (typeof fields.timeestimate === 'number' && fields.timeestimate > 0) return { estimateDays: round(fields.timeestimate / 3600 / HOURS_PER_DAY), source: 'remaining' };
  if (typeof fields.timeoriginalestimate === 'number' && fields.timeoriginalestimate > 0) return { estimateDays: round(fields.timeoriginalestimate / 3600 / HOURS_PER_DAY), source: 'original' };
  return { estimateDays: defaultDays, source: 'default' };
}

const assigneeId = (a: any): string => a?.accountId || a?.name || a?.key || '';

/** Development stage of an open ticket from its status. */
export function loadStage(status: string, statusCategory?: string): NonNullable<JiraLoadIssue['stage']> {
  const stage = jiraDevStage({ status, statusCategory } as Parameters<typeof jiraDevStage>[0]);
  if (stage === 'merged') return 'done';
  if (stage === 'review') return 'review';
  if (stage === 'in_progress') return 'in_progress';
  // Unknown status: "To Do"-like statuses wait, anything else in Jira's progress category is coding.
  return statusCategory === 'indeterminate' ? 'in_progress' : 'todo';
}

/** Groups open issues by assignee, skipping the project's own tasks. */
export function aggregateLoads(issues: any[], excludeKeys: string[], defaultDays: number): Record<string, DeveloperJiraLoad> {
  const skip = new Set(excludeKeys);
  const out: Record<string, DeveloperJiraLoad> = {};
  for (const it of issues) {
    const id = assigneeId(it.fields?.assignee);
    const type = it.fields?.issuetype;
    if (!id || skip.has(it.key) || type?.name === 'Epic' || (typeof type?.hierarchyLevel === 'number' && type.hierarchyLevel > 0)) continue;
    const f = it.fields ?? {};
    const status = f.status?.name ?? 'Unknown';
    const statusCategory = f.status?.statusCategory?.key;
    const issue: JiraLoadIssue = {
      key: it.key,
      summary: String(f.summary ?? '').slice(0, 200),
      status,
      statusCategory,
      stage: loadStage(status, statusCategory),
      due: f.duedate ?? undefined,
      ...issueLoadDays(f, defaultDays),
    };
    const load = (out[id] ??= { accountId: id, displayName: f.assignee?.displayName ?? id, days: 0, issues: [], postDev: [] });
    if (issue.stage === 'review' || issue.stage === 'done') {
      load.postDev!.push(issue);
      continue;
    }
    load.issues.push(issue);
    load.days += issue.estimateDays;
  }
  for (const l of Object.values(out)) {
    l.days = Math.round(l.days * 2) / 2;
    // In progress first, then by due date: the order they are likely worked on.
    l.issues.sort((a, b) => Number(b.stage === 'in_progress') - Number(a.stage === 'in_progress') || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  }
  return out;
}

export interface LoadOptions {
  /** Days counted for an issue without an estimate. */
  defaultDays?: number;
  /** Skip issues not updated for this many days (0 = count all). */
  staleDays?: number;
}

function checkInputs(accountIds: string[], excludeKeys: string[], o: Required<LoadOptions>) {
  if (accountIds.some((a) => !ACCOUNT.test(a))) throw new JiraLoadError('Akun Jira tidak valid.');
  if (excludeKeys.some((k) => !ISSUE_KEY.test(k))) throw new JiraLoadError('Jira key tidak valid.');
  if (!(o.defaultDays > 0 && o.defaultDays <= 20)) throw new JiraLoadError('Default hari per tiket harus 0.5–20.');
  if (!(Number.isInteger(o.staleDays) && o.staleDays >= 0 && o.staleDays <= 365)) throw new JiraLoadError('Batas tiket basi harus 0–365 hari.');
}

export function openJql(ids: string[], staleDays: number): string {
  return `assignee in (${ids.map((a) => `"${a}"`).join(',')}) AND statusCategory != Done${staleDays ? ` AND updated >= -${staleDays}d` : ''} ORDER BY updated DESC`;
}

const withDefaults = (o: LoadOptions = {}): Required<LoadOptions> => ({ defaultDays: o.defaultDays ?? 0.5, staleDays: o.staleDays ?? 30 });

/** Open workload per account id (accounts without open issues get 0 days). */
export async function jiraLoads(jira: JiraSearch, accountIds: string[], excludeKeys: string[], opts?: LoadOptions): Promise<Record<string, DeveloperJiraLoad>> {
  const o = withDefaults(opts);
  const ids = [...new Set(accountIds)].slice(0, 50);
  checkInputs(ids, excludeKeys, o);
  if (!ids.length) return {};
  const loads = aggregateLoads(await jira.searchRaw(openJql(ids, o.staleDays), LOAD_FIELDS, MAX_ISSUES), excludeKeys, o.defaultDays);
  return Object.fromEntries(ids.map((id) => [id, loads[id] ?? { accountId: id, displayName: id, days: 0, issues: [] }]));
}

/** People assignable in the projects' Jira spaces, least loaded first. */
export async function jiraCandidates(jira: JiraSearch, projectKeys: string[], excludeKeys: string[], opts?: LoadOptions): Promise<JiraCandidate[]> {
  const keys = [...new Set(projectKeys)].slice(0, 10);
  if (!keys.length || keys.some((k) => !PROJECT.test(k))) throw new JiraLoadError('Project key Jira tidak valid.');
  const users = (await jira.assignableUsers(keys)).filter((u) => ACCOUNT.test(u.accountId)).slice(0, 100);
  const loads = await jiraLoads(jira, users.map((u) => u.accountId), excludeKeys, opts);
  return users
    .map((u) => {
      const l = loads[u.accountId];
      const inProgress = l?.issues.filter((i) => i.stage === 'in_progress').length ?? 0;
      return { accountId: u.accountId, displayName: u.displayName, email: u.emailAddress, openIssues: l?.issues.length ?? 0, inProgress, loadDays: l?.days ?? 0 };
    })
    .sort((a, b) => a.loadDays - b.loadDays || a.openIssues - b.openIssues || a.displayName.localeCompare(b.displayName));
}
