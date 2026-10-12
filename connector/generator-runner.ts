import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collapseEmbeddedHtml, expandEmbeddedHtml } from '../src/lib/markdown/embedded-html.ts';
import type { FigmaFetchedSet } from '../src/lib/figma/types.ts';
import { isPdfEncrypted } from './workspace-docs.ts';
import { readFetchedSets } from './figma.ts';
import { DATA_DIR } from './paths.ts';

/** File tools only (no shell); edits outside the workspace are not auto-approved. */
export const GENERATOR_CLAUDE_ARGS = ['--allowedTools', 'Read,Edit,Write', '--permission-mode', 'acceptEdits'];

export interface RunChatOptions {
  draftId: string;
  prompt: string;
  prdMarkdown?: string;
  tadMarkdown: string;
  /** Absolute, already validated codebase folder the AI may read (never write). */
  servicesRoot?: string;
  figmaLinks?: { title?: string; url: string }[];
  provider?: 'claude' | 'antigravity' | 'inferhub' | '9router';
  /** brainstorm: discuss and maintain SCOPE.md only; edit: write the TAD itself. */
  kind?: 'brainstorm' | 'edit';
  scopeMarkdown?: string;
  /** The user approved SCOPE.md; the TAD must follow it. */
  scopeAgreed?: boolean;
  /** The TAD already exists in Confluence (imported): continue it instead of writing from scratch. */
  existingTad?: boolean;
}

export interface RunChatResult {
  reply: string;
  updatedTadMarkdown?: string;
  changed: boolean;
  updatedScopeMarkdown?: string;
  scopeChanged: boolean;
  workspacePath: string;
  error?: string;
}

export interface PreparedWorkspace {
  workspaceDir: string;
  tadPath: string;
  scopePath: string;
  instructions: string;
  /** SCOPE.md as written before the run (may be derived from the TAD), to detect real changes. */
  initialScope: string;
}

/**
 * For a TAD that already exists, its Development Scope is the agreed scope: brainstorming starts
 * from it instead of re-deriving everything from the codebase.
 */
export function scopeFromExistingTad(tad: string): string | undefined {
  const m = tad.match(/^#\s+Development Scope\s*$([\s\S]*?)(?=^#\s|(?![\s\S]))/m);
  const body = m?.[1].trim();
  if (!body) return undefined;
  return [
    '# Rencana Scope',
    '',
    '> Diambil dari Development Scope TAD yang sudah ada di Confluence. Ini scope yang sudah berjalan;',
    '> tambahkan perubahan baru di bagian "Perubahan yang Diusulkan" tanpa mengubah daftar di bawah kecuali diminta.',
    '',
    '## Scope Saat Ini',
    '',
    body,
    '',
    '## Perubahan yang Diusulkan',
    '',
    'Belum ada.',
    '',
  ].join('\n');
}

export function isValidDraftId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
}

/** How the AI should use the Figma screens Cockpit fetched into figma/ (images only for CLI providers). */
export function figmaContextLine(sets: FigmaFetchedSet[], provider: RunChatOptions['provider']): string {
  const list = sets
    .map((s) => `figma/${s.id}/index.md (${s.title ? `${s.title}, ` : ''}${s.fileName}, ${s.screens.length} layar${s.stale ? ', desain sudah berubah sejak diambil' : ''})`)
    .join('; ');
  const textOnly = provider === 'inferhub' || provider === '9router';
  return [
    `- figma/: layar desain yang diambil Cockpit dari Figma: ${list}.`,
    textOnly
      ? 'Baca index.md tiap set: berisi daftar layar dan seluruh teks yang terlihat di tiap layar (judul, label field, tombol, pesan). Jangan membuka file PNG (tidak bisa dibaca sebagai teks).'
      : 'Baca index.md tiap set (daftar layar dan seluruh teks di tiap layar), lalu buka gambar PNG layar yang relevan untuk memahami tampilan, field, state, dan alurnya.',
    'Jadikan ini acuan task UI (slicing, field, validasi, state kosong/error) dan integrasi API, sebut nama layarnya di task terkait, dan cantumkan link Figma-nya.',
  ].join(' ');
}

