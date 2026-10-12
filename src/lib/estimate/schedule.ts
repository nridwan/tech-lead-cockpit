import type { LeaveRange } from '../roster/types';
import type { Developer, EstimateProject, EstimateRole, EstimateTask, Holiday } from './types';
import { ESTIMATE_ROLES } from './types';

/**
 * Deterministic schedule for an estimate: no AI here. Time is counted in working days from the
 * start date (Mon–Fri minus holidays and, optionally, cuti bersama). A developer with allocation
 * 0.5 needs two working days for one man-day. Tasks run in parallel across developers, wait for
 * their dependencies, and go to the developer of the right role who can finish them earliest,
 * longest remaining chain first (classic list scheduling).
 */

const EPS = 1e-9;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Working days from a start date, generated on demand. Index 0 is the first working day on/after start. */
export class WorkCalendar {
  private readonly days: string[] = [];
  private readonly off: Map<string, Holiday>;

  constructor(
    readonly start: string,
    holidays: Holiday[],
    skipCutiBersama = true,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) throw new Error(`Tanggal mulai tidak valid: ${start}`);
    this.off = new Map(holidays.filter((h) => skipCutiBersama || h.kind === 'libur').map((h) => [h.date, h]));
  }

  isWorkingDay(date: string): boolean {
    return !isWeekend(date) && !this.off.has(date);
  }

  holiday(date: string): Holiday | undefined {
    return this.off.get(date);
  }

  dateAt(index: number): string {
    let cursor = this.days.length ? addDays(this.days[this.days.length - 1], 1) : this.start;
    while (this.days.length <= index) {
      if (this.isWorkingDay(cursor)) this.days.push(cursor);
      cursor = addDays(cursor, 1);
      if (this.days.length === 0 && cursor > addDays(this.start, 3660)) throw new Error('Tidak ada hari kerja dalam 10 tahun.');
    }
    return this.days[index];
  }

  /** Index of the first working day on/after `date` (0 for dates up to the start). */
  offsetOf(date: string): number {
    if (date <= this.start) return 0;
    let i = 0;
    while (this.dateAt(i) < date) i++;
    return i;
  }

  /** Days off (weekday holidays) between two dates inclusive, for the summary. */
  daysOffBetween(from: string, to: string): Holiday[] {
    const out: Holiday[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const h = this.off.get(d);
      if (h && !isWeekend(d)) out.push(h);
    }
    return out;
  }

  /** Calendar date where a span starting at working-day offset `start` begins. */
  startDate(start: number): string {
    return this.dateAt(Math.floor(start + EPS));
  }

  /** Last calendar date a span ending at offset `finish` still occupies. */
  endDate(finish: number): string {
    return this.dateAt(Math.max(0, Math.ceil(finish - EPS) - 1));
  }
}

export type ScheduleIssue = 'unestimated' | 'no-developer' | 'cycle' | 'waits-unscheduled';

export interface ScheduledTask {
  id: string;
  title: string;
  role: EstimateRole;
  effortDays: number | null;
  developerId?: string;
  /** Working-day offsets from the start date. */
  start: number;
  finish: number;
  startDate?: string;
  endDate?: string;
  /** Working days between start and end (inclusive), what a calendar shows. */
  spanDays: number;
  critical: boolean;
  /** Why it could not start earlier: a dependency, the developer busy with another task, their open Jira work, or their availability (other projects, leave). */
  waitedFor?: { kind: 'dependency' | 'developer' | 'jira' | 'availability'; id: string; title: string };
  issues: ScheduleIssue[];
}

export interface DeveloperLoad {
  id: string;
  name: string;
  role: EstimateRole;
  allocation: number;
  effortDays: number;
  tasks: number;
  finishDate?: string;
  /** Busy working days / project span. */
  utilization: number;
  /** Open Jira work (days) counted before this developer's project tasks. */
  jiraLoadDays: number;
  /** First day they can work on the project (other projects, leave), when later than the start. */
  availableFrom?: string;
  /** Leave working days that fell inside their project work. */
  leaveDays: number;
}

export interface ScheduleResult {
  startDate: string;
  endDate?: string;
  /** Working days from the first to the last day of the project. */
  spanDays: number;
  totalEffort: number;
  effortByRole: Record<EstimateRole, number>;
  tasks: ScheduledTask[];
  developers: DeveloperLoad[];
  /** Weekday holidays inside the project span. */
  daysOff: Holiday[];
  /** True when every task has an effort and a developer: the end date is then complete. */
  complete: boolean;
  warnings: string[];
}

interface Node {
  task: EstimateTask;
  index: number;
  deps: number[];
  dependents: number[];
  rank: number;
}

