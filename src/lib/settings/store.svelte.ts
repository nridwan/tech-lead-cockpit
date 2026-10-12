import { api, connectorDownMessage } from '../api-base';
import { DEFAULT_SETTINGS, type AppSettings, type SecretId, type SettingsResponse } from './types';

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

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * App-wide settings from the setup wizard. Loaded once after unlock; components read
 * `appSettings.value` for defaults (codebase folder, base branch, Jira project, AI provider, …).
 */
class SettingsState {
  value = $state<AppSettings>(DEFAULT_SETTINGS);
  secrets = $state<Record<SecretId, boolean>>({ confluence: false, jira: false, gitlab: false, inferhub: false, ninerouter: false, figma: false });
  envOnly = $state<string[]>([]);
  loaded = $state(false);
  error = $state('');
  /** The setup wizard is showing (opened on first run, from Koneksi, or via #/setup). */
  wizardOpen = $state(false);

  private apply(r: SettingsResponse) {
    this.value = r.settings;
    this.secrets = r.secrets;
    this.envOnly = r.envOnly;
    this.loaded = true;
    this.error = '';
  }

  async load(): Promise<void> {
    try {
      this.apply(await call<SettingsResponse>('/settings'));
    } catch (e) {
      this.error = (e as Error).message;
      this.loaded = true;
    }
  }

  /** Saves part of the settings (one wizard step). */
  async save(patch: DeepPartial<AppSettings>): Promise<void> {
    this.apply(await call<SettingsResponse>('/settings', { method: 'POST', body: JSON.stringify({ settings: patch }) }));
  }

  /** Stores a token in the Keychain ('' removes it). */
  async saveSecret(id: SecretId, value: string): Promise<void> {
    this.apply(await call<SettingsResponse>('/settings/secret', { method: 'POST', body: JSON.stringify({ id, value }) }));
  }

  get setupDone(): boolean {
    return Boolean(this.value.setup.completedAt);
  }
}

export const appSettings = new SettingsState();
