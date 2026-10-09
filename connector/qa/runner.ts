import { randomUUID } from 'node:crypto';
import type {
  QAAssertion,
  QAAssertionResult,
  QAEnvironment,
  QAFlow,
  QAFlowResult,
  QARunSummary,
  QAStep,
  QAStepResult,
  QAStepStatus,
} from '../../src/lib/qa/types.ts';

/**
 * Runs E2E flows step by step against an environment. Deterministic: the AI only wrote the
 * flows, this sends them. Hosts come only from the environment (a step has a path, never a
 * URL), a read-only environment gets GET requests only, and secrets are masked in everything
 * that is returned or stored.
 */

export const MAX_BODY_CHARS = 20_000;
const MASK = '***';
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;

export interface RunContext {
  env: QAEnvironment;
  /** Token (bearer/header) or password (basic) from the Keychain. */
  secret?: string;
  /** Variables kept in the Keychain (test credentials); they override all others and are masked. */
  secretVariables?: Record<string, string>;
  fetch?: typeof fetch;
  /** Checked between steps; true stops the run. */
  cancelled?: () => boolean;
  onStep?: (flowIndex: number, result: QAStepResult) => void;
}

const BUILTINS: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $timestamp: () => String(Date.now()),
  $unix: () => String(Math.floor(Date.now() / 1000)),
  $now: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1_000_000)),
};

/** Replaces {{name}} with variables or built-ins; unknown names are left as is (and reported). */
export function interpolate(value: string, vars: Record<string, string>, missing?: Set<string>): string {
  return value.replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (whole, name: string) => {
    if (name in vars) return vars[name];
    if (BUILTINS[name]) return BUILTINS[name]();
    missing?.add(name);
    return whole;
  });
}

function interpolateDeep(value: unknown, vars: Record<string, string>, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    // A value that is exactly one variable keeps a numeric/boolean look-alike as JSON, e.g. "{{amount}}" → 10000.
    const only = value.match(/^\{\{\s*([$\w.-]+)\s*\}\}$/);
    const out = interpolate(value, vars, missing);
    if (only && out !== value && /^(-?\d+(\.\d+)?|true|false)$/.test(out)) return JSON.parse(out);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, vars, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, vars, missing)]));
  return value;
}

