import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings, type SecretId } from '../src/lib/settings/types.ts';
import { CONFLUENCE_SERVICE, FIGMA_SERVICE, GITLAB_SERVICE, INFERHUB_SERVICE, JIRA_SERVICE, NINEROUTER_SERVICE } from './keychain.ts';
import { DATA_DIR } from './paths.ts';

/**
 * Cockpit's configuration, set in the setup wizard instead of code or .env files:
 * ~/.tech-lead-cockpit/settings.json (0600) for plain settings, the macOS Keychain for tokens.
 * Older installs configured through .env.local are migrated once. The rest of the connector still
 * reads `env` (CONFLUENCE_BASE_URL, …): the settings are applied onto it, so existing code follows
 * whatever the wizard saved.
 */

export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export class SettingsInputError extends Error {}

/** Keychain service per secret. */
export const SECRET_SERVICES: Record<SecretId, string> = {
  confluence: CONFLUENCE_SERVICE,
  jira: JIRA_SERVICE,
  gitlab: GITLAB_SERVICE,
  inferhub: INFERHUB_SERVICE,
  ninerouter: NINEROUTER_SERVICE,
  figma: FIGMA_SERVICE,
};

type Env = Record<string, string | undefined>;

const url = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw new SettingsInputError(`${what} harus diawali http:// atau https://.`);
  return s;
};
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);

/** Fills missing fields with defaults and checks the values a user can type. */
export function validateSettings(raw: Partial<AppSettings>): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = raw ?? {};
  const branch = text(r.workspace?.defaultBaseBranch, 100) || d.workspace.defaultBaseBranch;
  if (!/^[\w./-]+$/.test(branch)) throw new SettingsInputError('Nama branch dasar tidak valid.');
  const project = text(r.jira?.defaultProject, 10).toUpperCase();
  if (project && !/^[A-Z][A-Z0-9]{1,9}$/.test(project)) throw new SettingsInputError('Project key Jira tidak valid (mis. MU).');
  return {
    version: 1,
    general: { orgName: text(r.general?.orgName, 120), timezone: text(r.general?.timezone, 60) || d.general.timezone },
    workspace: { servicesRoot: text(r.workspace?.servicesRoot, 500) || d.workspace.servicesRoot, defaultBaseBranch: branch },
    confluence: {
      baseUrl: url(r.confluence?.baseUrl, 'URL Confluence'),
      auth: oneOf(r.confluence?.auth, ['bearer', 'basic'] as const, d.confluence.auth),
      email: text(r.confluence?.email, 200),
    },
    jira: {
      baseUrl: url(r.jira?.baseUrl, 'URL Jira'),
      auth: oneOf(r.jira?.auth, ['bearer', 'basic'] as const, d.jira.auth),
      email: text(r.jira?.email, 200),
      defaultProject: project,
    },
    gitlab: { baseUrl: url(r.gitlab?.baseUrl, 'URL GitLab') },
    ai: {
      defaultProvider: oneOf(r.ai?.defaultProvider, ['claude', 'antigravity', 'inferhub', '9router'] as const, d.ai.defaultProvider),
      defaultModel: text(r.ai?.defaultModel, 120),
      inferhub: { baseUrl: url(r.ai?.inferhub?.baseUrl, 'URL InferHub') || d.ai.inferhub.baseUrl, model: text(r.ai?.inferhub?.model, 120) || d.ai.inferhub.model },
      ninerouter: { baseUrl: url(r.ai?.ninerouter?.baseUrl, 'URL 9Router'), model: text(r.ai?.ninerouter?.model, 120) || d.ai.ninerouter.model },
    },
    teams: { tenantId: text(r.teams?.tenantId, 100), clientId: text(r.teams?.clientId, 100) },
    setup: { completedAt: typeof r.setup?.completedAt === 'string' ? r.setup.completedAt : undefined, skipped: Array.isArray(r.setup?.skipped) ? r.setup.skipped.map(String).slice(0, 20) : [] },
  };
}

/** Settings from an install configured through .env.local (before the wizard existed). */
function authFrom(auth: string, baseUrl: string): 'basic' | 'bearer' {
  if (auth === 'basic' || auth === 'bearer') return auth;
  return baseUrl && !/\.atlassian\.net/i.test(baseUrl) ? 'bearer' : 'basic';
}

