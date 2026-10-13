import { parseJsonReply } from './ai';
import { jsonProblem, resultDelta } from './patch';
import type { FlagFile } from './types';

/**
 * Putting a feature that is on the source but outside the release behind a feature flag (off by
 * default), so the source can go to the target without switching the feature on. The AI writes
 * small find/replace edits in the repo's own flag style; they are applied here, exactly, and the
 * user sees the diff before anything is written to GitLab.
 */

export interface FlagEdit {
  path: string;
  /** Exact text in the file (must occur once), or empty for a new file. */
  find: string;
  replace: string;
}

export interface FlagPlan {
  /** One flag per feature (several features can be flagged at once). */
  flags: { name: string; summary: string }[];
  edits: FlagEdit[];
  notes: string[];
}

export function flagPrompt(input: { repo: string; base: string; target: string; what: string; files: { path: string; content: string }[]; diff: string; conventions: string }): string {
  return [
    `Repo: ${input.repo}. Fitur berikut ada di ${input.base} tapi BUKAN bagian rilis ke ${input.target}. Bungkus fitur itu dengan feature flag supaya ${input.base} bisa naik ke ${input.target} tanpa fitur itu aktif.`,
    '',
    `Yang harus di-flag (bisa beberapa fitur): ${input.what}`,
    '',
    `Perubahan fitur itu (${input.target} → ${input.base}):`,
    input.diff || '(tidak ada diff)',
    '',
    'Konvensi flag/env yang sudah ada di repo (ikuti gaya ini: nama, cara baca env/config, default):',
    input.conventions || '(tidak ditemukan; pakai env NAMA_FITUR_ENABLE yang dibaca lewat cara baca env yang sudah dipakai repo, default mati)',
    '',
    `Isi lengkap file terkait di ${input.base}:`,
    ...input.files.map((f) => `### ${f.path}\n${f.content}`),
    '',
    'Aturan:',
    '- Kelompokkan per FITUR: satu flag per fitur (perubahan yang saling terkait = satu fitur). Jangan satu flag per file bila filenya bagian fitur yang sama.',
    '- Default MATI: tanpa env/config diset, perilaku fitur sama sekali tidak jalan (route tidak terdaftar, scheduler tidak start, handler menolak, UI tidak tampil).',
    '- Perubahan sekecil mungkin: bungkus titik masuk fitur (registrasi route/cron/consumer/menu, pemanggilan utama), jangan ubah logika fitur.',
    '- Ikuti gaya kode dan bahasa file. Tambahkan nama flag ke .env.example (atau file contoh config yang ada) dengan nilai mati.',
    '- Edit berupa find/replace: "find" HARUS potongan teks persis yang ada SEKALI di file (cukup panjang agar unik, termasuk indentasi), "replace" penggantinya. File baru: "find" kosong, "replace" isi file.',
    '- Bila fitur tidak bisa di-flag dengan aman (mis. perubahan skema/kontrak data, reformat file config besar), jangan buat edit; jelaskan di notes.',
    '',
    'Skema jawaban:',
    '{"flags":[{"flag":"NAMA_FLAG","summary":"fitur yang dijaga"}],"edits":[{"path":"path/file","find":"...","replace":"..."}],"notes":["..."]}',
  ].join('\n');
}

export function parseFlagReply(reply: string): FlagPlan | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const one = (f: unknown, summary?: unknown) => ({ name: typeof f === 'string' ? f.trim().slice(0, 80) : '', summary: typeof summary === 'string' ? summary.slice(0, 500) : '' });
  // Several flags ("flags"), or one ("flag") from an older answer shape.
  const flags = (Array.isArray(json.flags) ? json.flags.map((f) => one((f as Record<string, unknown>).flag ?? (f as Record<string, unknown>).name, (f as Record<string, unknown>).summary)) : [one(json.flag, json.summary)])
    .filter((f) => f.name)
    .slice(0, 10);
  const edits = (Array.isArray(json.edits) ? json.edits : [])
    .map((e) => {
      const r = e as Record<string, unknown>;
      return { path: typeof r.path === 'string' ? r.path.trim() : '', find: typeof r.find === 'string' ? r.find : '', replace: typeof r.replace === 'string' ? r.replace : '' };
    })
    .filter((e) => e.path && !e.path.includes('..') && !e.path.startsWith('/'))
    .slice(0, 30);
  const notes = (Array.isArray(json.notes) ? json.notes : []).filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 500)).slice(0, 15);
  return { flags, edits, notes };
}

/**
 * The edits applied to the files' current content (path → text, undefined = file does not exist).
 * An edit whose text is not found exactly once is refused, so nothing is guessed.
 */
export function applyFlagEdits(edits: FlagEdit[], current: Map<string, string | undefined>): { files: FlagFile[]; problems: string[] } {
  const next = new Map<string, string | undefined>(current);
  const created = new Set<string>();
  const problems: string[] = [];
  for (const e of edits) {
    const text = next.get(e.path);
    if (!e.find) {
      if (text !== undefined) {
        problems.push(`${e.path} sudah ada; edit file baru ditolak.`);
        continue;
      }
      next.set(e.path, e.replace);
      created.add(e.path);
      continue;
    }
    if (text === undefined) {
      problems.push(`${e.path} tidak ditemukan.`);
      continue;
    }
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) {
      problems.push(`${e.path}: potongan yang diganti ${at < 0 ? 'tidak ditemukan' : 'muncul lebih dari sekali'}; edit dilewati.`);
      continue;
    }
    next.set(e.path, text.slice(0, at) + e.replace + text.slice(at + e.find.length));
  }
  const files: FlagFile[] = [];
  for (const [path, content] of next) {
    if (content === undefined || content === current.get(path)) continue;
    const bad = jsonProblem(path, content);
    if (bad) problems.push(bad);
    files.push({ path, status: created.has(path) ? 'create' : 'update', content, preview: resultDelta(current.get(path) ?? '', content).slice(0, 40_000), baseHash: textHash(current.get(path)) });
  }
  return { files, problems };
}

/** A short fingerprint of a file's text (to see that it did not change in between). */
export function textHash(text: string | undefined): string {
  if (text === undefined) return 'none';
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** A branch name for the flags: feature-flag/tax-scheduler-enable, or …/tax-scheduler-enable-dan-2-lainnya. */
export const flagBranchName = (flags: string | string[]) => {
  const list = (Array.isArray(flags) ? flags : [flags]).filter(Boolean);
  return slugBranch(list.length > 1 ? `${list[0]}-dan-${list.length - 1}-lainnya` : (list[0] ?? ''));
};

const slugBranch = (flag: string) =>
  `feature-flag/${flag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'baru'}`;
