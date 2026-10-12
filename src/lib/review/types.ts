import type { AiSelection } from '../ai/types';
import type { ReviewStrictness } from '../gitlab/types';

/**
 * A background MR review (connector/review): the same review as the inline one on the MR page,
 * but run by the connector so it keeps going after the page is left. `mr` is the full review,
 * `tad` the TAD conformance check of one task.
 */
export type ReviewJobKind = 'mr' | 'tad';
export type ReviewJobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface ReviewJobEvent {
  at: string;
  kind: 'text' | 'tool' | 'tool-error' | 'info';
  text: string;
}

export interface ReviewJobMr {
  ref: string;
  webUrl: string;
  title: string;
  headSha?: string;
  jiraKeys: string[];
}

/** TAD task a conformance check compares the MR against. */
export interface ReviewJobTask {
  draftId: string;
  title: string;
  tadTitle?: string;
}

export interface ReviewJob {
  id: string;
  kind: ReviewJobKind;
  mr: ReviewJobMr;
  task?: ReviewJobTask;
  ai: AiSelection;
  strictness?: ReviewStrictness;
  status: ReviewJobStatus;
  progress?: string;
  /** The review in Markdown, once done. */
  reply?: string;
  error?: string;
  events: ReviewJobEvent[];
  agentTaskId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface StartReviewRequest {
  kind: ReviewJobKind;
  mr: ReviewJobMr;
  task?: ReviewJobTask;
  /** Instruction for the model (strictness, custom notes, TAD spec). */
  prompt: string;
  /** MR metadata + diff, as loaded on the page. */
  context: string;
  strictness?: ReviewStrictness;
  ai: AiSelection;
}

/** Jobs of one MR that belong to the same check: the whole review, or one TAD task's conformance. */
export function sameReviewScope(job: Pick<ReviewJob, 'kind' | 'task'>, kind: ReviewJobKind, task?: Pick<ReviewJobTask, 'draftId' | 'title'>): boolean {
  if (job.kind !== kind) return false;
  if (kind === 'mr') return true;
  return job.task?.draftId === task?.draftId && job.task?.title === task?.title;
}
