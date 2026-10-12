# Harness: Release Management

Modul **Rilis** mengelola satu rilis lintas service: MR ke branch produksi (default `master`) per service, apa yang dibawa tiap MR ke server (env, migrasi, query manual), tiket yang tercakup (dari TAD, codename, atau dokumen), runbook deploy dan rollback, dokumen rilis (import dari Confluence/Markdown, publish ke Confluence), dan permintaan review MR ke grup Teams.

---

## 🎯 Alur Kerja

1. **Buat rilis** di menu Rilis (`#/releases`). Isi versi, tanggal, branch target, approval minimal.
2. **Tentukan cakupan**: pilih proyek Cockpit (task TAD + Jira key-nya), codename (tiket `[TYPE][SERVICE][CODENAME] - Nama` ikut walau tidak ada di TAD; codename dari judul task TAD ikut otomatis), atau tiket tambahan. Bisa juga dengan **Import dokumen**.
3. **Cari service & MR** (AI, di background; `POST /releases/ai/start` kind `discover`): AI memilih service (repo) dan MR ke target dari tiket, daftar repo, dan kandidat MR. Hanya menambah; service yang pernah dihapus tidak ditambah lagi.
   **Jalankan cek** (AI, di background; kind `tickets`): membaca seluruh diff tiap service yang sudah ada di rilis dan menilai tiket, kebutuhan deploy, risiko, dan perubahan di luar scope. Hasilnya mengisi dokumen deploy (hanya service yang punya MR) dan laporan. Lihat **🤖 Cek dengan AI**.
4. **Share MR ke Teams** (`POST /releases/share`): pilih MR, grup/channel, tenggat, reviewer (dari Daftar Tim), catatan; pratinjau lalu kirim setelah konfirmasi. Tercatat di audit log (`teams.send`).
5. **Dokumen deploy**: env, query/migrasi, dan langkah pre/post-deploy per service ada di dokumen (tidak ada tab checklist terpisah); diisi oleh AI (Jalankan cek) dan diubah lewat prompt **Perbaiki dengan AI** di tab Dokumen (tidak ada form manual per service).
6. **Publish ke Confluence**: dokumen dari tab Dokumen dipublish lewat route publish yang sudah ada (cek versi 409 untuk update).

---

## 🤖 Cek dengan AI ([`src/lib/release/ai.ts`](../../../src/lib/release/ai.ts), `ReleaseManager.ai*`)

Semua pengecekan rilis lewat AI (provider dari pemilih AI, default dari setup wizard; mode teks tanpa tool, diff ada di prompt). Job berjalan di connector di background (`POST /releases/ai/start`, `GET /releases/ai/job`, `POST /releases/ai/cancel`), hasil terakhir per jenis disimpan di `releases/reports/<id>.ai-<kind>[-<serviceId>].json`. UI memantau lewat `AiJobWatch` ([`src/lib/release/ai-job.svelte.ts`](../../../src/lib/release/ai-job.svelte.ts)). Jawaban AI wajib JSON; yang di luar skema (tiket bukan scope, file yang tidak berubah, sha tak dikenal, service bukan milik rilis) dibuang.

