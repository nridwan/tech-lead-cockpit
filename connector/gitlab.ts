import type {
  GitLabUser,
  MrCommit,
  MrDetail,
  MrFileChange,
  MrRisk,
  MrScope,
  MrSummary,
  PipelineStatus,
  RiskKind,
} from '../src/lib/gitlab/types.ts';

/**
 * Read-only GitLab client for the internal instance (reached over the laptop's VPN).
 * Authenticates with a Personal Access Token (scope `read_api`) kept in the Keychain.
 * Only GET requests are made; MR content is treated as untrusted data.
 */

export interface GitLabConfig {
  baseUrl: string;
  token: string;
}

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'unauthorized' | 'forbidden' | 'not-found' | 'bad-request' | 'network' | 'upstream' = 'upstream',
  ) {
    super(message);
  }
}

/** Keeps responses (and AI prompts) bounded for huge MRs. */
const MAX_FILE_DIFF_CHARS = 200_000;
const MAX_TOTAL_DIFF_CHARS = 1_500_000;
const MAX_FILES = 400;

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api\/v4$/, '');
}

/**
 * `https://gitlab.x/group/sub/project/-/merge_requests/12` → { projectPath, iid }.
 * Only URLs on the configured host are accepted, so the token is never sent elsewhere.
 */
export function parseMrUrl(url: string, baseUrl: string): { projectPath: string; iid: number } | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(url.trim());
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.host !== base.host) return null;
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
  const m = path.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  return m ? { projectPath: decodeURIComponent(m[1]), iid: Number(m[2]) } : null;
}

/** Words that look like issue keys but aren't (UTF-8, SHA-256, …). */
const NOT_JIRA = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'CVE', 'GMT', 'UTC', 'PR', 'MR']);

export function extractJiraKeys(...texts: (string | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
      if (!NOT_JIRA.has(m[1])) keys.add(`${m[1]}-${m[2]}`);
    }
  }
  return [...keys];
}

const RISK_RULES: { kind: RiskKind; label: string; pattern: RegExp }[] = [
  { kind: 'auth', label: 'Auth / session / permission', pattern: /(auth|login|logout|session|permission|role|acl|jwt|oauth|token|password|passcode|otp|\bpin\b|middleware)/i },
  { kind: 'database', label: 'Database / migration', pattern: /(migration|migrate|\.sql$|schema\.|\/db\/|database|seeder)/i },
  { kind: 'payment', label: 'Payment / data finansial', pattern: /(payment|wallet|transaction|\btrx|topup|top-up|refund|settlement|disburs|qris|balance|ledger|\bfee|invoice|billing|cashout|transfer)/i },
  { kind: 'infra', label: 'Infrastruktur / deployment', pattern: /(dockerfile|docker-compose|compose\.ya?ml|\.gitlab-ci|makefile|\bk8s\b|helm|terraform|nginx|supervisor|\.service$)/i },
  { kind: 'api', label: 'Kontrak API', pattern: /(route|router|controller|handler|swagger|openapi|\.proto$|\/api\/|graphql|dto|request\.|response\.)/i },
  { kind: 'config', label: 'Secret / konfigurasi', pattern: /(\.env|config|setting|secret|credential|\.ini$|\.properties$|application\.ya?ml|\.pem$|\.key$)/i },
];

const TEST_FILE = /(test|spec|__tests__|_test\.go$|\.test\.|\.spec\.)/i;
const CODE_FILE = /\.(go|php|ts|tsx|js|jsx|py|java|kt|swift|dart|rb|cs|rs|vue|svelte)$/i;

export function detectRisks(changes: Pick<MrFileChange, 'newPath' | 'oldPath' | 'additions' | 'deletions'>[]): MrRisk[] {
  const risks: MrRisk[] = [];
  for (const rule of RISK_RULES) {
    const files = changes.filter((c) => rule.pattern.test(c.newPath) || rule.pattern.test(c.oldPath)).map((c) => c.newPath);
    if (files.length) risks.push({ kind: rule.kind, label: rule.label, files });
  }
  const lines = changes.reduce((n, c) => n + c.additions + c.deletions, 0);
  if (changes.length > 40 || lines > 1_500) {
    risks.push({ kind: 'size', label: `Perubahan besar (${changes.length} file, ${lines} baris)`, files: [] });
  }
  const codeChanged = changes.some((c) => CODE_FILE.test(c.newPath) && !TEST_FILE.test(c.newPath));
  if (codeChanged && !changes.some((c) => TEST_FILE.test(c.newPath))) {
    risks.push({ kind: 'tests', label: 'Kode berubah tanpa perubahan test', files: [] });
  }
  return risks;
}

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

