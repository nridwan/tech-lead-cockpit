// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aggregateLoads, issueLoadDays, jiraCandidates, jiraLoads, openJql, type JiraSearch } from './jira-load.ts';

const issue = (key: string, assignee: string, status: [string, string], est: { timeestimate?: number; timeoriginalestimate?: number } = {}, due?: string) => ({
  key,
  fields: { summary: `Issue ${key}`, status: { name: status[0], statusCategory: { key: status[1] } }, assignee: { accountId: assignee, displayName: assignee.toUpperCase() }, duedate: due, ...est },
});

const H = 3600;

describe('Jira load', () => {
  it('turns estimates into working days', () => {
    expect(issueLoadDays({ timeestimate: 12 * H, timeoriginalestimate: 40 * H }, 1)).toEqual({ estimateDays: 1.5, source: 'remaining' });
    expect(issueLoadDays({ timeoriginalestimate: 16 * H }, 1)).toEqual({ estimateDays: 2, source: 'original' });
    expect(issueLoadDays({ timeoriginalestimate: 1 * H }, 1)).toEqual({ estimateDays: 0.5, source: 'original' });
    expect(issueLoadDays({}, 1.5)).toEqual({ estimateDays: 1.5, source: 'default' });
  });

  it('groups by assignee, skips the project tasks and orders in-progress work first', () => {
    const loads = aggregateLoads(
      [
        issue('MU-1', 'budi', ['To Do', 'new'], {}, '2026-10-20'),
        issue('MU-2', 'budi', ['In Progress', 'indeterminate'], { timeestimate: 8 * H }),
        issue('MU-3', 'budi', ['To Do', 'new'], {}, '2026-10-10'),
        issue('MU-9', 'budi', ['In Progress', 'indeterminate']),
        issue('MU-4', 'citra', ['To Do', 'new'], { timeoriginalestimate: 24 * H }),
        { key: 'MU-5', fields: { status: { name: 'To Do' } } },
        { ...issue('MU-6', 'citra', ['In Progress', 'indeterminate']), fields: { ...issue('MU-6', 'citra', ['In Progress', 'indeterminate']).fields, issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
      ],
      ['MU-9'],
      1,
    );
    expect(Object.keys(loads).sort()).toEqual(['budi', 'citra']);
    expect(loads.budi.days).toBe(3);
    expect(loads.budi.issues.map((i) => i.key)).toEqual(['MU-2', 'MU-3', 'MU-1']);
    expect(loads.citra).toMatchObject({ displayName: 'CITRA', days: 3 });
  });

  it('does not count tickets past development (review, ready to test, QA) as load or as in progress', () => {
    const loads = aggregateLoads(
      [
        issue('MU-10', 'barru', ['READY TO TEST', 'indeterminate']),
        issue('MU-11', 'barru', ['IN REVIEW TL', 'indeterminate']),
        issue('MU-12', 'barru', ['IN QA', 'indeterminate']),
        issue('MU-13', 'barru', ['Code Not Pass', 'indeterminate']),
        issue('MU-14', 'barru', ['To Do', 'new']),
        issue('MU-15', 'barru', ['In Progress', 'indeterminate']),
        issue('MU-16', 'barru', ['Analisa', 'indeterminate']),
      ],
      [],
      0.5,
    );
    const l = loads.barru;
    expect(l.postDev!.map((i) => [i.key, i.stage])).toEqual([
      ['MU-10', 'done'],
      ['MU-11', 'review'],
      ['MU-12', 'done'],
    ]);
    // Rework, coding and unknown progress statuses are coding; To Do waits.
    expect(Object.fromEntries(l.issues.map((i) => [i.key, i.stage]))).toEqual({ 'MU-13': 'in_progress', 'MU-14': 'todo', 'MU-15': 'in_progress', 'MU-16': 'in_progress' });
    expect(l.days).toBe(2);
    expect(l.issues.filter((i) => i.stage === 'in_progress')).toHaveLength(3);
  });

  it('gives an account whose tickets are all past development no load', () => {
    const l = aggregateLoads([issue('MU-1', 'barru', ['READY TO TEST', 'indeterminate']), issue('MU-2', 'barru', ['IN REVIEW TL', 'indeterminate'])], [], 0.5).barru;
    expect(l).toMatchObject({ days: 0, issues: [] });
    expect(l.postDev).toHaveLength(2);
  });

  it('queries open work per account and ranks candidates by load', async () => {
    const jqls: string[] = [];
    const jira: JiraSearch = {
      searchRaw: async (jql) => (jqls.push(jql), [issue('MU-1', 'budi', ['In Progress', 'indeterminate'], { timeestimate: 16 * H }), issue('MU-2', 'citra', ['To Do', 'new'])]),
      assignableUsers: async () => [
        { accountId: 'budi', displayName: 'Budi' },
        { accountId: 'citra', displayName: 'Citra' },
        { accountId: 'dewi', displayName: 'Dewi' },
        { accountId: 'bad id"; drop', displayName: 'x' },
      ],
    };
    const loads = await jiraLoads(jira, ['budi', 'dewi'], ['MU-77'], { defaultDays: 1 });
    expect(jqls[0]).toBe('assignee in ("budi","dewi") AND statusCategory != Done AND updated >= -30d ORDER BY updated DESC');
    expect(openJql(['x'], 0)).toBe('assignee in ("x") AND statusCategory != Done ORDER BY updated DESC');
    expect(loads.dewi).toEqual({ accountId: 'dewi', displayName: 'dewi', days: 0, issues: [] });
    expect(loads.budi.days).toBe(2);

    const cands = await jiraCandidates(jira, ['MU'], [], { defaultDays: 1 });
    expect(cands.map((c) => [c.displayName, c.loadDays, c.openIssues, c.inProgress])).toEqual([
      ['Dewi', 0, 0, 0],
      ['Citra', 1, 1, 0],
      ['Budi', 2, 1, 1],
    ]);
    await expect(jiraLoads(jira, ['a" OR 1=1'], [])).rejects.toThrow('Akun Jira');
    await expect(jiraCandidates(jira, ['mu; drop'], [])).rejects.toThrow('Project key');
    await expect(jiraLoads(jira, ['budi'], [], { defaultDays: 0 })).rejects.toThrow('Default');
    await expect(jiraLoads(jira, ['budi'], [], { staleDays: 1.5 })).rejects.toThrow('basi');
    // Default per issue without an estimate is half a day.
    expect((await jiraLoads(jira, ['citra'], [])).citra.days).toBe(0.5);
  });
});
