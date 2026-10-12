import type { MrFileChange } from '../gitlab/types';
import type { AiPick, AiTicketVerdict, AiVerdict, ReleaseAiNeed, ReleaseDocFix } from './types';

/**
 * Prompts and answer parsing for the release AI jobs: read the tickets in the code, pick the
 * commits of a release branch, and fix the release document. Pure: the connector runs the AI.
 * Every answer is JSON; anything the AI says outside it, or that does not fit, is dropped.
 */

/** Diff text sent per AI call; files beyond it are listed by name only. */
export const AI_DIFF_BUDGET = 180_000;
const FILE_CAP = 20_000;

export const RELEASE_AI_SYSTEM = [
  'Kamu reviewer rilis senior. Kamu menilai dari ISI KODE (diff), bukan dari judul atau pesan commit.',
  'Jawab HANYA dengan satu objek JSON valid sesuai skema yang diminta, tanpa teks lain, tanpa markdown.',
  'Alasan ditulis singkat dalam Bahasa Indonesia dan menyebut nama file/fungsi/route yang jadi bukti.',
].join('\n');

/** Diffs as text within a budget: whole files first, the rest by name only. */
export function diffText(changes: MrFileChange[], budget = AI_DIFF_BUDGET, label = ''): { text: string; omitted: number } {
  const parts: string[] = [];
  const names: string[] = [];
  let left = budget;
  for (const c of changes) {
    const kind = c.newFile ? ' (file baru)' : c.deletedFile ? ' (dihapus)' : c.renamedFile ? ` (rename dari ${c.oldPath})` : '';
    const body = c.diff.length > FILE_CAP ? `${c.diff.slice(0, FILE_CAP)}\n… (diff dipotong)` : c.diff;
    if (!body || body.length > left) {
      names.push(`- ${c.newPath}${kind}${c.diff ? '' : ' (diff tidak tersedia)'}`);
      continue;
    }
    left -= body.length;
    parts.push(`### ${label}${c.newPath}${kind}\n${body}`);
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

export function ticketsPrompt(input: { service: string; target: string; refs: string[]; tickets: AiTicketInput[]; commits: string[]; diff: string }): string {
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
    'Tugas: untuk SETIAP tiket di atas, nilai apakah implementasinya ada di diff.',
    '- "ada": implementasi utama tiket terlihat (endpoint/handler/model/config sesuai tiket).',
    '- "sebagian": hanya sebagian yang terlihat, atau ragu.',
    '- "tidak": tidak terlihat di diff.',
    'Lalu sebutkan perubahan yang TIDAK punya tiket di daftar (kemungkinan di luar scope yang ikut terbawa), per file: termasuk endpoint/route baru atau yang diubah tanpa tiket (mis. endpoint yang didaftarkan di config API gateway tapi tidak ada tiketnya), fitur lain, atau perubahan config yang tidak dibutuhkan tiket. Sebut endpoint/fungsinya di reason. Abaikan perubahan kecil yang jelas pendukung fitur tiket (mis. DTO/validator fitur yang sama).',
    '',
    'Terakhir, daftar SEMUA yang harus disiapkan di server sebelum/sesudah deploy supaya tidak ada yang ketinggalan, dari isi diff:',
    '- "env": variabel environment baru atau yang mulai dibaca kode (os.Getenv, process.env, config ${X}, tag env, viper, dll). label = NAMA_ENV, detail = contoh nilai/keterangan.',
    '- "sql": query yang harus dijalankan manual: CREATE/ALTER/DROP TABLE, CREATE INDEX, INSERT/UPDATE data master/konfigurasi, termasuk tabel baru yang dipakai model/struct/query di kode tapi tidak ada file migrasinya. label = ringkasan, detail = query SQL lengkap bila bisa disusun dari kode (kolom dari struct/model).',
    '- "migration": file migrasi yang harus dijalankan. label = path file.',
    '- "other": hal lain: config file, cron/scheduler baru, queue/topic, bucket, dependency/service baru, perubahan gateway, feature flag, data seed, restart service lain, smoke test endpoint baru. label = langkah singkat yang bisa langsung dikerjakan.',
    'Setiap item diberi "when": "pre" (sebelum deploy) atau "post" (sesudah deploy), supaya panduan deploy lengkap dan berurutan.',
    '',
    'Skema jawaban:',
    '{"tickets":[{"key":"MU-1","verdict":"ada|sebagian|tidak","files":["path/file.go"],"reason":"..."}],"unrelated":[{"path":"path/file.go","reason":"..."}],"needs":[{"kind":"env|sql|migration|other","when":"pre|post","label":"...","detail":"...","files":["path/file.go"]}]}',
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

export function picksPrompt(input: { repo: string; source: string; target: string; tickets: AiTicketInput[]; commits: AiCommitInput[] }): string {
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
    '- Commit campuran (scope + di luar scope): include false, jelaskan di reason dan notes.',
    '- Commit pendukung (config, CI, dependency) include true hanya bila dibutuhkan fitur scope.',
    '- Perhatikan urutan: commit scope yang bergantung pada commit lain yang tidak dipilih bisa konflik; sebutkan di notes.',
    '- Sebutkan di notes tiket scope yang tidak ditemukan di commit mana pun.',
    '',
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
    '- preDeploy/postDeploy berisi daftar langkah lengkap setelah diperbaiki.',
    '- Jelaskan setiap perubahan di summary.',
    '',
    'Skema jawaban:',
    '{"services":[{"name":"<nama service persis>","envBlock":"KEY=...","preDeploy":["..."],"postDeploy":["..."],"failover":"..."}],"summary":["..."]}',
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

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown, max = 20) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, max) : []);
const VERDICTS: AiVerdict[] = ['ada', 'sebagian', 'tidak'];

/** Something the server needs for this release, found by the AI in the diff. */
export type AiNeed = ReleaseAiNeed;
const NEED_KINDS: AiNeed['kind'][] = ['env', 'sql', 'migration', 'other'];

/** Ticket verdicts for the asked keys only; files limited to the files that changed. */
export function parseTicketsReply(reply: string, keys: string[], paths: string[]): { tickets: Map<string, AiTicketVerdict>; unrelated: { path: string; reason: string }[]; needs: AiNeed[] } | null {
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
  const unrelated = (Array.isArray(json.unrelated) ? json.unrelated : [])
    .map((u) => ({ path: str((u as Record<string, unknown>).path, 300), reason: str((u as Record<string, unknown>).reason) }))
    .filter((u) => known.has(u.path))
    .slice(0, 50);
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
  return { tickets, unrelated, needs: needs.slice(0, 80) };
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
