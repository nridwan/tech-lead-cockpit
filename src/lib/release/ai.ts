import type { MrFileChange } from '../gitlab/types';
import type { AiPick, AiTicketVerdict, AiVerdict, PatchFile, ReleaseAiNeed, ReleaseDocFix } from './types';

/**
 * Prompts and answer parsing for the release AI jobs: read the tickets in the code, pick the
 * commits of a release branch, and fix the release document. Pure: the connector runs the AI.
 * Every answer is JSON; anything the AI says outside it, or that does not fit, is dropped.
 */

/**
 * Version of the rules the AI checks with (prompts above). Bump it when they change: results made
 * with older rules are then checked again instead of being reused.
 */
export const AI_RULES_VERSION = 2;

/** Feature flags made through Cockpit for a service, for the AI to take into account. */
export interface KnownFlag {
  name: string;
  summary: string;
  files: string[];
  /** merged = in the source already; open = still in review (not in the source yet). */
  mr?: { ref: string; merged: boolean };
}

/** The known flags as prompt lines. */
export function knownFlagsText(flags: KnownFlag[]): string {
  if (!flags.length) return '';
  return [
    'Feature flag yang dibuat lewat Cockpit untuk service ini:',
    ...flags.map((f) => `- ${f.name}${f.summary ? `: ${f.summary}` : ''} (file: ${f.files.join(', ') || '-'}; ${f.mr ? (f.mr.merged ? `MR ${f.mr.ref} sudah merged ke sumber` : `MR ${f.mr.ref} masih direview, BELUM ada di sumber`) : 'belum dibuat MR-nya'})`),
    'Perubahan fitur yang dijaga flag yang sudah merged: tandai "flag" dengan namanya (aman naik). Yang flag-nya belum merged: JANGAN tandai flag; sebut di reason bahwa flag-nya masih di MR/belum dibuat.',
  ].join('\n');
}

/** Diff text sent per AI call; files beyond it are listed by name only. */
export const AI_DIFF_BUDGET = 180_000;
const FILE_CAP = 20_000;

export const RELEASE_AI_SYSTEM = [
  'Kamu reviewer rilis senior. Kamu menilai dari ISI KODE (diff), bukan dari judul atau pesan commit.',
  'Jawab HANYA dengan satu objek JSON valid sesuai skema yang diminta, tanpa teks lain, tanpa markdown.',
  'Alasan ditulis singkat dalam Bahasa Indonesia dan menyebut nama file/fungsi/route yang jadi bukti.',
].join('\n');

/**
 * A diff without context lines and without lines that only moved or changed formatting (removed
 * and added again with the same text once spaces are ignored): a reformatted file shrinks to
 * what is really new, e.g. the endpoint blocks it adds.
 */
export function compactDiff(diff: string): string {
  const lines = diff.split('\n');
  const key = (l: string) => l.slice(1).replace(/\s+/g, '');
  const count = (sign: string) => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.startsWith(sign) && !l.startsWith(sign.repeat(3))) m.set(key(l), (m.get(key(l)) ?? 0) + 1);
    return m;
  };
  const removed = count('-');
  const added = count('+');
  const out: string[] = [];
  let header = '';
  for (const l of lines) {
    if (l.startsWith('@@')) {
      header = l;
      continue;
    }
    const sign = l[0];
    if ((sign !== '+' && sign !== '-') || l.startsWith('+++') || l.startsWith('---')) continue;
    const k = key(l);
    if (!k) continue;
    const other = sign === '+' ? removed : added;
    const n = other.get(k) ?? 0;
    if (n > 0) {
      // The same text on the other side: moved or reformatted, not a change.
      other.set(k, n - 1);
      continue;
    }
    if (header) {
      out.push(header);
      header = '';
    }
    out.push(l);
  }
  return out.join('\n');
}

/**
 * Lines really added and removed between two versions of a file, when GitLab gives no diff
 * (too big). Spaces are ignored, so a reformat drops out; consecutive lines are grouped with
 * their line number, so the AI sees where they are.
 */
export function fileDelta(before: string | undefined, after: string | undefined): string {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const key = (l: string) => l.replace(/\s+/g, '');
  const tally = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) if (key(l)) m.set(key(l), (m.get(key(l)) ?? 0) + 1);
    return m;
  };
  const inA = tally(a);
  const inB = tally(b);
  const pick = (lines: string[], other: Map<string, number>, sign: string) => {
    const left = new Map(other);
    const out: string[] = [];
    let last = -2;
    lines.forEach((l, i) => {
      const k = key(l);
      if (!k) return;
      const n = left.get(k) ?? 0;
      if (n > 0) {
        left.set(k, n - 1);
        return;
      }
      if (i !== last + 1) out.push(`@@ ${sign === '+' ? 'baru' : 'lama'} baris ${i + 1} @@`);
      out.push(`${sign}${l}`);
      last = i;
    });
    return out;
  };
  return [...pick(b, inA, '+'), ...pick(a, inB, '-')].join('\n');
}

