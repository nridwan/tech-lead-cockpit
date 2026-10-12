# Harness: External Integrations & AI Providers

Modul ini mendokumentasikan seluruh adapter integrasi eksternal di **Tech Lead Cockpit**: Atlassian Jira, Confluence, GitLab, Figma, Microsoft Teams, AI Provider Drivers (Claude CLI, Antigravity CLI, InferHub, 9Router), dan macOS Keychain adapter.

---

## 🎯 Ringkasan & Arsitektur Provider

Semua integrasi eksternal dijalankan secara lokal melalui proses Connector. Kredensial rahasia (token) dibaca secara dinamis dari **macOS Keychain** sesaat sebelum panggilan HTTP dilakukan, sehingga browser/UI tidak pernah memegang token mentah:

```mermaid
graph TD
    subgraph "Local Connector Hub"
        KC["macOS Keychain (/usr/bin/security)<br/>• Read dynamically per call<br/>• Zero memory caching<br/>• No token in localStorage"]
        
        ClientJira["Jira Client (jira.ts)<br/>• Basic Auth (Cloud) / Bearer (DC)"]
        ClientConf["Confluence Client (confluence.ts)<br/>• REST v1 / v2<br/>• Conflict 409 guard"]
        ClientGitLab["GitLab Client (gitlab.ts)<br/>• Private-Token API v4"]
        ClientTeams["Teams Client (session.ts)<br/>• MS Graph API token"]
        AIProviders["AI Providers Manager (ai-providers.ts)<br/>• ChildProcess Spawner<br/>• Stream parsers"]
    end

    KC --> ClientJira
    KC --> ClientConf
    KC --> ClientGitLab
    KC --> ClientTeams
    KC --> AIProviders

    ClientJira --> RemoteJira["Jira Software (Cloud / Data Center)"]
    ClientConf --> RemoteConf["Confluence (Cloud / Data Center)"]
    ClientGitLab --> RemoteGitLab["GitLab Enterprise (Internal VPN)"]
    ClientTeams --> RemoteTeams["Microsoft Graph API"]
    AIProviders --> ClaudeBinary["Claude CLI (claude -p)"]
    AIProviders --> AgyBinary["Antigravity CLI (agy -p)"]
    AIProviders --> InferHubAPI["InferHub API Relay"]
    AIProviders --> NineRouterAPI["9Router API"]
```

---

## 📂 Peta File Source Code (Integrations Module)

