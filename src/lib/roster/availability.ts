import { schedule, WorkCalendar, type DeveloperAvailability, type ScheduleResult } from '../estimate/schedule';
import { ROLE_LABELS, type EstimateProject, type EstimateRole, type Holiday } from '../estimate/types';
import type { ActivityResponse, MemberBusy, MemberRecommendation, TeamMember } from './types';

/**
 * Availability and recommendations from the team roster. No AI and no network: the roster, the
 * other Cockpit projects (their own schedules), Jira load already fetched, and git activity
 * already fetched go in; dates and a ranked, explained list come out.
 */

const EPS = 1e-9;
/** People who can start within the same week rank together; familiarity decides inside a week. */
const WEEK = 5;

const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Schedules of the other projects, computed once per call site. */
export function otherSchedules(projects: EstimateProject[], currentId: string, holidays: Holiday[]): Map<string, ScheduleResult> {
  const out = new Map<string, ScheduleResult>();
  for (const p of projects) {
    if (p.id === currentId || !p.developers.some((d) => d.memberId)) continue;
    try {
      out.set(p.id, schedule(p, holidays));
    } catch {
      /* a project with a broken start date simply does not count */
    }
  }
  return out;
}

/** Where a member works in other projects that are still running at `from`. */
export function memberBusy(member: TeamMember, projects: EstimateProject[], schedules: Map<string, ScheduleResult>, from: string): MemberBusy[] {
  const out: MemberBusy[] = [];
  for (const p of projects) {
    const s = schedules.get(p.id);
    if (!s) continue;
    for (const d of p.developers.filter((x) => x.memberId === member.id)) {
      const until = s.developers.find((x) => x.id === d.id)?.finishDate;
      if (until && until >= from) out.push({ projectId: p.id, projectName: p.name, allocation: d.allocation, until });
    }
  }
  return out.sort((a, b) => a.until.localeCompare(b.until));
}

/**
 * When a member can start at `allocation` on a project starting at `start`: right away if enough
 * capacity is left after other projects, else the day after the work that frees enough ends.
 */
export function availableFrom(member: TeamMember, busy: MemberBusy[], start: string, allocation = member.capacity): { from: string; freeCapacity: number; reason?: string } {
  const used = busy.reduce((n, b) => n + b.allocation, 0);
  const freeCapacity = Math.max(0, member.capacity - used);
  if (freeCapacity + EPS >= Math.min(allocation, member.capacity)) return { from: start, freeCapacity };
  // Free up the earliest-ending work first until enough capacity is left.
  let left = used;
  for (const b of busy) {
    left -= b.allocation;
    if (member.capacity - left + EPS >= Math.min(allocation, member.capacity)) {
      return { from: nextDay(b.until), freeCapacity, reason: `masih di ${b.projectName} sampai ${fmt(b.until)}` };
    }
  }
  const last = busy[busy.length - 1];
  return { from: nextDay(last.until), freeCapacity, reason: `masih di ${last.projectName} sampai ${fmt(last.until)}` };
}

/** Availability per developer of a project, for the scheduler (developers linked to the roster only). */
export function projectAvailability(project: EstimateProject, members: TeamMember[], projects: EstimateProject[], holidays: Holiday[]): Record<string, DeveloperAvailability> {
  const linked = project.developers.filter((d) => d.memberId);
  if (!linked.length) return {};
  const byId = new Map(members.map((m) => [m.id, m]));
  const schedules = otherSchedules(projects, project.id, holidays);
  const out: Record<string, DeveloperAvailability> = {};
  for (const d of linked) {
    const m = byId.get(d.memberId!);
    if (!m) continue;
    const busy = memberBusy(m, projects, schedules, project.startDate);
    const a = availableFrom(m, busy, project.startDate, d.allocation);
    out[d.id] = { ...(a.from > project.startDate ? { from: a.from, fromReason: a.reason } : {}), ...(m.leaves.length ? { leaves: m.leaves } : {}) };
  }
  return out;
}

/** Leave working days between two dates (inclusive). */
export function leaveDaysBetween(member: TeamMember, from: string, to: string, holidays: Holiday[], skipCutiBersama = true): number {
  if (!member.leaves.length || to < from) return 0;
  const cal = new WorkCalendar(from, holidays, skipCutiBersama);
  let n = 0;
  for (const l of member.leaves) {
    const a = l.start > from ? l.start : from;
    const b = l.end < to ? l.end : to;
    if (b < a) continue;
    for (let i = cal.offsetOf(a); cal.dateAt(i) <= b; i++) n++;
  }
  return n;
}

export interface RecommendInput {
  role: EstimateRole;
  members: TeamMember[];
  project: EstimateProject;
  projects: EstimateProject[];
  holidays: Holiday[];
  /** Open Jira work outside the project, by Jira account (already fetched). */
  jiraLoads?: Record<string, { days: number; issues: number; inProgress?: number; postDev?: number }>;
  activity?: ActivityResponse;
  /** End of the window for counting leave (the current schedule end); default 20 working days. */
  windowEnd?: string;
}

/**
 * Active members of a role, best first: earliest start (by week; their open Jira work always
 * counts here, whatever the project's own schedule setting), then the lighter Jira load, then the
 * most familiar with the repos of this role's tasks. A member whose Jira load is unknown (no Jira
 * link, or not loaded) ranks after the known ones of the same week, so "no data" never looks like
 * "free". Each comes with the reasons behind it.
 */