/** Hunks of a diff, the ones naming a focus word first (endpoints, ticket words, the instruction). */
function focusHunks(diff: string, focus: string[]): string {
  if (!focus.length) return diff;
  const hunks = diff.split(/\n(?=@@)/);
  const hit = (h: string) => focus.some((f) => h.toLowerCase().includes(f));
  return [...hunks.filter(hit), ...hunks.filter((h) => !hit(h))].join('\n');
}

/** Words worth finding in a big diff: paths and identifiers from tickets, endpoints and the instruction. */
export function focusTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\/[A-Za-z0-9_\-{}:.]+(?:\/[A-Za-z0-9_\-{}:.]+)+/g)) {
      // A path, without its parameters: /v1/x/{id} → /v1/x/
      out.add(m[0].replace(/\{[^}]*\}|:[A-Za-z_]+/g, '').toLowerCase());
    }
  }
  return [...out].filter((x) => x.length >= 5).slice(0, 30);
}

/**
 * Diffs as text within a budget: whole files first; a file too big is compacted (no context, no
 * reformat noise) and its focus hunks come first; what still does not fit is listed by name.
 */
export function diffText(changes: MrFileChange[], budget = AI_DIFF_BUDGET, label = '', focus: string[] = []): { text: string; omitted: number } {
  const parts: string[] = [];
  const names: string[] = [];
  let left = budget;
  for (const c of changes) {
    const kind = c.newFile ? ' (file baru)' : c.deletedFile ? ' (dihapus)' : c.renamedFile ? ` (rename dari ${c.oldPath})` : '';
    let body = c.diff;
    let note = '';
    if (body.length > Math.min(FILE_CAP, left)) {
      body = focusHunks(compactDiff(body), focus);
      note = ' (dipadatkan: tanpa konteks dan tanpa baris yang hanya pindah/berubah format)';
    }
    const cap = Math.min(FILE_CAP * 3, left);
    const cut = '\n… (diff dipotong)';
    if (body.length > cap && cap > 2_000) body = `${body.slice(0, cap - cut.length)}${cut}`;
    if (!body || body.length > left) {
      names.push(`- ${c.newPath}${kind}${c.diff ? '' : ' (diff tidak tersedia)'}`);
      continue;
    }
    left -= body.length;
    parts.push(`### ${label}${c.newPath}${kind}${note}\n${body}`);
  }
  const rest = names.length ? `\n\nFile lain yang berubah (diff tidak dimuat):\n${names.join('\n')}` : '';
  return { text: parts.join('\n\n') + rest, omitted: names.length };
}

export interface AiTicketInput {
  key: string;
  summary: string;
  /** The ticket's TAD Detail Task as plain text, if any. */
  detail?: string;
}

export function ticketsPrompt(input: { service: string; target: string; refs: string[]; tickets: AiTicketInput[]; commits: string[]; diff: string; flags?: KnownFlag[] }): string {
  return [
    `Service: ${input.service}`,
    `Kode yang akan dirilis ke ${input.target}: ${input.refs.join(', ')}`,
    '',
    'Tiket scope rilis untuk service ini:',
    ...input.tickets.map((t) => `- ${t.key}: ${t.summary}${t.detail ? `\n  Detail Task TAD:\n  ${t.detail.slice(0, 2000).replace(/\n/g, '\n  ')}` : ''}`),
    '',
    `Commit (${input.commits.length}, hanya konteks, jangan jadikan bukti):`,
    ...input.commits.slice(0, 80).map((c) => `- ${c}`),
    '',
    'Diff (baris + ditambah, - dihapus):',
    input.diff,
    '',
    ...(input.flags?.length ? [knownFlagsText(input.flags), ''] : []),
    'Tugas: untuk SETIAP tiket di atas, nilai apakah implementasinya ada di diff.',
    '- "ada": implementasi utama tiket terlihat (endpoint/handler/model/config sesuai tiket).',
    '- "sebagian": hanya sebagian yang terlihat, atau ragu.',
    '- "tidak": tidak terlihat di diff.',
    'Lalu sebutkan perubahan yang TIDAK punya tiket di daftar (kemungkinan di luar scope yang ikut terbawa), per file: termasuk endpoint/route baru atau yang diubah tanpa tiket (mis. endpoint yang didaftarkan di config API gateway tapi tidak ada tiketnya), fitur lain, atau perubahan config yang tidak dibutuhkan tiket. Sebut endpoint/fungsinya di reason. Abaikan perubahan kecil yang jelas pendukung fitur tiket (mis. DTO/validator fitur yang sama).',
    'Feature flag: perubahan di luar tiket yang SELURUH perilakunya dijaga feature flag/toggle dengan default MATI (mis. if os.Getenv("X_ENABLE") == "true", config enabled: false, flag di DB/remote config yang belum dinyalakan) tidak masalah ikut naik karena fungsinya tersembunyi. Bila hanya sebagian yang dijaga flag, atau default-nya hidup, perlakukan sebagai perubahan di luar scope biasa. Tetap sebut di "unrelated" dengan "flag": "<NAMA_FLAG>" dan tambahkan di "needs" env/config flag itu dengan nilai mati (kind env/other, when pre) supaya tetap mati di produksi.',
    '',
    'Terakhir, daftar SEMUA yang harus disiapkan di server sebelum/sesudah deploy supaya tidak ada yang ketinggalan, dari isi diff:',
    '- "env": variabel environment baru atau yang mulai dibaca kode (os.Getenv, process.env, config ${X}, tag env, viper, dll). label = NAMA_ENV, detail = contoh nilai/keterangan.',
    '- "sql": query yang harus dijalankan manual: CREATE/ALTER/DROP TABLE, CREATE INDEX, INSERT/UPDATE data master/konfigurasi, termasuk tabel baru yang dipakai model/struct/query di kode tapi tidak ada file migrasinya. label = ringkasan, detail = query SQL lengkap bila bisa disusun dari kode (kolom dari struct/model).',
    '- "migration": file migrasi yang harus dijalankan. label = path file.',
    '- "other": langkah deploy lain yang HARUS dikerjakan saat rilis: config file, cron/scheduler baru, queue/topic, bucket, dependency/service baru, perubahan gateway, feature flag, data seed, restart service lain, smoke test endpoint baru. label = langkah singkat yang bisa langsung dikerjakan, tanpa duplikat.',
    'Temuan review (secret/kredensial di repo, bug, risiko, hal yang perlu diputuskan, perubahan kontrak) BUKAN langkah deploy: masukkan ke "risks", jangan ke "needs".',
    'Setiap item diberi "when": "pre" (sebelum deploy) atau "post" (sesudah deploy), supaya panduan deploy lengkap dan berurutan.',
    '',
    'Skema jawaban:',
    '{"tickets":[{"key":"MU-1","verdict":"ada|sebagian|tidak","files":["path/file.go"],"reason":"..."}],"unrelated":[{"path":"path/file.go","reason":"...","flag":"NAMA_FLAG bila di balik feature flag default mati"}],"needs":[{"kind":"env|sql|migration|other","when":"pre|post","label":"...","detail":"...","files":["path/file.go"]}],"risks":[{"path":"path/file.go","reason":"..."}]}',
  ].join('\n');
}

