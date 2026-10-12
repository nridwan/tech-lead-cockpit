import { describe, expect, it } from 'vitest';
import type { EstimateProject, EstimateTask } from '../estimate/types';
import { availableFrom, leaveDaysBetween, memberBusy, otherSchedules, projectAvailability, recommendMembers } from './availability';
import type { ActivityResponse, TeamMember } from './types';

// 2026-10-05 is a Monday.
const member = (id: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  id,
  name: id,
  role: 'BACKEND',
  gitEmails: [`${id}@example.com`],
  capacity: 1,
  leaves: [],
  active: true,
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const task = (title: string, effortDays: number, service = 'core-payment'): EstimateTask => ({ id: title, draftId: 'd', title, service, role: title.startsWith('[MOBILE-FE]') ? 'MOBILE-FE' : 'BACKEND', effortDays, dependsOn: [] });

const project = (id: string, extra: Partial<EstimateProject> = {}): EstimateProject => ({
  id,
  name: `Proyek ${id}`,
  draftIds: ['d'],
  startDate: '2026-10-05',
  skipCutiBersama: true,
  developers: [],
  tasks: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

/** Andi works 100% on project A for 4 days (until Thu 8 Oct). */
const projectA = project('A', { developers: [{ id: 'dA', name: 'Andi', role: 'BACKEND', allocation: 1, memberId: 'andi' }], tasks: [task('[BACKEND][X][Y] - a', 4)] });

describe('availability', () => {
  it('finds other projects a member is still busy in', () => {
    const schedules = otherSchedules([projectA], 'B', []);
    expect(memberBusy(member('andi'), [projectA], schedules, '2026-10-05')).toEqual([{ projectId: 'A', projectName: 'Proyek A', allocation: 1, until: '2026-10-08' }]);
    expect(memberBusy(member('andi'), [projectA], schedules, '2026-10-12')).toEqual([]);
    // The project itself never counts as "other".
    expect(otherSchedules([projectA], 'A', []).size).toBe(0);
  });

  it('starts right away when enough capacity is left, else after the work that frees it', () => {
    const busy = [{ projectId: 'A', projectName: 'Proyek A', allocation: 0.5, until: '2026-10-08' }];
    expect(availableFrom(member('andi'), busy, '2026-10-05', 0.5)).toEqual({ from: '2026-10-05', freeCapacity: 0.5 });
    expect(availableFrom(member('andi'), busy, '2026-10-05', 1)).toMatchObject({ from: '2026-10-09', reason: expect.stringContaining('Proyek A') });
  });

  it('gives the scheduler a start date and the leave of roster-linked developers only', () => {
    const b = project('B', { developers: [{ id: 'd1', name: 'Andi', role: 'BACKEND', allocation: 1, memberId: 'andi' }, { id: 'd2', name: 'Backend 2', role: 'BACKEND', allocation: 1 }] });
    const leaves = [{ start: '2026-10-20', end: '2026-10-21' }];
    const av = projectAvailability(b, [member('andi', { leaves })], [projectA, b], []);
    expect(av).toEqual({ d1: { from: '2026-10-09', fromReason: expect.stringContaining('Proyek A'), leaves } });
  });

  it('counts leave working days inside a window', () => {
    const m = member('x', { leaves: [{ start: '2026-10-09', end: '2026-10-13' }] });
    // Fri 9, Mon 12, Tue 13 (the weekend does not count).
    expect(leaveDaysBetween(m, '2026-10-05', '2026-10-30', [])).toBe(3);
    expect(leaveDaysBetween(m, '2026-10-12', '2026-10-12', [])).toBe(1);
    expect(leaveDaysBetween(m, '2026-10-14', '2026-10-30', [])).toBe(0);
  });
});

describe('recommendMembers', () => {
  const current = project('B', { tasks: [task('[BACKEND][PAY][Y] - b', 3), task('[MOBILE-FE][APP][Y] - c', 2, 'mobile-app')] });
  const activity: ActivityResponse = {
    days: 180,
    services: [
      { service: 'core-payment', repo: 'core-payment', total: 100, byEmail: { 'citra@example.com': 60, 'budi@example.com': 10 } },
      { service: 'mobile-app', repo: 'mobile-app', total: 50, byEmail: { 'dewi@example.com': 50 } },
    ],
  };

  it('ranks by earliest start week, then familiarity with the role repos, and explains why', () => {
    const members = [member('andi'), member('budi'), member('citra'), member('dewi', { role: 'MOBILE-FE' }), member('eko', { active: false })];
    const recs = recommendMembers({ role: 'BACKEND', members, project: current, projects: [projectA, current], holidays: [], activity });
    expect(recs.map((r) => r.member.id)).toEqual(['citra', 'budi', 'andi']);
    expect(recs[0].familiarity).toMatchObject({ share: 0.6, commits: 60, topService: 'core-payment' });
    expect(recs[0].reasons).toContain('60% commit di core-payment (180 hari terakhir)');
    // Andi is busy until Thursday: same week, but no commits, so last.
    expect(recs[2]).toMatchObject({ availableFrom: '2026-10-09', waitDays: 4 });
    expect(recs[2].reasons.some((r) => r.includes('Proyek A'))).toBe(true);
    expect(recs[2].reasons).toContain('belum ada commit di repo Backend proyek ini');
  });

  it('puts someone free next week behind everyone free this week, whatever their commits', () => {
    const longA = project('A', { developers: [{ id: 'dA', name: 'Citra', role: 'BACKEND', allocation: 1, memberId: 'citra' }], tasks: [task('[BACKEND][X][Y] - a', 8)] });
    const recs = recommendMembers({ role: 'BACKEND', members: [member('budi'), member('citra')], project: current, projects: [longA, current], holidays: [], activity });
    expect(recs.map((r) => r.member.id)).toEqual(['budi', 'citra']);
  });

  it('always counts open Jira work for the start date, skips a start on leave and flags missing git e-mails', () => {
    const members = [member('budi', { jira: { accountId: 'acc-b', displayName: 'Budi' }, leaves: [{ start: '2026-10-08', end: '2026-10-08' }] }), member('fajar', { gitEmails: [] })];
    // The project does not count Jira load in its own schedule; the recommendation still does.
    const recs = recommendMembers({ role: 'BACKEND', members, project: current, projects: [current], holidays: [], activity, jiraLoads: { 'acc-b': { days: 3, issues: 2, inProgress: 1 } } });
    const budi = recs.find((r) => r.member.id === 'budi')!;
    // 3 days of Jira work (Mon–Wed) → Thursday, which is leave → Friday.
    expect(budi.availableFrom).toBe('2026-10-09');
    expect(budi.jira).toEqual({ days: 3, issues: 2, until: '2026-10-07' });
    expect(budi.reasons).toContain('2 tiket Jira belum selesai dev, 1 sedang dikerjakan (±3 hari, selesai ±7 Okt)');
    // Tickets past development are mentioned, never counted.
    const post = recommendMembers({ role: 'BACKEND', members: [members[0]], project: current, projects: [current], holidays: [], jiraLoads: { 'acc-b': { days: 0, issues: 0, postDev: 27 } } })[0];
    expect(post.availableFrom).toBe('2026-10-05');
    expect(post.reasons).toEqual(expect.arrayContaining(['tidak ada tiket Jira yang perlu dikerjakan', '27 tiket sudah lewat development (review, ready to test, QA), tidak dihitung']));
    const fajar = recs.find((r) => r.member.id === 'fajar')!;
    expect(fajar.reasons).toContain('email git belum diisi di daftar tim');
    expect(fajar.reasons).toContain('beban Jira tidak diketahui: akun Jira belum ditautkan di daftar tim');
  });

  it('prefers the lighter Jira load over more commits within the same week, and puts unknown load last', () => {
    const jiraOf = (id: string) => ({ jira: { accountId: `acc-${id}`, displayName: id } });
    const members = [member('budi', jiraOf('budi')), member('citra', jiraOf('citra')), member('gita')];
    const recs = recommendMembers({ role: 'BACKEND', members, project: current, projects: [current], holidays: [], activity, jiraLoads: { 'acc-citra': { days: 2, issues: 3 }, 'acc-budi': { days: 0.5, issues: 1 } } });
    // Citra has 60% of the commits but 2 days of tickets; Budi has half a day. Gita: no Jira link.
    expect(recs.map((r) => r.member.id)).toEqual(['budi', 'citra', 'gita']);
    // Part-time capacity stretches the Jira work: 2 days at 50% = 4 working days.
    const half = recommendMembers({ role: 'BACKEND', members: [member('citra', { ...jiraOf('citra'), capacity: 0.5 })], project: current, projects: [current], holidays: [], jiraLoads: { 'acc-citra': { days: 2, issues: 3 } } });
    expect(half[0]).toMatchObject({ availableFrom: '2026-10-09', waitDays: 4 });
  });

  it('works without git data and marks members already in the team', () => {
    const inTeam = { ...current, developers: [{ id: 'x', name: 'Budi', role: 'BACKEND' as const, allocation: 1, memberId: 'budi' }] };
    const recs = recommendMembers({ role: 'BACKEND', members: [member('budi')], project: inTeam, projects: [inTeam], holidays: [] });
    expect(recs[0]).toMatchObject({ inProject: true, reasons: ['bisa mulai 5 Okt', 'beban Jira tidak diketahui: akun Jira belum ditautkan di daftar tim'] });
    expect(recs[0].familiarity).toBeUndefined();
  });
});
