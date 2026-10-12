import { api, connectorDownMessage } from '../api-base';
import type { ActivityResponse, GitAuthor, TeamMember } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/roster${path}`), {
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

/** The team roster (local file) and recent git activity in the Services repos (read-only). */
export const roster = {
  list: () => call<TeamMember[]>(''),
  save: (member: Partial<TeamMember>) => call<TeamMember[]>('', { member }),
  remove: (id: string) => call<TeamMember[]>('/delete', { id }),
  gitAuthors: (servicesRoot?: string, days?: number) => call<GitAuthor[]>(`/git-authors?${new URLSearchParams({ ...(servicesRoot ? { root: servicesRoot } : {}), ...(days ? { days: String(days) } : {}) })}`),
  activity: (services: string[], servicesRoot?: string, days?: number) => call<ActivityResponse>('/activity', { services, root: servicesRoot, days }),
};
