# 🤖 AGENTS.md — Pedoman Operasional & Arsitektur Tech Lead Cockpit

Dokumen ini adalah **pedoman utama dan entrypoint resmi** bagi setiap AI Coding Assistant (Antigravity, Claude, Codex, Cursor, dsb.) dan engineer manusia yang bekerja pada repositori **Tech Lead Cockpit**.

---

## ⚡ MANDATORY RULE: PROTOKOL SINKRONISASI HARNESS

> [!CRITICAL]
> ### 🛑 ATURAN WAJIB UPDATE HARNESS (NON-NEGOTIABLE)
> **Setiap agent atau pengembang yang melakukan penambahan fitur, perubahan kode, perbaikan bug, atau refactoring di repositori ini WAJIB meng-update dokumentasi harness terkait di bawah folder [`docs/harness/`](docs/harness/index.md) serta memperbarui referensi di file ini sebelum menandai tugas sebagai selesai.**
>
> **Tidak ada tugas pengembangan yang dianggap selesai tanpa sinkronisasi harness!**
> 
> Baca panduan lengkapnya di [Harness Synchronization Protocol](docs/harness/development-guide/index.md#harness-synchronization-protocol).

---

## 🧩 1. Ringkasan Tech Stack & Arsitektur Sistem

Tech Lead Cockpit adalah aplikasi desktop lokal untuk Tech Lead yang menggabungkan:
- **TAD Generator & Confluence Publisher** berbasis PRD dan Figma.
- **GitLab MR Review & Jira Automation** melalui VPN laptop tanpa memindahkan source code ke cloud publik.
- **Autonomous Coder Agent** lokal yang mengimplementasikan task arsitektur di sandbox terisolasi.
- **Bug Tracing & Diagnostics** lintas microservice.
- **WhatsApp Web Multi-Device Bridge** untuk drafting balasan berbasis audiens.

### Lapisan Teknologi (Tech Stack Layers)
1. **Desktop Shell Layer**:
   - **Tauri v2** (`@tauri-apps/cli` 2.12.1, Rust edition 2024, `src-tauri/`).
   - Mengelola native desktop window, izin protokol aman (`open_external`), dan mengawasi siklus hidup local connector (menjalankan Node 22 subprocess, streaming log, dan melepaskan lock saat shutdown).
2. **Frontend UI Layer**:
   - **Svelte 5** (`^5.57.1`) menggunakan sistem modern **Runes** (`$state`, `$derived`, `$derived.by`, `$effect`, `{#snippet}`).
   - **Vite 8** (`^8.3.2`) dengan `@sveltejs/vite-plugin-svelte`.
   - **TypeScript 5.9** dengan type checker `svelte-check`.
   - **Styling**: `src/app.css` (custom design system, variabel warna terang/gelap, font Poppins `@fontsource/poppins`).
   - **Rendering & Visualisasi**: `marked` (Markdown parser), `dompurify` (HTML sanitization), `mermaid` (diagram arsitektur/flowchart), `qrcode` (pairing QR code).
3. **Local Connector Layer (Sidecar / API Gateway)**:
   - **Runtime**: Node.js 22 LTS ESM (`dist-connector/server.mjs` dibundle via `vite.connector.config.ts`).
   - **Mode Dev**: Plugin Vite `devConnector` di [`connector/dev-connector.ts`](connector/dev-connector.ts) yang menyajikan route `/api/connector/*` di port 5173.
   - **Mode Desktop Bundle**: Standalone server di port 5174 (`src/lib/api-base.ts` otomatis merutekan ke port 5174 saat di bundle desktop).
   - **Keamanan Kredensial**: **macOS Login Keychain** via `/usr/bin/security` wrapper ([`connector/keychain.ts`](connector/keychain.ts)). Token rahasia tidak pernah dikirim ke frontend!
4. **Remote Companion Layer**:
   - Progressive Web App (PWA) di [`connector/remote/`](connector/remote/) yang disajikan melalui IP Tailscale (port 5175) untuk monitoring dari smartphone.
5. **Scheduled Reporter Layer**:
   - Standalone Node script di [`reporter/tad-progress.ts`](reporter/tad-progress.ts) (dibundle ke `dist-reporter/tad-progress.mjs`) untuk dijalankan via cron VPS (Hermes) guna mengirim laporan progres ke grup WhatsApp tim.

---

## 📚 2. Sistem Referensi Dokumentasi Harness (`docs/harness/`)

Untuk memahami setiap fitur secara mendalam—mulai dari struktur file, alur kerja, kontrak data, hingga cara mengembangkannya—gunakan referensi tautan modular berikut:

| Nama Modul & Fitur | Quick Referensi Dokumen Harness | Cakupan Utama Fitur |
|---|---|---|
| 🏛️ **System Architecture** | [`docs/harness/architecture/index.md`](docs/harness/architecture/index.md) | Topologi Tauri v2, Connector Node 22, komunikasi IPC, siklus hidup proses, direktori `~/.tech-lead-cockpit`, dan batas keamanan Keychain. |
| 📝 **TAD Workspace** | [`docs/harness/tad/index.md`](docs/harness/tad/index.md) | Parsing PRD, AI generator TAD (Claude/Agy/InferHub), revisi & line diff rollback, validator kepatuhan arsitektur, ambil layar Figma (screenshot + teks) ke workspace AI, converter format Confluence tadgen (1800px & 1688px), save as draft tanpa naik versi, auto-generate tiket Jira, dan AI generated Catatan Versi (changelog) berbasis diff target. |
| 🔀 **GitLab MR Review** | [`docs/harness/mr-review/index.md`](docs/harness/mr-review/index.md) | MR review engine over VPN (inline atau di background via Agent Tasks), deteksi perubahan-ke-task dengan evidence, panel Acceptance Criteria Jira, TAD conformance checker, dan proteksi transisi Jira. |
| 🤖 **Coder Agents** | [`docs/harness/coder-agents/index.md`](docs/harness/coder-agents/index.md) | Autonomous coding agent lokal, isolasi clone di `~/.tech-lead-cockpit/coder/<run>`, batas konkurensi, profil Backend/Frontend, modal diff review, dan unit test verifier. |
| 🐛 **Bug Tracing** | [`docs/harness/bug-tracing/index.md`](docs/harness/bug-tracing/index.md) | Ingestion error & stack trace, sanitasi log/PII otomatis, penelusuran alur kode multi-service di folder `Services/`, analisis akar masalah (RCA), dan pembuatan fix spec. |
| 📊 **Projects & Ops Board** | [`docs/harness/projects-ops/index.md`](docs/harness/projects-ops/index.md) | Papan operasional task, pelacakan progres proyek, pencegahan regresi status (*task peaks*), engine estimasi hari kerja dengan kalender libur nasional Indonesia, Daftar Tim (role, Jira, email git, cuti) dan rekomendasi developer per role, dan sinkronisasi VPS. |
| 🧪 **QA Automation** | [`docs/harness/qa-automation/index.md`](docs/harness/qa-automation/index.md) | Generator skenario pengujian E2E dari flow TAD, eksekutor test otomatis, manajemen environment (Staging/Dev), dan pelaporan hasil uji. |
| 💬 **AI Assistant** | [`docs/harness/assistant/index.md`](docs/harness/assistant/index.md) | Chat asisten Tech Lead multi-turn, Cockpit Context Engine (injeksi status live app ke prompt sistem), persistensi sesi, Claude Cloud, dan mode Ultrareview. |
| 📱 **WhatsApp Bridge** | [`docs/harness/whatsapp/index.md`](docs/harness/whatsapp/index.md) | WhatsApp Web multi-device (Baileys), QR authentication, draft balasan AI dengan adaptasi persona (Dev/QA, PM, Klien), template manager, dan konfirmasi manual anti-spam. |
| 🚀 **Release Management** | [`docs/harness/releases/index.md`](docs/harness/releases/index.md) | Rilis lintas service: MR ke master per service, cek env/migrasi/query, tiket dicek langsung dari isi diff kode (endpoint TAD, nama tiket di identifier/path), cakupan tiket dari TAD dan codename, import dokumen rilis (Confluence/Markdown), publish ke Confluence, dan share review MR ke grup Teams. |
| 🔌 **External Integrations** | [`docs/harness/integrations/index.md`](docs/harness/integrations/index.md) | Adapter Jira (Cloud & DC), Confluence REST API, GitLab API v4, Figma REST API (ambil layar desain untuk TAD, read-only), MS Teams Graph API, driver AI CLI (Claude & Agy), InferHub, 9Router, dan macOS Keychain. |
| 📲 **Remote Access PWA** | [`docs/harness/remote-pwa/index.md`](docs/harness/remote-pwa/index.md) | Companion PWA mobile di port 5175 via Tailscale, bundled assets di connector, otentikasi PIN/pairing QR, dan whitelist API mobile. |
| 🛠️ **Development Guide** | [`docs/harness/development-guide/index.md`](docs/harness/development-guide/index.md) | Standar coding Svelte 5 Runes, pola pembuatan endpoint connector, teknik unit testing (Vitest seam injection), dan protokol wajib sinkronisasi harness. |

---

## 🔒 3. Guardrails Keamanan & Integritas Data (Safety Rules)

1. **LARANGAN KERAS BACA FILE `.ENV`**:
   - Dilarang membaca, menampilkan, atau memproses file `.env`, `.env.*`, atau kunci privat (`*.pem`, `*.key`, `id_rsa*`).
   - Jika schema dibutuhkan, rujuk dokumen non-sensitif seperti `.env.example`.
2. **KREDENSIAL HANYA DI MACOS KEYCHAIN**:
   - Semua token disimpan di Keychain via [`connector/keychain.ts`](connector/keychain.ts).
   - Frontend tidak boleh menyimpan token mentah di `localStorage` atau `sessionStorage`.
3. **ISOLASI EKSEKUSI KODE**:
   - AI Coder Agent TIDAK BOLEH memodifikasi folder `Services/` pengguna secara langsung. Eksekusi wajib dilakukan pada git clone terisolasi di `~/.tech-lead-cockpit/coder/<run-id>`.
4. **HUMAN-IN-THE-LOOP UNTUK AKSI WRITE**:
   - Setiap tindakan yang memodifikasi sistem luar (Publish Confluence, Jira Transition, Push Git, Send WhatsApp) WAJIB memerlukan konfirmasi eksplisit dari pengguna.
5. **AUDIT TRAIL**:
   - Setiap mutasi wajib dicatat menggunakan `deps.appendAudit(...)` ke file `~/.tech-lead-cockpit/audit.log`.

---

## 💻 4. Standar Kode & Panduan Implementasi

### Standar Frontend (Svelte 5 Runes)
- Gunakan `$state()` untuk variabel reaktif (bukan `let`).
- Gunakan `$derived()` atau `$derived.by()` untuk nilai komputasi (bukan `$: `).
- Gunakan `$effect()` untuk *side effects* eksplisit (bukan `$: `).
- File store reaktif yang menggunakan Runes di luar file `.svelte` WAJIB dinamai `*.svelte.ts`.
- Manfaatkan reusable snippets (`{#snippet ...}`) untuk elemen UI modular.

### Standar Backend (Node 22 ESM)
- Rute baru didaftarkan di [`connector/dev-connector.ts`](connector/dev-connector.ts).
- Pisahkan logika bisnis ke dalam controller/manager tersendiri di dalam direktori `connector/`.
- Gunakan pola *seam injection* (`ConnectorDeps`) untuk mempermudah unit testing tanpa network atau Keychain nyata.
- Batasi ukuran pembacaan request JSON (`readJson(req, MAX_BYTES)`).

---

## 🔄 5. Alur Kerja Agent (Standard Operating Procedure)

Setiap AI Agent yang menerima tugas pengembangan di repositori ini harus mengikuti langkah-langkah berikut:

```mermaid
flowchart TD
    Start([Terima User Request]) --> Step1[1. Identifikasi Modul Terkait]
    Step1 --> Step2[2. Baca docs/harness/<modul>/index.md]
    Step2 --> Step3[3. Rencanakan & Implementasikan Kode]
    Step3 --> Step4[4. Jalankan Pengujian (npm test & npm run check)]
    Step4 --> Step5[5. Sinkronkan Perubahan ke docs/harness/ & AGENTS.md]
    Step5 --> Step6[6. Konfirmasi & Ringkas Pekerjaan ke User]
    Step6 --> End([Selesai])
```

1. **Identifikasi Area**: Periksa modul apa yang tersentuh oleh permintaan user.
2. **Baca Harness Terkait**: Buka file `docs/harness/<modul>/index.md` untuk memahami alur kerja, struktur kode, dan kontrak data yang ada.
3. **Implementasikan Perubahan**: Tulis kode sesuai standar (Svelte 5 Runes, TypeScript strict, seam injection, zero secret exposure).
4. **Verifikasi**: Jalankan type check dan test suite:
   ```bash
   npm run check
   npm test
   ```
5. **Update Dokumen Harness**: Catat perubahan arsitektur, endpoint baru, atau modifikasi logika bisnis ke dalam dokumen harness terkait dan perbarui `AGENTS.md` jika ada perubahan struktural.
6. **Laporkan Hasil**: Jelaskan perubahan secara padat dengan menyertakan tautan markdown ke file kode dan dokumen harness yang diperbarui.
