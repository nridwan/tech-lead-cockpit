// Cockpit's configuration, edited in the setup wizard (no code or .env edits needed). Tokens are
// never part of it: they go to the macOS Keychain and the UI only learns whether one is set.

import type { AiProviderId } from '../ai/types';

export interface AppSettings {
  version: 1;
  general: {
    /** Shown in reports and headers (optional). */
    orgName: string;
    timezone: string;
  };
  workspace: {
    /** Folder with one subfolder per service repo; the AI reads it read-only. */
    servicesRoot: string;
    /** Branch agents and bug fixes start from. */
    defaultBaseBranch: string;
  };
  confluence: { baseUrl: string; auth: 'bearer' | 'basic'; email: string };
  jira: { baseUrl: string; auth: 'bearer' | 'basic'; email: string; defaultProject: string };
  gitlab: { baseUrl: string };
  ai: {
    defaultProvider: AiProviderId;
    /** '' = the provider's own default. */
    defaultModel: string;
    inferhub: { baseUrl: string; model: string };
    ninerouter: { baseUrl: string; model: string };
  };
  teams: { tenantId: string; clientId: string };
  setup: {
    /** Set when the wizard was finished; the wizard opens on its own until then. */
    completedAt?: string;
    /** Steps the user chose to skip. */
    skipped: string[];
  };
}

export type SecretId = 'confluence' | 'jira' | 'gitlab' | 'inferhub' | 'ninerouter' | 'figma';

export interface SettingsResponse {
  settings: AppSettings;
  /** Which tokens are in the Keychain (values never leave the connector). */
  secrets: Record<SecretId, boolean>;
  /** Values still coming from .env.local only (to show where a setting really comes from). */
  envOnly: string[];
  /** True when settings were just migrated from .env.local. */
  migrated: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  general: { orgName: '', timezone: 'Asia/Jakarta' },
  // Empty on a fresh install: the setup wizard asks for it.
  workspace: { servicesRoot: '', defaultBaseBranch: 'staging' },
  // Atlassian Cloud (email + one API token) is the common case; PAT (bearer) is for Server / Data Center.
  confluence: { baseUrl: '', auth: 'basic', email: '' },
  jira: { baseUrl: '', auth: 'basic', email: '', defaultProject: '' },
  gitlab: { baseUrl: '' },
  ai: {
    defaultProvider: '9router',
    defaultModel: 'ag/claude-sonnet-4-6',
    inferhub: { baseUrl: 'https://api.inferhub.dev', model: 'ag/claude-sonnet-4-6' },
    ninerouter: { baseUrl: '', model: 'ag/claude-sonnet-4-6' },
  },
  teams: { tenantId: '', clientId: '' },
  setup: { skipped: [] },
};
