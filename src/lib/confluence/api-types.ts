import type { AiSelection } from '../ai/types.ts';

/** Contract between the UI and the local connector (dev server today, Tauri/Go sidecar later). */

export type Flavor = 'cloud' | 'datacenter';

export interface ConnectorStatus {
  configured: boolean;
  flavor?: Flavor;
  baseUrl?: string;
  auth?: 'basic' | 'bearer';
  tokenPresent: boolean;
  user?: string;
  /** Human-readable reason when not usable (missing config, VPN, token rejected…). */
  error?: string;
}

export interface PageInfo {
  id: string;
  title: string;
  version: number;
  url: string;
  spaceKey: string;
  status?: 'current' | 'draft';
  storage?: string;
}

export interface SpaceInfo {
  key: string;
  name: string;
}

export interface PreflightRequest {
  spaceKey: string;
  title: string;
  parentId?: string;
  /** Page this draft was published to before; takes precedence over title lookup. */
  pageId?: string;
}

export interface PreflightResponse {
  space: SpaceInfo;
  parent?: PageInfo;
  existing?: PageInfo;
}

export interface AttachmentUpload {
  filename: string;
  contentType: string;
  base64: string;
}

export interface PublishRequest {
  spaceKey: string;
  title: string;
  storage: string;
  parentId?: string;
  /** Set to update; omitted to create. */
  pageId?: string;
  /** Version the user reviewed; the connector refuses the update if Confluence moved on. */
  expectedVersion?: number;
  versionMessage?: string;
  attachments: AttachmentUpload[];
  context: { draftId: string; mrUrl?: string; jiraKeys?: string[] };
  /** When true, saved as unpublished draft without bumping public version. */
  asDraft?: boolean;
}

export interface PublishResponse {
  page: PageInfo;
  action: 'create' | 'update';
  isDraft?: boolean;
}

export interface ChangelogRequest {
  title: string;
  isNewPage?: boolean;
  sectionsChanged?: string[];
  diffSnippet?: string;
  ai?: AiSelection;
}

export interface ChangelogResponse {
  message: string;
}

export interface ConnectorError {
  error: string;
  code?: 'conflict' | 'exists' | 'not-configured' | 'unauthorized' | 'not-found' | 'network' | 'bad-request' | 'upstream' | 'pdf-password-required' | 'pdf-password-invalid';
  currentVersion?: number;
  page?: PageInfo;
}

export interface AuditEvent {
  ts: string;
  action: 'confluence.create' | 'confluence.update' | 'whatsapp.send' | 'teams.send' | 'jira.transition' | 'coder.push' | 'qa.run' | 'report.install' | 'report.send'
    | 'remote.enable' | 'remote.disable' | 'remote.pair' | 'remote.revoke' | 'remote.connect' | 'remote.action' | 'bug.ticket' | 'jira.create' | 'gitlab.mr.create';
  result: 'success' | 'failure';
  spaceKey: string;
  title: string;
  pageId?: string;
  versionBefore?: number;
  versionAfter?: number;
  attachments: number;
  mrUrl?: string;
  /** MR commit the decision was based on (Jira transitions after a review). */
  headSha?: string;
  jiraKeys?: string[];
  actor?: string;
  error?: string;
  isDraft?: boolean;
}
