import { describe, expect, it } from 'vitest';
import { DEFAULT_HOLIDAYS } from './holidays';
import { WorkCalendar, lockAssignments, nextWorkingDay, placeWork, recommendAssignees, schedule } from './schedule';
import type { Developer, EstimateTask } from './types';
import { roleOf, roundEffort } from './types';

// In these tests the task id is just its title (one TAD).
const task = (title: string, effortDays: number | null, dependsOn: string[] = [], extra: Partial<EstimateTask> = {}): EstimateTask => ({
  id: title,
  draftId: 'd1',
  title,
  service: 'svc',
  role: roleOf(title),
  effortDays,
  dependsOn,
  ...extra,
});

const dev = (id: string, role: Developer['role'], allocation = 1): Developer => ({ id, name: id, role, allocation });

describe('WorkCalendar', () => {
  it('skips weekends, national holidays and cuti bersama around Nyepi/Idulfitri 2026', () => {
    const cal = new WorkCalendar('2026-03-16', DEFAULT_HOLIDAYS);
    // 18 cuti, 19 Nyepi, 20 cuti, 21–22 weekend (Idulfitri), 23–24 cuti.
    expect([0, 1, 2, 3].map((i) => cal.dateAt(i))).toEqual(['2026-03-16', '2026-03-17', '2026-03-25', '2026-03-26']);
    expect(cal.daysOffBetween('2026-03-16', '2026-03-26').map((h) => h.date)).toEqual(['2026-03-18', '2026-03-19', '2026-03-20', '2026-03-23', '2026-03-24']);
  });

  it('can treat cuti bersama as working days', () => {
    const cal = new WorkCalendar('2026-03-16', DEFAULT_HOLIDAYS, false);
    expect([0, 1, 2, 3, 4, 5].map((i) => cal.dateAt(i))).toEqual(['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-20', '2026-03-23', '2026-03-24']);
  });

  it('starts on the next working day when the start date is off', () => {
    expect(new WorkCalendar('2026-12-24', DEFAULT_HOLIDAYS).dateAt(0)).toBe('2026-12-28');
    expect(nextWorkingDay(DEFAULT_HOLIDAYS, '2026-10-10')).toBe('2026-10-12');
    expect(() => new WorkCalendar('2026-13-40', [])).toThrow('tidak valid');
  });
});

