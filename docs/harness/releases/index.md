# Harness: Release Management

Modul **Rilis** mengelola satu rilis lintas service: MR ke branch produksi (default `master`) per service, apa yang dibawa tiap MR ke server (env, migrasi, query manual), tiket yang tercakup (dari TAD, codename, atau dokumen), runbook deploy dan rollback, dokumen rilis (import dari Confluence/Markdown, publish ke Confluence), dan permintaan review MR ke grup Teams.

---

## 🎯 Alur Kerja

1. **Buat rilis** di menu Rilis (`#/releases`). Isi versi, tanggal, branch target, approval minimal.
2. **Tentukan cakupan**: pilih proyek Cockpit (task TAD + Jira key-nya), codename (tiket `[TYPE][SERVICE][CODENAME] - Nama` ikut walau tidak ada di TAD; codename dari judul task TAD ikut otomatis), atau tiket tambahan. Bisa juga dengan **Import dokumen**.
3. **Cari service & MR** (`POST /releases/discover`): service diturunkan dari tiket, dipetakan ke project GitLab lewat remote git repo di folder Services, lalu MR ke branch target (terbuka, atau merge sejak ±7 hari sebelum rilis dibuat) ditambahkan. Tidak ada yang dihapus.
4. **Jalankan cek** (`POST /releases/check`): tiap MR diambil dari GitLab dan diperiksa secara deterministik (tanpa AI). Env/migrasi/query baru masuk checklist; laporan disimpan.
5. **Share MR ke Teams** (`POST /releases/share`): pilih MR, grup/channel, tenggat, reviewer (dari Daftar Tim), catatan; pratinjau lalu kirim setelah konfirmasi. Tercatat di audit log (`teams.send`).
6. **Checklist hari rilis**: centang env, migrasi, query, langkah deploy, rollback.
7. **Publish ke Confluence**: dokumen dari tab Dokumen dipublish lewat route publish yang sudah ada (cek versi 409 untuk update).

---

## 🔍 Cek per MR ([`src/lib/release/checks.ts`](../../../src/lib/release/checks.ts))

| Temuan | Cara |
|---|---|
| Env baru | Baris `+KEY=` di file `.env`, `.env.example`, `env.sample`, … (nilai yang hanya berubah tidak dihitung) |
| Env dibaca di kode | `process.env.X`, `os.Getenv("X")`, `os.getenv`, `env('X')`, `System.getenv`, tag `env:"X"`, `${X}` di file config; baris yang hanya pindah diabaikan |
| Migrasi | File di folder migrasi (`migrations/`, `db/migrate/`, `flyway/`, `prisma/migrations/`, …) atau pola nama `V1__x.sql` / `20261012_x.sql`; migrasi lama yang diubah ditandai |
| Query manual | File `.sql` di luar folder migrasi dan folder test |
| Model tanpa migrasi | File model/entity/schema berubah tanpa migrasi di MR yang sama |
| Commit tanpa Jira key | Judul commit tanpa key (merge commit diabaikan) |
| Status MR | state, draft, konflik, pipeline, approval vs minimal, branch target |

Diff yang terpotong (GitLab atau batas Cockpit) ditandai supaya env dicek manual.

## 🎯 Scope vs kode

Rilis dianggap **scope sesuai** hanya bila: semua tiket scope ada di kode MR rilis, tidak ada tiket di luar scope yang terbawa, dan tidak ada commit tanpa Jira key. "Kode" = Jira key di judul commit (termasuk merge commit dari branch fitur) dan nama branch sumber (`codeKeys`); judul/deskripsi MR tidak dihitung (deskripsi MR buatan Cockpit memuat daftar tiket).

- Tiket di kode yang bukan scope (`outOfScope`) diambil judul/statusnya dari Jira. Yang codename-nya milik rilis (lebih tua dari jangkauan pencarian codename) otomatis masuk scope.
- Aksi di tab Tiket: **Masukkan ke scope** (ke `jiraKeys`) atau **Sengaja ikut** (ke `accepted`, dengan alasan) supaya tidak terus jadi peringatan.
- Kartu status scope di atas tab; mengubah status ke Siap rilis/Dirilis saat belum sesuai meminta konfirmasi.

## 🔀 Buat MR

