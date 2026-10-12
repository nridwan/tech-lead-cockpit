import { buildHunks, lineDiff, type DiffHunk, type DiffLine } from '../diff';
import type { PatchFile } from './types';

/**
 * A release branch made of chosen changes instead of whole commits: every changed file is split
 * into hunks (target → source), the AI or the user picks hunks, and the chosen ones are applied
 * to the target's version of the file. Lines are compared without spaces, so a reformat does not
 * glue itself to a real change; unchosen lines keep the target's text.
 */

/** Lines kept per hunk for the preview (the apply step always uses the whole file). */
const PREVIEW_LINES = 120;

/** A diff line; an unchanged line also keeps the source's text (it may differ by a comma or spaces). */
export type PatchLine = DiffLine & { alt?: string };

export interface FileHunks {
  diff: PatchLine[];
  hunks: DiffHunk[];
}

/** Hunks of one file; `before` undefined = new file, `after` undefined = deleted file. */
export function fileHunks(before: string | undefined, after: string | undefined): FileHunks {
  const a = before === undefined ? [] : before.split('\n');
  const b = after === undefined ? [] : after.split('\n');
  // Spaces and a trailing comma do not make a line different: a reformat, or `}` becoming `},`
  // before a new block, must not glue itself to the real change.
  const key = (l: string) => l.replace(/\s+/g, '').replace(/,$/, '');
  const raw = lineDiff(a.map(key), b.map(key));
  let i = 0;
  let j = 0;
  const diff: PatchLine[] = raw.map((l) => (l.type === 'same' ? { type: 'same', text: a[i++], alt: b[j++] } : l.type === 'del' ? { type: 'del', text: a[i++] } : { type: 'add', text: b[j++] }));
  // A new or deleted file is one change.
  if (before === undefined || after === undefined) return { diff, hunks: diff.length ? [{ id: 0, start: 0, end: diff.length, section: '', added: b.length, removed: a.length }] : [] };
  return { diff, hunks: splitBlocks(diff, buildHunks(diff, 1)) };
}

const indent = (l: string) => l.length - l.trimStart().length;

/**
 * Blocks added next to each other (two routes, two functions) are separate choices: a hunk that
 * only adds lines is cut after a line closing a block at the block's own indent (`}`, `},`, `]`),
 * or at a blank line.
 */
function splitBlocks(diff: PatchLine[], hunks: DiffHunk[]): DiffHunk[] {
  const out: DiffHunk[] = [];
  const push = (start: number, end: number, section: string) => {
    const lines = diff.slice(start, end);
    out.push({ id: out.length, start, end, section, added: lines.filter((l) => l.type === 'add').length, removed: lines.filter((l) => l.type === 'del').length });
  };
  for (const h of hunks) {
    if (diff.slice(h.start, h.end).some((l) => l.type !== 'add')) {
      push(h.start, h.end, h.section);
      continue;
    }
    let start = h.start;
    const base = indent(diff[start].text);
    for (let i = start; i < h.end; i++) {
      const t = diff[i].text;
      const closes = /^[}\])],?;?$/.test(t.trim()) && indent(t) === base;
      if ((closes || !t.trim()) && i + 1 < h.end) {
        push(start, i + 1, h.section);
        start = i + 1;
      }
    }
    push(start, h.end, h.section);
  }
  return out;
}

/**
 * The file after applying the chosen hunks to the target's version. An unchanged line right
 * before an added block takes the source's trailing comma; in a .json file a comma left before
 * `]` or `}` is dropped, so choosing one route of many still gives valid JSON.
 */
export function applyFileHunks(fh: FileHunks, chosen: ReadonlySet<number>, path = ''): string {
  const owner = new Int32Array(fh.diff.length).fill(-1);
  for (const h of fh.hunks) for (let i = h.start; i < h.end; i++) owner[i] = h.id;
  const kept: PatchLine[] = [];
  fh.diff.forEach((line, i) => {
    if (line.type === 'same') return void kept.push(line);
    const take = owner[i] >= 0 && chosen.has(owner[i]);
    if ((line.type === 'add' && take) || (line.type === 'del' && !take)) kept.push(line);
  });
  const out = kept.map((l, k) => {
    const next = kept[k + 1];
    if (l.type === 'same' && next?.type === 'add' && l.alt && /,\s*$/.test(l.alt) && !/,\s*$/.test(l.text)) return l.text.replace(/\s*$/, ',');
    return l.text;
  });
  const text = out.join('\n');
  return /\.json$/i.test(path) ? text.replace(/,(\s*[\]}])/g, '$1') : text;
}

/** A file's hunks for the AI and the UI: their added/removed lines (capped) and where they are. */
export function patchFile(path: string, status: PatchFile['status'], fh: FileHunks): PatchFile {
  return {
    path,
    status,
    hunks: fh.hunks.map((h) => {
      const lines = fh.diff.slice(h.start, h.end).filter((l) => l.type !== 'same');
      // Line number in the target's file where the hunk starts.
      const at = fh.diff.slice(0, h.start).filter((l) => l.type !== 'add').length + 1;
      return {
        id: `${path}#${h.id}`,
        at,
        added: lines.filter((l) => l.type === 'add').map((l) => l.text).slice(0, PREVIEW_LINES),
        removed: lines.filter((l) => l.type === 'del').map((l) => l.text).slice(0, PREVIEW_LINES),
        more: Math.max(0, lines.length - PREVIEW_LINES * 2),
        include: false,
      };
    }),
  };
}