### Integrasi Atlassian (Jira & Confluence)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/jira.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/jira.ts) | Jira API Client | Mendukung Jira Cloud (Basic Auth + email + API token) dan Jira Data Center (Personal Access Token). Mengambil detail issue, status, transitions, pencarian via JQL, dan pembuatan batch tiket. |
| [`connector/confluence.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/confluence.ts) | Confluence API Client | Mendukung Confluence Cloud dan Server/DC. Fetch halaman, pencarian space, pembuatan halaman baru, pembaruan konten, upload attachment diagram PNG, dan proteksi konflik versi (HTTP 409). |
| [`src/lib/jira/client.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/jira/client.ts) | Jira Frontend Bridge | Client komunikasi UI ke endpoint `/api/connector/jira/*`. |
| [`src/lib/confluence/client.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/confluence/client.ts) | Confluence Frontend Bridge | Client komunikasi UI ke endpoint `/api/connector/confluence/*`. |

### Integrasi GitLab & Microsoft Teams
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/gitlab.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/gitlab.ts) | GitLab API Client | Client REST API v4 GitLab: MR list, MR detail, commits, changed files, pipeline status, dan pembuatan review discussion. |
| [`connector/teams/session.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/teams/session.ts) | MS Teams Session Manager | Mengelola autentikasi Microsoft Graph API, pembacaan user profile, dan sinkronisasi Teams channels. |
| [`src/lib/teams/client.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/teams/client.ts) | Teams Frontend Bridge | Client komunikasi UI ke endpoint `/api/connector/teams/*`. |

### Integrasi Figma (REST API, read-only)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/figma.ts`](../../../connector/figma.ts) | Figma Client & Manager | `parseFigmaUrl` (link file/design/proto/board, branch, `node-id` 1-2 atau 1:2), `FigmaClient` (header `X-Figma-Token`, retry sekali pada 429 sesuai `Retry-After`, pesan error 401/403/404 yang jelas), deteksi layar (`screenChoices`), ekstraksi teks urut baca (`extractTexts`), render PNG dengan skala sisi panjang ~1568px, dan penulisan hasil ke `workspaces/<draftId>/figma/<fileKey>_<node>/`. |
| [`src/lib/figma/client.ts`](../../../src/lib/figma/client.ts) | Figma Frontend Bridge | Client UI ke `/api/connector/figma/*`; thumbnail diambil sebagai blob karena endpoint gambar tetap butuh header `X-TLC-Client`. |
| [`src/lib/figma/types.ts`](../../../src/lib/figma/types.ts) | Kontrak Data | `FigmaStatus`, `FigmaScreenList`, `FigmaFetchedSet` (manifest per set, termasuk flag `stale`). |

Endpoint connector (semua hanya membaca Figma, tidak ada write ke Figma):

| Route | Fungsi |
|---|---|
| `GET /figma/status` | Status token di Keychain dan akun Figma (`/v1/me`). |
| `POST /figma/save-token` | Memvalidasi token ke Figma dulu, baru menyimpannya ke Keychain `tech-lead-cockpit.figma`. |
| `GET /figma/screens?url=` | Daftar layar di link (section/page/group dibuka; frame berisi ≥2 frame ≥320px dianggap kumpulan layar) beserta pilihan awal. |
| `POST /figma/fetch` | `{ draftId, url, screenIds, title? }`, maksimal 30 layar: render PNG, unduh, tulis `index.md` (teks tiap layar) dan `manifest.json`. Fetch ulang link yang sama mengganti set lama. |
| `GET /figma/fetched?draftId=&check=1` | Set yang sudah diambil; `check=1` membandingkan versi file Figma dan menandai `stale`. |
| `POST /figma/fetched/delete` | Menghapus satu set dari workspace. |
| `GET /figma/image?draftId=&set=&name=` | Menyajikan PNG untuk thumbnail (nama file divalidasi, tanpa path traversal). |

Token dibuat di Figma → Settings → Security → Personal access tokens dengan scope **File content: Read-only**, lalu disimpan lewat Setup wizard (langkah Figma) atau kartu Figma di halaman Koneksi.

### AI Inference Providers & Keychain
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/ai-providers.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/ai-providers.ts) | AI Drivers Manager | Mendeteksi binary `claude` dan `agy` di sistem, memvalidasi versi CLI, membaca daftar model, memicu child process streaming NDJSON, dan mengelola pembatalan (*cancel*). |
| [`connector/inferhub.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/inferhub.ts) | InferHub Driver | Menghubungkan Cockpit ke gateway InferHub (streaming model frontier seperti Claude 3.7 Sonnet, GPT-4o, DeepSeek, dsb.). |
| [`connector/ninerouter.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/ninerouter.ts) | 9Router Driver | Integrasi ke model gateway 9Router dengan streaming protokol seragam. |
| [`connector/keychain.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/keychain.ts) | macOS Keychain Adapter | Fungsi `readKeychain()`, `writeKeychain()`, dan `deleteKeychain()` yang membungkus CLI `/usr/bin/security`. |

---

## 🔑 Manajemen Token & Skrip Bantuan

Penyimpanan token ke Keychain dapat dilakukan langsung dari menu **Koneksi** di antarmuka aplikasi atau melalui skrip terminal:

```bash
npm run token:confluence  # Simpan token Confluence ke Keychain
npm run token:jira        # Simpan token Jira ke Keychain
npm run token:gitlab      # Simpan token GitLab ke Keychain
npm run token:inferhub    # Simpan API key InferHub ke Keychain
npm run token:9router     # Simpan API key 9Router ke Keychain
```

> [!WARNING]
> Jangan pernah menulis token API langsung ke dalam file kode atau meng-commit file `.env`! Semua token wajib masuk ke OS Keychain.

---

## 🛠️ Panduan Development & Debugging

### Menjalankan Test Integrasi Provider
```bash
npm test connector/jira.test.ts
npm test connector/confluence.test.ts
npm test connector/gitlab.test.ts
npm test connector/ai-providers.test.ts
npm test connector/inferhub.test.ts
npm test connector/ninerouter.test.ts
```

> [!NOTE]
> Setelah melakukan perubahan pada modul Integrasi, pastikan Anda memperbarui dokumen ini jika terdapat penambahan provider baru, perubahan header autentikasi, atau skema keychain!
