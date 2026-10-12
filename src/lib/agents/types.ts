// Mirrors connector/agent-tasks.ts: the Agent Tasks list of Cockpit's local coding-agent runs.

export const AGENT_TASK_STATUSES = ['pending', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_LIMITS = { steer: 20_000 } as const;

export interface AgentTaskProgress {
  /** 0–100. */
  percent?: number;
  message?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  provider: string;
  model?: string;
  approvalPolicy: 'review_required' | 'auto_approve';
  idempotencyKey?: string;
  runId?: string;
  error?: string;
  progress?: AgentTaskProgress;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** general (prompt), review (background MR review / TAD conformance), implement (TAD task → code) or trace (code question). Absent = general. */
  kind?: 'general' | 'review' | 'implement' | 'trace' | 'e2e';
  /** Always `local` in the list (Cockpit's coding agents). */
  runner?: 'local';
  links?: {
    draftId?: string;
    tadTitle?: string;
    taskTitle?: string;
    jiraKey?: string;
    repo?: string;
    branch?: string;
    mrUrl?: string;
    coderRunId?: string;
    traceId?: string;
    qaJobId?: string;
    qaProjectId?: string;
    /** Background MR review (connector/review) behind a `review` task. */
    reviewId?: string;
  };
}

export interface AgentTaskEvent {
  at: string;
  /** `local.<kind>` from the coding run's event log. */
  event: string;
  id?: string;
  /** JSON-encoded payload, truncated by the connector. */
  data?: string;
  truncated?: boolean;
}
