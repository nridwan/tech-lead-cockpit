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
  /** Where it was found: the pattern check, the document, typed in, or the AI reading the diff. */
  source: 'check' | 'import' | 'manual' | 'ai';
  /** Why the AI thinks it is needed (files, reasoning). */
  note?: string;
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
  /** Services the user removed: the check never adds them back. */
  ignoredServices?: string[];
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
  /** From the Jira title ([TYPE][SERVICE][CODENAME]), else the TAD row. */
  service?: string;
  /** The TAD row's service when the Jira title names another one. */
  alsoService?: string;
  /** Where the ticket comes from. */
  from: 'tad' | 'codename' | 'release';
  /**
   * Where the work is: release MRs (or `path@branch` when a service has no MR yet) whose diff
   * shows it (strong code evidence) or whose commits / source branch carry its key.
   */
  inMrs: string[];
  /** What the diff shows, per MR or branch: the files and the name or endpoint that matched. */
  code?: CodeEvidence[];
  /** Refs whose commits or source branch carry the key (supporting signal, never required). */
  byKey?: string[];
  /** Only weak code evidence: the words are spread over a file. Needs a human look. */
  unsure?: boolean;
  /** None of the release's services is this ticket's service (e.g. mobile apps): no code to read. */
  noRepo?: boolean;
  /** The AI's reading of the diff, when "Cek dengan AI" ran. It decides over the pattern match. */
  ai?: AiTicketVerdict;
  /** Jira says development is finished (ready to test, QA, done…). */
  devDone: boolean;
}

export interface CodeHit {
  path: string;
  /** The endpoint, identifier or path that matched. */
  match: string;
}

export interface CodeEvidence {
  /** MR ref, or `group/repo@branch` for a service without an MR. */
  ref: string;
  strength: 'strong' | 'weak';
  hits: CodeHit[];
}

/** Code read for a service: its live MR, or the compare of its source branch with the target. */
export interface CodeSource {
  service: string;
  ref: string;
  kind: 'mr' | 'branch';
  files: number;
  /** Changed files no scope ticket accounts for (first 30). */
  unattributed: string[];
  /** Changed files the AI found unrelated to every scope ticket, with why. */
  aiUnrelated?: { path: string; reason: string }[];
  /** Review findings of the AI (leaked secrets, bugs, risks, decisions to make). */
  aiRisks?: { path: string; reason: string }[];
  /** Deploy needs the AI found in a branch without a release MR: they enter the document once the MR exists. */
  aiPending?: ReleaseAiNeed[];
  error?: string;
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
  /** Commits without a Jira key (informational: tickets are found from the code). */
  commitsWithoutKey: number;
  /** Scope tickets found only by weak code evidence: need a look. */
  unsure?: number;
  /** Scope tickets whose service is not in the release (no repo to read). */
  noRepo?: number;
  /** Nothing missing, nothing carried. */
  matched: boolean;
}

export interface ReleaseReport {
  releaseId: string;
  checkedAt: string;
  mrs: MrCheck[];
  tickets: TicketCoverage[];
  /** Release services without a live MR into the target branch. */
  servicesWithoutMr: string[];
  /** The code read per service (MR diff or branch compare). */
  sources?: CodeSource[];
  /** Set when the tickets were also read by AI. */
  ai?: { model: string; errors: string[] };
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
  /** Release tickets of this service, and whether the source branch's diff shows them. */
  tickets: { key: string; summary: string; status: string; inSource: boolean; unsure?: boolean; code?: CodeEvidence; byKey?: boolean }[];
  /** Changed files no ticket of this service accounts for. */
  unattributed?: string[];
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

/** AI verdict on one ticket: ada (implemented), sebagian (partly), tidak (not in the diff). */
export type AiVerdict = 'ada' | 'sebagian' | 'tidak';

export interface AiTicketVerdict {
  verdict: AiVerdict;
  files: string[];
  reason: string;
}

/** The AI's choice for one commit of the release branch. */
export interface AiPick {
  sha: string;
  include: boolean;
  keys: string[];
  reason: string;
}

/** A background AI job of a release: read the tickets in the code, or pick commits for a release branch. */
export interface ReleaseAiJob {
  id: string;
  releaseId: string;
  kind: 'tickets' | 'picks' | 'document' | 'mr' | 'patch' | 'discover';
  serviceId?: string;
  sourceBranch?: string;
  /** What the Tech Lead asked (document fix, commit pick). */
  instruction?: string;
  model: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  /** picks: the AI's choice per commit, and overall notes (mixed commits, missing tickets…). */
  picks?: AiPick[];
  /** document: proposed fixes per service, applied only when the user confirms. */
  fixes?: ReleaseDocFix[];
  /** patch: the changed files split in hunks, with the AI's choice per hunk. */
  patch?: { files: PatchFile[]; skipped: string[] };
  /** mr: the AI's reading of the source branch diff for one service. */
  verdicts?: ({ key: string } & AiTicketVerdict)[];
  unrelated?: { path: string; reason: string }[];
  needs?: ReleaseAiNeed[];
  risks?: { path: string; reason: string }[];
  notes?: string[];
}

/** A fix the AI proposes for one service's part of the deployment document. */
export type ReleaseDocFix = Pick<ReleaseService, 'envBlock' | 'preDeploy' | 'postDeploy' | 'failover'> & {
  serviceId: string;
  name: string;
  /** The service's full list of manual queries after the fix (replaces the current ones). */
  queries?: { label: string; sql?: string }[];
};

/** Something the server needs for a release, found by the AI in the diff. */
export interface ReleaseAiNeed {
  kind: 'env' | 'sql' | 'migration' | 'other';
  /** Before or after the deploy. */
  when: 'pre' | 'post';
  label: string;
  detail?: string;
  files: string[];
}

/** One hunk of a release patch: lines it adds/removes in the target's file, and the AI's choice. */
export interface PatchHunk {
  /** `path#n`. */
  id: string;
  /** Line in the target's file where it starts. */
  at: number;
  added: string[];
  removed: string[];
  /** Lines left out of the preview. */
  more: number;
  include: boolean;
  keys?: string[];
  reason?: string;
}

export interface PatchFile {
  path: string;
  status: 'new' | 'deleted' | 'modified';
  hunks: PatchHunk[];
}
