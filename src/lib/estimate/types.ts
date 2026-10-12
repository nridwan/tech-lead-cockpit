// Effort estimation per project: a project groups one or more TADs and one team. The AI proposes
// man-days per task, the Tech Lead corrects them, and the schedule (dates, parallel work per
// developer) is computed deterministically from working days. Shared by the connector (store,
// AI job) and the UI.

import type { AiSelection } from '../ai/types';

export const ESTIMATE_ROLES = ['BACKEND', 'MOBILE-FE', 'WEB-FE'] as const;
export type EstimateRole = (typeof ESTIMATE_ROLES)[number];

export const ROLE_LABELS: Record<EstimateRole, string> = {
  BACKEND: 'Backend',
  'MOBILE-FE': 'Mobile FE',
  'WEB-FE': 'Web/CMS FE',
};

export type Confidence = 'low' | 'medium' | 'high';

export interface Developer {
  id: string;
  name: string;
  role: EstimateRole;
  /** Share of a working day spent on this project, 0.1–1. */
  allocation: number;
  /** Linked Jira user (Cloud accountId, or username on Data Center). */
  jira?: { accountId: string; displayName: string };
  /** Open Jira work outside the project at the last refresh. */
  jiraLoad?: { days: number; issues: number; loadedAt: string };
  /** Team roster member this developer is (availability, leave and other projects come from there). */
  memberId?: string;
}

export interface JiraLoadIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  due?: string;
  estimateDays: number;
  /** remaining / original estimate from Jira, or the default per issue. */
  source: 'remaining' | 'original' | 'default';
}

export interface DeveloperJiraLoad {
  accountId: string;
  displayName: string;
  days: number;
  issues: JiraLoadIssue[];
}

export interface JiraCandidate {
  accountId: string;
  displayName: string;
  email?: string;
  openIssues: number;
  inProgress: number;
  loadDays: number;
}

export interface AiEffort {
  effortDays: number;
  confidence: Confidence;
  reason: string;
}

export interface EstimateTask {
  /** Unique within the project: `${draftId}::${title}` (titles may repeat across TADs). */
  id: string;
  /** TAD the task comes from. */
  draftId: string;
  /** Task title as in the Development Scope. */
  title: string;
  service: string;
  role: EstimateRole;
  /** The role was set by hand; otherwise it follows the title tags. */
  roleManual?: boolean;
  /** Final man-days (multiples of 0.5); null = not estimated yet. */
  effortDays: number | null;
  /** The AI's proposal, kept next to the final number for comparison. */
  ai?: AiEffort;
  /** Ids of tasks that must finish first (may be in another TAD of the project). */
  dependsOn: string[];
  /** Fixed developer; otherwise the scheduler picks the one of the right role that finishes earliest. */
  assigneeId?: string;
}

/**
 * Jira tickets that belong to the project outside its TADs (bug fixing, improvements, ops),
 * pulled in by a simple filter and tracked on the Task Board next to TAD tasks.
 */
export interface ProjectJiraFilter {
  /** Jira project key, e.g. MU. */
  projectKey: string;
  /** Issue type names, e.g. Bug, Task, Improvement. Empty = all types. */
  issueTypes: string[];
  label?: string;
  /** Epic (parent) key. */
  epicKey?: string;
  /** Only issues in an open sprint. */
  activeSprint?: boolean;
  /** Finished issues stay listed for this many days after resolution (default 14). */
  doneDays?: number;
}

/** A piece of work without a TAD or ticket of its own, added by hand. */
export interface ProjectManualTask {
  id: string;
  title: string;
  /** Service folder / repo. */
  repo?: string;
  /** Lets MRs be detected (and linked by hand) like any other task. */
  jiraKey?: string;
  /** Marked done by hand (for work without an MR). */
  done?: boolean;
  createdAt: string;
}

export const DEFAULT_DONE_DAYS = 14;

export interface EstimateProject {
  id: string;
  name: string;
  /** TADs in this project; a TAD belongs to at most one project. */
  draftIds: string[];
  /** Jira tickets outside the TADs (bug fixing etc.), tracked on the Task Board. */
  jiraFilter?: ProjectJiraFilter;
  /** Bug Tracing cases whose fix tasks are tracked on the Task Board. */
  bugCaseIds?: string[];
  /** Work added by hand. */
  manualTasks?: ProjectManualTask[];
  /** First working day, YYYY-MM-DD. */
  startDate: string;
  /** Cuti bersama count as days off (most companies follow the SKB). */
  skipCutiBersama: boolean;
  developers: Developer[];
  /** Developers start project work after their open Jira load (linked developers only). */
  useJiraLoad?: boolean;
  /** Days counted for an open Jira issue without an estimate (default 0.5). */
  jiraDefaultDays?: number;
  /** Jira issues not updated for this many days are ignored (default 30, 0 = all). */
  jiraStaleDays?: number;
  tasks: EstimateTask[];
  /** Assumptions and risks from the AI. */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export function taskId(draftId: string, title: string): string {
  return `${draftId}::${title}`;
}

export type HolidayKind = 'libur' | 'cuti-bersama';

export interface Holiday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
  kind: HolidayKind;
}

export interface EstimateTaskInput {
  id: string;
  title: string;
  /** Title of the TAD the task comes from. */
  tadTitle: string;
  service: string;
  role: EstimateRole;
  /** Detail Task as plain text. */
  spec: string;
}

export interface EstimateRequest {
  projectId: string;
  projectName: string;
  ai: AiSelection;
  tasks: EstimateTaskInput[];
  /** Development Analysis / architecture context from the project's TADs. */
  context?: string;
  /** Codebase the AI may read (read-only); omitted = estimate from the TAD only. */
  servicesRoot?: string;
  instructions?: string;
}

export interface EstimateJob {
  id: string;
  projectId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  progress?: string;
  error?: string;
  rawReply?: string;
  /** Proposals keyed by task id; dependsOn holds task ids. */
  result?: { tasks: (AiEffort & { id: string; dependsOn: string[] })[]; notes?: string };
  /** Repos whose working tree changed during the run (should be empty: the codebase is read-only). */
  touchedRepos?: string[];
}

const MOBILE_TAGS = new Set(['MOBILE-FE', 'FE-MOBILE', 'MOBILE', 'ANDROID', 'IOS', 'FLUTTER']);
const WEB_TAGS = new Set(['WEB-FE', 'FE-WEB', 'WEB', 'CMS']);
const GENERIC_FE_TAGS = new Set(['FRONTEND', 'FRONT-END', 'FE', 'UI']);

/**
 * Role from the title tags, e.g. [MOBILE-FE][...] → MOBILE-FE. A generic [FRONTEND]/[FE] task is
 * web unless its service (second tag) names a mobile app. Other tags count as backend.
 */
export function roleOf(title: string): EstimateRole {
  const [type = '', service = ''] = [...title.matchAll(/\[([^\]]+)\]/g)].slice(0, 2).map((m) => m[1].trim().toUpperCase());
  if (!/^\s*\[/.test(title)) return 'BACKEND';
  if (MOBILE_TAGS.has(type)) return 'MOBILE-FE';
  if (WEB_TAGS.has(type)) return 'WEB-FE';
  if (GENERIC_FE_TAGS.has(type)) return /MOBILE|\bAPPS?\b|-APP\b|ANDROID|IOS|FLUTTER/.test(service) ? 'MOBILE-FE' : 'WEB-FE';
  return 'BACKEND';
}

/** Rounds to the nearest half day, at least half a day. */
export function roundEffort(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0.5;
  return Math.max(0.5, Math.round(days * 2) / 2);
}