/** Minimal JSON path: $.a.b[0].c, $.items[*].id is not supported. */
export function jsonPath(data: unknown, path: string): { found: boolean; value?: unknown } {
  const p = path.trim();
  if (p === '$' || p === '') return { found: data !== undefined, value: data };
  const parts = p
    .replace(/^\$\.?/, '')
    .split(/\.|\[(\d+)\]/)
    .filter((s) => s !== undefined && s !== '');
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return { found: false };
    const key = Array.isArray(cur) && /^\d+$/.test(part) ? Number(part) : part;
    if (!(key in (cur as Record<string | number, unknown>))) return { found: false };
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return { found: true, value: cur };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function compare(op: string, actual: unknown, found: boolean, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return found && actual !== undefined;
    case 'not_exists':
      return !found;
    case 'equals':
      return found && (actual === expected || JSON.stringify(actual) === JSON.stringify(expected) || (typeof actual !== 'object' && String(actual) === String(expected)));
    case 'not_equals':
      return !compare('equals', actual, found, expected);
    case 'contains':
      if (!found) return false;
      if (Array.isArray(actual)) return actual.some((a) => compare('equals', a, true, expected));
      return String(typeof actual === 'object' ? JSON.stringify(actual) : actual).includes(String(expected));
    case 'matches':
      try {
        return found && new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    case 'type':
      return found && typeOf(actual) === String(expected);
    case 'gt':
      return found && Number(actual) > Number(expected);
    case 'lt':
      return found && Number(actual) < Number(expected);
    default:
      return false;
  }
}

const show = (v: unknown) => (v === undefined ? '(tidak ada)' : JSON.stringify(v)?.slice(0, 200));

export function checkAssertion(a: QAAssertion, res: { status: number; headers: Record<string, string>; json: unknown; durationMs: number }): QAAssertionResult {
  if (a.type === 'status') {
    const want = Array.isArray(a.expected) ? a.expected : [a.expected];
    const passed = want.map(Number).includes(res.status);
    return { assertion: a, passed, actual: res.status, message: passed ? `Status ${res.status}` : `Status ${res.status}, harusnya ${want.join(' / ')}` };
  }
  if (a.type === 'latency') {
    const passed = res.durationMs < Number(a.expected);
    return { assertion: a, passed, actual: res.durationMs, message: `${res.durationMs} ms ${passed ? '<' : '≥'} ${a.expected} ms` };
  }
  if (a.type === 'header') {
    const key = Object.keys(res.headers).find((k) => k.toLowerCase() === a.name.toLowerCase());
    const actual = key ? res.headers[key] : undefined;
    const passed = compare(a.op, actual, key !== undefined, a.expected);
    return { assertion: a, passed, actual, message: `Header ${a.name} ${a.op}${a.expected !== undefined ? ` ${show(a.expected)}` : ''}: ${passed ? 'OK' : `aktual ${show(actual)}`}` };
  }
  const { found, value } = jsonPath(res.json, a.path);
  const passed = compare(a.op, value, found, a.expected);
  return { assertion: a, passed, actual: value, message: `${a.path} ${a.op}${a.expected !== undefined ? ` ${show(a.expected)}` : ''}: ${passed ? 'OK' : `aktual ${show(value)}`}` };
}

function joinUrl(base: string, path: string, query: Record<string, string>): string {
  const url = new URL(base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

/** Base URL for a step: the service's own URL (case-insensitive name match), else the default. */
export function baseUrlFor(env: QAEnvironment, service?: string): string {
  if (service) {
    const key = Object.keys(env.services).find((k) => k.toLowerCase() === service.toLowerCase());
    if (key && env.services[key].trim()) return env.services[key].trim();
  }
  return env.baseUrl.trim();
}

function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join(MASK);
  return out;
}

function maskHeaders(headers: Record<string, string>, secrets: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? MASK : maskSecrets(v, secrets)]));
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(method: string, url: string, headers: Record<string, string>, body?: string): string {
  const parts = [`curl -X ${method} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (body !== undefined) parts.push(`--data ${shellQuote(body)}`);
  return parts.join(' \\\n  ');
}

function authHeaders(env: QAEnvironment, secret?: string): Record<string, string> {
  if (!secret) return {};
  if (env.auth.type === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (env.auth.type === 'basic') return { Authorization: `Basic ${Buffer.from(`${env.auth.username ?? ''}:${secret}`).toString('base64')}` };
  if (env.auth.type === 'header' && env.auth.headerName) return { [env.auth.headerName]: secret };
  return {};
}

/** Values pulled from a response for later steps. Extracted values count as secrets when they look like tokens. */
function extractVars(step: QAStep, json: unknown, headers: Record<string, string>): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, source] of Object.entries(step.extract ?? {})) {
    if (source.startsWith('header:')) {
      const want = source.slice(7).trim().toLowerCase();
      const key = Object.keys(headers).find((k) => k.toLowerCase() === want);
      if (key) values[name] = headers[key];
      else missing.push(name);
      continue;
    }
    const { found, value } = jsonPath(json, source);
    if (found && value !== undefined && value !== null) values[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    else missing.push(name);
  }
  return { values, missing };
}

const isTokenName = (name: string) => /token|secret|password|passwd|session|cookie|signature|otp|pin/i.test(name);

async function runStep(step: QAStep, vars: Record<string, string>, ctx: RunContext, secrets: string[]): Promise<{ result: QAStepResult; extracted: Record<string, string> }> {
  const base: QAStepResult = { stepId: step.id, name: step.name, status: 'running', startedAt: new Date().toISOString(), assertions: [] };
  const method = step.request.method.toUpperCase();
  if (ctx.env.readOnly && method !== 'GET') {
    return { result: { ...base, status: 'blocked', error: `Environment "${ctx.env.name}" read-only: request ${method} tidak dikirim.` }, extracted: {} };
  }
  const missing = new Set<string>();
  const path = interpolate(step.request.path, vars, missing);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    return { result: { ...base, status: 'error', error: 'Path step tidak boleh berisi host/URL lengkap; host diambil dari environment.' }, extracted: {} };
  }
  const baseUrl = baseUrlFor(ctx.env, step.service);
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { result: { ...base, status: 'error', error: `Base URL untuk service "${step.service ?? '(default)'}" belum diatur di environment.` }, extracted: {} };
  }
  const query = Object.fromEntries(Object.entries(step.request.query ?? {}).map(([k, v]) => [k, interpolate(String(v), vars, missing)]));
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(ctx.env.headers).map(([k, v]) => [k, interpolate(v, vars, missing)])),
    ...(step.useEnvAuth === false ? {} : authHeaders(ctx.env, ctx.secret)),
    ...Object.fromEntries(Object.entries(step.request.headers ?? {}).map(([k, v]) => [k, interpolate(String(v), vars, missing)])),
  };
  const bodyValue = step.request.body === undefined || method === 'GET' ? undefined : interpolateDeep(step.request.body, vars, missing);
  const body = bodyValue === undefined ? undefined : typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);

  let url: string;
  try {
    url = joinUrl(baseUrl, path, query);
  } catch {
    return { result: { ...base, status: 'error', error: `URL tidak valid: ${baseUrl} + ${path}` }, extracted: {} };
  }
  const shownHeaders = maskHeaders(headers, secrets);
  const shownBody = body === undefined ? undefined : maskSecrets(body, secrets);
  const request = { method, url: maskSecrets(url, secrets), headers: shownHeaders, body: shownBody };
  const curl = toCurl(method, request.url, shownHeaders, shownBody);
  if (missing.size) {
    return { result: { ...base, status: 'error', request, curl, error: `Variabel belum punya nilai: ${[...missing].map((m) => `{{${m}}}`).join(', ')}` }, extracted: {} };
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(url, { method, headers, body, signal: AbortSignal.timeout(ctx.env.timeoutMs || 30_000), redirect: 'manual' });
  } catch (e) {
    const err = e as Error;
    const why = err.name === 'TimeoutError' ? `Tidak ada respons dalam ${Math.round((ctx.env.timeoutMs || 30_000) / 1000)} detik.` : `Gagal terhubung: ${(err as { cause?: Error }).cause?.message ?? err.message}. Cek VPN dan base URL.`;
    return { result: { ...base, status: 'error', durationMs: Date.now() - started, request, curl, error: why }, extracted: {} };
  }
  const text = await res.text().catch(() => '');
  const durationMs = Date.now() - started;
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  const { values, missing: notExtracted } = extractVars(step, json, resHeaders);
  for (const [name, value] of Object.entries(values)) if (isTokenName(name)) secrets.push(value);

  // Expected values may reference earlier results, e.g. $.data.orderId equals "{{orderId}}".
  const assertions = step.assertions.map((a) =>
    checkAssertion('expected' in a && typeof a.expected === 'string' ? ({ ...a, expected: interpolate(a.expected, vars) } as QAAssertion) : a, { status: res.status, headers: resHeaders, json, durationMs }),
  );
  for (const name of notExtracted) {
    assertions.push({ assertion: { type: 'json', path: step.extract![name], op: 'exists' }, passed: false, message: `Tidak bisa mengambil {{${name}}} dari ${step.extract![name]}` });
  }
  // Assertions on a token (e.g. "$.data.accessToken exists") must not echo it back.
  for (const a of assertions) {
    const raw = typeof a.actual === 'string' ? a.actual : a.actual === undefined ? '' : JSON.stringify(a.actual);
    if (raw && maskSecrets(raw, secrets) !== raw) a.actual = typeof a.actual === 'string' ? maskSecrets(raw, secrets) : MASK;
    a.message = maskSecrets(a.message, secrets);
  }
  const masked = maskSecrets(text, secrets);
  const status: QAStepStatus = assertions.every((a) => a.passed) ? 'passed' : 'failed';
  return {
    result: {
      ...base,
      status,
      durationMs,
      request,
      response: { status: res.status, headers: maskHeaders(resHeaders, secrets), body: masked.slice(0, MAX_BODY_CHARS), truncated: masked.length > MAX_BODY_CHARS || undefined },
      assertions,
      extracted: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isTokenName(k) ? MASK : v])),
      curl,
    },
    extracted: values,
  };
}

/** Runs one flow; after the first step that does not pass, the rest are skipped (they depend on it). */
export async function runFlow(flow: QAFlow, flowIndex: number, ctx: RunContext): Promise<QAFlowResult> {
  const secretVars = ctx.secretVariables ?? {};
  const secrets = [ctx.secret ?? '', ...Object.values(secretVars)].filter(Boolean);
  // Flow variables are the AI's sample values; the environment's real test data wins. Values are
  // resolved once, so {{$uuid}} in a variable stays the same for the whole flow.
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(flow.variables ?? {}), ...ctx.env.variables })) vars[k] = interpolate(v, vars);
  Object.assign(vars, secretVars);
  const steps: QAStepResult[] = [];
  let stopped: string | undefined;
  for (const step of flow.steps) {
    if (stopped || ctx.cancelled?.()) {
      const r: QAStepResult = { stepId: step.id, name: step.name, status: 'skipped', assertions: [], error: stopped ?? 'Run dibatalkan.' };
      steps.push(r);
      ctx.onStep?.(flowIndex, r);
      continue;
    }
    const { result, extracted } = await runStep(step, vars, ctx, secrets);
    Object.assign(vars, extracted);
    steps.push(result);
    ctx.onStep?.(flowIndex, result);
    if (result.status !== 'passed') stopped = `Dilewati karena step "${step.name}" ${result.status === 'blocked' ? 'diblokir' : 'gagal'}.`;
  }
  const status: QAStepStatus = steps.some((s) => s.status === 'blocked')
    ? 'blocked'
    : steps.some((s) => s.status === 'error')
      ? 'error'
      : steps.some((s) => s.status === 'failed')
        ? 'failed'
        : steps.every((s) => s.status === 'passed')
          ? 'passed'
          : 'skipped';
  return { flowId: flow.id, name: flow.name, category: flow.category, taskTitles: flow.taskTitles, status, steps };
}

export function summarize(flows: QAFlowResult[]): QARunSummary {
  const steps = flows.flatMap((f) => f.steps);
  return {
    flows: flows.length,
    passedFlows: flows.filter((f) => f.status === 'passed').length,
    failedFlows: flows.filter((f) => f.status !== 'passed' && f.status !== 'pending' && f.status !== 'running').length,
    steps: steps.length,
    passedSteps: steps.filter((s) => s.status === 'passed').length,
    failedSteps: steps.filter((s) => s.status === 'failed' || s.status === 'error' || s.status === 'blocked').length,
  };
}