describe('schedule', () => {
  const tasks = [
    task('[BACKEND][SVC][X] - A', 2),
    task('[BACKEND][SVC][X] - B', 3),
    task('[BACKEND][SVC][X] - C', 1, ['[BACKEND][SVC][X] - A']),
    task('[MOBILE-FE][APP][X] - D', 1, ['[BACKEND][SVC][X] - B']),
  ];
  const team = [dev('be1', 'BACKEND'), dev('be2', 'BACKEND'), dev('fe1', 'MOBILE-FE', 0.5)];

  it('runs tasks in parallel, respects dependencies and allocation, and finds the critical chain', () => {
    const r = schedule({ startDate: '2026-10-05', skipCutiBersama: true, developers: team, tasks }, DEFAULT_HOLIDAYS);
    const [a, b, c, d] = r.tasks;
    // Longest chain first: B (3+1) goes to be1, A to be2, C after A on be2, D after B on the half-time FE.
    expect([b.developerId, b.start, b.finish]).toEqual(['be1', 0, 3]);
    expect([a.developerId, a.start, a.finish]).toEqual(['be2', 0, 2]);
    expect([c.developerId, c.start, c.finish]).toEqual(['be2', 2, 3]);
    expect([d.developerId, d.start, d.finish]).toEqual(['fe1', 3, 5]);
    expect([d.startDate, d.endDate, d.spanDays]).toEqual(['2026-10-08', '2026-10-09', 2]);
    expect(d.waitedFor).toEqual({ kind: 'dependency', id: '[BACKEND][SVC][X] - B', title: '[BACKEND][SVC][X] - B' });
    expect(r.tasks.filter((t) => t.critical).map((t) => t.title)).toEqual(['[BACKEND][SVC][X] - B', '[MOBILE-FE][APP][X] - D']);
    expect([r.startDate, r.endDate, r.spanDays, r.totalEffort]).toEqual(['2026-10-05', '2026-10-09', 5, 7]);
    expect(r.effortByRole).toEqual({ BACKEND: 6, 'MOBILE-FE': 1, 'WEB-FE': 0 });
    expect(r.complete).toBe(true);
    expect(r.developers.find((x) => x.id === 'fe1')).toMatchObject({ effortDays: 1, finishDate: '2026-10-09', utilization: 0.4 });
  });

  it('stretches the calendar over holidays', () => {
    const r = schedule({ startDate: '2026-03-16', skipCutiBersama: true, developers: [dev('be1', 'BACKEND')], tasks: [task('[BACKEND][S][X] - Big', 4)] }, DEFAULT_HOLIDAYS);
    expect([r.startDate, r.endDate, r.spanDays]).toEqual(['2026-03-16', '2026-03-26', 4]);
    expect(r.daysOff).toHaveLength(5);
  });

  it('packs half days on the same developer', () => {
    const r = schedule(
      { startDate: '2026-10-05', skipCutiBersama: true, developers: [dev('be1', 'BACKEND')], tasks: [task('[BACKEND][S][X] - a', 0.5), task('[BACKEND][S][X] - b', 0.5), task('[BACKEND][S][X] - c', 1)] },
      [],
    );
    // The 1-day task goes first (longer chain); the two half days share the next day.
    expect(r.tasks.map((t) => [t.startDate, t.endDate])).toEqual([
      ['2026-10-06', '2026-10-06'],
      ['2026-10-06', '2026-10-06'],
      ['2026-10-05', '2026-10-05'],
    ]);
    expect(r.spanDays).toBe(2);
  });

  it('honours a fixed assignee even when another developer is free', () => {
    const r = schedule(
      { startDate: '2026-10-05', skipCutiBersama: true, developers: [dev('be1', 'BACKEND'), dev('be2', 'BACKEND')], tasks: [task('[BACKEND][S][X] - a', 2, [], { assigneeId: 'be1' }), task('[BACKEND][S][X] - b', 2, [], { assigneeId: 'be1' })] },
      [],
    );
    expect(r.tasks.map((t) => [t.developerId, t.start])).toEqual([
      ['be1', 0],
      ['be1', 2],
    ]);
    expect(r.tasks[1].waitedFor).toEqual({ kind: 'developer', id: '[BACKEND][S][X] - a', title: '[BACKEND][S][X] - a' });
  });

  it('reports unestimated tasks, missing roles, unknown dependencies and cycles', () => {
    const r = schedule(
      {
        startDate: '2026-10-05',
        skipCutiBersama: true,
        developers: [dev('be1', 'BACKEND')],
        tasks: [
          task('[BACKEND][S][X] - a', null),
          task('[BACKEND][S][X] - b', 1, ['[BACKEND][S][X] - a', 'tidak ada']),
          task('[WEB-FE][CMS][X] - c', 2),
          task('[BACKEND][S][X] - d', 1, ['[BACKEND][S][X] - e']),
          task('[BACKEND][S][X] - e', 1, ['[BACKEND][S][X] - d']),
        ],
      },
      [],
    );
    expect(r.tasks.map((t) => t.issues)).toEqual([['unestimated'], ['waits-unscheduled'], ['no-developer'], ['cycle'], ['cycle']]);
    expect(r.complete).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/tidak ada di proyek[\s\S]*melingkar[\s\S]*belum punya estimasi[\s\S]*Belum ada developer WEB-FE/);
    // b still gets scheduled.
    expect(r.tasks[1]).toMatchObject({ developerId: 'be1', start: 0, finish: 1 });
  });
});

