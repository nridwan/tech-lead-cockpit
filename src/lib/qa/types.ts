// End-to-end API flow tests per project (one or more TADs), generated from their Detail Tasks. Shared by the connector (generator, runner,
// store) and the UI. Secrets (environment tokens/passwords) never appear here: the connector
// keeps them in the Keychain and only reports whether one is set.

import type { AiSelection } from '../ai/types';

export const QA_CATEGORIES = ['happy-path', 'validation', 'auth', 'business-edge-case', 'integration-chain'] as const;
export type QACategory = (typeof QA_CATEGORIES)[number];

export const QA_CATEGORY_LABELS: Record<QACategory, string> = {
  'happy-path': 'Happy path',
  validation: 'Validasi input',
  auth: 'Auth & akses',
  'business-edge-case': 'Edge case bisnis',
  'integration-chain': 'Rantai antar-service',
};

export const QA_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type QAMethod = (typeof QA_METHODS)[number];

export type QAAuthType = 'none' | 'bearer' | 'basic' | 'header';

/** The PostgreSQL server holding the services' databases (one login for all); password in the Keychain. */
export interface QADbServer {
  host: string;
  port: number;
  user: string;
  ssl?: boolean;
}

/**
 * A service's database, queried read-only (SELECT only). Connection details come from the
 * environment's server unless this entry has its own host.
 */
export interface QADatabase {
  /** Name flows use in "db" (usually the service name, e.g. core-promo-ultimate). */
  name: string;
  /** Service (as in the TAD) this database belongs to; generation only reads the selected tasks' ones. */
  service?: string;
  /** Database name on the server. */
  database: string;
  host?: string;
  port?: number;
  user?: string;
  ssl?: boolean;
}

/** A fully resolved connection (server details + database). */
export interface QADbConnection {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
}

/** Result of one read-only query (values as strings, capped rows). */
export interface QADbResult {
  db: string;
  sql: string;
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  truncated?: boolean;
  durationMs: number;
}

/** Real data for a flow variable, read before the flow's first request. */
export interface QADataQuery {
  /** Variable name, used as {{name}} in steps. */
  name: string;
  /** Database name from the environment. */
  db: string;
  /** One SELECT; {{variables}} allowed. The first row is used. */
  sql: string;
  /** Column to take (default: the first). */
  column?: string;
}

/** A query run for a flow: data setup (variable) or a data check (assertion). */
export interface QADbQueryLog {
  kind: 'data' | 'check';
  /** Variable filled (data) or what was checked (check). */
  label: string;
  db: string;
  sql: string;
  at: string;
  ok: boolean;
  result?: QADbResult;
  value?: string;
  /** Not queried: the value came from this earlier flow of the run. */
  reusedFrom?: string;
  error?: string;
}

export interface QAEnvironment {
  id: string;
  name: string;
  /** Used when a step names no service, or one without its own URL. */
  baseUrl: string;
  /** Service name (as written in the TAD) → base URL. */
  services: Record<string, string>;
  headers: Record<string, string>;
  /** Non-secret values steps can use as {{name}}. */
  variables: Record<string, string>;
  auth: {
    type: QAAuthType;
    /** For type 'header', e.g. X-Api-Key. */
    headerName?: string;
    /** For type 'basic'. */
    username?: string;
  };
  /** Only GET requests are sent; other steps are blocked. */
  readOnly: boolean;
  /** Server of the services' databases (one login). */
  dbServer?: QADbServer;
  /** Databases per service, for real test data and data checks (read-only). */
  databases?: QADatabase[];
  /** Set by the connector: the server password is in the Keychain. */
  dbServerPassword?: boolean;
  /** Set by the connector: databases with their own password in the Keychain. */
  dbPasswords?: Record<string, boolean>;
  timeoutMs: number;
  /** Set by the connector: a token/password is stored in the Keychain. */
  hasSecret?: boolean;
  /** Set by the connector: names of variables whose values live in the Keychain (masked in results). */
  secretVariableNames?: string[];
}

export type QAAssertion =
  | { type: 'status'; op: 'equals' | 'in'; expected: number | number[] }
  | { type: 'json'; path: string; op: QAValueOp; expected?: unknown }
  | { type: 'header'; name: string; op: QAValueOp; expected?: unknown }
  | { type: 'latency'; op: 'lt'; expected: number }
  /** Checks data after the request: one SELECT (read-only); `column` of the first row, or the row count for exists/not_exists. */
  | { type: 'db'; db: string; sql: string; op: QAValueOp; column?: string; expected?: unknown };

export const QA_VALUE_OPS = ['equals', 'not_equals', 'contains', 'exists', 'not_exists', 'matches', 'type', 'gt', 'lt'] as const;
export type QAValueOp = (typeof QA_VALUE_OPS)[number];