/** Tasks that sit on a dependency cycle (by index). */
function findCycle(nodes: Node[]): Set<number> {
  const indegree = nodes.map((n) => n.deps.length);
  const queue = nodes.filter((n) => !n.deps.length).map((n) => n.index);
  const seen = new Set(queue);
  while (queue.length) {
    const i = queue.shift()!;
    for (const d of nodes[i].dependents) if (--indegree[d] === 0 && !seen.has(d)) (seen.add(d), queue.push(d));
  }
  return new Set(nodes.filter((n) => !seen.has(n.index)).map((n) => n.index));
}

/** Per developer, from the team roster: busy in other projects until a date, and leave. */
export interface DeveloperAvailability {
  /** Earliest day they can start on this project (YYYY-MM-DD). */
  from?: string;
  /** Why `from` is set, shown when a task waits for it. */
  fromReason?: string;
  leaves?: LeaveRange[];
}

export type SchedulePlan = Pick<EstimateProject, 'startDate' | 'skipCutiBersama' | 'developers' | 'tasks' | 'useJiraLoad'> & {
  /** Keyed by developer id; computed from the roster and other projects (see roster/availability). */
  availability?: Record<string, DeveloperAvailability>;
};

/** Working-day offsets a developer is on leave. */
function leaveOffsets(cal: WorkCalendar, leaves: LeaveRange[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const l of leaves ?? []) {
    if (l.end < cal.start) continue;
    for (let i = cal.offsetOf(l.start); cal.dateAt(i) <= l.end; i++) out.add(i);
  }
  return out;
}

/**
 * Places `effort` man-days starting at offset `from` for a developer with `allocation`, skipping
 * their leave days. Returns the real start (first non-leave moment) and the finish offset.
 */
export function placeWork(from: number, effort: number, allocation: number, leave: Set<number>): { start: number; finish: number; leaveDays: number } {
  let t = from;
  while (leave.has(Math.floor(t + EPS))) t = Math.floor(t + EPS) + 1;
  const start = t;
  let rest = effort / allocation;
  let skipped = 0;
  while (rest > EPS) {
    const day = Math.floor(t + EPS);
    if (leave.has(day)) {
      t = day + 1;
      skipped++;
      continue;
    }
    const step = Math.min(day + 1 - t, rest);
    t += step;
    rest -= step;
  }
  return { start, finish: t, leaveDays: skipped };
}

/** Open Jira work (days) a developer finishes before project tasks, when the project counts it. */
export function jiraLoadOf(plan: Pick<EstimateProject, 'useJiraLoad'>, d: Developer): number {
  return plan.useJiraLoad && d.jira && d.jiraLoad ? Math.max(0, d.jiraLoad.days) : 0;
}