/** The hunk number inside its file from a hunk id ("path#3" → 3). */
export const hunkNumber = (id: string) => Number(id.slice(id.lastIndexOf('#') + 1));
export const hunkPath = (id: string) => id.slice(0, id.lastIndexOf('#'));

/** Keys written twice in one JSON object (JSON.parse silently keeps the last), with their line. */
export function duplicateKeys(text: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  const stack: (Set<string> | null)[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    else if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const str = text.slice(i + 1, j);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const keys = stack[stack.length - 1];
      if (text[k] === ':' && keys) {
        if (keys.has(str)) out.push({ key: str, line });
        keys.add(str);
      }
      i = j;
    }
  }
  return out;
}

/** Is the result still valid JSON (for .json files), without keys written twice? An error message when not. */
export function jsonProblem(path: string, content: string): string | undefined {
  if (!/\.json$/i.test(path)) return undefined;
  try {
    JSON.parse(content);
  } catch (e) {
    return `${path} bukan JSON valid setelah perubahan dipilih (${(e as Error).message}).`;
  }
  const dup = duplicateKeys(content);
  if (dup.length) return `${path} bukan JSON valid setelah perubahan dipilih (key ganda: ${dup.slice(0, 5).map((d) => `"${d.key}" baris ${d.line}`).join(', ')}).`;
  return undefined;
}

/** Paths named in a text (/v1/x/{id}) as patterns matching only that route, any parameter name. */
export function routePatterns(text: string): { path: string; re: RegExp }[] {
  const out: { path: string; re: RegExp }[] = [];
  for (const m of text.matchAll(/\/[A-Za-z0-9_\-{}:.]+(?:\/[A-Za-z0-9_\-{}:.]+)+/g)) {
    const path = m[0].replace(/[.,;:]+$/, '');
    const body = path
      .split(/(\{[^}]*\}|:[A-Za-z_]\w*)/)
      .map((part, i) => (i % 2 ? '(?:\\{[^}/]*\\}|:[A-Za-z_]\\w*)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    if (!out.some((o) => o.path === path)) out.push({ path, re: new RegExp(`${body}(?![A-Za-z0-9_\\-{}/])`) });
  }
  return out.slice(0, 10);
}

/**
 * Where routes named in the instruction already are: in a hunk (can be chosen), already in the
 * target's version of a changed file (nothing to bring), or nowhere in the files read.
 */
export function locateRoutes(text: string, files: { path: string; fh: FileHunks }[]): { path: string; where: 'hunk' | 'target' | 'none'; file?: string; line?: number }[] {
  return routePatterns(text).map(({ path, re }) => {
    for (const f of files) if (f.fh.diff.some((l) => l.type === 'add' && re.test(l.text))) return { path, where: 'hunk' as const, file: f.path };
    for (const f of files) {
      let n = 0;
      for (const l of f.fh.diff) {
        if (l.type === 'add') continue;
        n++;
        if (re.test(l.text)) return { path, where: 'target' as const, file: f.path, line: n };
      }
    }
    return { path, where: 'none' as const };
  });
}

/** What a result changes vs the target, line by line (LCS, spaces ignored), with line numbers. */
export function resultDelta(before: string, after: string): string {
  const fh = fileHunks(before, after);
  const out: string[] = [];
  let line = 0;
  let open = false;
  for (const l of fh.diff) {
    if (l.type !== 'add') line++;
    if (l.type === 'same') {
      open = false;
      continue;
    }
    if (!open) out.push(`@@ baris ${l.type === 'add' ? line + 1 : line} @@`);
    open = true;
    out.push(`${l.type === 'add' ? '+' : '-'}${l.text}`);
  }
  return out.join('\n');
}

/** A short label for a JSON value: an object by its first few string fields (endpoint, method…). */
function label(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const parts = Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string').slice(0, 2).map(([k, x]) => `${k}: ${x}`);
    return parts.length ? `{${parts.join(', ')}}` : '{…}';
  }
  return JSON.stringify(v)?.slice(0, 80) ?? String(v);
}

/**
 * What a JSON file's data gains, loses or changes (formatting ignored): array items matched by
 * value, objects by key. For the preview: "endpoints + {endpoint: /v1/x, method: GET}".
 */
export function jsonChanges(before: string, after: string, max = 30): string[] {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(before || 'null');
    b = JSON.parse(after);
  } catch {
    return [];
  }
  const out: string[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const walk = (x: unknown, y: unknown, path: string) => {
    if (out.length >= max || same(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      const left = x.map((v) => JSON.stringify(v));
      const right = y.map((v) => JSON.stringify(v));
      const pool = [...left];
      const added = y.filter((_, i) => {
        const k = pool.indexOf(right[i]);
        if (k >= 0) pool.splice(k, 1);
        return k < 0;
      });
      const pool2 = [...right];
      const removed = x.filter((_, i) => {
        const k = pool2.indexOf(left[i]);
        if (k >= 0) pool2.splice(k, 1);
        return k < 0;
      });
      for (const v of added) if (out.length < max) out.push(`${path || '(akar)'} + ${label(v)}`);
      for (const v of removed) if (out.length < max) out.push(`${path || '(akar)'} − ${label(v)}`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in xo)) out.push(`${p} + ${label(yo[k])}`);
        else if (!(k in yo)) out.push(`${p} − ${label(xo[k])}`);
        else walk(xo[k], yo[k], p);
        if (out.length >= max) return;
      }
      return;
    }
    out.push(`${path || '(akar)'}: ${label(x)} → ${label(y)}`);
  };
  walk(a, b, '');
  return out;
}
