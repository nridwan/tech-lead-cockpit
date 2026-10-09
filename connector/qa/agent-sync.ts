import type { QAAgentJob } from '../../src/lib/qa/types.ts';
import type { AgentTaskStatus, AgentTaskStore } from '../agent-tasks.ts';

const TERMINAL = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled']);
const STATUS: Record<QAAgentJob['status'], AgentTaskStatus> = { queued: 'queued', running: 'running', done: 'completed', error: 'failed', cancelled: 'cancelled' };
const ROLE: Record<QAAgentJob['role'], string> = { plan: 'Perencana', write: 'Penulis', repair: 'Perbaikan' };

/** Keeps an E2E pipeline agent (planner, writer per stage, repairer) visible in Agent Tasks (kind `e2e`). */
export async function syncQaAgent(store: Pick<AgentTaskStore, 'get' | 'create' | 'update'>, job: QAAgentJob, projectName: string): Promise<string> {
  let task = job.agentTaskId ? await store.get(job.agentTaskId) : undefined;
  if (!task) {
    ({ task } = await store.create({
      title: `E2E ${ROLE[job.role]} · ${job.label.replace(/^[^:]+:\s*/, '')} · ${projectName}`.slice(0, 300),
      prompt: job.label,
      provider: job.ai.provider,
      model: job.ai.model || undefined,
      status: 'queued',
      approvalPolicy: 'review_required',
      kind: 'e2e',
      runner: 'local',
      links: { qaJobId: job.id, qaProjectId: job.projectId },
      idempotencyKey: `e2e-${job.id}`,
    }));
  }
  if (TERMINAL.has(task.status)) return task.id;
  const message =
    job.status === 'queued'
      ? 'Menunggu giliran (antrian agent paralel)…'
      : job.status === 'running'
        ? job.progress || 'Agent bekerja…'
        : job.status === 'done'
          ? job.result || 'Selesai.'
          : job.status === 'cancelled'
            ? 'Dibatalkan.'
            : 'Agent gagal.';
  await store.update(task.id, { status: STATUS[job.status], progress: { message }, error: job.status === 'error' ? (job.error ?? 'Gagal.').slice(0, 2_000) : null });
  return task.id;
}
