import { fileHunks, jsonProblem } from './patch';

/**
 * Is a release branch safe to merge? The deterministic layers: every change of the release
 * branch (vs the target) must come from the source it was built from (code that was tested
 * there), no conflict markers, and config files that still parse. The AI dependency check and
 * the pipeline are added by the connector.
 */

export interface SafetyIssue {
  path: string;
  /** Line in the release branch's file, when it is about a line. */
  line?: number;
  text?: string;
  reason: string;
}

/** Lines compared without spaces and a trailing comma, like the release patch. */
const key = (l: string) => l.replace(/\s+/g, '').replace(/,$/, '');

function tally(text: string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of (text ?? '').split('\n')) {
    const k = key(l);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Changes of one file in the release branch that the source does not have. A line may appear in
 * the release as often as in the target, as in the source, or anything in between; outside that
 * range it is new code (or a removal) that was never tested on the source.
 */
export function notFromSource(path: string, target: string | undefined, release: string | undefined, source: string | undefined): SafetyIssue[] {
  const t = tally(target);
  const s = tally(source);
  const issues: SafetyIssue[] = [];
  const fh = fileHunks(target, release);
  let line = 0;
  const seen = new Map<string, number>();
  for (const l of fh.diff) {
    if (l.type !== 'del') line++;
    if (l.type !== 'add') continue;
    const k = key(l.text);
    if (!k) continue;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const max = Math.max(t.get(k) ?? 0, s.get(k) ?? 0);
    if ((t.get(k) ?? 0) + n > max) issues.push({ path, line, text: l.text.trim().slice(0, 200), reason: 'baris ini tidak ada di branch sumber (belum pernah dites di sana)' });
  }
  // Removed lines the source still has: the release drops code the source keeps.
  const r = tally(release);
  for (const [k, n] of t) {
    const min = Math.min(n, s.get(k) ?? 0);
    if ((r.get(k) ?? 0) < min) {
      const text = (target ?? '').split('\n').find((x) => key(x) === k)?.trim().slice(0, 200);
      issues.push({ path, text, reason: 'baris ini dihapus di branch rilis tapi masih ada di branch sumber' });
    }
  }
  return issues.slice(0, 50);
}

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

/** Conflict markers, and config files that no longer parse. */
export function fileProblems(path: string, release: string | undefined): SafetyIssue[] {
  if (release === undefined) return [];
  const issues: SafetyIssue[] = [];
  release.split('\n').forEach((l, i) => {
    if (MARKER.test(l)) issues.push({ path, line: i + 1, text: l.slice(0, 80), reason: 'penanda konflik git tertinggal' });
  });
  const bad = jsonProblem(path, release);
  if (bad) issues.push({ path, reason: bad });
  return issues;
}

export interface SafetyResult {
  branch: string;
  /** The branch the release branch was built from (its changes were tested there). */
  from: string;
  subset: SafetyIssue[];
  files: SafetyIssue[];
  deps?: { verdict: 'aman' | 'perlu dicek' | 'putus'; issues: SafetyIssue[]; summary?: string };
  pipeline?: { status?: string; url?: string; note?: string };
  /** Files too big or binary to compare. */
  skipped: string[];
}

/** All layers green: nothing outside the source, files fine, dependencies safe, pipeline passed. */
export function safetyOk(r: SafetyResult): boolean {
  return !r.subset.length && !r.files.length && r.deps?.verdict === 'aman' && r.pipeline?.status === 'success';
}