export interface AiCommitInput {
  sha: string;
  shortId: string;
  title: string;
  merge: boolean;
  /** Titles of the commits a merge brought in. */
  brought?: string[];
  diff: string;
}

export function picksPrompt(input: { repo: string; source: string; target: string; tickets: AiTicketInput[]; commits: AiCommitInput[]; instruction?: string }): string {
  return [
    `Repo: ${input.repo}. Branch rilis dibuat dari ${input.target}, lalu commit dari ${input.source} di-cherry-pick satu per satu (merge commit dengan -m 1).`,
    '',
    'Tiket scope rilis untuk repo ini:',
    ...input.tickets.map((t) => `- ${t.key}: ${t.summary}${t.detail ? `\n  Detail: ${t.detail.slice(0, 800).replace(/\n/g, ' ')}` : ''}`),
    '',
    `Commit di jalur ${input.source}, lama ke baru, dengan perubahannya:`,
    ...input.commits.map((c, i) => [`## [${i + 1}] ${c.sha} — ${c.title}${c.merge ? ' (merge commit)' : ''}`, ...(c.brought?.length ? [`Membawa: ${c.brought.slice(0, 15).join('; ')}`] : []), c.diff || '(diff kosong)'].join('\n')),
    '',
    'Tugas: tentukan commit mana yang harus masuk branch rilis supaya isinya PERSIS scope di atas.',
    '- include true hanya bila perubahan commit itu milik tiket scope (nilai dari diff, bukan judul).',
    '- Banyak commit tidak punya Jira key, atau judulnya tidak jelas: tetap nilai dari diff. Masuk bila perubahannya bagian fitur scope (atau diminta instruksi Tech Lead); bila tidak terkait tiket mana pun, include false dan jelaskan isinya di reason.',
    '- Commit campuran (scope + di luar scope): include false, jelaskan di reason dan notes. KECUALI bagian di luar scope-nya seluruhnya di balik feature flag default mati: include true, sebut nama flag di reason, dan ingatkan di notes agar flag tetap mati di produksi.',
    '- Feature flag: perubahan di luar tiket yang SELURUH perilakunya dijaga feature flag/toggle dengan default MATI (mis. if os.Getenv("X_ENABLE") == "true", config enabled: false, flag di DB/remote config yang belum dinyalakan) tidak masalah ikut naik karena fungsinya tersembunyi. Bila hanya sebagian yang dijaga flag, atau default-nya hidup, perlakukan sebagai perubahan di luar scope biasa.',
    '- Commit pendukung (config, CI, dependency) include true hanya bila dibutuhkan fitur scope.',
    '- Perhatikan urutan: commit scope yang bergantung pada commit lain yang tidak dipilih bisa konflik; sebutkan di notes.',
    '- Sebutkan di notes tiket scope yang tidak ditemukan di commit mana pun.',
    '- Bila scope atau instruksi Tech Lead hanya bisa dipenuhi dengan mengambil SEBAGIAN isi commit campuran, tulis di notes: "Pakai Ambil perubahan tertentu saja (per hunk)" dan sebut perubahan mana yang perlu diambil.',
    '',
    ...(input.instruction ? [`Instruksi Tech Lead (utamakan, selama tidak memasukkan perubahan yang jelas di luar rilis tanpa disebut): ${input.instruction}`, ''] : []),
    'Skema jawaban (satu entri per commit, sha lengkap):',
    '{"picks":[{"sha":"<sha>","include":true,"keys":["MU-1"],"reason":"..."}],"notes":["..."]}',
  ].join('\n');
}

