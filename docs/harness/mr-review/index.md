# Harness: GitLab MR Review & Jira Automation

Modul ini mendokumentasikan fitur **GitLab MR Review**: antarmuka code review desktop-first, ekstraksi diff & changed files dari GitLab internal via VPN laptop, deteksi perubahan-ke-task (Change-to-Task Detection) dengan bukti (*evidence*), integrasi tiket Jira berdampingan, evaluasi kepatuhan terhadap TAD (TAD Conformance), serta rekomendasi transisi status Jira.

---

## 🎯 Ringkasan & Alur Kerja Fitur

Workflow MR Review berfokus pada efisiensi Tech Lead dalam meninjau Merge Request tanpa memindahkan kode ke server cloud publik:

```mermaid
sequenceDiagram
    autonumber
    actor TL as Tech Lead
    participant UI as Svelte UI (MrReviewView)
    participant Conn as Connector (/api/connector/gitlab)
    participant GL as Internal GitLab API (over VPN)
    participant Jira as Jira Software
    participant AI as AI Reviewer Engine

    TL->>UI: 1. Buka MR (Paste URL / Pilih dari Inbox MR)
    UI->>Conn: GET /gitlab/mr?url=...
    Conn->>GL: Ambil metadata MR, commits, changed files, diffs, pipeline
    GL-->>Conn: Return data MR lengkap
    Conn-->>UI: Display overview, diff files, pipeline status

    par Ekstraksi Jira Context
        UI->>UI: Ekstrak Jira issue keys dari branch/title/commit
        UI->>Conn: GET /jira/issues/by-keys
        Conn->>Jira: Ambil detail issue & Acceptance Criteria
        Jira-->>UI: Tampilkan di JiraPanel
    and Evaluasi TAD Conformance
        UI->>UI: Bandingkan changed files & symbols dengan TAD aktif
        UI-->>UI: Tampilkan status kesesuaian arsitektur di TadConformance
    end

    TL->>UI: 2. Jalankan Analisa AI Review
    UI->>Conn: POST /ai/gitlab/review (diff, strictness, criteria)
    Conn->>AI: Kirim potongan diff ter-sanitasi & instruksi review
    AI-->>Conn: Stream review checklist, potential bugs, task hypothesis
    Conn-->>UI: Tampilkan hasil review & Verdict (Approve / Request Changes)

    TL->>UI: 3. Konfirmasi Transisi Jira (Opsional)
    UI->>Conn: POST /jira/transition (issueKey, targetTransition)
    Conn->>Jira: Eksekusi perubahan status Jira issue
    Jira-->>UI: Sukses transisi status
```

---

## 📂 Peta File Source Code (MR Review Module)

### Frontend (`src/mr/` & `src/lib/gitlab/`)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`src/mr/MrReviewView.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/mr/MrReviewView.svelte) | Main MR Review View | Komponen utama tampilan MR: tab navigasi (Overview, Files, Commits, AI Review, TAD Conformance), filter pencarian MR, recent MR list, dan kontrol diff. |
| [`src/mr/DiffFile.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/mr/DiffFile.svelte) | File Diff Viewer | Merender diff kode per file (tambah, hapus, modifikasi) dengan sintaks line-numbering, fold/unfold hunks, dan visual highlight. |
| [`src/mr/JiraPanel.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/mr/JiraPanel.svelte) | Jira Context Sidebar | Menampilkan tiket Jira yang terdeteksi dari branch atau judul MR: status tiket, assignee, deskripsi, dan Acceptance Criteria untuk perbandingan langsung dengan kode. |
| [`src/mr/TadConformance.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/mr/TadConformance.svelte) | Pemeriksa Kepatuhan TAD | Memvalidasi apakah file yang diubah pada MR sesuai dengan batasan scope yang telah ditetapkan pada dokumen TAD terkait. |
| [`src/lib/gitlab/client.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/gitlab/client.ts) | GitLab Frontend Client | Wrapper komunikasi fetch dari browser ke backend Connector `/api/connector/gitlab/*`. |
| [`src/lib/gitlab/types.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/gitlab/types.ts) | Tipe Data & Kontrak | Definisi TypeScript untuk `MrDetail`, `MrSummary`, `DiffFile`, `PipelineStatus`, `ReviewStrictness`, dan builder prompt review AI. |
| [`src/mr/BackgroundReviewCard.svelte`](../../../src/mr/BackgroundReviewCard.svelte) | Status Review Background | Kartu status review background terakhir untuk MR/task TAD: status, model, progres, error, peringatan bila diff sudah berubah (head SHA beda), tombol Batalkan dan tautan ke Agent Tasks. |
| [`src/lib/review/types.ts`](../../../src/lib/review/types.ts) · [`client.ts`](../../../src/lib/review/client.ts) | Kontrak Review Background | `ReviewJob`, `StartReviewRequest`, `sameReviewScope()`, dan client `/api/connector/reviews`. |

### Backend Connector (`connector/`)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/gitlab.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/gitlab.ts) | GitLab API Client | Client REST API GitLab v4: fetching MR list, parsing URL proyek, pagination diff, deteksi Jira issue key regex, dan penanganan timeout/retry. |
| [`connector/gitlab-manual.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/gitlab-manual.ts) | Manual MR Store | Penyimpanan mapping manual antara Jira key dan MR URL ketika auto-detection regex gagal mendeteksi issue key. |
| [`connector/git-review.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/git-review.ts) | Git Repo Resolver | Helper untuk menyelesaikan path repositori lokal di disk pengguna guna membaca konteks branch atau git history. |
| [`connector/review/manager.ts`](../../../connector/review/manager.ts) | Review Background | `ReviewManager`: menjalankan review MR / cek TAD di background lewat `startProviderRun` mode teks (prompt sistem `code-review` + strictness, sama dengan review inline; timeout 15 menit), simpan job di `~/.tech-lead-cockpit/reviews/<id>.json`, batas 4 review berjalan, tolak review ganda untuk MR+scope yang sama, bisa dibatalkan, job yang tertinggal saat restart ditutup sebagai gagal. |
| [`connector/review/agent-sync.ts`](../../../connector/review/agent-sync.ts) | Sinkronisasi Agent Tasks | `syncReviewJob()`: satu Agent Task kind `review` (runner `local`) per job, link `reviewId`/`mrUrl`/`jiraKey` (+`draftId`/`taskTitle` untuk cek TAD); ringkasan task = isi bagian Kesimpulan. |
| [`connector/jira-transition.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/jira-transition.ts) | Guarded Jira Transition | Mesin transisi Jira dengan validasi prasyarat (verifikasi `head_sha` MR, pemeriksaan status saat ini, pencocokan nama transisi aktual dari metadata Jira). |