describe('schedule across TADs', () => {
  it('keeps same-titled tasks from two TADs apart and chains them by id', () => {
    const t1: EstimateTask = { id: 'tadA::[BACKEND][S][X] - API', draftId: 'tadA', title: '[BACKEND][S][X] - API', service: 's', role: 'BACKEND', effortDays: 2, dependsOn: [] };
    const t2: EstimateTask = { ...t1, id: 'tadB::[BACKEND][S][X] - API', draftId: 'tadB', effortDays: 1, dependsOn: [t1.id] };
    const r = schedule({ startDate: '2026-10-05', skipCutiBersama: true, developers: [dev('be1', 'BACKEND'), dev('be2', 'BACKEND')], tasks: [t1, t2] }, []);
    expect(r.tasks.map((t) => [t.id, t.start, t.finish])).toEqual([
      [t1.id, 0, 2],
      [t2.id, 2, 3],
    ]);
    expect(r.tasks[1].waitedFor?.id).toBe(t1.id);
  });
});

describe('helpers', () => {
  it('maps title tags to roles and rounds effort to half days', () => {
    expect(roleOf('[MOBILE-FE][APP][X] - a')).toBe('MOBILE-FE');
    expect(roleOf('[WEB-FE][CMS][X] - a')).toBe('WEB-FE');
    expect(roleOf('[BACKEND][S][X] - a')).toBe('BACKEND');
    expect(roleOf('Tanpa tag')).toBe('BACKEND');
    // Generic frontend tags: web portals vs mobile apps by service name.
    expect(roleOf('[FRONTEND][WEB-PORTAL][PROMO] - Halaman Daftar Promo')).toBe('WEB-FE');
    expect(roleOf('[FRONTEND][MP-PORTAL-FDS][FDS] - Dashboard')).toBe('WEB-FE');
    expect(roleOf('[FE][MOBILE-APP][X] - Slicing UI')).toBe('MOBILE-FE');
    expect(roleOf('[FRONTEND][MERCHANT-MOBILE][X] - Integrasi API')).toBe('MOBILE-FE');
    expect(roleOf('[CMS][PORTAL][X] - a')).toBe('WEB-FE');
    expect([roundEffort(1.3), roundEffort(1.25), roundEffort(0.1), roundEffort(-1)]).toEqual([1.5, 1.5, 0.5, 0.5]);
  });
});

describe('Jira load and assignee recommendations', () => {
  const jiraDev = (id: string, days: number): Developer => ({ ...dev(id, 'BACKEND'), jira: { accountId: `acc-${id}`, displayName: id }, jiraLoad: { days, issues: 2, loadedAt: '' } });
  const base = { startDate: '2026-10-05', skipCutiBersama: true };

  it('starts a developer after their open Jira work only when the project counts it', () => {
    const tasks = [task('[BACKEND][S][X] - a', 2)];
    const busy = [jiraDev('budi', 3)];
    expect(schedule({ ...base, developers: busy, tasks }, []).tasks[0]).toMatchObject({ start: 0, finish: 2 });
    const r = schedule({ ...base, useJiraLoad: true, developers: busy, tasks }, []);
    expect(r.tasks[0]).toMatchObject({ start: 3, finish: 5, startDate: '2026-10-08', endDate: '2026-10-09' });
    expect(r.tasks[0].waitedFor).toMatchObject({ kind: 'jira' });
    expect(r.developers[0].jiraLoadDays).toBe(3);
    // A developer without a Jira link has no load.
    expect(schedule({ ...base, useJiraLoad: true, developers: [{ ...dev('x', 'BACKEND'), jiraLoad: { days: 9, issues: 1, loadedAt: '' } }], tasks }, []).tasks[0].start).toBe(0);
  });

  it('ranks developers by project end, task end and load, and locks the current picks', () => {
    const plan = {
      ...base,
      useJiraLoad: true,
      developers: [jiraDev('budi', 4), jiraDev('citra', 0), dev('andi', 'MOBILE-FE')],
      tasks: [task('[BACKEND][S][X] - a', 2), task('[BACKEND][S][X] - b', 1)],
    };
    const recs = recommendAssignees(plan, [], plan.tasks[0].id);
    expect(recs.map((r) => r.developerId)).toEqual(['citra', 'budi']);
    expect(recs[0]).toMatchObject({ current: true, jiraLoadDays: 0, taskEndDate: '2026-10-06' });
    expect(recs[1]).toMatchObject({ current: false, jiraLoadDays: 4 });
    expect(recommendAssignees(plan, [], 'nope')).toEqual([]);

    const locked = lockAssignments(plan, []);
    expect(locked.map((t) => t.assigneeId)).toEqual(['citra', 'citra']);
    // Already fixed tasks stay as they are.
    expect(lockAssignments({ ...plan, tasks: [{ ...plan.tasks[0], assigneeId: 'budi' }, plan.tasks[1]] }, [])[0].assigneeId).toBe('budi');
  });
});