// ── GitLab API shapes (only the fields used) ──
interface ApiUser {
  id: number;
  username: string;
  name: string;
  avatar_url?: string;
}
interface ApiMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: MrSummary['state'];
  draft?: boolean;
  work_in_progress?: boolean;
  author: ApiUser;
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  has_conflicts?: boolean;
  user_notes_count?: number;
  references?: { full?: string };
  sha?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  head_pipeline?: { id: number; status: PipelineStatus; web_url?: string } | null;
  pipeline?: { id: number; status: PipelineStatus; web_url?: string } | null;
  reviewers?: ApiUser[];
  assignees?: ApiUser[];
  labels?: string[];
}
interface ApiDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}
interface ApiCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  created_at: string;
}

const user = (u: ApiUser): GitLabUser => ({ id: u.id, username: u.username, name: u.name, avatarUrl: u.avatar_url });

function projectPathOf(mr: ApiMr): string {
  const full = mr.references?.full;
  if (full?.includes('!')) return full.slice(0, full.lastIndexOf('!'));
  const m = mr.web_url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//);
  return m ? m[1] : String(mr.project_id);
}

function summary(mr: ApiMr): MrSummary {
  const projectPath = projectPathOf(mr);
  return {
    ref: `${projectPath}!${mr.iid}`,
    projectId: mr.project_id,
    projectPath,
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    author: user(mr.author),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    webUrl: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    hasConflicts: mr.has_conflicts,
    userNotesCount: mr.user_notes_count,
    pipelineStatus: (mr.head_pipeline ?? mr.pipeline)?.status,
  };
}