/** Per service: what the document says now, and what the code needs. */
export interface AiDocService {
  name: string;
  envBlock?: string;
  preDeploy?: string[];
  postDeploy?: string[];
  failover?: string;
  /** Manual queries in the document now. */
  queries: { label: string; sql?: string }[];
  /** Env names added in .env files and read by the code, migrations and SQL files, from the diff. */
  code: { envAdded: string[]; envReadInCode: string[]; migrations: string[]; sql: string[]; envDiff: string };
}

export function documentPrompt(input: { instruction: string; release: string; services: AiDocService[] }): string {
  return [
    `Dokumen deployment rilis "${input.release}". Per service: isi dokumen saat ini dan yang dibutuhkan kode.`,
    '',
    ...input.services.map((s) =>
      [
        `## ${s.name}`,
        'Blok .env di dokumen:',
        s.envBlock?.trim() ? s.envBlock : '(kosong)',
        `Pre-deploy: ${s.preDeploy?.length ? s.preDeploy.join(' | ') : '(kosong)'}`,
        `Post-deploy: ${s.postDeploy?.length ? s.postDeploy.join(' | ') : '(kosong)'}`,
        `Failover: ${s.failover ?? '(default)'}`,
        `Query manual di dokumen: ${s.queries.length ? '' : '(kosong)'}`,
        ...s.queries.map((q) => `- ${q.label}${q.sql ? `\n\`\`\`sql\n${q.sql}\n\`\`\`` : ''}`),
        `Dari kode: env baru di file .env: ${s.code.envAdded.join(', ') || '-'}; env dibaca kode tanpa ada di .env: ${s.code.envReadInCode.join(', ') || '-'}; migrasi: ${s.code.migrations.join(', ') || '-'}; query manual: ${s.code.sql.join(', ') || '-'}`,
        s.code.envDiff ? `Diff file .env/config:\n${s.code.envDiff}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    `Instruksi Tech Lead: ${input.instruction}`,
    '',
    'Perbaiki dokumen sesuai instruksi dan kode. Aturan:',
    '- Hanya ubah service yang perlu diubah; service lain jangan disertakan.',
    '- envBlock adalah isi lengkap blok .env service setelah diperbaiki (KEY=nilai per baris). Pertahankan nilai yang sudah ada; untuk env baru tanpa nilai yang diketahui tulis KEY= (kosong), jangan mengarang rahasia.',
    '- preDeploy/postDeploy berisi daftar langkah lengkap setelah diperbaiki (tanpa query; query di "queries").',
    '- queries berisi daftar LENGKAP query manual service setelah diperbaiki (label singkat + SQL lengkap), termasuk CREATE/ALTER TABLE yang dibutuhkan kode tapi belum ada migrasinya. Sertakan hanya bila query perlu diubah.',
    '- Commit id tidak diisi (diisi setelah MR merge).',
    '- Jelaskan setiap perubahan di summary.',
    '',
    'Skema jawaban:',
    '{"services":[{"name":"<nama service persis>","envBlock":"KEY=...","preDeploy":["..."],"postDeploy":["..."],"queries":[{"label":"...","sql":"..."}],"failover":"..."}],"summary":["..."]}',
  ].join('\n');
}

/** The first JSON object in an AI reply (also inside a ```json fence). */
export function parseJsonReply(reply: string): Record<string, unknown> | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const text = fenced ?? reply;
  const start = text.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching brace, skipping strings.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Entries with the same path become one, their reasons joined. */
function mergeByPath(list: { path: string; reason: string; flag?: string }[]): { path: string; reason: string; flag?: string }[] {
  const out: { path: string; reason: string; flag?: string }[] = [];
  for (const u of list) {
    const prev = out.find((x) => x.path === u.path);
    if (!prev) out.push({ ...u });
    else {
      if (u.reason && !prev.reason.includes(u.reason)) prev.reason = `${prev.reason} · ${u.reason}`;
      // Behind a flag only when every change of the file is.
      if (prev.flag !== u.flag) delete prev.flag;
    }
  }
  return out;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown, max = 20) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, max) : []);
const VERDICTS: AiVerdict[] = ['ada', 'sebagian', 'tidak'];

/** Something the server needs for this release, found by the AI in the diff. */
export type AiNeed = ReleaseAiNeed;
const NEED_KINDS: AiNeed['kind'][] = ['env', 'sql', 'migration', 'other'];

