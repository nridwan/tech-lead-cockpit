import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { TeamMember } from '../../src/lib/roster/types.ts';
import { projectAvailability } from '../../src/lib/roster/availability.ts';
import { join } from 'node:path';
import type { EstimateProject, Holiday } from '../../src/lib/estimate/types.ts';
import { schedule } from '../../src/lib/estimate/schedule.ts';
import type { MrSummary } from '../../src/lib/gitlab/types.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import type { QARun } from '../../src/lib/qa/types.ts';
import type { MobileAgentTask, MobileE2E, MobileMr, MobileProject, RemoteReportTarget } from '../../src/lib/remote/types.ts';
import { buildTadProgress } from '../../src/lib/tad/progress-build.ts';
import { applyTaskPeaks, calculateCombinedDevProgress, getDevStageCounts, type DevStage, type TadProgressData } from '../../src/lib/tad/progress-report.ts';
import { renderScheduledReport, SNAPSHOT_VERSION, type ProgressSnapshot } from '../../src/lib/report/snapshot.ts';
import { parseScopeTasks } from '../../src/lib/tad/task-links.ts';
import type { MobileData } from './server.ts';

/**
 * What the phone sees, computed in the connector with the app's own pure builders: progress
 * rows/flags (progress-build.ts), dev % and stages (progress-report.ts) and the target date
 * (estimate/schedule.ts). Read-only towards Jira/GitLab; results are cached briefly so a phone
 * refreshing does not hammer them.
 */

export interface MobileSources {
  projects: () => Promise<EstimateProject[]>;
  holidays: () => Promise<Holiday[]>;
  /** Team roster, for availability (other projects, leave) in the target dates; optional. */
  members?: () => Promise<TeamMember[]>;
  drafts: () => Promise<{ id: string; markdown: string; scopePlan?: string }[]>;
  jiraIssues: (keys: string[]) => Promise<JiraIssue[]>;
  /** null when GitLab is not configured or unreachable. */
  gitlabMrsForKeys: (keys: string[]) => Promise<Record<string, MrSummary[]> | null>;
  openMrs: () => Promise<MrSummary[]>;
  agentTasks: () => Promise<{ id: string; title: string; status: string; updatedAt: string; error?: string; progress?: { message?: string } }[]>;
  qaRuns: (projectId: string) => Promise<QARun[]>;
  sendWhatsApp: (jid: string, text: string) => Promise<void>;
  reportTargets: () => Promise<Record<string, RemoteReportTarget>>;
  /** Where the anti-regression peak % per project is kept. */
  dir: string;
  /** Furthest stage per task (shared with the app), so a task that went back keeps its progress. */
  taskPeaks?: { read(): Promise<Record<string, DevStage>>; raise(p: Record<string, DevStage>): Promise<unknown> };
}

const CACHE_MS = 60_000;

const tadTitle = (markdown: string) => markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Untitled';