Per service: **Buat MR** (`POST /releases/mr/plan` lalu `/releases/mr/create`). Rencana membandingkan branch sumber (default `staging`, per rilis) dengan branch target lewat GitLab compare: commit, file, env/migrasi/query, tiket service yang belum ada di commit, dan tiket di luar scope yang akan terbawa. Judul mengikuti format tim `[{TARGET}] - {RELEASE}` (mis. `[MASTER] - Cashin Toko`), bisa diganti per rilis lewat `mrTitleTemplate` (placeholder `{TARGET}` `{RELEASE}` `{VERSION}` `{SERVICE}` `{CODENAME}`, kolom "Judul MR" di header rilis). Judul dan deskripsi (tiket, checklist server, commit) tetap bisa diedit sebelum dibuat.
- **Buat MR**: lewat API, butuh token scope `api` (dicek dari `/personal_access_tokens/self`), selalu dikonfirmasi, audit `gitlab.mr.create`. MR terbuka untuk branch yang sama ditautkan, bukan dibuat dua kali.
- **Buka form di GitLab**: form "new merge request" GitLab yang sudah terisi; tidak butuh scope tulis.
- **Branch sumber per service**: `ReleaseService.sourceBranch` (kosong = default rilis). Branch yang dipakai saat membuat MR atau branch rilis diingat per service.

### Branch rilis (staging kotor)

[`src/lib/release/branch.ts`](../../../src/lib/release/branch.ts) `planReleaseBranch`: jalur first-parent branch sumber (dari `parent_ids` GitLab compare), lama ke baru. Merge commit dinilai bersama commit yang dibawanya (dari parent kedua, tanpa menyeberang jalur utama), jadi satu pilihan = satu fitur utuh. Default terpilih hanya yang semua key-nya di scope (termasuk `accepted`); `out-of-scope`, `mixed`, dan `no-key` tidak terpilih tapi bisa dicentang.
- Nama branch default `releaseBranchName`: `release/<codename>[-<versi>]`, else `release/<versi>`, else `release/<nama rilis>`; tidak pernah tanggal rilis (tanggal bisa berubah).
- **Salin perintah git**: `git checkout -b release/<nama> origin/<target>` + `git cherry-pick [-m 1] <sha>` berurutan + push.
- **Buat branch & cherry-pick di GitLab** (`POST /releases/mr/branch`): `createBranch` dari target lalu `cherryPick` satu per satu; berhenti di kegagalan pertama (biasanya konflik) dan melaporkan commit-nya; audit `gitlab.branch.create`. Service lalu memakai branch itu sebagai sumber.

## 🧾 Cakupan tiket ([`src/lib/release/coverage.ts`](../../../src/lib/release/coverage.ts))

- Tiket dari TAD, codename (dicari longgar `summary ~ "CODE"` lalu dicocokkan persis di tag judul mana pun: `[TYPE][SERVICE][CODENAME] - Nama` maupun pola mobile `[IOS][CODENAME][UI] Nama`), dan tiket tambahan.
- Service tiket: tag sebelum codename; untuk pola mobile, platformnya (ANDROID, IOS). Nama service dianggap sama hanya bila persis sama (tanpa beda huruf/tanda baca) atau beda kata generik (`-service`, `-api`, …): `core-tcico` ≠ `core-tcico-ultimate`. Pemetaan ke folder repo (`matchRepo`) memakai aturan yang sama; nama platform boleh cocok ke folder yang memuatnya.
- Tiket "di MR" bila key-nya muncul di commit, judul, branch, atau deskripsi MR rilis.
- `devDone` memakai aturan status laporan progres (`jiraDevStage`).
- Service yang disentuh tiket tapi tidak punya MR hidup ke branch target, dan judul tiket di luar format, dilaporkan.

## 🗂️ Format dokumen Deployment ([`src/lib/release/deployment.ts`](../../../src/lib/release/deployment.ts))

Dokumen rilis mengikuti halaman Deployment tim di Confluence, dua arah:
- **Baca** (`parseDeploymentStorage`, dari storage XHTML): tabel info (Target Release dengan `<time>` + jam, Actual Release, Deployment Status/Impact dari macro status, peran seperti Supervisor/Tech Lead/QA/Cloud Platform Team/Product Lead sebagai mention atau nama, Deployment Room, Issue/Request Link), Change Log, Deployment List (urutan dari panel info, lalu tabel per service: Pre-deploy berupa checklist + blok kode env/SQL, Commit id, Post-deploy, Failover Strategy, Updated by), Release List (JQL), dan link bukti Post Deployment Test. Mengembalikan `null` bila halaman bukan format ini (lalu pembaca Markdown generik dipakai).
- **Tulis** (`deploymentStorage`): struktur yang sama, termasuk checklist Confluence (`ac:task`), macro status, code macro, mention, info panel urutan deploy, page-signatures, dan tabel Post Deployment issues. Pre-deploy disusun dari blok `.env` service (nilai dari dokumen yang diimport tetap utuh, env baru dari cek MR ditambah sebagai `KEY=`), migrasi, query, dan catatan pre-deploy. Commit id: isian manual/import, else commit merge MR (atau head MR). Status mengikuti status rilis kecuali diubah. Judul halaman `Deployment <tanggal>`.
- Data tambahan: `Release.deploy` (DeployInfo) dan per service `commitId`, `envBlock`, `preDeploy`, `postDeploy`, `failover`, `updatedBy`. Diedit di tab Dokumen (form Info dokumen Deployment, pencarian akun Confluence untuk mention) dan "Detail deployment" per service di Papan.
- Pembacaan dan penulisan saling cocok (round-trip diuji), jadi import halaman lama lalu publish ulang tidak menghilangkan isi.