/** Deploy needs in an AI answer ("needs"), files limited to those that changed. */
export function parseNeeds(json: Record<string, unknown>, known: Set<string>): AiNeed[] {
  const needs: AiNeed[] = [];
  for (const n of Array.isArray(json.needs) ? json.needs : []) {
    const r = n as Record<string, unknown>;
    const kind = str(r.kind, 20).toLowerCase() as AiNeed['kind'];
    let label = str(r.label, 300);
    if (!NEED_KINDS.includes(kind) || !label) continue;
    // An env name is the item; whatever the AI wrapped around it is not.
    if (kind === 'env') label = label.match(/[A-Z][A-Z0-9_]{1,80}/)?.[0] ?? '';
    if (!label || needs.some((x) => x.kind === kind && x.label === label)) continue;
    const detail = typeof r.detail === 'string' ? r.detail.trim().slice(0, 20_000) : '';
    const when = str(r.when, 10).toLowerCase() === 'post' ? 'post' : 'pre';
    needs.push({ kind, when, label, ...(detail ? { detail } : {}), files: strs(r.files, 8).filter((p) => known.has(p)) });
  }
  return needs.slice(0, 80);
}

/** Ticket verdicts for the asked keys only; files limited to the files that changed. */
export function parseTicketsReply(
  reply: string,
  keys: string[],
  paths: string[],
): { tickets: Map<string, AiTicketVerdict>; unrelated: { path: string; reason: string; flag?: string }[]; needs: AiNeed[]; risks: { path: string; reason: string }[] } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const want = new Set(keys);
  const known = new Set(paths);
  const tickets = new Map<string, AiTicketVerdict>();
  for (const t of Array.isArray(json.tickets) ? json.tickets : []) {
    const key = str((t as Record<string, unknown>).key, 20).toUpperCase();
    const verdict = str((t as Record<string, unknown>).verdict, 20).toLowerCase() as AiVerdict;
    if (!want.has(key) || !VERDICTS.includes(verdict)) continue;
    tickets.set(key, { verdict, files: strs((t as Record<string, unknown>).files, 8).filter((p) => known.has(p)), reason: str((t as Record<string, unknown>).reason) });
  }
  // One entry per file: the AI may name a file twice (two unrelated changes in one config).
  const unrelated = mergeByPath(
    (Array.isArray(json.unrelated) ? json.unrelated : [])
      .map((u) => {
        const r = u as Record<string, unknown>;
        const flag = str(r.flag, 100);
        return { path: str(r.path, 300), reason: str(r.reason), ...(flag && !/^(-|tidak|none|null)$/i.test(flag) ? { flag } : {}) };
      })
      .filter((u) => known.has(u.path)),
  ).slice(0, 50);
  const needs = parseNeeds(json, known);
  const risks = (Array.isArray(json.risks) ? json.risks : [])
    .map((u) => ({ path: str((u as Record<string, unknown>).path, 300), reason: str((u as Record<string, unknown>).reason, 800) }))
    .filter((u) => u.reason && (!u.path || known.has(u.path)))
    .slice(0, 30);
  return { tickets, unrelated, needs, risks };
}

/** One pick per known commit, in the commits' order; unknown shas are dropped. */
export function parsePicksReply(reply: string, shas: string[]): { picks: AiPick[]; notes: string[] } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const by = new Map<string, AiPick>();
  for (const p of Array.isArray(json.picks) ? json.picks : []) {
    const r = p as Record<string, unknown>;
    const raw = str(r.sha, 64).toLowerCase();
    const sha = shas.find((s) => raw.length >= 7 && s.toLowerCase().startsWith(raw));
    if (!sha || by.has(sha)) continue;
    by.set(sha, { sha, include: r.include === true, keys: strs(r.keys, 10).map((k) => k.toUpperCase()), reason: str(r.reason) });
  }
  return { picks: shas.flatMap((s) => (by.has(s) ? [by.get(s)!] : [])), notes: strs(json.notes, 15) };
}

export type DocFix = ReleaseDocFix;

/** Proposed document fixes for the release's own services (matched by name, case-insensitive). */
export function parseDocumentReply(reply: string, services: { id: string; name: string }[]): { fixes: DocFix[]; summary: string[] } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const fixes: DocFix[] = [];
  for (const s of Array.isArray(json.services) ? json.services : []) {
    const r = s as Record<string, unknown>;
    const name = str(r.name, 100).toLowerCase();
    const svc = services.find((x) => x.name.toLowerCase() === name);
    if (!svc || fixes.some((f) => f.serviceId === svc.id)) continue;
    const fix: DocFix = { serviceId: svc.id, name: svc.name };
    if (typeof r.envBlock === 'string') fix.envBlock = r.envBlock.slice(0, 50_000).trim();
    if (Array.isArray(r.preDeploy)) fix.preDeploy = strs(r.preDeploy, 40);
    if (Array.isArray(r.postDeploy)) fix.postDeploy = strs(r.postDeploy, 40);
    if (typeof r.failover === 'string' && r.failover.trim()) fix.failover = str(r.failover, 300);
    if (Array.isArray(r.queries)) {
      fix.queries = r.queries
        .map((q) => ({ label: str((q as Record<string, unknown>).label, 300), sql: typeof (q as Record<string, unknown>).sql === 'string' ? ((q as Record<string, unknown>).sql as string).trim().slice(0, 20_000) : '' }))
        .filter((q) => q.label)
        .map((q) => (q.sql ? q : { label: q.label }))
        .slice(0, 40);
    }
    if (Object.keys(fix).length > 2) fixes.push(fix);
  }
  return { fixes, summary: strs(json.summary, 20) };
}