export function settingsFromEnv(env: Env): AppSettings {
  const v = (k: string) => env[k]?.trim() || '';
  const safeUrl = (k: string) => {
    try {
      return url(v(k), k);
    } catch {
      return '';
    }
  };
  return validateSettings({
    // An old .env.local without *_AUTH meant a PAT (bearer); with no URL at all it's a fresh install (Cloud default).
    confluence: { baseUrl: safeUrl('CONFLUENCE_BASE_URL'), auth: authFrom(v('CONFLUENCE_AUTH'), safeUrl('CONFLUENCE_BASE_URL')), email: v('CONFLUENCE_EMAIL') },
    jira: { baseUrl: safeUrl('JIRA_BASE_URL'), auth: authFrom(v('JIRA_AUTH'), safeUrl('JIRA_BASE_URL')), email: v('JIRA_EMAIL'), defaultProject: '' },
    gitlab: { baseUrl: safeUrl('GITLAB_BASE_URL') },
    ai: {
      ...DEFAULT_SETTINGS.ai,
      inferhub: { baseUrl: safeUrl('INFERHUB_BASE_URL') || DEFAULT_SETTINGS.ai.inferhub.baseUrl, model: v('INFERHUB_MODEL') || DEFAULT_SETTINGS.ai.inferhub.model },
      ninerouter: { baseUrl: safeUrl('NINEROUTER_BASE_URL'), model: v('NINEROUTER_MODEL') || DEFAULT_SETTINGS.ai.ninerouter.model },
    },
    teams: { tenantId: v('TEAMS_TENANT_ID'), clientId: v('TEAMS_CLIENT_ID') },
  } as Partial<AppSettings>);
}

/**
 * Puts the settings onto the env the connector reads. Empty settings leave env alone, so a value
 * only in .env.local keeps working until the wizard sets one.
 */
export function applySettingsToEnv(s: AppSettings, ...targets: Env[]) {
  const map: Record<string, string> = {
    CONFLUENCE_BASE_URL: s.confluence.baseUrl,
    CONFLUENCE_AUTH: s.confluence.baseUrl ? s.confluence.auth : '',
    CONFLUENCE_EMAIL: s.confluence.email,
    JIRA_BASE_URL: s.jira.baseUrl,
    JIRA_AUTH: s.jira.baseUrl ? s.jira.auth : '',
    JIRA_EMAIL: s.jira.email,
    GITLAB_BASE_URL: s.gitlab.baseUrl,
    INFERHUB_BASE_URL: s.ai.inferhub.baseUrl,
    INFERHUB_MODEL: s.ai.inferhub.model,
    NINEROUTER_BASE_URL: s.ai.ninerouter.baseUrl,
    NINEROUTER_MODEL: s.ai.ninerouter.model,
    TEAMS_TENANT_ID: s.teams.tenantId,
    TEAMS_CLIENT_ID: s.teams.clientId,
    TLC_SERVICES_ROOT: s.workspace.servicesRoot,
    TLC_DEFAULT_BRANCH: s.workspace.defaultBaseBranch,
  };
  for (const target of targets) for (const [k, val] of Object.entries(map)) if (val) target[k] = val;
}

export class SettingsStore {
  private cache?: AppSettings;

  constructor(private readonly file = SETTINGS_FILE) {}

  /** The saved settings; on the first run the ones from .env.local (migrated and saved). */
  async load(env: Env = process.env): Promise<{ settings: AppSettings; migrated: boolean }> {
    if (this.cache) return { settings: this.cache, migrated: false };
    try {
      this.cache = validateSettings(JSON.parse(await readFile(this.file, 'utf8')));
      return { settings: this.cache, migrated: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    const migrated = settingsFromEnv(env);
    await this.write(migrated);
    return { settings: migrated, migrated: true };
  }

  /** Merges a partial update (one wizard step at a time) and saves it. */
  async update(patch: Partial<AppSettings>, env: Env = process.env): Promise<AppSettings> {
    const { settings } = await this.load(env);
    const merged: Partial<AppSettings> = { ...settings };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) (merged as Record<string, unknown>)[k] = { ...(settings as unknown as Record<string, object>)[k], ...v };
    }
    if (patch.ai) merged.ai = { ...settings.ai, ...patch.ai, inferhub: { ...settings.ai.inferhub, ...patch.ai.inferhub }, ninerouter: { ...settings.ai.ninerouter, ...patch.ai.ninerouter } };
    const next = validateSettings(merged);
    await this.write(next);
    return next;
  }

  private async write(s: AppSettings) {
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    this.cache = s;
  }
}
