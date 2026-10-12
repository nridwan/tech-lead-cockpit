# Tech Lead Cockpit

Aplikasi desktop lokal untuk membantu Tech Lead menyusun Technical Architecture Document (TAD) dari PRD dan Figma, memecah fitur menjadi task (Backend, Mobile FE, Web/CMS FE), menjalankan AI generator berbasis Claude CLI dengan riwayat revisi dan rollback, serta mempublikasikan dokumen rapi ke Confluence dengan format **tadgen**.

Rencana lengkap: [docs/PLAN.md](docs/PLAN.md).

## Status

| Area | Status |
| --- | --- |
| Import PRD (.md) & deteksi requirements/Figma | ✅ Parser metadata, objective, requirements table, figma links |
| Generator Berbasis Chat (Claude CLI) | ✅ Berjalan di folder kerja TAD (`PRD.md` + `TAD.md`), riwayat revisi + diff + rollback |
| Template & Validator Format TAD | ✅ Validasi Scope ↔ Detail Task, coverage PRD, tipe task (BACKEND, MOBILE-FE, WEB-FE) |
| Confluence Converter (Gaya tadgen) | ✅ Tabel Document Info (1800px), tabel 2-kolom Detail Task (1688px), Jira macro, wide code macro |
| Ambil layar Figma untuk AI | ✅ Token Figma di Keychain (Setup → Figma), pilih layar dari link Figma, screenshot + teks tiap layar disimpan ke workspace TAD dan dibaca AI generator |
| Release Management | ✅ MR ke master per service, cek env/migrasi/query, cakupan tiket (TAD + codename), import/publish dokumen rilis, share review MR ke grup Teams |
| Publish ke Confluence (create/update + version check + audit) | ✅ via connector lokal (token di Keychain, conflict protection 409) |
| Balas WhatsApp (AI + template) | ✅ Tautkan via QR (linked device), draft AI lewat Claude CLI, template per audiens, kirim manual dengan konfirmasi |
| MR Review, Jira Automation, Dashboard | Tahap lanjutan (Phase 1, 4, 5) |

## 💻 Prasyarat Sistem (Prerequisites)

- **Node.js**: Node.js 22 LTS atau yang lebih baru (ESM native), ATAU runtime **Bun** (`>= 1.2`).
- **Rust Toolchain** *(hanya jika menjalankan/membangun desktop Tauri)*:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Sistem Operasi**: macOS 11+ (Apple Silicon atau Intel) dengan dukungan `/usr/bin/security` (Keychain).

---

## 📦 Instalasi

Pilih package manager favorit Anda (**npm**, **bun**, atau **pnpm**):

```bash
# Menggunakan npm
npm install

# ATAU menggunakan bun
bun install

# ATAU menggunakan pnpm
pnpm install
```

---

## 🚀 Cara Menjalankan (Development Modes)

Aplikasi menyediakan beberapa mode eksekusi sesuai kebutuhan:

### 1. Mode Web Dev (Browser di http://127.0.0.1:5173)
Menjalankan frontend Svelte 5 dengan integrated Vite dev server dan plugin connector sidecar:
```bash
npm run dev
# atau: bun run dev / pnpm dev
```
> [!NOTE]
> Mode ini menyajikan UI di port `5173` dengan backend connector otomatis aktif di rute `/api/connector/*` pada port yang sama.

### 2. Mode Native Desktop (Tauri v2 Dev Window)
Menjalankan aplikasi langsung sebagai jendela desktop native macOS dengan hot-reload:
```bash
npm run dev:desktop
# atau: bun run dev:desktop / pnpm dev:desktop
```
> [!TIP]
> Mode ini otomatis menjalankan Vite dev server dan meluncurkan native desktop shell Tauri v2.

### 3. Mode Fresh Profile (Lingkungan Uji Terisolasi)
Menjalankan dev server di port `5180` dengan direktori konfigurasi terisolasi (`TLC_PROFILE=test`):
```bash
npm run dev:fresh
# atau: bun run dev:fresh / pnpm dev:fresh
```

### 4. Mode Standalone Connector
Membundle dan menjalankan backend local connector secara independen sebagai Node server di port `5174`:
```bash
npm run connector
# atau: bun run connector / pnpm connector
```

---

## 🏗️ Cara Build (Production Packaging)

### 1. Build Desktop Native macOS (`.app` & `.dmg`)
Membangun aplikasi desktop native siap pakai yang menggabungkan seluruh komponen:
```bash
npm run build:desktop
# atau: bun run build:desktop / pnpm build:desktop
```
Pipeline ini secara otomatis:
1. Mem-build UI frontend Svelte 5 via Vite (`dist/`).
2. Mem-bundle local connector Node.js via Vite (`dist-connector/server.mjs`).
3. Mem-bundle VPS scheduled reporter via Vite (`dist-reporter/tad-progress.mjs`).
4. Mengompilasi Rust shell Tauri v2 ke file binary dan installer native:
   - **File `.dmg`**: `src-tauri/target/release/bundle/dmg/`
   - **File `.app`**: `src-tauri/target/release/bundle/macos/`