export function connectorMobileData(src: MobileSources, now: () => number = Date.now): MobileData {
  let cache: { at: number; projects: MobileProject[]; tads: Map<string, { name: string; tads: TadProgressData[]; peak: number }> } | null = null;

  const peaksFile = join(src.dir, 'peaks.json');
  async function readPeaks(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(peaksFile, 'utf8'));
    } catch {
      return {};
    }
  }
  async function writePeaks(peaks: Record<string, number>) {
    await mkdir(src.dir, { recursive: true, mode: 0o700 });
    const tmp = `${peaksFile}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(peaks), { mode: 0o600 });
    await rename(tmp, peaksFile);
  }

  async function load() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    const [projects, drafts, holidays, targets, peaks, members] = await Promise.all([src.projects(), src.drafts(), src.holidays().catch(() => []), src.reportTargets(), readPeaks(), src.members?.().catch(() => []) ?? Promise.resolve([] as TeamMember[])]);
    const tasksByDraft = new Map(drafts.map((d) => [d.id, parseScopeTasks(d.markdown, d.scopePlan)]));
    const keys = [...new Set(projects.flatMap((p) => p.draftIds.flatMap((id) => (tasksByDraft.get(id) ?? []).flatMap((t) => t.jiraKeys))))];

    const errors: string[] = [];
    let issues: Record<string, JiraIssue> = {};
    let mrs: Record<string, MrSummary[]> = {};
    let mrsLoaded = false;
    if (keys.length) {
      await Promise.all([
        src
          .jiraIssues(keys)
          .then((list) => (issues = Object.fromEntries(list.map((i) => [i.key, i]))))
          .catch((e) => errors.push(`Jira: ${(e as Error).message}`)),
        src
          .gitlabMrsForKeys(keys)
          .then((m) => {
            if (m) (mrs = m), (mrsLoaded = true);
            else errors.push('GitLab belum terhubung; status MR tidak ikut dihitung.');
          })
          .catch((e) => errors.push(`GitLab: ${(e as Error).message}`)),
      ]);
    }

    const taskPeaks = (await src.taskPeaks?.read().catch(() => ({}))) ?? {};
    const raisedPeaks: Record<string, DevStage> = {};
    const tadsByProject = new Map<string, { name: string; tads: TadProgressData[]; peak: number }>();
    let peaksChanged = false;
    const out: MobileProject[] = projects.map((p) => {
      const tads = p.draftIds
        .map((id) => drafts.find((d) => d.id === id))
        .filter((d): d is NonNullable<typeof d> => Boolean(d))
        .map((d) => {
          const tad = buildTadProgress(d.id, tadTitle(d.markdown), tasksByDraft.get(d.id) ?? [], issues, mrs, mrsLoaded);
          const { rows, raised } = applyTaskPeaks(d.id, tad.rows, taskPeaks);
          Object.assign(raisedPeaks, raised);
          return { ...tad, rows };
        });
      const live = calculateCombinedDevProgress(tads);
      const peak = Math.max(live, peaks[p.id] ?? 0);
      if (peak !== (peaks[p.id] ?? 0)) (peaks[p.id] = peak), (peaksChanged = true);
      tadsByProject.set(p.id, { name: p.name, tads, peak });
      const stages = getDevStageCounts(tads.flatMap((t) => t.rows));
      let targetDate: string | undefined;
      let targetComplete = false;
      if (p.tasks.length) {
        try {
          const s = schedule({ ...p, availability: projectAvailability(p, members, projects, holidays) }, holidays);
          targetDate = s.endDate;
          targetComplete = s.complete;
        } catch {
          /* invalid start date: no target */
        }
      }
      return {
        id: p.id,
        name: p.name,
        devPercent: peak,
        livePercent: live,
        tasks: stages.total,
        stages: { merged: stages.merged, review: stages.review, inProgress: stages.inProgress, todo: stages.todo },
        attention: tads.flatMap((t) =>
          t.rows
            .filter((r) => r.flags.some((f) => f.tone !== 'info'))
            .map((r) => ({ tad: t.tadTitle, task: r.task.title, jiraKeys: r.task.jiraKeys, flags: r.flags.filter((f) => f.tone !== 'info').map((f) => f.text) })),
        ),
        targetDate,
        targetComplete,
        reportTarget: targets[p.id]?.name,
        errors,
      };
    });
    if (peaksChanged) await writePeaks(peaks).catch(() => {});
    if (Object.keys(raisedPeaks).length) await src.taskPeaks?.raise(raisedPeaks).catch(() => {});
    cache = { at: now(), projects: out, tads: tadsByProject };
    return cache;
  }

  return {
    async projects() {
      return (await load()).projects;
    },

    async agentTasks() {
      const tasks = await src.agentTasks();
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      const order = (s: string) => (['running', 'blocked', 'queued', 'pending', 'failed'].includes(s) ? 0 : 1);
      const list: MobileAgentTask[] = [...tasks]
        .sort((a, b) => order(a.status) - order(b.status) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 30)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt, error: t.error?.slice(0, 300), progress: t.progress?.message?.slice(0, 200) }));
      return { counts, tasks: list };
    },

    async mrs() {
      const list = await src.openMrs();
      return list
        .filter((m, i, a) => a.findIndex((x) => x.ref === m.ref) === i)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 40)
        .map((m): MobileMr => ({ ref: m.ref, title: m.title, author: m.author?.name ?? m.author?.username ?? '', webUrl: m.webUrl, updatedAt: m.updatedAt, draft: m.draft, hasConflicts: m.hasConflicts, pipelineStatus: m.pipelineStatus }));
    },

    async e2e() {
      const projects = await src.projects();
      const runs = await Promise.all(projects.map((p) => src.qaRuns(p.id).then((r) => r[0]).catch(() => undefined)));
      return runs
        .filter((r): r is QARun => Boolean(r))
        .map((r): MobileE2E => ({
          projectId: r.projectId,
          projectName: r.projectName,
          status: r.status,
          environment: r.environment.name,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          passedFlows: r.summary.passedFlows,
          failedFlows: r.summary.failedFlows,
          flows: r.summary.flows,
        }));
    },

    async reportText(projectId) {
      cache = null; // A report goes out: use fresh data.
      const p = (await load()).tads.get(projectId);
      if (!p) throw new Error('Proyek tidak ditemukan.');
      if (!p.tads.length) return { projectName: p.name, text: `Proyek ${p.name} belum punya TAD.` };
      // Same short summary as the scheduled WhatsApp report (numbers only, no task list).
      const at = new Date(now());
      const snapshot: ProgressSnapshot = { version: SNAPSHOT_VERSION, generatedAt: at.toISOString(), projects: [{ projectId, name: p.name, tads: p.tads, peakPercent: p.peak }] };
      return { projectName: p.name, text: renderScheduledReport(snapshot, { now: at }).text };
    },

    async sendWhatsApp(target, text) {
      await src.sendWhatsApp(target.jid, text);
    },
  };
}