## 📄 Import dokumen ([`src/lib/release/import.ts`](../../../src/lib/release/import.ts))

Tanpa template tetap: link MR dan Jira key di mana saja, versi/tanggal di awal dokumen (termasuk "20 Oktober 2026"), tabel service dari judul kolom (Service/Repo/Aplikasi/Project/Modul + PIC + No), env (`KEY=` atau nama UPPER_SNAKE di bagian Env/Konfigurasi), blok SQL, langkah dari bagian Deploy/Langkah/Runbook, dan Rollback. `mergeReleaseDoc` hanya menambah; tanda selesai tetap. Halaman Confluence dikonversi di UI (`storageToMarkdown`) lalu dikirim ke `POST /releases/import`.

## 💬 Pesan Teams ([`src/lib/release/share.ts`](../../../src/lib/release/share.ts))

HTML dibangun dari data dengan semua nilai di-escape; hanya `p`, `b`, `a` (http/https), `ul`, `li`, `br`. `teamsSession.sendMessage(..., { html })` dipakai hanya untuk HTML buatan connector. Reviewer ditulis tebal (bukan mention Teams).

---

## 📂 Peta File

| File | Peran |
|---|---|
| [`src/releases/ReleasesView.svelte`](../../../src/releases/ReleasesView.svelte) | Halaman Rilis: daftar, header & cakupan, Papan, Checklist, Tiket, Dokumen; autosave (flush sebelum aksi server) |
| [`src/releases/ReleaseImportDialog.svelte`](../../../src/releases/ReleaseImportDialog.svelte) | Import dari Confluence / file .md / teks, dengan ringkasan yang terbaca |
| [`src/releases/ShareMrModal.svelte`](../../../src/releases/ShareMrModal.svelte) | Share MR ke grup/channel Teams |
| [`src/releases/PublishReleaseModal.svelte`](../../../src/releases/PublishReleaseModal.svelte) | Publish/perbarui dokumen rilis di Confluence |
| [`src/lib/release/`](../../../src/lib/release/) | Tipe, cek MR, cakupan, import, pesan share, dokumen Markdown, client |
| [`connector/releases/store.ts`](../../../connector/releases/store.ts) | `~/.tech-lead-cockpit/releases/<id>.json` (0600), validasi |
| [`connector/releases/manager.ts`](../../../connector/releases/manager.ts) | Tiket, discover, check (laporan di `releases/reports/`), import, share |
| [`connector/releases/repos.ts`](../../../connector/releases/repos.ts) | `git remote get-url origin` per repo di folder Services → path project GitLab |
| [`connector/gitlab.ts`](../../../connector/gitlab.ts) | `mrsToBranch`, `compare` (dengan `parentIds`), `branchExists`, `openMrFor`, `tokenScopes`; tulis (scope `api`, setelah konfirmasi): `createMr`, `createBranch`, `cherryPick` |
| [`src/releases/CreateMrModal.svelte`](../../../src/releases/CreateMrModal.svelte) | Buat MR per service: perbandingan, temuan, scope, judul/deskripsi, API atau form GitLab |
| [`src/lib/release/mr.ts`](../../../src/lib/release/mr.ts) | Judul, deskripsi, dan URL form MR GitLab |

Route: `GET /releases`, `GET /releases/one`, `GET /releases/report`, `GET /releases/codenames`, `POST /releases`, `POST /releases/delete`, `POST /releases/discover`, `POST /releases/check`, `POST /releases/import`, `POST /releases/mr/plan`, `POST /releases/mr/create`, `POST /releases/mr/branch`, `POST /releases/share/preview`, `POST /releases/share`.

## 🔒 Batas

- Jira hanya dibaca. Tulis ke luar hanya setelah konfirmasi: pesan Teams, membuat MR / branch rilis / cherry-pick di GitLab (token scope `api`), dan publish Confluence lewat route publish yang sudah ada.
- Belum ada: mention Teams sungguhan (butuh ID akun Microsoft), thread checklist otomatis di MR GitLab (butuh token scope `api`), dan job CI `release-check` di repo service.

## 🛠️ Test

```bash
npm test src/lib/release/release.test.ts
npm test connector/releases/releases.test.ts
```