---

## 🔍 Change-to-Task & Risk Detection

Algoritma review dan analisis perubahan menerapkan prinsip kehati-hatian (*safety-first*):

### Deteksi Area Berisiko Tinggi (High Risk Flags)
MR otomatis diberi tanda peringatan jika perubahannya menyentuh:
- **Autentikasi & Otorisasi**: File yang berkaitan dengan JWT, session, middleware auth, permissions, atau hashing.
- **Database & Migrasi**: Perubahan file skema SQL, migration scripts, atau query DDL.
- **Pembayaran & Finansial**: Service payment gateway, transaksi, ledgers, kalkulasi diskon.
- **Konfigurasi & Secret**: File konfigurasi runtime, docker-compose, atau template environment.
- **API Contract**: Route, proto files, OpenAPI specs, GraphQL schemas yang berpotensi menyebabkan *breaking changes*.
- **Ukuran Diff Ekstrem**: Perubahan lebih dari 500 baris atau menyentuh lebih dari 20 file.
- **Ketiadaan Test**: Perubahan pada kode produksi tanpa disertai penambahan/modifikasi unit test atau integration test.

### Review di Background (Agent Tasks)
Selain review inline (streaming `/ai/assistant/chat`, berhenti bila halaman ditinggalkan), tab **Review AI** dan **Kesesuaian TAD** punya tombol **Jalankan di background**:

1. Halaman mengirim data yang sudah dimuat (metadata MR, diff ter-batas, instruksi dari `buildMrReviewPrompt()` / `conformancePrompt()`, pilihan AI dari AiPicker) ke `POST /api/connector/reviews` → `202` + job `running`.
2. Connector menjalankan AI tanpa terikat halaman; progres dan event (maks 200) tersimpan di job dan dicerminkan ke Agent Tasks (kind `review`).
3. Saat MR dibuka lagi, halaman memanggil `GET /reviews?mrUrl=…` dan menampilkan kartu status; hasil yang selesai ditampilkan di tab (kecuali review inline yang lebih baru), dan dipakai untuk saran transisi Jira.
4. Di Agent Tasks: *Lihat hasil review*, *Buka di MR Review*, *Batalkan*, dan *Log progress* (`GET /agent-tasks/:id` mengembalikan `review` + `events`). Revisi/steer tidak tersedia; review diulang dari halaman MR.

Route: `GET /reviews[?mrUrl=]`, `GET /reviews/one?id=`, `POST /reviews`, `POST /reviews/cancel`. Sinkronisasi "MR merged → task selesai" mengabaikan task `review`.

### Standar Strictness AI Review
Tersedia tiga tingkatan ketelitian review ([`ReviewStrictness`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/gitlab/types.ts)):
1. **Lax**: Fokus hanya pada syntax bugs fatal, breaking contract, dan vulnerability kritikal.
2. **Standard (Default)**: Memeriksa business logic edge cases, error handling, penamaan, struktur arsitektur, dan ketersediaan test.
3. **Strict**: Audit mendalam terhadap code style, potensi memory leak, performa query N+1, concurrency hazards, dan adherence penuh terhadap Acceptance Criteria.

---

## 🛠️ Panduan Development & Debugging

### Menguji GitLab Client Tanpa Jaringan Nyata
Gunakan fixture JSON untuk mensimulasikan respons GitLab di unit test:
```bash
npm test connector/gitlab.test.ts
```

### Menambah Parameter Review AI
1. Buka [`src/lib/gitlab/types.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/gitlab/types.ts).
2. Modifikasi fungsi `buildMrReviewPrompt()` untuk menambahkan instruksi atau konteks domain baru.
3. Pastikan token batas diff (`MAX_AI_DIFF` = 150.000 karakter) tidak terlampaui agar tidak memicu truncation pada model LLM.