export interface AiDiscoverInput {
  release: string;
  target: string;
  tickets: { key: string; summary: string; service?: string }[];
  /** Repo folder → GitLab project path, from the Services folder. */
  repos: Record<string, string>;
  services: { name: string; gitlabPath?: string; mrs: string[] }[];
  /** Services the user removed from this release: never proposed again. */
  ignored: string[];
  mrs: { ref: string; projectPath: string; title: string; sourceBranch: string; state: string; updatedAt: string }[];
}

export function discoverPrompt(input: AiDiscoverInput): string {
  return [
    `Rilis "${input.release}" ke branch ${input.target}. Tentukan service (repo) dan MR yang termasuk rilis ini.`,
    '',
    'Tiket scope rilis (judul berformat [TYPE][SERVICE][CODENAME] - Nama, atau [PLATFORM][CODENAME][JENIS] Nama untuk mobile):',
    ...input.tickets.map((t) => `- ${t.key}: ${t.summary}${t.service ? ` (service: ${t.service})` : ''}`),
    '',
    'Repo yang tersedia (folder → project GitLab):',
    ...Object.entries(input.repos).map(([f, p]) => `- ${f} → ${p}`),
    '',
    'Service yang sudah ada di rilis:',
    ...(input.services.length ? input.services.map((s) => `- ${s.name}${s.gitlabPath ? ` (${s.gitlabPath})` : ' (project GitLab belum diketahui)'}${s.mrs.length ? `, MR: ${s.mrs.join(', ')}` : ''}`) : ['(belum ada)']),
    ...(input.ignored.length ? ['', `Service yang SUDAH DIHAPUS user dari rilis, jangan diusulkan lagi: ${input.ignored.join(', ')}`] : []),
    '',
    `MR ke ${input.target} (kandidat):`,
    ...(input.mrs.length ? input.mrs.map((m) => `- ${m.ref} [${m.state}, ${m.updatedAt.slice(0, 10)}] ${m.title} (branch ${m.sourceBranch})`) : ['(tidak ada)']),
    '',
    'Aturan:',
    '- Service masuk rilis hanya bila ada tiket scope untuk repo itu. Cocokkan nama service di tiket dengan nama repo secara teliti: "core-tcico" dan "core-tcico-ultimate" adalah dua repo berbeda.',
    '- Tiket mobile/web (IOS, ANDROID, dll.) masuk hanya bila ada repo yang jelas untuk platform itu.',
    '- Tiket [FRONTEND]/[FE]/[WEB]/[CMS] dengan service X milik repo front-end X (mis. x-frontend, x-fe, x-web), BUKAN repo back-end X. Repo back-end X masuk hanya bila ada tiket back-end untuknya.',
    '- Untuk service yang sudah ada tapi project GitLab-nya belum diketahui, isi gitlabPath dari daftar repo bila jelas.',
    '- MR masuk hanya bila repo-nya service rilis DAN isinya (judul/branch) berkaitan dengan tiket scope. Jangan masukkan MR fitur lain atau yang tidak jelas.',
    '- Hanya usulkan tambahan; jangan ulang yang sudah ada.',
    '',
    'Skema jawaban:',
    '{"services":[{"name":"<nama service>","gitlabPath":"<group/repo>","reason":"..."}],"mrs":[{"ref":"<group/repo!iid>","service":"<nama service>","reason":"..."}]}',
  ].join('\n');
}

export interface AiDiscovered {
  services: { name: string; gitlabPath?: string; reason: string }[];
  mrs: { ref: string; service: string; reason: string }[];
}

/** Proposed services on known repos and proposed MRs among the candidates; the rest is dropped. */
export function parseDiscoverReply(reply: string, repoPaths: string[], mrRefs: string[]): AiDiscovered | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const paths = new Set(repoPaths);
  const refs = new Set(mrRefs);
  const services: AiDiscovered['services'] = [];
  for (const s of Array.isArray(json.services) ? json.services : []) {
    const r = s as Record<string, unknown>;
    const name = str(r.name, 100);
    const gitlabPath = str(r.gitlabPath, 300);
    if (!name || (gitlabPath && !paths.has(gitlabPath))) continue;
    services.push({ name, ...(gitlabPath ? { gitlabPath } : {}), reason: str(r.reason) });
  }
  const mrs = (Array.isArray(json.mrs) ? json.mrs : [])
    .map((m) => ({ ref: str((m as Record<string, unknown>).ref, 400), service: str((m as Record<string, unknown>).service, 100), reason: str((m as Record<string, unknown>).reason) }))
    .filter((m) => refs.has(m.ref));
  return { services: services.slice(0, 30), mrs: mrs.slice(0, 60) };
}

