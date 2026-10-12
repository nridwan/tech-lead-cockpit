// Release management: one release groups the MRs into the production branch (master by default)
// of every service a set of projects touched, the checks on them (code, env, database), the
// deploy runbook, and the release document (imported from Confluence/Markdown or generated).
// Stored by the connector in ~/.tech-lead-cockpit/releases/<id>.json.

export const RELEASE_STATUSES = ['draft', 'review', 'ready', 'released', 'rolled-back'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  draft: 'Draft',
  review: 'Review MR',
  ready: 'Siap rilis',
  released: 'Dirilis',
  'rolled-back': 'Rollback',
};

export interface ReleaseMrRef {
  /** group/repo!12 */
  ref: string;
  projectPath: string;
  iid: number;
  webUrl: string;
  title?: string;
  /** How it got here: found in GitLab, typed in, or read from the release document. */
  via: 'auto' | 'manual' | 'import';
}

export interface ReleaseService {
  id: string;
  /** Service name as in the task titles / repo folder. */
  name: string;
  /** GitLab project path (group/repo), from the repo's git remote or typed in. */
  gitlabPath?: string;
  mrs: ReleaseMrRef[];
  /** 1 = deployed first. */
  order: number;
  pic?: string;
  note?: string;
}

/** Something to do on the server: set an env variable, run a migration or a query. */
export interface ReleaseItem {
  id: string;
  kind: 'env' | 'migration' | 'sql';
  /** Env name, migration file path, or a short label for a query. */
  label: string;
  service?: string;
  /** SQL text for a query from the release document. */
  detail?: string;
  /** Where it was found. */
  source: 'check' | 'import' | 'manual';
  done: boolean;
  doneAt?: string;
}

export interface ReleaseStep {
  id: string;
  kind: 'deploy' | 'rollback';
  text: string;
  service?: string;
  done: boolean;
  doneAt?: string;
}

export interface ReleaseShare {
  at: string;
  chatId: string;
  chatName: string;
  mrRefs: string[];
}

export interface ReleaseSource {
  kind: 'confluence' | 'markdown';
  title: string;
  pageId?: string;
  version?: number;
  url?: string;
  importedAt: string;
}

export interface Release {
  id: string;
  name: string;
  version: string;
  /** Planned release day, YYYY-MM-DD. */
  date?: string;
  status: ReleaseStatus;
  /** Branch the release MRs go into. */
  targetBranch: string;
  /** Approvals an MR needs before the release counts as ready. */
  minApprovals: number;
  /** Cockpit projects in this release (their TAD tasks and codenames). */
  projectIds: string[];
  /** CODENAMEs whose tickets belong here even without a TAD ([TYPE][SERVICE][CODENAME] - …). */
  codenames: string[];
  /** Extra Jira keys (typed in or from the release document). */
  jiraKeys: string[];
  services: ReleaseService[];
  items: ReleaseItem[];
  steps: ReleaseStep[];
  /** The release document as Markdown (imported or edited). */
  docMarkdown?: string;
  source?: ReleaseSource;
  /** Last Teams chat used to ask for review. */
  teamsChat?: { id: string; name: string };
  shares: ReleaseShare[];
  /** Confluence page this release was published to. */
  published?: { pageId: string; version: number; url?: string; at: string };
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the checks found in one MR. */
export interface MrCheck {
  ref: string;
  title: string;
  webUrl: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  pipeline?: string;
  approvals: { count: number; by: string[]; required?: number };
  hasConflicts?: boolean;
  /** Env names added to .env.example-like files. */
  envAdded: string[];
  /** Env names newly read in code (may already exist on the server). */
  envReadInCode: string[];
  migrations: string[];
  /** .sql files outside migration folders: queries someone has to run by hand. */
  sqlOutside: string[];
  /** Models/entities changed without a migration in the same MR. */
  modelWithoutMigration: string[];
  /** Commit titles without a Jira key. */
  commitsWithoutKey: string[];
  jiraKeys: string[];
  /** The diff was cut by GitLab or Cockpit: env lines may be missing. */
  diffTruncated: boolean;
  error?: string;
}

export interface TicketCoverage {
  key: string;
  summary: string;
  status: string;
  service?: string;
  /** Where the ticket comes from. */
  from: 'tad' | 'codename' | 'release';
  /** Release MRs whose commits, title or branch mention it. */
  inMrs: string[];
  /** Jira says development is finished (ready to test, QA, done…). */
  devDone: boolean;
}

export interface ReleaseReport {
  releaseId: string;
  checkedAt: string;
  mrs: MrCheck[];
  tickets: TicketCoverage[];
  /** Services touched by the tickets that have no MR into the target branch. */
  servicesWithoutMr: string[];
  /** Tickets whose title does not follow [TYPE][SERVICE][CODENAME] - Name. */
  badTitles: { key: string; summary: string }[];
  warnings: string[];
}