| Jenis | Pemicu | Isi |
|---|---|---|
| `discover` | tombol **Cari service & MR** (header rilis) | `aiDiscover`: AI memilih service (repo dari folder Services) dan MR ke target dari tiket, repo, dan kandidat MR; hanya menambah; service yang pernah dihapus (`Release.ignoredServices`) tidak pernah ditambah lagi; repo di luar folder Services dan MR bukan kandidat dibuang; gagal → pencarian biasa. |
| `tickets` | tombol **Jalankan cek** (header rilis) | 1) `readCode` + cek pola per MR. 2) Per service AI membaca diff (maks ±180 KB, sisanya nama file) + tiket + Detail Task TAD: verdict `ada`/`sebagian`/`tidak` per tiket dengan file bukti, perubahan tanpa tiket (termasuk endpoint/route tanpa task), dan kebutuhan deploy (`env`, `sql` termasuk CREATE/ALTER/INSERT yang disusun dari model, `migration`, `other`; masing-masing `pre`/`post`). |
| `mr` | otomatis saat jendela **Buat MR** memuat rencana | Sama seperti di atas untuk compare branch sumber → target satu service; hasil tampil di jendela dan ditambahkan ke deskripsi MR (`aiMrSection`) selama deskripsi belum diedit. |
| `picks` | **Pilih dengan AI** di branch rilis (Buat MR) | AI membaca diff tiap commit jalur first-parent (compare parent pertama → commit; merge = seluruh fitur, maks 40 commit) dan memilih commit scope dengan alasan, juga commit tanpa Jira key (dinilai dari diff); instruksi opsional dari Tech Lead (mis. "perubahan CI tetap ikut") diutamakan; commit campuran tidak dipilih; catatan urutan/konflik. |
| `patch` | **Susun perubahan dengan AI** di bagian "Ambil perubahan tertentu saja (per hunk)" (Buat MR) | Untuk commit campuran atau perubahan tanpa tiket yang diminta instruksi. Tiap file yang berubah target → sumber dibaca utuh (`rawFile`) dan dipecah jadi hunk ([`patch.ts`](../../../src/lib/release/patch.ts) `fileHunks`: dibandingkan tanpa spasi dan tanpa koma akhir, blok yang ditambah berdampingan dipecah per blok). AI memilih hunk scope + instruksi (instruksi **wajib** dijalankan); route yang disebut instruksi dilaporkan ada di hunk / sudah ada di target / tidak ada (`locateRoutes`). **Lihat hasil** (`POST /releases/patch/preview`) menerapkan tanpa menulis: diff hasil vs target, ringkasan data JSON (`jsonChanges`), dan validasi JSON termasuk key ganda (`jsonProblem`). **Buat branch dari perubahan pilihan** (`POST /releases/patch/branch`, konfirmasi, audit `gitlab.branch.create`): satu commit lewat GitLab `repository/commits` dengan `start_branch` = target (`commitFiles`); JSON tidak valid ditolak kecuali dipaksa; service lalu memakai branch itu. |
| `document` | **Perbaiki dengan AI** di tab Dokumen | Instruksi Tech Lead + isi dokumen per service + temuan kode (diff .env/config, env dibaca kode, migrasi, query) → usulan `envBlock`/pre/post-deploy/failover per service; diterapkan hanya setelah klik **Terapkan**. |

Diff untuk AI ([`ai.ts`](../../../src/lib/release/ai.ts) `diffText`): file besar dipadatkan (`compactDiff`: tanpa baris konteks, tanpa baris yang hanya pindah/berubah spasi, jadi reformat massal tinggal perubahan nyata), hunk yang memuat path dari endpoint tiket, Detail Task, atau instruksi (`focusTerms`) didahulukan. Diff yang dikosongkan GitLab karena terlalu besar dihitung dari isi file lama/baru (`rawFile` + `fileDelta`, maks 12 file per sumber, file biner/lock dilewati).

Aturan hasil:
- **Service tiket ditentukan Jira**: dari judul tiket di Jira (`[TYPE][SERVICE][CODENAME]`, atau platform untuk pola mobile); service baris TAD hanya cadangan bila judul tidak menyebut service, dan ikut dicek bila berbeda (`alsoService`, `belongsTo`). Tiket `[FRONTEND][X]` (juga FE/WEB/CMS) milik repo front-end X (`x-frontend`, `x-fe`, `x-web`); bila repo front-end itu ada di rilis, repo back-end X **bukan** service tiket tersebut (back-end X masuk scope hanya lewat tiket back-end). Discover (biasa dan AI) memakai aturan yang sama. Aturan ini dipakai Papan ("service di luar scope", juga untuk laporan lama lewat judul tiket), discover, cek, Buat MR, dan pemilihan commit/hunk.
- **Dokumen hanya dari MR rilis.** Service tanpa MR hidup ke target tetap dicek (tiket, risiko, perubahan tanpa tiket dari compare branch), tapi kebutuhan deploy-nya hanya pratinjau (`CodeSource.aiPending`, "masuk dokumen setelah MR dibuat"); query AI lamanya dibuang. Dokumen menulis "Menunggu MR ke <target>" untuk service itu tanpa .env/query/langkah (`hasReleaseMr`), dan **Perbaiki dengan AI** hanya untuk service yang punya MR.
- Tiap cek AI mengganti hasil AI sebelumnya untuk service yang dibaca (query `source: 'ai'`, Pre/Post-deploy), tidak menumpuk.
- Temuan review (secret di repo, bug, risiko, keputusan, perubahan kontrak) dipisah ke `risks` (`CodeSource.aiRisks`, `ReleaseAiJob.risks`), bukan langkah deploy.
- Verdict AI menentukan status tiket (`TicketCoverage.ai`): `ada` = di kode; `sebagian` = perlu dicek; `tidak` = hilang, kecuali pola menemukannya (berbeda pendapat → perlu dicek).
- Kebutuhan deploy langsung masuk dokumen: env → blok `.env` service (`KEY=`, nilai yang ada dipertahankan, `foldEnvItems`); query/migrasi → item `source: 'ai'` (SQL di `detail`, tampil di Pre-deploy; diubah lewat Perbaiki dengan AI, `queries` mengganti seluruh daftar query service); langkah lain → `preDeploy`/`postDeploy`.
- `POST /releases/check` dan `/releases/discover` (tanpa AI) tetap ada untuk API/test; UI hanya memakai cek AI.