/** Hunks as text for the AI within a budget, focus hunks first; the rest listed by id only. */
export function hunksText(files: PatchFile[], budget = AI_DIFF_BUDGET, focus: string[] = []): string {
  const all = files.flatMap((f) => f.hunks.map((h) => ({ f, h, text: [...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`)].join('\n') })));
  const hit = (t: string) => focus.some((x) => t.toLowerCase().includes(x));
  const ordered = [...all.filter((x) => hit(x.text)), ...all.filter((x) => !hit(x.text))];
  const parts: string[] = [];
  const rest: string[] = [];
  let left = budget;
  for (const x of ordered) {
    const block = `### [${x.h.id}] ${x.f.path}${x.f.status === 'new' ? ' (file baru)' : x.f.status === 'deleted' ? ' (file dihapus)' : ` baris ${x.h.at}`}\n${x.text}${x.h.more ? `\n… (${x.h.more} baris lagi)` : ''}`;
    if (block.length > left) {
      rest.push(x.h.id);
      continue;
    }
    left -= block.length;
    parts.push(block);
  }
  return parts.join('\n\n') + (rest.length ? `\n\nHunk lain (isi tidak dimuat; anggap tidak terkait kecuali diminta): ${rest.join(', ')}` : '');
}

export function patchPrompt(input: { repo: string; source: string; target: string; tickets: AiTicketInput[]; hunks: string; instruction?: string }): string {
  return [
    `Repo: ${input.repo}. Branch rilis dibuat dari ${input.target} lalu diisi HANYA hunk perubahan yang dipilih dari ${input.source} (bukan cherry-pick commit utuh).`,
    '',
    'Tiket scope rilis untuk repo ini:',
    ...input.tickets.map((t) => `- ${t.key}: ${t.summary}${t.detail ? `\n  Detail: ${t.detail.slice(0, 800).replace(/\n/g, ' ')}` : ''}`),
    '',
    ...(input.instruction ? [`Instruksi Tech Lead (WAJIB dijalankan: hunk yang diminta harus dipilih walau tidak ada tiketnya): ${input.instruction}`, ''] : []),
    `Hunk perubahan ${input.target} → ${input.source} per file (- dihapus, + ditambah; perbandingan mengabaikan spasi):`,
    input.hunks,
    '',
    'Tugas: pilih hunk yang harus masuk branch rilis supaya isinya persis scope + instruksi Tech Lead.',
    '- Pilih hunk milik tiket scope atau yang diminta instruksi; nilai dari isinya, bukan dari judul commit.',
    '- Jangan pilih hunk fitur lain, reformat/whitespace, atau file infra yang tidak dibutuhkan, kecuali diminta instruksi.',
    '- Hunk fitur lain yang seluruhnya di balik feature flag default mati BOLEH dipilih bila memudahkan (mis. menjaga satu blok tetap utuh); sebut nama flag di reason. Bila tidak perlu, tetap jangan dipilih.',
    '- Bila satu blok baru terpecah ke beberapa hunk yang saling bergantung (mis. koma JSON, kurung penutup, import), pilih semua bagiannya supaya file tetap valid.',
    '- Jelaskan singkat setiap hunk yang dipilih; sebut di notes bila ada yang diminta tapi tidak ditemukan.',
    '',
    'Skema jawaban:',
    '{"hunks":[{"id":"<path#n>","keys":["MU-1"],"reason":"..."}],"notes":["..."]}',
  ].join('\n');
}

/** The chosen hunks (known ids only) with their reasons. */
export function parsePatchReply(reply: string, ids: string[]): { chosen: Map<string, { keys: string[]; reason: string }>; notes: string[] } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const known = new Set(ids);
  const chosen = new Map<string, { keys: string[]; reason: string }>();
  for (const h of Array.isArray(json.hunks) ? json.hunks : []) {
    const r = h as Record<string, unknown>;
    const id = str(r.id, 600);
    if (known.has(id)) chosen.set(id, { keys: strs(r.keys, 10).map((k) => k.toUpperCase()), reason: str(r.reason) });
  }
  return { chosen, notes: strs(json.notes, 15) };
}

export function safetyPrompt(input: { repo: string; branch: string; from: string; target: string; tickets: AiTicketInput[]; releaseDiff: string; leftOut: string }): string {
  return [
    `Repo: ${input.repo}. Branch rilis ${input.branch} dibuat dari ${input.target} dengan hanya SEBAGIAN perubahan ${input.from}. Kombinasi ini belum pernah dites utuh.`,
    '',
    'Tiket scope rilis untuk repo ini:',
    ...input.tickets.map((t) => `- ${t.key}: ${t.summary}`),
    '',
    `Perubahan yang IKUT di branch rilis (${input.target} → ${input.branch}):`,
    input.releaseDiff || '(tidak ada)',
    '',
    `Perubahan di ${input.from} yang SENGAJA TIDAK IKUT (${input.branch} → ${input.from}):`,
    input.leftOut || '(tidak ada)',
    '',
    'Tugas: periksa ketergantungan. Apakah kode yang ikut memakai sesuatu yang hanya ada di perubahan yang tidak ikut, atau yang belum ada di target?',
    '- Fungsi, method, struct/kelas, konstanta, import/package, interface yang dipanggil tapi didefinisikan di perubahan yang tidak ikut.',
    '- Route/endpoint/handler, kolom atau tabel database, migrasi, env/config, file template, atau dependency yang dirujuk tapi tidak ikut.',
    '- Untuk config gateway/proxy: backend/endpoint yang dirujuk harus ada; pola route tidak bentrok.',
    '- Perubahan yang ikut tapi setengah (mis. pemanggil ikut, implementasinya tidak).',
    '- Feature flag: perubahan di luar tiket yang SELURUH perilakunya dijaga feature flag/toggle dengan default MATI (mis. if os.Getenv("X_ENABLE") == "true", config enabled: false, flag di DB/remote config yang belum dinyalakan) tidak masalah ikut naik karena fungsinya tersembunyi. Bila hanya sebagian yang dijaga flag, atau default-nya hidup, perlakukan sebagai perubahan di luar scope biasa. Kode seperti itu yang ikut bukan masalah; cukup pastikan flag-nya terdefinisi dengan nilai mati (sebut di summary).',
    'verdict: "aman" bila tidak ada ketergantungan putus; "putus" bila ada yang pasti putus; "perlu dicek" bila ragu atau bukti tidak cukup. Sebut file dan nama yang jadi bukti.',
    '',
    'Skema jawaban:',
    '{"verdict":"aman|perlu dicek|putus","summary":"...","issues":[{"path":"path/file","reason":"..."}]}',
  ].join('\n');
}

/** The dependency verdict and its issues (paths kept as given; they are only shown). */
export function parseSafetyReply(reply: string): { verdict: 'aman' | 'perlu dicek' | 'putus'; summary: string; issues: { path: string; reason: string }[] } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  const v = str(json.verdict, 20).toLowerCase();
  const verdict = v === 'aman' ? 'aman' : v === 'putus' ? 'putus' : 'perlu dicek';
  const issues = (Array.isArray(json.issues) ? json.issues : [])
    .map((i) => ({ path: str((i as Record<string, unknown>).path, 300), reason: str((i as Record<string, unknown>).reason, 800) }))
    .filter((i) => i.reason)
    .slice(0, 30);
  return { verdict, summary: str(json.summary, 800), issues };
}

/** "Generate dokumen": what the server needs for one service's release MRs, from their diff. */
export function docgenPrompt(input: { service: string; target: string; mrs: string[]; diff: string; current: { envBlock?: string; failover?: string } }): string {
  return [
    `Service: ${input.service}. MR rilis ke ${input.target}: ${input.mrs.join(', ')}.`,
    'Susun bagian dokumen deployment service ini dari ISI DIFF MR (bukan judul/commit).',
    '',
    'Blok .env di dokumen saat ini:',
    input.current.envBlock?.trim() || '(kosong)',
    `Failover saat ini: ${input.current.failover ?? '(default)'}`,
    '',
    'Diff MR (baris + ditambah, - dihapus):',
    input.diff,
    '',
    'Daftar SEMUA yang harus disiapkan di server sebelum/sesudah deploy:',
    '- "env": variabel environment baru atau yang mulai dibaca kode. label = NAMA_ENV, detail = contoh nilai/keterangan (jangan mengarang rahasia).',
    '- "sql": query manual: CREATE/ALTER/DROP TABLE, CREATE INDEX, INSERT/UPDATE data master, termasuk tabel yang dipakai model/query tapi tidak ada migrasinya. detail = SQL lengkap bila bisa disusun dari kode.',
    '- "migration": file migrasi yang harus dijalankan. label = path file.',
    '- "other": langkah deploy lain yang HARUS dikerjakan (config, cron, queue/topic, bucket, dependency/service, gateway, feature flag tetap mati, restart service lain, smoke test endpoint baru). label = langkah singkat.',
    'Setiap item diberi "when": "pre" atau "post". Temuan review (bug, risiko) BUKAN langkah deploy, jangan dimasukkan.',
    'Isi "failover" hanya bila strategi rollback khusus dibutuhkan (mis. migrasi yang tidak bisa dibalik); selain itu kosongkan.',
    '',
    'Skema jawaban:',
    '{"needs":[{"kind":"env|sql|migration|other","when":"pre|post","label":"...","detail":"...","files":["path/file"]}],"failover":""}',
  ].join('\n');
}

export function parseDocgenReply(reply: string, paths: string[]): { needs: AiNeed[]; failover: string } | null {
  const json = parseJsonReply(reply);
  if (!json) return null;
  return { needs: parseNeeds(json, new Set(paths)), failover: str(json.failover, 300) };
}