describe('availability from the team roster', () => {
  // 2026-10-05 is a Monday.
  const base = { startDate: '2026-10-05', skipCutiBersama: true };
  const tasks = [task('[BACKEND][S][X] - a', 2)];

  it('starts a developer busy in another project on their first free day', () => {
    const r = schedule({ ...base, developers: [dev('a', 'BACKEND')], tasks, availability: { a: { from: '2026-10-08', fromReason: 'masih di Proyek Lain sampai 7 Okt' } } }, []);
    expect(r.tasks[0]).toMatchObject({ start: 3, finish: 5, startDate: '2026-10-08', endDate: '2026-10-09' });
    expect(r.tasks[0].waitedFor).toEqual({ kind: 'availability', id: 'a', title: 'a masih di Proyek Lain sampai 7 Okt' });
    expect(r.developers[0].availableFrom).toBe('2026-10-08');
  });

  it('skips leave days in the middle of a task and at its start', () => {
    const mid = schedule({ ...base, developers: [dev('a', 'BACKEND')], tasks: [task('[BACKEND][S][X] - a', 3)], availability: { a: { leaves: [{ start: '2026-10-06', end: '2026-10-07' }] } } }, []);
    expect(mid.tasks[0]).toMatchObject({ start: 0, finish: 5, endDate: '2026-10-09' });
    expect(mid.developers[0].leaveDays).toBe(2);
    const atStart = schedule({ ...base, developers: [dev('a', 'BACKEND')], tasks, availability: { a: { leaves: [{ start: '2026-10-05', end: '2026-10-05' }] } } }, []);
    expect(atStart.tasks[0]).toMatchObject({ start: 1, finish: 3, startDate: '2026-10-06' });
    expect(atStart.tasks[0].waitedFor).toMatchObject({ kind: 'availability', title: 'a cuti' });
  });

  it('counts the later of Jira load and other-project work, not both', () => {
    const d: Developer = { ...dev('a', 'BACKEND'), jira: { accountId: 'acc', displayName: 'a' }, jiraLoad: { days: 3, issues: 1, loadedAt: '' } };
    const r = schedule({ ...base, useJiraLoad: true, developers: [d], tasks, availability: { a: { from: '2026-10-07' } } }, []);
    expect(r.tasks[0].start).toBe(3);
    expect(r.tasks[0].waitedFor?.kind).toBe('jira');
  });

  it('gives the task to a colleague when one developer is on leave', () => {
    const r = schedule({ ...base, developers: [dev('a', 'BACKEND'), dev('b', 'BACKEND')], tasks, availability: { a: { leaves: [{ start: '2026-10-05', end: '2026-10-09' }] } } }, []);
    expect(r.tasks[0].developerId).toBe('b');
  });

  it('places part-time work around leave', () => {
    expect(placeWork(0, 1, 0.5, new Set([1]))).toEqual({ start: 0, finish: 3, leaveDays: 1 });
    expect(placeWork(0.5, 0.5, 1, new Set([0]))).toEqual({ start: 1, finish: 1.5, leaveDays: 0 });
  });
});