export function schedule(plan: SchedulePlan, holidays: Holiday[]): ScheduleResult {
  const cal = new WorkCalendar(plan.startDate, holidays, plan.skipCutiBersama);
  const warnings: string[] = [];
  // Open Jira work is done first, at full days: the developer joins the project after it.
  // Busy elsewhere until a date: they join then. Their Jira load already contains that other work,
  // so the later of the two counts, not the sum.
  const devs: (Developer & { free: number; jiraDays: number; fromDays: number; fromReason?: string; leave: Set<number>; leaveDays: number; last?: number; effort: number; busy: number; count: number })[] = plan.developers.map((d) => {
    const av = plan.availability?.[d.id];
    const fromDays = av?.from ? cal.offsetOf(av.from) : 0;
    return {
      ...d,
      allocation: Math.min(1, Math.max(0.1, Number(d.allocation) || 1)),
      free: Math.max(jiraLoadOf(plan, d), fromDays),
      jiraDays: jiraLoadOf(plan, d),
      fromDays,
      fromReason: av?.fromReason,
      leave: leaveOffsets(cal, av?.leaves),
      leaveDays: 0,
      effort: 0,
      busy: 0,
      count: 0,
    };
  });

  const byId = new Map(plan.tasks.map((t, i) => [t.id, i]));
  const nodes: Node[] = plan.tasks.map((task, index) => ({ task, index, deps: [], dependents: [], rank: 0 }));
  for (const n of nodes) {
    for (const id of new Set(n.task.dependsOn)) {
      const j = byId.get(id);
      if (j === undefined) warnings.push(`"${n.task.title}" bergantung pada task yang tidak ada di proyek: "${id.split('::').pop()}".`);
      else if (j !== n.index) (n.deps.push(j), nodes[j].dependents.push(n.index));
    }
  }
  const cycle = findCycle(nodes);
  if (cycle.size) warnings.push(`Dependency melingkar, task tidak dijadwalkan: ${[...cycle].map((i) => plan.tasks[i].title).join(', ')}.`);

  // Rank = effort of the longest chain from this task to the end; longer chains go first.
  const effortOf = (t: EstimateTask) => (t.effortDays && t.effortDays > 0 ? t.effortDays : 0);
  const rankMemo = new Map<number, number>();
  const rank = (i: number): number => {
    if (cycle.has(i)) return 0;
    if (rankMemo.has(i)) return rankMemo.get(i)!;
    rankMemo.set(i, 0);
    const r = effortOf(nodes[i].task) + Math.max(0, ...nodes[i].dependents.filter((d) => !cycle.has(d)).map(rank));
    rankMemo.set(i, r);
    return r;
  };
  for (const n of nodes) n.rank = rank(n.index);

  const result: ScheduledTask[] = plan.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, effortDays: t.effortDays, start: 0, finish: 0, spanDays: 0, critical: false, issues: [] }));
  const done = new Set<number>();
  const pending = new Set(nodes.filter((n) => !cycle.has(n.index)).map((n) => n.index));
  for (const i of cycle) result[i].issues.push('cycle');
  /** Which task decided each task's start, for the critical chain. */
  const pred = new Map<number, number>();

  while (pending.size) {
    const ready = [...pending].filter((i) => nodes[i].deps.every((d) => done.has(d)));
    if (!ready.length) break;
    ready.sort((a, b) => nodes[b].rank - nodes[a].rank || a - b);
    const i = ready[0];
    const { task } = nodes[i];
    const r = result[i];
    let readyAt = 0;
    let readyBy: number | undefined;
    for (const d of nodes[i].deps) {
      if (result[d].finish > readyAt + EPS) (readyAt = result[d].finish, (readyBy = d));
      if (result[d].issues.length) r.issues.includes('waits-unscheduled') || r.issues.push('waits-unscheduled');
    }

    const effort = effortOf(task);
    const fixed = task.assigneeId ? devs.find((d) => d.id === task.assigneeId) : undefined;
    const candidates = fixed ? [fixed] : devs.filter((d) => d.role === task.role);
    if (!effort || !candidates.length) {
      // Zero-length placeholder so dependents still get a sensible start.
      r.start = r.finish = readyAt;
      if (!effort) r.issues.push('unestimated');
      if (!candidates.length) r.issues.push('no-developer');
      if (readyBy !== undefined) pred.set(i, readyBy);
    } else {
      let best: { dev: (typeof devs)[number]; start: number; finish: number; leaveDays: number } | undefined;
      for (const dev of candidates) {
        const placed = placeWork(Math.max(readyAt, dev.free), effort, dev.allocation, dev.leave);
        if (!best || placed.finish < best.finish - EPS || (Math.abs(placed.finish - best.finish) < EPS && dev.effort < best.dev.effort)) best = { dev, ...placed };
      }
      const { dev, start, finish, leaveDays } = best!;
      dev.leaveDays += leaveDays;
      r.developerId = dev.id;
      r.start = start;
      r.finish = finish;
      r.startDate = cal.startDate(start);
      r.endDate = cal.endDate(finish);
      r.spanDays = Math.ceil(finish - EPS) - Math.floor(start + EPS);
      if (start > EPS) {
        if (readyBy !== undefined && Math.abs(start - readyAt) < EPS) {
          r.waitedFor = { kind: 'dependency', id: plan.tasks[readyBy].id, title: plan.tasks[readyBy].title };
          pred.set(i, readyBy);
        } else if (dev.last !== undefined) {
          r.waitedFor = { kind: 'developer', id: plan.tasks[dev.last].id, title: plan.tasks[dev.last].title };
          pred.set(i, dev.last);
        } else if (dev.jiraDays > EPS && Math.abs(start - dev.jiraDays) < EPS && dev.jiraDays >= dev.fromDays) {
          r.waitedFor = { kind: 'jira', id: dev.id, title: `beban Jira ${dev.name} (${dev.jiraDays} hari)` };
        } else if (dev.fromDays > EPS || dev.leave.size) {
          r.waitedFor = { kind: 'availability', id: dev.id, title: dev.fromDays > EPS && start - dev.fromDays < 1 ? `${dev.name} ${dev.fromReason ?? `baru tersedia ${cal.dateAt(dev.fromDays)}`}` : `${dev.name} cuti` };
        }
      }
      dev.free = finish;
      dev.last = i;
      dev.effort += effort;
      dev.busy += finish - start;
      dev.count++;
    }
    pending.delete(i);
    done.add(i);
  }

  const scheduled = result.filter((t) => t.developerId);
  const maxFinish = Math.max(0, ...scheduled.map((t) => t.finish));
  const last = scheduled.reduce<ScheduledTask | undefined>((a, t) => (!a || t.finish > a.finish + EPS ? t : a), undefined);
  if (last) {
    let i: number | undefined = result.indexOf(last);
    while (i !== undefined) {
      result[i].critical = true;
      i = pred.get(i);
    }
  }

  const effortByRole = Object.fromEntries(ESTIMATE_ROLES.map((r) => [r, 0])) as Record<EstimateRole, number>;
  for (const t of plan.tasks) effortByRole[t.role] += effortOf(t);
  const totalEffort = Object.values(effortByRole).reduce((a, b) => a + b, 0);
  const spanDays = Math.ceil(maxFinish - EPS);
  const startDate = cal.dateAt(0);
  const endDate = scheduled.length ? cal.endDate(maxFinish) : undefined;

  const unestimated = result.filter((t) => t.issues.includes('unestimated')).length;
  if (unestimated) warnings.push(`${unestimated} task belum punya estimasi; tanggal selesai belum lengkap.`);
  for (const role of ESTIMATE_ROLES) {
    const missing = result.filter((t) => t.role === role && t.issues.includes('no-developer') && !plan.tasks[result.indexOf(t)].assigneeId);
    if (missing.length) warnings.push(`Belum ada developer ${role} untuk ${missing.length} task.`);
  }
  for (const t of plan.tasks) if (t.assigneeId && !devs.some((d) => d.id === t.assigneeId)) warnings.push(`Assignee untuk "${t.title}" sudah tidak ada di tim.`);

  return {
    startDate,
    endDate,
    spanDays,
    totalEffort,
    effortByRole,
    tasks: result,
    developers: devs.map((d) => ({
      id: d.id,
      name: d.name,
      role: d.role,
      allocation: d.allocation,
      effortDays: d.effort,
      tasks: d.count,
      finishDate: d.count ? cal.endDate(d.free) : undefined,
      utilization: spanDays ? d.busy / spanDays : 0,
      jiraLoadDays: d.jiraDays,
      availableFrom: d.fromDays > 0 ? cal.dateAt(d.fromDays) : undefined,
      leaveDays: d.leaveDays,
    })),
    daysOff: endDate ? cal.daysOffBetween(startDate, endDate) : [],
    complete: result.every((t) => !t.issues.length),
    warnings,
  };
}