/** Writes PRD.md and TAD.md into the draft's workspace and builds the prompt for the CLI. */
export async function prepareGeneratorWorkspace(opts: RunChatOptions): Promise<PreparedWorkspace> {
  // draftId becomes a directory name; reject anything that could escape the workspaces root.
  if (!isValidDraftId(opts.draftId)) throw new Error('draftId tidak valid.');
  const workspaceDir = path.join(DATA_DIR, 'workspaces', opts.draftId);
  await fs.promises.mkdir(workspaceDir, { recursive: true });

  const prdPath = path.join(workspaceDir, 'PRD.md');
  const tadPath = path.join(workspaceDir, 'TAD.md');
  if (opts.prdMarkdown) {
    await fs.promises.writeFile(prdPath, opts.prdMarkdown, 'utf-8');
  } else if (!fs.existsSync(prdPath)) {
    await fs.promises.writeFile(prdPath, '# PRD\n\nBelum diimpor.', 'utf-8');
  }
  // Detail Task tables are one long HTML line in the draft; spread them out so the AI can edit them.
  await fs.promises.writeFile(tadPath, expandEmbeddedHtml(opts.tadMarkdown), 'utf-8');
  const scopePath = path.join(workspaceDir, 'SCOPE.md');
  const initialScope = opts.scopeMarkdown?.trim()
    ? opts.scopeMarkdown
    : ((opts.existingTad ? scopeFromExistingTad(opts.tadMarkdown) : undefined) ??
      '# Rencana Scope\n\nBelum ada. Susun berdasarkan PRD, dokumen pendukung, dan codebase.\n');
  await fs.promises.writeFile(scopePath, initialScope, 'utf-8');
  // Antigravity only treats Git roots as workspaces; without one it can't edit TAD.md headlessly,
  // and its file tools stay confined to this root (allowNonWorkspaceAccess is off by default).
  if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
    await promisify(execFile)('git', ['init', '-q', workspaceDir]).catch(() => undefined);
  }

  const figma = (opts.figmaLinks ?? []).filter((f) => /^https:\/\/([\w-]+\.)*figma\.com\//.test(f.url));
  if (figma.length) {
    const body = ['# Link Figma', '', ...figma.map((f) => `- ${f.title ? `${f.title}: ` : ''}${f.url}`)].join('\n');
    await fs.promises.writeFile(path.join(workspaceDir, 'figma-links.md'), body, 'utf-8');
  }
  const figmaSets = await readFetchedSets(path.join(workspaceDir, 'figma'));
  let docs: string[] = [];
  try {
    docs = await fs.promises.readdir(path.join(workspaceDir, 'docs'));
  } catch {
    docs = [];
  }
  const readableDocs: string[] = [];
  const encryptedDocs: string[] = [];
  for (const d of docs) {
    if (d.toLowerCase().endsWith('.pdf')) {
      try {
        const buf = await fs.promises.readFile(path.join(workspaceDir, 'docs', d));
        if (isPdfEncrypted(buf)) {
          encryptedDocs.push(d);
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    readableDocs.push(d);
  }
  const referenceTads = opts.servicesRoot ? path.join(opts.servicesRoot, 'technical-analysis-document') : '';
  const hasReferenceTads = Boolean(referenceTads && fs.existsSync(referenceTads));

  const brainstorm = opts.kind === 'brainstorm';
  const target = brainstorm ? 'SCOPE.md' : 'TAD.md';
  const context = [
    '',
    'Sumber yang tersedia:',
    opts.existingTad
      ? '- PRD.md: requirement produk bila sudah diimpor. Jika isinya "Belum diimpor", jangan mengarang requirement di luar TAD.md dan permintaan user.'
      : '- PRD.md: requirement produk (sumber utama).',
    figma.length
      ? figmaSets.length
        ? '- figma-links.md: link desain Figma. Layar dari link yang sudah diambil ada di figma/ (lihat poin berikut); untuk link lain kamu tidak bisa membuka Figma, cukup cantumkan link-nya pada task UI terkait.'
        : '- figma-links.md: link desain Figma. Kamu tidak bisa membuka Figma; cantumkan link-nya pada task UI terkait dan gunakan ekspor layar di docs/ bila ada.'
      : '',
    figmaSets.length ? figmaContextLine(figmaSets, opts.provider) : '',
    readableDocs.length ? `- docs/: dokumen pendukung (${readableDocs.join(', ')}), misalnya dokumentasi API partner atau ekspor layar Figma. Baca seluruhnya.` : '',
    encryptedDocs.length
      ? `- PERINGATAN DOKUMEN: File (${encryptedDocs.join(', ')}) di folder docs/ terenkripsi/berproteksi sandi dan tidak dapat dibaca oleh AI. JANGAN membuka atau memanggil tool view_file pada file tersebut karena akan memicu error 400 (INVALID_ARGUMENT). Sampaikan ke user di chat bahwa file tersebut perlu dibuka dengan password lewat menu Dokumen Partner di Cockpit.`
      : '',
    opts.servicesRoot && opts.existingTad
      ? `- Codebase seluruh service ada di folder "${opts.servicesRoot}" (satu subfolder per service/repo). JANGAN memindai ulang seluruh codebase: baca hanya service/file yang relevan dengan permintaan user, dan sebutkan file/fungsi existing yang menjadi acuan. Folder ini HANYA untuk dibaca: jangan membuat, mengubah, atau menghapus file apa pun di sana.`
      : opts.servicesRoot
        ? `- Codebase seluruh service ada di folder "${opts.servicesRoot}" (satu subfolder per service/repo). Telusuri untuk menentukan service mana yang perlu diubah atau ditambah, dan ikuti pola yang sudah ada (struktur folder, model, route, middleware, integrasi antar service, scheduler, migration). Sebutkan file/fungsi existing yang menjadi acuan. Folder ini HANYA untuk dibaca: jangan membuat, mengubah, atau menghapus file apa pun di sana.`
        : '',
    hasReferenceTads ? `- Contoh TAD yang sudah ada di "${referenceTads}" bisa dijadikan acuan gaya dan tingkat detail.` : '',
    '- SCOPE.md: rencana scope hasil brainstorming dengan user' + (opts.scopeAgreed ? ' (SUDAH DISETUJUI user).' : ' (belum disetujui).'),
    `- Satu-satunya file yang boleh kamu ubah adalah ${target}.`,
    opts.provider === 'antigravity'
      ? `- Gunakan tool list_dir, find_by_name, grep_search, dan view_file untuk membaca, serta replace_file_content, multi_replace_file_content, atau write_to_file untuk mengedit ${target}. JANGAN memakai run_command/terminal, browser, atau web: semuanya diblokir dan akan menghentikan proses.`
      : opts.provider === 'inferhub' || opts.provider === '9router'
        ? `- Gunakan tool read_file, list_dir, dan grep_search untuk membaca, serta write_file atau replace_file_content untuk mengedit ${target}. Terminal tidak tersedia.`
        : `- Gunakan Glob, Grep, dan Read untuk membaca, serta Edit/Write untuk mengubah ${target}. Terminal (Bash) tidak tersedia.`,
    `- Jika pesan user hanya sapaan atau pertanyaan (bukan permintaan perubahan), jawab singkat dan jangan ubah ${target}.`,
    `- Perubahanmu bisa direview user dan diterima sebagian atau ditolak, jadi ${target} bisa berbeda dari hasil editmu sebelumnya. Selalu baca ulang ${target} sebelum mengedit.`,
  ].filter(Boolean);

  const existingRules = [
    'TAD ini SUDAH ADA di Confluence dan sedang dipakai tim; tugasmu MELANJUTKAN, bukan menulis ulang.',
    '- TAD.md adalah sumber kebenaran. Ubah HANYA bagian yang diminta user; jangan menulis ulang, merapikan, menerjemahkan, atau mengubah gaya bagian lain.',
    '- Development Scope di TAD.md adalah scope yang sudah disepakati. Jangan menambah atau menghapus task kecuali diminta; usulan tambahan sebutkan di balasan chat.',
    '- Detail Task berbentuk tabel HTML: kolom kiri <th><h3>Label</h3></th> (Description, Service, Endpoint, Method, Header, Payload, Response, ...), kolom kanan <td>isi</td>. Saat mengedit atau menambah task, ikuti format tabel yang sama persis dengan task di sekitarnya:',
    '  - pakai tag HTML biasa (p, ul/ol/li, strong, em, code, h4, table/tr/th/td); JANGAN menulis Markdown di dalam tabel;',
    '  - blok kode ditulis <pre data-tlc-code="json"><code>…</code></pre>, dengan karakter <, >, & dan " di-escape (&lt; &gt; &amp; &quot;); baris baru di dalam kode boleh langsung ditulis;',
    '  - jangan memakai makro Confluence (ac:structured-macro) atau CDATA, dan jangan mengubah atribut data-table-width, colgroup, atau data-tlc-* pada tabel yang ada;',
    '  - task baru: tambahkan juga barisnya di tabel Development Scope dengan format nama yang sama.',
  ];

  const instructions = brainstorm
    ? [
        'Kamu adalah asisten Tech Lead. Saat ini FASE BRAINSTORMING: tujuan kamu menyepakati scope perubahan dengan user SEBELUM TAD lengkap ditulis, supaya generate TAD tidak boros dan sesuai keinginan user.',
        ...(opts.existingTad
          ? [
              'TAD ini SUDAH ADA di Confluence. SCOPE.md sudah berisi "Scope Saat Ini" yang diambil dari Development Scope TAD: anggap itu sudah disepakati.',
              'Analisa hanya perubahan baru dari permintaan user, tulis di bagian "## Perubahan yang Diusulkan" (task baru/diubah/dihapus beserta alasan dan bukti di codebase). Jangan menganalisa ulang service yang sudah ada di scope kecuali diminta.',
            ]
          : []),
        'JANGAN mengubah TAD.md. Tuangkan hasil analisa ke SCOPE.md dengan struktur ringkas berikut (Markdown, Bahasa Indonesia):',
        '1. ## Pemahaman Kebutuhan: 3-6 poin inti dari PRD.',
        '2. ## Service Terdampak: tabel | Service | Jenis Perubahan (baru/ubah/integrasi) | Alasan | Bukti di codebase (path file/fungsi) |.',
        '3. ## Usulan Task: tabel | No | Task ([TYPE][SERVICE][CODENAME] - Nama Task) | Requirement PRD | Catatan |. Tipe: BACKEND, MOBILE-FE, atau WEB-FE. Judul task saja, tanpa detail API/payload.',
        '4. ## Keputusan Desain: tiap keputusan penting beserta alternatif yang ditolak dan alasannya.',
        '5. ## Di Luar Scope: hal yang sengaja tidak dikerjakan.',
        '6. ## Asumsi',
        '7. ## Pertanyaan Terbuka: hal yang perlu dikonfirmasi user/PM sebelum TAD ditulis.',
        'Cara menentukan service (penting, jangan menebak dari nama folder):',
        hasReferenceTads
          ? `- Baca dulu contoh TAD di "${referenceTads}": di sana arsitektur dan pembagian tanggung jawab antar service sudah terdokumentasi (siapa pemilik saldo/wallet, di mana scheduler, gateway, notifikasi). Ikuti pola tersebut.`
          : '',
        '- Untuk setiap domain yang disentuh PRD (user/akun, saldo/wallet & transaksi, notifikasi, scheduler/job, gateway), cari service PEMILIK data/logikanya dengan membaca kode (model, route, query), lalu cantumkan path file yang benar-benar kamu baca sebagai bukti.',
        '- Utamakan service existing yang sudah memiliki domain tersebut daripada service lain yang hanya mirip namanya.',
        '- Nama service di judul task WAJIB nama repo lengkap dalam huruf besar, contoh [BACKEND][CORE-USER-AUTH-ULTIMATE][CODENAME] - ..., dengan CODENAME dari Code Name di TAD.md.',
        'Tetap ringkas: ini bahan diskusi, bukan dokumen final. Jangan menulis Detail Task, endpoint, payload, atau response.',
        'Jika user memberi masukan, perbarui SCOPE.md sesuai masukan tersebut (misalnya mengeluarkan service atau task dari scope).',
        ...context,
        '',
        `Pesan dari user: ${opts.prompt}`,
        '',
        'Balas di chat dengan ringkasan singkat perubahan pada SCOPE.md dan daftar pertanyaan terbuka yang paling penting.',
      ].join('\n')
    : opts.existingTad
      ? [
          'Kamu adalah asisten Tech Lead yang melanjutkan dokumen Technical Architecture Document (TAD).',
          'Di direktori kerja saat ini terdapat PRD.md, SCOPE.md, dan TAD.md.',
          ...existingRules,
          opts.scopeAgreed
            ? '- SCOPE.md sudah disetujui user: terapkan "Perubahan yang Diusulkan" di dalamnya ke TAD.md (Development Scope dan Detail Task), tanpa mengubah task lain.'
            : '',
          '- Untuk perubahan besar, edit TAD.md bertahap per bagian dengan beberapa Edit. Jangan menulis ulang seluruh file dalam satu Write.',
          ...context,
          '',
          `Instruksi dari user: ${opts.prompt}`,
          '',
          'Edit TAD.md langsung bila user meminta perubahan, lalu berikan ringkasan perubahan yang kamu lakukan.',
        ]
          .filter(Boolean)
          .join('\n')
      : [
        'Kamu adalah asisten Tech Lead yang bertugas menyusun dan mengedit dokumen Technical Architecture Document (TAD).',
        'Di direktori kerja saat ini terdapat PRD.md, SCOPE.md, dan TAD.md.',
        'Format TAD harus mengikuti standar berikut:',
        '1. Judul H1 (# TAD - <Judul>)',
        '2. Tabel Document Information (Author, To Be Reviewed By, To Be Informed to, Last Update, State, Code Name)',
        '3. Tabel Change History (Description, Update Date, Updated By)',
        '4. # Objective',
        '5. # Development Analysis (mencakup ## Architecture dengan diagram Mermaid, ## Technology Stack, ## Development Schema)',
        '6. # Documentation (tabel link Test Cases, PRD, dan Figma)',
        '7. # Development Scope (tabel dengan kolom No, Service Name, Task Name, Jira Task). Format nama task: [TYPE][SERVICE][CODENAME] - Nama Task.',
        '   Tipe task HARUS salah satu dari: BACKEND, MOBILE-FE, atau WEB-FE.',
        '8. # Detail Task: setiap task dari Development Scope memiliki heading H2 (## [TYPE][SERVICE][CODENAME] - Nama Task) dengan sub-section: #### Description, #### Service, #### Endpoint, #### Method, #### Header, #### Payload, #### Response, dll.',
        'Aturan penting:',
        '- Setiap task di Development Scope WAJIB memiliki Detail Task yang sesuai.',
        '- Setiap requirement di PRD.md WAJIB tercakup oleh minimal satu task.',
        opts.scopeAgreed
          ? '- SCOPE.md sudah disetujui user: ikuti service, task, keputusan desain, dan batas scope di dalamnya. Jangan menambah service atau task di luar SCOPE.md; jika menurutmu ada yang kurang, sebutkan di balasan chat, jangan langsung ditambahkan.'
          : '',
        '- Untuk perubahan besar, edit TAD.md bertahap per section dengan beberapa Edit. Jangan menulis ulang seluruh file dalam satu Write, karena output yang terlalu panjang akan terpotong.',
        '- Bagian yang bertuliskan "TODO: diisi AI" adalah bagian yang harus kamu isi; ganti placeholder tersebut.',
        ...context,
        '',
        `Instruksi dari user: ${opts.prompt}`,
        '',
        'PENTING: Edit file TAD.md secara langsung di direktori ini jika user meminta perubahan atau pembuatan TAD. Berikan ringkasan perubahan yang kamu lakukan.',
      ]
        .filter(Boolean)
        .join('\n');

  return { workspaceDir, tadPath, scopePath, instructions, initialScope };
}

/** Reads TAD.md and SCOPE.md back after the CLI ran and reports what changed. */
export async function readGeneratorResult(
  ws: PreparedWorkspace,
  original: { tad: string; scope?: string },
  outcome: { reply: string; error?: string },
): Promise<RunChatResult> {
  const read = (file: string) => fs.promises.readFile(file, 'utf-8').catch(() => undefined);
  const [rawTad, scope] = await Promise.all([read(ws.tadPath), read(ws.scopePath)]);
  // Back to the draft's single-line table form, so an untouched table doesn't count as a change.
  const tad = rawTad === undefined ? undefined : collapseEmbeddedHtml(rawTad);
  const changed = tad !== undefined && tad.trim() !== original.tad.trim();
  const scopeChanged = scope !== undefined && scope.trim() !== (original.scope ?? '').trim() && !/^# Rencana Scope\s+Belum ada\./.test(scope.trim());
  return {
    reply: outcome.error ?? outcome.reply,
    error: outcome.error,
    updatedTadMarkdown: changed ? tad : undefined,
    changed,
    updatedScopeMarkdown: scopeChanged ? scope : undefined,
    scopeChanged,
    workspacePath: ws.workspaceDir,
  };
}