### 2. Build Frontend Web Saja
Mengompilasi aset UI Svelte 5 ke direktori `dist/`:
```bash
npm run build
# atau: bun run build / pnpm build

# Preview hasil build lokal (port 4173):
npm run preview
# atau: bun run preview / pnpm preview
```

### 3. Build Sidecar Connector Saja
Membundle server API connector mandiri:
```bash
npm run build:connector
# atau: bun run build:connector / pnpm build:connector
# Output: dist-connector/server.mjs
```

### 4. Build Scheduled Reporter VPS Saja
Membundle script pengirim laporan progres TAD WhatsApp untuk cron server:
```bash
npm run build:reporter
# atau: bun run build:reporter / pnpm build:reporter
# Output: dist-reporter/tad-progress.mjs
```

---

## 🧪 Verifikasi & Pengujian

Sebelum commit atau deploy, jalankan verifikasi type check dan pengujian:

```bash
# Type-checking Svelte 5 Runes & TypeScript strict
npm run check
# atau: bun run check / pnpm check

# Menjalankan unit & integration tests (Vitest + JSDOM)
npm test
# atau: bun test / pnpm test
```

---

## 🔑 Pengaturan Kredensial & Token (macOS Keychain)

Simpan token akses secara aman langsung ke macOS Keychain (tidak pernah ditulis ke file `.env`):

```bash
npm run token:confluence  # Token Confluence Cloud/DC
npm run token:jira        # Token Atlassian Jira
npm run token:gitlab      # Personal Access Token GitLab
npm run token:inferhub    # API Key InferHub
npm run token:9router     # API Key 9Router
```
*(Bisa juga dijalankan dengan `bun run token:<name>` atau `pnpm token:<name>`)*

---

## 📋 Tabel Perbandingan Perintah (Cheat Sheet)

| Kebutuhan | Perintah NPM | Perintah Bun | Perintah pnpm |
|---|---|---|---|
| **Instalasi** | `npm install` | `bun install` | `pnpm install` |
| **Web Dev** | `npm run dev` | `bun run dev` | `pnpm dev` |
| **Desktop Dev** | `npm run dev:desktop` | `bun run dev:desktop` | `pnpm dev:desktop` |
| **Fresh Dev Profile** | `npm run dev:fresh` | `bun run dev:fresh` | `pnpm dev:fresh` |
| **Build Desktop (.dmg/.app)** | `npm run build:desktop` | `bun run build:desktop` | `pnpm build:desktop` |
| **Build Frontend** | `npm run build` | `bun run build` | `pnpm build` |
| **Build Connector** | `npm run build:connector` | `bun run build:connector` | `pnpm build:connector` |
| **Build Reporter** | `npm run build:reporter` | `bun run build:reporter` | `pnpm build:reporter` |
| **Type Check** | `npm run check` | `bun run check` | `pnpm check` |
| **Unit Tests** | `npm test` | `bun test` | `pnpm test` |
| **Set Confluence Token** | `npm run token:confluence` | `bun run token:confluence` | `pnpm token:confluence` |
| **Set Jira Token** | `npm run token:jira` | `bun run token:jira` | `pnpm token:jira` |
| **Set GitLab Token** | `npm run token:gitlab` | `bun run token:gitlab` | `pnpm token:gitlab` |

## Alur Kerja TAD

1. **Import PRD**: tempel/upload PRD (.md), periksa link Figma yang terdeteksi (bisa tambah manual), dan upload dokumen pendukung (dokumentasi API partner, ekspor layar Figma PNG/PDF, catatan). Tidak ada input service manual.
2. **Kerangka TAD**: aplikasi hanya mengisi bagian yang pasti dari PRD (Document Information, Change History, Objective, Documentation, Development Schema). Bagian lain ditandai `TODO: diisi AI`.
3. **Analisa AI**: AI membaca PRD, link Figma, dokumen di `docs/`, dan codebase di folder Services (default `~/Documents/MTN & FM/Services`) untuk menentukan service yang berubah, lalu menyusun Development Analysis, Development Scope, dan Detail Task. Codebase hanya dibaca: Claude mendapat `--add-dir` dengan larangan tulis, Antigravity butuh izin `read_file` yang diberikan lewat tombol di dialog, dan `git status` setiap repo dibandingkan sebelum/sesudah job.
4. **Riwayat Revisi & Rollback**: Setiap perubahan AI atau import dicatat sebagai revisi. Buka menu **Revisi** untuk melihat perbandingan line diff dan tombol rollback kapan saja.
5. **Validasi**: Validator otomatis memeriksa:
   - Setiap task di tabel *Development Scope* wajib memiliki *Detail Task* yang bersesuaian.
   - Setiap requirement dari PRD wajib tercakup oleh minimal satu task.
   - Format nama task mengikuti `[TYPE][SERVICE][CODENAME] - Nama Task`, dengan tipe: `BACKEND`, `MOBILE-FE`, atau `WEB-FE`.