export interface AssigneeOption {
  developerId: string;
  name: string;
  /** When the task would end with this developer. */
  taskEndDate?: string;
  /** Project end and length with this choice. */
  projectEndDate?: string;
  spanDays: number;
  jiraLoadDays: number;
  /** Project work already queued on this developer (man-days, excluding this task). */
  queuedDays: number;
  /** The scheduler picks this developer today (task not fixed to someone else). */
  current: boolean;
}

/**
 * Developers of the task's role ranked for it: the schedule is recomputed with the task fixed to
 * each candidate, best first by project end, then task end, then the lighter load.
 */
export function recommendAssignees(plan: SchedulePlan, holidays: Holiday[], taskId: string): AssigneeOption[] {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task || !task.effortDays) return [];
  const base = schedule(plan, holidays);
  const chosen = base.tasks.find((t) => t.id === taskId)?.developerId;
  return plan.developers
    .filter((d) => d.role === task.role)
    .map((d) => {
      const r = schedule({ ...plan, tasks: plan.tasks.map((t) => (t.id === taskId ? { ...t, assigneeId: d.id } : t)) }, holidays);
      const mine = r.tasks.find((t) => t.id === taskId);
      const load = r.developers.find((x) => x.id === d.id);
      return {
        developerId: d.id,
        name: d.name,
        taskEndDate: mine?.endDate,
        projectEndDate: r.endDate,
        spanDays: r.spanDays,
        jiraLoadDays: jiraLoadOf(plan, d),
        queuedDays: Math.max(0, (load?.effortDays ?? 0) - (task.effortDays ?? 0)),
        current: chosen === d.id,
        finish: mine?.finish ?? Infinity,
      };
    })
    .sort((a, b) => a.spanDays - b.spanDays || a.finish - b.finish || a.jiraLoadDays + a.queuedDays - (b.jiraLoadDays + b.queuedDays) || a.name.localeCompare(b.name))
    .map(({ finish: _f, ...o }) => o);
}

/** Fixes every unassigned task to the developer the scheduler picks now. */
export function lockAssignments(plan: SchedulePlan, holidays: Holiday[]): EstimateTask[] {
  const r = schedule(plan, holidays);
  const byTask = new Map(r.tasks.map((t) => [t.id, t.developerId]));
  return plan.tasks.map((t) => (t.assigneeId || !byTask.get(t.id) ? t : { ...t, assigneeId: byTask.get(t.id) }));
}

/** Today in the local timezone (WIB), not UTC. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Next working day on/after today, the default start date. */
export function nextWorkingDay(holidays: Holiday[], from = today()): string {
  return new WorkCalendar(from, holidays).dateAt(0);
}
