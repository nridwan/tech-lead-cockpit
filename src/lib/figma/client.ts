import { api, connectorDownMessage } from '../api-base';
import type { FigmaFetchedSet, FigmaScreenList, FigmaStatus, FigmaUser } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/figma${path}`), {
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

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** Read-only Figma access through the local connector (token stays in the Keychain). */
export const figma = {
  status: () => call<FigmaStatus>('/status'),
  /** Validates the token against Figma before it replaces a working one. */
  saveToken: (token: string) => call<{ ok: true; user: FigmaUser }>('/save-token', { token }),
  screens: (url: string) => call<FigmaScreenList>(`/screens?${q({ url })}`),
  fetchScreens: (draftId: string, url: string, screenIds: string[], title?: string) => call<{ set: FigmaFetchedSet; sets: FigmaFetchedSet[] }>('/fetch', { draftId, url, screenIds, title }),
  fetched: (draftId: string, check = false) => call<FigmaFetchedSet[]>(`/fetched?${q({ draftId, ...(check ? { check: '1' } : {}) })}`),
  deleteFetched: (draftId: string, id: string) => call<FigmaFetchedSet[]>('/fetched/delete', { draftId, id }),
  /**
   * A rendered screen as an object URL (the connector needs its client header, which an <img src>
   * cannot send). Revoke it with URL.revokeObjectURL when it is no longer shown.
   */
  imageObjectUrl: async (draftId: string, set: string, name: string) => {
    const res = await fetch(api(`/api/connector/figma/image?${q({ draftId, set, name })}`), { headers: { 'X-TLC-Client': '1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
};