6. **Publish ke Confluence**: Dikonversi ke Confluence storage format gaya *tadgen*:
   - Tabel Document Information lebar 1800px dengan header highlight.
   - Tabel Change History 3 kolom.
   - Tabel 2 kolom (kv_table) untuk setiap Detail Task.
   - Code macro lebar (`breakoutMode="wide"`).
   - Jira structured macro untuk issue keys.
   - Diagram Mermaid sebagai attachment PNG dan expand macro.

## AI: Claude CLI, Antigravity CLI & InferHub

Generator TAD dan drafter WhatsApp mendukung **Claude CLI**, **Antigravity CLI**, dan **InferHub** (API relay model frontier), dengan model yang dapat dipilih langsung dari aplikasi:

| Provider | Siapkan | Model |
| --- | --- | --- |
| Claude CLI | `brew upgrade --cask claude-code` (minimal 2.1), lalu jalankan `claude` sekali untuk login dan menyetujui ketentuan | Default, Opus, Sonnet, Haiku |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`, lalu jalankan `agy` sekali untuk login | Daftar dari `agy models` (Gemini Flash/Pro) |
| InferHub | Dapatkan API key di [inferhub.dev/dashboard](https://inferhub.dev/dashboard), simpan via `npm run token:inferhub` atau `INFERHUB_API_KEY` di `.env.local` | `ag/claude-sonnet-4-6`, `cb/gpt-5.4`, `ag/claude-opus-4-6-thinking`, `ali/qwen3.8-max`, `ag/gemini-3.8-flash-high`, atau custom slug |

- Generator berjalan sebagai job di background dengan progres langsung (file yang dibaca/diedit) dan tombol **Batalkan**. Job tetap berjalan bila halaman di-reload.
- Tidak ada izin bebas: Claude hanya boleh Read/Edit/Write di folder kerja draft. Untuk Antigravity & InferHub, akses file di luar draft dibatasi hanya untuk membaca codebase, dan perintah terminal diblokir.
- Kalau CLI tidak merespons dalam 60 detik (biasanya karena belum login, ada ketentuan baru, atau versi terlalu lama), job dihentikan dengan penjelasan.

## Balas WhatsApp

1. Buka menu **Balas WhatsApp** → **Tampilkan QR** → di HP: *Perangkat tertaut → Tautkan perangkat* → scan.
2. Pilih chat, tentukan lawan bicara (**Tim dev/QA**, **PM/Stakeholder**, **Klien/eksternal**), pilih template (opsional) dan isi variabelnya, tambahkan instruksi, lalu **Buat balasan dengan AI**.
3. Edit draft bila perlu, lalu **Kirim** → **Ya, kirim**. Tidak ada pengiriman otomatis.

Catatan:

- Koneksi memakai protokol WhatsApp Web (library Baileys), **tidak resmi**: WhatsApp bisa membatasi nomor yang terlihat seperti bot. Pengiriman dibatasi minimal 3 detik antar pesan dan 15 pesan/menit, hanya ke chat yang sudah ada.
- Sesi tertaut: `~/.tech-lead-cockpit/whatsapp-auth/` (izin 0700). Template: `~/.tech-lead-cockpit/wa-templates.json`. Isi chat hanya di memori; audit log mencatat pengiriman tanpa isi pesan.
- Draft AI mengirim maksimal 25 pesan terakhir chat terpilih ke Claude CLI tanpa tools; isi chat diperlakukan sebagai data, bukan instruksi.
- Membuka chat tidak mengirim tanda "dibaca". **Putuskan** menghapus perangkat tertaut dan sesi lokal.

## Menghubungkan Confluence

1. `cp .env.example .env.local`, isi `CONFLUENCE_BASE_URL` dan `CONFLUENCE_AUTH`
   - Data Center: Personal Access Token → `CONFLUENCE_AUTH=bearer`
   - Cloud: API token + `CONFLUENCE_EMAIL` → `CONFLUENCE_AUTH=basic` (base URL diakhiri `/wiki`)
2. `npm run token:confluence` — token disimpan di macOS Keychain (service `tech-lead-cockpit.confluence`)
3. Aktifkan VPN, restart `npm run dev`, cek di menu **Koneksi**
4. Sertifikat internal ditolak? `NODE_EXTRA_CA_CERTS=/path/ca.pem npm run dev`
