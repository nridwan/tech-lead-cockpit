import { api, connectorDownMessage } from '../api-base';
import type { QAEnvironment, QAGenerateJob, QAGenerateRequest, QARun, QARunRequest, QASuite } from './types';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/qa${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });
const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

export const qa = {
  environments: () => call<QAEnvironment[]>('/environments'),
  /** `secret`: undefined keeps the stored token, '' removes it. `secretVariables`: undefined keeps them. */
  saveEnvironment: (environment: QAEnvironment, secret?: string, secretVariables?: Record<string, string>, dbPasswords?: Record<string, string>, dbServerPassword?: string) =>
    post<QAEnvironment[]>('/environments', { environment, secret, secretVariables, dbPasswords, dbServerPassword }),
  /** Connects (read-only) to the environment's database server, or one mapped database, and returns the server version. */
  testDatabase: (environmentId: string, name?: string) => post<{ version: string }>('/db/test', { environmentId, name }).then((r) => r.version),
  /** Database names on the environment's server. */
  listDatabases: (environmentId: string) => post<{ databases: string[] }>('/db/list', { environmentId }).then((r) => r.databases),
  deleteEnvironment: (id: string) => post<QAEnvironment[]>('/environments/delete', { id }),
  /** `draftIds`/`projectName` let a project adopt the per-TAD suites stored before projects existed. */
  suite: (projectId: string, adopt?: { projectName: string; draftIds: string[] }) =>
    call<{ suite: QASuite | null }>(`/suite${q({ projectId, ...(adopt ? { projectName: adopt.projectName, draftIds: adopt.draftIds.join(',') } : {}) })}`).then((r) => r.suite),
  saveSuite: (suite: QASuite) => post<{ suite: QASuite }>('/suite', { suite }).then((r) => r.suite),
  generate: (req: QAGenerateRequest) => post<QAGenerateJob>('/generate', req),
  job: (id: string) => call<{ job: QAGenerateJob | null }>(`/generate${q({ id })}`).then((r) => r.job),
  latestJob: (projectId: string) => call<{ job: QAGenerateJob | null }>(`/generate${q({ projectId })}`).then((r) => r.job),
  cancelJob: (id: string) => post<{ job: QAGenerateJob | null }>('/generate/cancel', { id }).then((r) => r.job),
  startRun: (req: QARunRequest) => post<QARun>('/runs', req),
  runs: (projectId: string) => call<QARun[]>(`/runs${q({ projectId })}`),
  run: (projectId: string, id: string) => call<QARun>(`/runs/one${q({ projectId, id })}`),
  cancelRun: (id: string) => post<{ run: QARun | null }>('/runs/cancel', { id }).then((r) => r.run),
};

/** Markdown report of a run: summary plus every failing step with its reproduction. */
export function runReport(run: QARun): string {
  const s = run.summary;
  const lines = [
    `# Laporan E2E: ${run.projectName}`,
    '',
    `- Environment: ${run.environment.name}${run.environment.readOnly ? ' (read-only)' : ''}`,
    `- Waktu: ${new Date(run.startedAt).toLocaleString('id-ID')}`,
    `- Flow: ${s.passedFlows}/${s.flows} lulus · Step: ${s.passedSteps}/${s.steps} lulus`,
    '',
  ];
  const failing = run.flows.filter((f) => f.status !== 'passed');
  if (!failing.length) return [...lines, 'Semua flow lulus.'].join('\n');
  lines.push('## Temuan');
  for (const flow of failing) {
    const step = flow.steps.find((st) => st.status !== 'passed' && st.status !== 'skipped');
    lines.push('', `### ${flow.name} (${flow.status})`, `Task: ${flow.taskTitles.join(', ') || '-'}`);
    if (!step) continue;
    lines.push(`Step gagal: **${step.name}**`);
    if (step.error) lines.push(`Error: ${step.error}`);
    for (const a of step.assertions.filter((x) => !x.passed)) lines.push(`- ${a.message}`);
    if (step.response) lines.push('', `Response ${step.response.status}:`, '```json', (step.response.body ?? '').slice(0, 1500), '```');
    if (step.curl) lines.push('', 'Reproduksi:', '```bash', step.curl, '```');
  }
  return lines.join('\n');
}