---

## 🔍 Cek per MR ([`src/lib/release/checks.ts`](../../../src/lib/release/checks.ts))

| Temuan | Cara |
|---|---|
| Env baru | Baris `+KEY=` di file `.env`, `.env.example`, `env.sample`, … (nilai yang hanya berubah tidak dihitung) |
| Env dibaca di kode | `process.env.X`, `os.Getenv("X")`, `os.getenv`, `env('X')`, `System.getenv`, tag `env:"X"`, `${X}` di file config; baris yang hanya pindah diabaikan |
| Migrasi | File di folder migrasi (`migrations/`, `db/migrate/`, `flyway/`, `prisma/migrations/`, …) atau pola nama `V1__x.sql` / `20261012_x.sql`; migrasi lama yang diubah ditandai |
| Query manual | File `.sql` di luar folder migrasi dan folder test |
| Model tanpa migrasi | File model/entity/schema berubah tanpa migrasi di MR yang sama |
| Commit tanpa Jira key | Judul commit tanpa key (merge commit diabaikan); informasi saja, tidak lagi memblokir scope |
| Status MR | state, draft, konflik, pipeline, approval vs minimal, branch target |

Diff yang terpotong (GitLab atau batas Cockpit) ditandai supaya env dicek manual.

## 🎯 Scope vs kode

Tiket dicari di **isi kode** yang akan dirilis, bukan di pesan commit ([`src/lib/release/evidence.ts`](../../../src/lib/release/evidence.ts)). Kode per service (`ReleaseReport.sources`): diff MR hidup ke target, atau bila belum ada MR, GitLab compare `target...branch sumber service` (ref `group/repo@branch`). Tiket hanya dicari di kode service-nya sendiri (semua service bila tiket tidak menyebut service).

- **Kuat** (`strength: 'strong'`, tiket dihitung ada di kode): endpoint dari Detail Task TAD (`taskEndpoints`, juga ekor path-nya karena prefix router group) ada di baris yang ditambah, atau satu identifier/path/route memuat semua kata nama tiket (`GetDetailCashinChannel`, `get_detail_cashin_channel`, `/cashin/channel/detail`). Kata jenis pekerjaan dibuang (Develop, Enhance, API, Membuat, …), kata petunjuk opsional (get, model, scheduler, response, …), kata Indonesia diterjemahkan (kode→code, transaksi→transaction, …). Minimal dua kata; satu kata tidak bisa membedakan tiket.
- **Endpoint dibagi antar service** (`withSharedEndpoints`): satu fitur punya tiket per service (gateway "Register API X", backend "Develop API X"). Tiket tanpa endpoint TAD memakai endpoint tiket lain yang kata-katanya persis sama (minimal dua kata), jadi route di config gateway ikut terdeteksi.
- **Samar** (`weak`, `unsure`): semua kata ada di satu file tapi tersebar, hanya di file test, atau satu nama memuat semua kata kecuali satu plus kata petunjuk (mis. `/mobile/cashin/channel/{id}` untuk "Get Detail Cashin Channel Mobile"). Ditampilkan "perlu dicek" dan memblokir scope sesuai sampai dicek.
- Jira key di commit/branch tetap dibaca sebagai pendukung (`byKey`), termasuk key yang menempel `_` (`[MU-1859_MU-1860]`) dan key huruf kecil di nama branch untuk prefix proyek scope.
- Tiket yang service-nya tidak ada di rilis (mis. IOS/ANDROID) ditandai `noRepo`, diperingatkan, tidak dihitung hilang.
- File yang berubah tapi tidak terkait tiket scope mana pun (`unattributed`, tetangga folder yang namanya memuat kata tiket dianggap bagian fiturnya) ditampilkan sebagai kandidat perubahan yang ikut terbawa.

Rilis dianggap **scope sesuai** bila semua tiket scope terlihat di kode (bukti kuat atau key), tidak ada yang hanya samar, dan tidak ada tiket di luar scope yang terbawa (key di commit/branch, `codeKeys`; judul/deskripsi MR tidak dihitung).

