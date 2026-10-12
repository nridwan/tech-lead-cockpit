import { api, connectorDownMessage } from '../api-base';
import type { MrPlan, Release, ReleaseReport, ReleaseSource } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/releases${path}`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface ShareRequest {
  mrRefs: string[];
  deadline?: string;
  reviewers?: string[];
  note?: string;
  reminder?: boolean;
}

/** Release management through the local connector (GitLab/Jira read-only; Teams after confirmation). */
export const releases = {
  list: () => call<Release[]>(''),
  get: (id: string) => call<Release>(`/one?id=${encodeURIComponent(id)}`),
  save: (release: Partial<Release>) => call<Release>('', { release }),
  remove: (id: string) => call<Release[]>('/delete', { id }),
  discover: (id: string) => call<{ release: Release; addedMrs: number; addedServices: number; warnings: string[] }>('/discover', { id }),
  check: (id: string) => call<{ release: Release; report: ReleaseReport }>('/check', { id }),
  report: (id: string) => call<{ report: ReleaseReport | null }>(`/report?id=${encodeURIComponent(id)}`).then((r) => r.report),
  codenames: (id: string) => call<string[]>(`/codenames?id=${encodeURIComponent(id)}`),
  importDoc: (id: string, markdown: string, source: Omit<ReleaseSource, 'importedAt'>) => call<Release>('/import', { id, markdown, source }),
  /** What a new MR for one service would contain (reads GitLab only). */
  mrPlan: (id: string, serviceId: string, sourceBranch?: string) => call<MrPlan>('/mr/plan', { id, serviceId, sourceBranch }),
  /** Creates the MR in GitLab (token with scope api), or attaches the one already open. */
  createMr: (id: string, serviceId: string, req: { sourceBranch: string; title: string; description: string }) =>
    call<{ release: Release; ref: string; webUrl: string; created: boolean }>('/mr/create', { id, serviceId, ...req }),
  sharePreview: (id: string, req: ShareRequest) => call<{ text: string; html: string }>('/share/preview', { id, ...req }),
  share: (id: string, chat: { id: string; name: string }, req: ShareRequest) => call<Release>('/share', { id, chatId: chat.id, chatName: chat.name, ...req }),
};
