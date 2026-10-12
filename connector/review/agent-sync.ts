import type { ReviewJob } from '../../src/lib/review/types.ts';
import type { AgentTaskStatus, AgentTaskStore } from '../agent-tasks.ts';

const TERMINAL = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled']);
const STATUS: Record<ReviewJob['status'], AgentTaskStatus> = { running: 'running', done: 'completed', error: 'failed', cancelled: 'cancelled' };

/** The conclusion of the review (or its opening) as one plain line for the task card. */
export function reviewSummary(reply: string): string {
  const at = reply.search(/^#{1,4}\s*Kesimpulan/im);
  const section = at >= 0 ? reply.slice(at).replace(/^#{1,4}[^\n]*\n/, '') : reply;
  const plain = section
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 300);
}

export function reviewTaskTitle(job: Pick<ReviewJob, 'kind' | 'mr' | 'task'>): string {
  return job.kind === 'tad' ? `[Cek TAD] ${job.mr.ref} · ${job.task?.title ?? ''}` : `[Review MR] ${job.mr.ref}: ${job.mr.title}`;
}

/**
 * Keeps a background review visible in Agent Tasks (kind `review`, runner `local`), one entry per
 * review job. Only references go into the task; the review itself stays in connector/review.
 */
export async function syncReviewJob(store: Pick<AgentTaskStore, 'get' | 'create' | 'update'>, job: ReviewJob): Promise<string> {
  let task = job.agentTaskId ? await store.get(job.agentTaskId) : undefined;
  if (!task) {
    const what =
      job.kind === 'tad'
        ? `Cek kesesuaian MR ${job.mr.ref} dengan task TAD "${job.task?.title ?? ''}".`
        : `Review MR ${job.mr.ref} (ketelitian ${job.strictness ?? 'standard'}).`;
    ({ task } = await store.create({
      title: reviewTaskTitle(job),
      prompt: `${what}\n${job.mr.webUrl}`,
      provider: job.ai.provider,
      model: job.ai.model || undefined,
      status: 'queued',
      approvalPolicy: 'review_required',
      kind: 'review',
      runner: 'local',
      links: {
        reviewId: job.id,
        mrUrl: job.mr.webUrl,
        ...(job.mr.jiraKeys[0] ? { jiraKey: job.mr.jiraKeys[0] } : {}),
        ...(job.task ? { draftId: job.task.draftId, taskTitle: job.task.title, ...(job.task.tadTitle ? { tadTitle: job.task.tadTitle } : {}) } : {}),
      },
      idempotencyKey: `review-${job.id}`,
    }));
  }
  if (TERMINAL.has(task.status)) return task.id;
  const message =
    job.status === 'running'
      ? job.progress || 'Mereview diff…'
      : job.status === 'done'
        ? reviewSummary(job.reply ?? '') || 'Review selesai.'
        : job.status === 'cancelled'
          ? 'Dibatalkan.'
          : 'Review gagal.';
  await store.update(task.id, { status: STATUS[job.status], progress: { message }, error: job.status === 'error' ? (job.error ?? 'Gagal.').slice(0, 2_000) : null });
  return task.id;
}