- Tiket di kode yang bukan scope (`outOfScope`) diambil judul/statusnya dari Jira. Yang codename-nya milik rilis (lebih tua dari jangkauan pencarian codename) otomatis masuk scope.
- Aksi di tab Tiket: **Masukkan ke scope** (ke `jiraKeys`) atau **Sengaja ikut** (ke `accepted`, dengan alasan) supaya tidak terus jadi peringatan.
- Kartu status scope di atas tab; mengubah status ke Siap rilis/Dirilis saat belum sesuai meminta konfirmasi.

## 🔀 Buat MR

Per service: **Buat MR** (`POST /releases/mr/plan` lalu `/releases/mr/create`). Rencana membandingkan branch sumber (default `staging`, per rilis) dengan branch target lewat GitLab compare: commit, file, env/migrasi/query, tiket service dicek dari diff (bukti file + nama/endpoint yang cocok), file tanpa tiket, dan tiket di luar scope yang akan terbawa. Judul mengikuti format tim `[{TARGET}] - {RELEASE}` (mis. `[MASTER] - Cashin Toko`), bisa diganti per rilis lewat `mrTitleTemplate` (placeholder `{TARGET}` `{RELEASE}` `{VERSION}` `{SERVICE}` `{CODENAME}`, kolom "Judul MR" di header rilis). Judul dan deskripsi (tiket, checklist server, commit) tetap bisa diedit sebelum dibuat.
- **Buat MR**: lewat API, butuh token scope `api` (dicek dari `/personal_access_tokens/self`), selalu dikonfirmasi, audit `gitlab.mr.create`. MR terbuka untuk branch yang sama ditautkan, bukan dibuat dua kali.
- **Buka form di GitLab**: form "new merge request" GitLab yang sudah terisi; tidak butuh scope tulis.
- **Review perubahan**: di jendela Buat MR, daftar file yang berubah (dengan diff, total maks. ±1,5 MB) bisa disaring dan dibuka per file sebelum MR dibuat. Di Papan, tombol **Review** per MR membuka MR itu di MR Review (diff, review AI termasuk di background, kesesuaian TAD) lewat `OPEN_MR_KEY`.
- **Branch sumber per service**: `ReleaseService.sourceBranch` (kosong = default rilis). Branch yang dipakai saat membuat MR atau branch rilis diingat per service.

### Branch rilis (staging kotor)

[`src/lib/release/branch.ts`](../../../src/lib/release/branch.ts) `planReleaseBranch`: jalur first-parent branch sumber (dari `parent_ids` GitLab compare), lama ke baru. Merge commit dinilai bersama commit yang dibawanya (dari parent kedua, tanpa menyeberang jalur utama), jadi satu pilihan = satu fitur utuh. Default terpilih hanya yang semua key-nya di scope (termasuk `accepted`); `out-of-scope`, `mixed`, dan `no-key` tidak terpilih tapi bisa dicentang.
- Nama branch default `releaseBranchName`: `release/<codename>[-<versi>]`, else `release/<versi>`, else `release/<nama rilis>`; tidak pernah tanggal rilis (tanggal bisa berubah).
- **Salin perintah git**: `git checkout -b release/<nama> origin/<target>` + `git cherry-pick [-m 1] <sha>` berurutan + push.
- **Buat branch & cherry-pick di GitLab** (`POST /releases/mr/branch`): `createBranch` dari target lalu `cherryPick` satu per satu; berhenti di kegagalan pertama (biasanya konflik) dan melaporkan commit-nya; audit `gitlab.branch.create`. Service lalu memakai branch itu sebagai sumber.

## 🧾 Cakupan tiket ([`src/lib/release/coverage.ts`](../../../src/lib/release/coverage.ts))

- Tiket dari TAD, codename (dicari longgar `summary ~ "CODE"` lalu dicocokkan persis di tag judul mana pun: `[TYPE][SERVICE][CODENAME] - Nama` maupun pola mobile `[IOS][CODENAME][UI] Nama`), dan tiket tambahan.
- Service tiket: tag sebelum codename; untuk pola mobile, platformnya (ANDROID, IOS). Nama service dianggap sama hanya bila persis sama (tanpa beda huruf/tanda baca) atau beda kata generik (`-service`, `-api`, …): `core-tcico` ≠ `core-tcico-ultimate`. Pemetaan ke folder repo (`matchRepo`) memakai aturan yang sama; nama platform boleh cocok ke folder yang memuatnya.
- Tiket "di kode" dari bukti di diff (lihat Scope vs kode); key di commit/branch sebagai pendukung.
- `devDone` memakai aturan status laporan progres (`jiraDevStage`).
- Service rilis yang tidak punya MR hidup ke branch target, dan judul tiket di luar format, dilaporkan. Laporan yang disimpan disaring ke service rilis saat ini (`forCurrentServices`), jadi service yang sudah dihapus tidak muncul lagi.
- Item checklist dan langkah milik service yang tidak ada di rilis dibuang saat disimpan (store), `removeServices` mencocokkan nama service tanpa beda huruf.
- Discover hanya memakai judul dan branch MR untuk menambah service baru, bukan deskripsi MR.