export function recommendMembers(input: RecommendInput): MemberRecommendation[] {
  const { role, project, holidays } = input;
  const cal = new WorkCalendar(project.startDate, holidays, project.skipCutiBersama);
  const start = cal.dateAt(0);
  const windowEnd = input.windowEnd && input.windowEnd >= start ? input.windowEnd : cal.dateAt(19);
  const schedules = otherSchedules(input.projects, project.id, holidays);
  const services = [...new Set(project.tasks.filter((t) => t.role === role && t.service).map((t) => t.service))];
  const activity = input.activity?.services.filter((s) => services.includes(s.service) && s.repo) ?? [];
  const total = activity.reduce((n, s) => n + s.total, 0);

  return input.members
    .filter((m) => m.active && m.role === role)
    .map((m): MemberRecommendation & { _bucket: number } => {
      const busy = memberBusy(m, input.projects, schedules, start);
      const a = availableFrom(m, busy, start);
      const jira = m.jira ? input.jiraLoads?.[m.jira.accountId] : undefined;
      // Open Jira work (at the member's capacity) already includes the other projects' tickets:
      // the later of the two counts, not the sum.
      const jiraDays = jira ? Math.ceil(jira.days / m.capacity - EPS) : 0;
      const jiraUntil = jiraDays > 0 ? cal.dateAt(jiraDays - 1) : undefined;
      let offset = Math.max(cal.offsetOf(a.from), jiraDays);
      let from = cal.dateAt(offset);
      // Starting on a leave day means starting after it.
      for (let guard = 0; guard < 400 && m.leaves.some((l) => l.start <= from && from <= l.end); guard++) from = cal.dateAt(++offset);
      const leaveDays = leaveDaysBetween(m, from, windowEnd, holidays, project.skipCutiBersama);

      let familiarity: MemberRecommendation['familiarity'];
      if (total > 0) {
        const emails = new Set(m.gitEmails);
        let commits = 0;
        let top: { service: string; commits: number; share: number } | undefined;
        for (const s of activity) {
          const mine = Object.entries(s.byEmail).reduce((n, [e, c]) => n + (emails.has(e) ? c : 0), 0);
          commits += mine;
          if (mine && (!top || mine > top.commits)) top = { service: s.service, commits: mine, share: s.total ? mine / s.total : 0 };
        }
        familiarity = { share: commits / total, commits, ...(top ? { topService: top.service, topShare: top.share } : {}) };
      }

      const reasons: string[] = [];
      reasons.push(offset === 0 ? `bisa mulai ${fmt(start)}` : `bisa mulai ${fmt(from)} (${offset} hari kerja setelah proyek mulai)`);
      for (const b of busy) reasons.push(`${Math.round(b.allocation * 100)}% di ${b.projectName} sampai ${fmt(b.until)}`);
      if (jira) {
        reasons.push(jira.issues ? `${jira.issues} tiket Jira belum selesai dev${jira.inProgress ? `, ${jira.inProgress} sedang dikerjakan` : ''} (±${jira.days} hari${jiraUntil ? `, selesai ±${fmt(jiraUntil)}` : ''})` : 'tidak ada tiket Jira yang perlu dikerjakan');
        if (jira.postDev) reasons.push(`${jira.postDev} tiket sudah lewat development (review, ready to test, QA), tidak dihitung`);
      }
      else reasons.push(m.jira ? 'beban Jira belum termuat' : 'beban Jira tidak diketahui: akun Jira belum ditautkan di daftar tim');
      if (familiarity?.topService) reasons.push(`${Math.round((familiarity.topShare ?? 0) * 100)}% commit di ${familiarity.topService} (${input.activity!.days} hari terakhir)`);
      else if (familiarity) reasons.push(m.gitEmails.length ? `belum ada commit di repo ${ROLE_LABELS[role]} proyek ini` : 'email git belum diisi di daftar tim');
      if (leaveDays) reasons.push(`cuti ${leaveDays} hari kerja di periode proyek`);
      if (m.capacity < 1) reasons.push(`kapasitas ${Math.round(m.capacity * 100)}%`);

      return {
        member: m,
        availableFrom: from,
        waitDays: offset,
        freeCapacity: a.freeCapacity,
        busy,
        leaveDays,
        ...(jira ? { jira: { days: jira.days, issues: jira.issues, ...(jiraUntil ? { until: jiraUntil } : {}) } } : {}),
        ...(familiarity ? { familiarity } : {}),
        inProject: project.developers.some((d) => d.memberId === m.id),
        reasons,
        _bucket: Math.floor(offset / WEEK),
      };
    })
    .sort(
      (a, b) =>
        a._bucket - b._bucket ||
        Number(!a.jira) - Number(!b.jira) ||
        (a.jira?.days ?? 0) - (b.jira?.days ?? 0) ||
        (b.familiarity?.share ?? 0) - (a.familiarity?.share ?? 0) ||
        a.leaveDays - b.leaveDays ||
        a.member.name.localeCompare(b.member.name),
    )
    .map(({ _bucket: _b, ...r }) => r);
}
