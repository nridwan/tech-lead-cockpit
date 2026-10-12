import { api, connectorDownMessage } from '../api-base';
import type { ReviewJob, StartReviewRequest } from './types';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Background MR reviews (connector/review); each one is also listed in Agent Tasks. */
export const reviews = {
  /** Newest first, for one MR when `mrUrl` is given. */
  list: (mrUrl?: string) => call<ReviewJob[]>(`/reviews${mrUrl ? `?${new URLSearchParams({ mrUrl })}` : ''}`),
  get: (id: string) => call<ReviewJob>(`/reviews/one?${new URLSearchParams({ id })}`),
  start: (req: StartReviewRequest) => post<ReviewJob>('/reviews', req),
  cancel: (id: string) => post<ReviewJob>('/reviews/cancel', { id }),
};
