import type { MrFileChange } from '../gitlab/types';
import type { ReleaseBranchPlan } from './branch';

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
  /** Branch this service's release MR comes from (staging, a release branch…); default the release's. */
  sourceBranch?: string;
  /** Deployment page fields (typed in or imported). */
  commitId?: string;
  /** The env code block of the deployment page, values included (local file only). */
  envBlock?: string;
  /** Other pre-deploy tasks (not env, migration or query). */
  preDeploy?: string[];
  postDeploy?: string[];
  failover?: string;
  updatedBy?: DeployPerson;
  mrs: ReleaseMrRef[];
  /** 1 = deployed first. */
  order: number;
  pic?: string;
  note?: string;
}

/** Something to do on the server: set an env variable, run a migration or a query. */
export interface DeployPerson {
  /** Confluence/Atlassian account (shown as a mention); missing for names typed as text. */
  accountId?: string;
  name: string;
}

/** The release info and sections of the team's deployment page. */
export interface DeployInfo {
  /** Release time on the release day, e.g. "06:00". */
  targetTime?: string;
  actual?: string;
  /** Status shown on the page; default follows the release status. */
  statusTitle?: string;
  statusColour?: string;
  impact?: string;
  /** Supervisor, Tech Lead, QA, … with the people for each. */
  roles: { label: string; people: DeployPerson[] }[];
  room?: string;
  issueLink?: string;
  changeLog: { details: string; notes?: string }[];
  /** Jira issues of the release (a JQL link). */
  releaseList?: { url?: string; jql?: string };
  testEvidence: { title: string; url: string }[];
}

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
  /** Branch a new release MR comes from (e.g. staging), per service unless changed in the dialog. */
  sourceBranch: string;
  /** Title of new release MRs; placeholders {TARGET} {RELEASE} {VERSION} {SERVICE} {CODENAME}. Default "[{TARGET}] - {RELEASE}". */
  mrTitleTemplate?: string;
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
  /** Deployment page info (release time, roles, change log, …). */
  deploy?: DeployInfo;
  /** Tickets outside the scope that may ride along on purpose (decided by the user), with why. */
  accepted: { key: string; note?: string; at: string }[];
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
  /** Commit to deploy: the merge commit once merged, else the MR head. */
  commitSha?: string;
  /** Commit titles per Jira key (at most 5 each), to show what a key brought in. */
  keyCommits: Record<string, string[]>;
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

/** A ticket whose commits ride along in a release MR without being in the release. */
export interface OutOfScope {
  key: string;
  summary?: string;
  status?: string;
  /** CODENAME of its title, when it follows the naming rule. */
  codename?: string;
  /** Release MRs that carry it. */
  mrs: string[];
  commits: string[];
}

export interface ScopeSummary {
  /** Tickets in the release scope. */
  tickets: number;
  /** Scope tickets found in the release MRs' code. */
  inCode: number;
  /** Scope tickets not in any release MR. */
  missing: number;
  /** Tickets in the code that are not in the scope (not accepted). */
  carried: number;
  /** Carried tickets the user accepted on purpose. */
  accepted: number;
  /** Commits without a Jira key: their scope cannot be told. */
  commitsWithoutKey: number;
  /** Nothing missing, nothing carried, no unknown commits. */
  matched: boolean;
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
  /** Jira keys in release MRs that are not part of the release: changes carried along. */
  outOfScope: OutOfScope[];
  /** Does the code in the release MRs match the release scope? */
  scope: ScopeSummary;
  warnings: string[];
}

/** What creating a release MR for one service would do (shown before anything is written). */
export interface MrPlan {
  serviceId: string;
  projectPath: string;
  sourceBranch: string;
  targetBranch: string;
  sourceExists: boolean;
  targetExists: boolean;
  /** An MR from source into target is already open: use it instead of creating one. */
  existing?: { ref: string; webUrl: string; title: string };
  commits: { shortId: string; title: string }[];
  files: number;
  /** Changed files with their diff, for reviewing before the MR exists (diffs capped in size). */
  changes: MrFileChange[];
  truncated: boolean;
  findings: Pick<MrCheck, 'envAdded' | 'envReadInCode' | 'migrations' | 'sqlOutside' | 'modelWithoutMigration' | 'commitsWithoutKey' | 'jiraKeys'>;
  /** Release tickets of this service, and whether their key is in the source branch commits. */
  tickets: { key: string; summary: string; status: string; inSource: boolean }[];
  /** Tickets in the source branch commits that are not in the release: would be carried along. */
  outOfScope: OutOfScope[];
  title: string;
  description: string;
  /** GitLab's "new merge request" form, filled in (no write scope needed). */
  formUrl: string;
  /** The token has the `api` scope; undefined when GitLab can't tell. */
  canCreate?: boolean;
  /** A clean branch from the target with only the scope's commits (for a dirty source). */
  releaseBranch: ReleaseBranchPlan;
  warnings: string[];
}