export class GitLabClient {
  constructor(
    private readonly cfg: GitLabConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<{ body: T; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v4${path}`, {
        headers: { 'PRIVATE-TOKEN': this.cfg.token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new GitLabError(`GitLab tidak terjangkau (${(e as Error).message}). Pastikan VPN aktif.`, 502, 'network');
    }
    if (res.status === 401) throw new GitLabError('Token GitLab ditolak (401). Periksa atau buat ulang token dengan scope read_api.', 401, 'unauthorized');
    if (res.status === 403) throw new GitLabError('Akses ditolak (403). Token tidak punya akses ke project ini.', 403, 'forbidden');
    if (res.status === 404) throw new GitLabError('Tidak ditemukan di GitLab (404).', 404, 'not-found');
    if (!res.ok) throw new GitLabError(`GitLab membalas HTTP ${res.status}.`, 502, 'upstream');
    return { body: (await res.json()) as T, headers: res.headers };
  }

  async currentUser(): Promise<GitLabUser> {
    return user((await this.get<ApiUser>('/user')).body);
  }

  async version(): Promise<string | undefined> {
    return (await this.get<{ version?: string }>('/version').catch(() => undefined))?.body.version;
  }

  async listMrs(scope: MrScope, me: GitLabUser): Promise<MrSummary[]> {
    const q =
      scope === 'all'
        ? 'scope=all'
        : scope === 'reviewer'
          ? `scope=all&reviewer_id=${me.id}`
          : scope === 'assigned'
            ? 'scope=assigned_to_me'
            : 'scope=created_by_me';
    const { body } = await this.get<ApiMr[]>(`/merge_requests?state=opened&${q}&order_by=updated_at&per_page=100`);
    return body.map(summary);
  }

  /**
   * MRs mentioning each Jira key in branch, title or description: the last 90 days of MRs are
   * scanned locally (GitLab's search ignores branch names), then GitLab search fills the gaps.
   */
  async mrsForKeys(keys: string[]): Promise<Record<string, MrSummary[]>> {
    const want = [...new Set(keys)].slice(0, 60);
    const out: Record<string, MrSummary[]> = Object.fromEntries(want.map((k) => [k, []]));
    if (!want.length) return out;
    const add = (key: string, mr: ApiMr) => {
      if (!out[key].some((m) => m.ref === summary(mr).ref)) out[key].push(summary(mr));
    };
    const mentions = (mr: ApiMr, key: string) =>
      new RegExp(`\\b${key}\\b`).test(`${mr.source_branch} ${mr.title} ${mr.description ?? ''}`);
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    for (let page = 1; page <= 3; page++) {
      const { body, headers } = await this.get<ApiMr[]>(`/merge_requests?scope=all&state=all&order_by=updated_at&updated_after=${since}&per_page=100&page=${page}`);
      for (const mr of body) for (const key of want) if (mentions(mr, key)) add(key, mr);
      if (!headers.get('x-next-page')) break;
    }
    for (const key of want.filter((k) => !out[k].length).slice(0, 20)) {
      const { body } = await this.get<ApiMr[]>(`/merge_requests?scope=all&state=all&search=${encodeURIComponent(key)}&per_page=20`).catch(() => ({ body: [] as ApiMr[] }));
      for (const mr of body) if (mentions(mr, key)) add(key, mr);
    }
    return out;
  }

  /**
   * MRs into a branch (e.g. master) across all projects the token can see, updated in the last
   * `days`, open and merged: the candidates for a release.
   */
  async mrsToBranch(targetBranch: string, days = 30): Promise<(MrSummary & { description: string })[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const out: (MrSummary & { description: string })[] = [];
    for (let page = 1; page <= 3; page++) {
      const { body, headers } = await this.get<ApiMr[]>(`/merge_requests?scope=all&state=all&target_branch=${encodeURIComponent(targetBranch)}&updated_after=${since}&order_by=updated_at&per_page=100&page=${page}`);
      for (const mr of body) if (mr.state === 'opened' || mr.state === 'merged') out.push({ ...summary(mr), description: mr.description ?? '' });
      if (!headers.get('x-next-page')) break;
    }
    return out;
  }

  /** One MR's summary (state, branches, pipeline), e.g. to refresh an MR linked by hand. */
  async mrSummary(projectPath: string, iid: number): Promise<MrSummary> {
    const { body } = await this.get<ApiMr>(`/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`);
    return summary(body);
  }

  async mr(projectPath: string, iid: number): Promise<MrDetail> {
    const project = encodeURIComponent(projectPath);
    const base = `/projects/${project}/merge_requests/${iid}`;
    const [{ body: mr }, commits, approvals, diffs] = await Promise.all([
      this.get<ApiMr>(base),
      this.get<ApiCommit[]>(`${base}/commits?per_page=100`).then((r) => r.body).catch(() => [] as ApiCommit[]),
      this.get<{ approved?: boolean; approved_by?: { user: ApiUser }[]; approvals_required?: number; approvals_left?: number }>(`${base}/approvals`)
        .then((r) => r.body)
        .catch(() => undefined),
      this.diffs(base),
    ]);

    let budget = MAX_TOTAL_DIFF_CHARS;
    let diffTruncated = diffs.length > MAX_FILES;
    const changes: MrFileChange[] = diffs.slice(0, MAX_FILES).map((d) => {
      const counts = countDiffLines(d.diff ?? '');
      let diff = d.diff ?? '';
      let truncated = Boolean(d.too_large || d.collapsed);
      if (diff.length > MAX_FILE_DIFF_CHARS || diff.length > budget) {
        diff = '';
        truncated = true;
      }
      budget -= diff.length;
      if (truncated) diffTruncated = true;
      return {
        oldPath: d.old_path,
        newPath: d.new_path,
        newFile: d.new_file,
        renamedFile: d.renamed_file,
        deletedFile: d.deleted_file,
        diff,
        truncated,
        ...counts,
      };
    });

    const commitList: MrCommit[] = commits.map((c) => ({ id: c.id, shortId: c.short_id, title: c.title, authorName: c.author_name, createdAt: c.created_at }));
    const pipeline = mr.head_pipeline ?? mr.pipeline ?? undefined;
    return {
      ...summary(mr),
      description: mr.description ?? '',
      headSha: mr.sha,
      mergeStatus: mr.detailed_merge_status ?? mr.merge_status,
      pipeline: pipeline ? { id: pipeline.id, status: pipeline.status, webUrl: pipeline.web_url } : undefined,
      approvals: approvals && {
        approved: Boolean(approvals.approved),
        approvedBy: (approvals.approved_by ?? []).map((a) => a.user.name),
        required: approvals.approvals_required,
        left: approvals.approvals_left,
      },
      reviewers: (mr.reviewers ?? []).map(user),
      assignees: (mr.assignees ?? []).map(user),
      labels: mr.labels ?? [],
      commits: commitList,
      changes,
      totals: {
        files: diffs.length,
        additions: changes.reduce((n, c) => n + c.additions, 0),
        deletions: changes.reduce((n, c) => n + c.deletions, 0),
      },
      jiraKeys: extractJiraKeys(mr.source_branch, mr.title, mr.description ?? '', ...commitList.map((c) => c.title)),
      risks: detectRisks(changes),
      diffTruncated,
    };
  }

  /** `/diffs` (GitLab ≥ 15.7, paginated); older instances only have `/changes`. */
  private async diffs(base: string): Promise<ApiDiff[]> {
    try {
      const out: ApiDiff[] = [];
      for (let page = 1; page <= 10; page++) {
        const { body, headers } = await this.get<ApiDiff[]>(`${base}/diffs?per_page=100&page=${page}`);
        out.push(...body);
        if (!headers.get('x-next-page')) break;
      }
      return out;
    } catch (e) {
      if (!(e instanceof GitLabError) || e.status !== 404) throw e;
      const { body } = await this.get<{ changes?: ApiDiff[] }>(`${base}/changes`);
      return body.changes ?? [];
    }
  }
}