## 🗂️ Format dokumen Deployment ([`src/lib/release/deployment.ts`](../../../src/lib/release/deployment.ts))

Dokumen rilis mengikuti halaman Deployment tim di Confluence, dua arah:
- **Baca** (`parseDeploymentStorage`, dari storage XHTML): tabel info (Target Release dengan `<time>` + jam, Actual Release, Deployment Status/Impact dari macro status, peran seperti Supervisor/Tech Lead/QA/Cloud Platform Team/Product Lead sebagai mention atau nama, Deployment Room, Issue/Request Link), Change Log, Deployment List (urutan dari panel info, lalu tabel per service: Pre-deploy berupa checklist + blok kode env/SQL, Commit id, Post-deploy, Failover Strategy, Updated by), Release List (JQL), dan link bukti Post Deployment Test. Mengembalikan `null` bila halaman bukan format ini (lalu pembaca Markdown generik dipakai).
- **Tulis** (`deploymentStorage`): struktur yang sama, termasuk checklist Confluence (`ac:task`), macro status, code macro, mention, info panel urutan deploy, page-signatures, dan tabel Post Deployment issues. Pre-deploy disusun dari blok `.env` service (nilai dari dokumen yang diimport tetap utuh, env baru dari cek MR ditambah sebagai `KEY=`), migrasi, query, dan catatan pre-deploy. Commit id: merge commit MR rilis yang sudah merged, else TBA (menunggu review merge ke target). Status mengikuti status rilis kecuali diubah. Judul halaman `Deployment <tanggal>`.
- Data tambahan: `Release.deploy` (DeployInfo) dan per service `commitId`, `envBlock`, `preDeploy`, `postDeploy`, `failover`, `updatedBy`. Info dokumen (peran, room, jam, impact) diedit di form Info dokumen Deployment di tab Dokumen; isi per service dibuat AI.
- Pembacaan dan penulisan saling cocok (round-trip diuji).
- **Dokumen mengikuti data rilis.** Import (`mergeReleaseDoc` + `importPreview`) tidak pernah mengganti data rilis: service di dokumen yang tidak ada di rilis tidak ditambahkan kecuali dicentang (`addServices`), Jira key dokumen tidak masuk scope kecuali dipilih (`addKeys`), dan commit id, Change Log, Release List, bukti test, status, actual, serta tanda selesai tidak diambil. Yang diambil: orang per peran, Deployment Room, jam rilis/impact (bila kosong), dan untuk service yang ada di rilis: blok `.env`, catatan pre/post-deploy, failover, updated by.
- Commit id di dokumen hanya merge commit MR rilis yang sudah merged ke target; sebelum itu TBA (head MR atau sha ketikan tidak dipakai). Change Log kosong = satu baris dari rilis (`changeLogRows`). Release List = `key in (tiket rilis)` kecuali JQL diisi.
- Membersihkan sisa import lama: Papan menandai service tanpa tiket scope dan tanpa MR (`servicesOutsideScope`, butuh hasil cek) dengan tombol hapus (beserta item checklist-nya); tab Dokumen punya **Susun ulang dari data rilis** (`resetDocumentData`).
- **Pratinjau** di tab Dokumen merender storage yang akan dipublish (`storageToPreviewHtml`: lozenge status, checklist, code block, panel, mention, emoji, tanggal; disanitasi DOMPurify) lewat `PreviewPane` TAD, jadi tampilannya sama dengan halaman Confluence.

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
| [`connector/releases/manager.ts`](../../../connector/releases/manager.ts) | Tiket, discover, check (baca kode per service, laporan di `releases/reports/`), import, share |
| [`src/lib/release/ai.ts`](../../../src/lib/release/ai.ts) | Prompt dan parser jawaban AI: discover, tiket + kebutuhan deploy, pilih commit, perbaikan dokumen |
| [`src/lib/release/ai-job.svelte.ts`](../../../src/lib/release/ai-job.svelte.ts) | Pantau job AI rilis dari UI, pilihan AI tersimpan |
| [`src/lib/release/evidence.ts`](../../../src/lib/release/evidence.ts) | Cari tiket di diff: endpoint TAD, kata nama tiket di identifier/path, file tanpa tiket |
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