export interface QARequest {
  method: QAMethod;
  /** Path relative to the service base URL, e.g. /v1/orders/{{orderId}}. Hosts come only from the environment. */
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface QAStep {
  id: string;
  name: string;
  /** Service name from the TAD; picks the base URL from the environment. */
  service?: string;
  request: QARequest;
  assertions: QAAssertion[];
  /** Variable → source for later steps: `$.data.id` (JSON path of the body) or `header:X-Request-Id`. */
  extract?: Record<string, string>;
  /** Add the environment's auth (default true). False for e.g. a login step or a negative auth test. */
  useEnvAuth?: boolean;
}

export interface QAFlow {
  id: string;
  name: string;
  description: string;
  category: QACategory;
  /** Detail Task titles this flow exercises. */
  taskTitles: string[];
  /** Journey stage, e.g. "1. Buat data promo (CMS)"; flows run and show in journey order. */
  stage?: string;
  /** Sample values for {{name}}; environment variables with the same name override them. */
  variables?: Record<string, string>;
  /** Real data from the environment's databases (read-only), loaded before the first step; overrides sample values. */
  dataQueries?: QADataQuery[];
  steps: QAStep[];
  enabled: boolean;
}

export interface QASuite {
  projectId: string;
  projectName: string;
  flows: QAFlow[];
  /** Assumptions and open questions the AI noted while writing the flows. */
  notes?: string;
  generatedAt?: string;
  ai?: AiSelection;
  updatedAt: string;
}

export interface QATaskInput {
  title: string;
  /** TAD the task comes from (a project can have several). */
  tadTitle?: string;
  service?: string;
  jiraKey?: string;
  /** Detail Task as plain text. */
  spec: string;
}

export interface QAGenerateRequest {
  projectId: string;
  projectName: string;
  ai: AiSelection;
  tasks: QATaskInput[];
  prdMarkdown?: string;
  categories: QACategory[];
  instructions?: string;
  /** Flows to keep (the AI adds to them instead of starting over). */
  existing?: QAFlow[];
  /** Environment whose databases the AI may use for real data and data checks. */
  environmentId?: string;
  /** Let the AI read the Services codebase (read-only) to check routes, payloads and responses (default true). */
  useCodebase?: boolean;
  servicesRoot?: string;
  /** Filled by the connector: the codebase root and the selected tasks' service folders. */
  codebase?: { root: string; folders: string[] };
  /** Filled by the connector from that environment: schema per database (never passwords). */
  databases?: { name: string; service?: string; schema: string; error?: string }[];
}

export type QAJobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface QAGenerateJob {
  id: string;
  projectId: string;
  status: QAJobStatus;
  startedAt: string;
  finishedAt?: string;
  /** Last activity line from the AI, for the progress label. */
  progress?: string;
  error?: string;
  /** The AI's answer when it could not be parsed, so the user can see what went wrong. */
  rawReply?: string;
  suite?: QASuite;
}

export type QAStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped' | 'blocked';

export interface QAAssertionResult {
  assertion: QAAssertion;
  passed: boolean;
  actual?: unknown;
  message: string;
}

export interface QAStepResult {
  stepId: string;
  name: string;
  status: QAStepStatus;
  /** When the step started (ISO); absent on runs recorded before it was added. */
  startedAt?: string;
  durationMs?: number;
  request?: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; headers: Record<string, string>; body?: string; truncated?: boolean };
  assertions: QAAssertionResult[];
  extracted?: Record<string, string>;
  /** Copy-pasteable reproduction, secrets masked. */
  curl?: string;
  /** Data checks (db assertions) run after this request. */
  dbChecks?: QADbQueryLog[];
  error?: string;
}

export interface QAFlowResult {
  flowId: string;
  name: string;
  category: QACategory;
  taskTitles: string[];
  status: QAStepStatus;
  /** Data queries run before the first step (real test data). */
  dataQueries?: QADbQueryLog[];
  steps: QAStepResult[];
}

export interface QARunSummary {
  flows: number;
  passedFlows: number;
  failedFlows: number;
  steps: number;
  passedSteps: number;
  failedSteps: number;
}

export interface QARun {
  id: string;
  projectId: string;
  projectName: string;
  environment: { id: string; name: string; readOnly: boolean };
  status: 'running' | 'done' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  flows: QAFlowResult[];
  summary: QARunSummary;
}

export interface QARunRequest {
  projectId: string;
  environmentId: string;
  /** Run only these flows (default: every enabled flow of the suite). */
  flowIds?: string[];
}

export function emptyEnvironment(): QAEnvironment {
  return {
    id: '',
    name: '',
    baseUrl: '',
    services: {},
    headers: { 'Content-Type': 'application/json' },
    variables: {},
    auth: { type: 'none' },
    readOnly: false,
    timeoutMs: 30_000,
  };
}
