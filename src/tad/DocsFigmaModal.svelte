<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { drafts, type Draft } from './drafts.svelte';
  import FigmaScreensPanel from './FigmaScreensPanel.svelte';
  import { uploadDoc, deleteDoc, unlockDoc, withPdfPassword } from './generator-client';
  import { syncDocumentationSection } from '../lib/tad/docs-sync';
  import { api } from '../lib/api-base';

  let {
    open = $bindable(false),
    draft,
  }: {
    open: boolean;
    draft: Draft;
  } = $props();

  const MAX_FILE_MB = 20;
  const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

  let activeTab = $state<'figma' | 'docs'>('figma');
  let screensPanel = $state<ReturnType<typeof FigmaScreensPanel> | undefined>();

  // Figma links state
  let newFigmaUrl = $state('');
  let newFigmaTitle = $state('');
  let figmaError = $state('');

  // Uploading state
  let uploading = $state(false);
  let uploadError = $state('');

  const figmaLinks = $derived(draft.figmaLinks ?? (draft.source?.figmaUrl ? [{ title: 'Figma', url: draft.source.figmaUrl }] : []));
  const supportingDocs = $derived(draft.supportingDocs ?? []);

  $effect(() => {
    if (open && draft.id) {
      void fetch(api(`/api/connector/chat/docs?draftId=${encodeURIComponent(draft.id)}`), { headers: HEADERS })
        .then((res) => (res.ok ? res.json() : null))
        .then((docs) => {
          if (Array.isArray(docs)) drafts.update(draft.id, { supportingDocs: docs });
        })
        .catch(() => {});
    }
  });

  function addFigma() {
    figmaError = '';
    const url = newFigmaUrl.trim();
    if (!url) return;
    if (!/^https:\/\/([\w-]+\.)*figma\.com\//i.test(url)) {
      figmaError = 'URL harus diawali dengan https://figma.com/ atau link Figma yang valid.';
      return;
    }
    const title = newFigmaTitle.trim() || undefined;
    const existing = figmaLinks.filter((f) => f.url !== url);
    const updated = [...existing, { title, url }];
    drafts.update(draft.id, {
      figmaLinks: updated,
      source: { ...draft.source, figmaUrl: updated[0]?.url },
    });
    newFigmaUrl = '';
    newFigmaTitle = '';
    toasts.show('Link Figma ditambahkan.', 'ok', 2500);
  }

  function removeFigma(url: string) {
    const updated = figmaLinks.filter((f) => f.url !== url);
    drafts.update(draft.id, {
      figmaLinks: updated,
      source: { ...draft.source, figmaUrl: updated[0]?.url },
    });
    toasts.show('Link Figma dihapus.', 'ok', 2000);
  }

  async function handleFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;

    uploading = true;
    uploadError = '';
    const failed: string[] = [];
    let currentDocs = supportingDocs;

    for (const f of files) {
      if (f.size > MAX_FILE_MB * 1024 * 1024) {
        failed.push(`${f.name} (melebihi ${MAX_FILE_MB}MB)`);
        continue;
      }
      try {
        const uploaded = await withPdfPassword(f.name, (password) => uploadDoc(draft.id, f, password));
        if (uploaded) currentDocs = uploaded;
        else failed.push(`${f.name} (password tidak diisi)`);
      } catch (err) {
        failed.push(`${f.name} (${(err as Error).message})`);
      }
    }

    drafts.update(draft.id, { supportingDocs: currentDocs });
    uploading = false;

    if (failed.length) {
      uploadError = `Gagal upload: ${failed.join(', ')}`;
      toasts.show(uploadError, 'err', 5000);
    } else {
      toasts.show(`${files.length} dokumen partner berhasil diunggah.`, 'ok', 3000);
    }
  }

  async function unlockStoredDoc(name: string) {
    try {
      const docs = await withPdfPassword(name, (password) => unlockDoc(draft.id, name, password ?? ''));
      if (!docs) return;
      drafts.update(draft.id, { supportingDocs: docs });
      toasts.show(`${name} sudah dibuka dan siap dibaca AI.`, 'ok', 3000);
    } catch (err) {
      toasts.show(`Gagal membuka PDF: ${(err as Error).message}`, 'err');
    }
  }

  async function removeDoc(name: string) {
    const ok = await confirmDialog({
      title: 'Hapus Dokumen?',
      message: `Hapus file "${name}" dari dokumen pendukung draft ini?`,
      confirmText: 'Hapus File',
      danger: true,
    });
    if (!ok) return;

    try {
      const remaining = await deleteDoc(draft.id, name);
      drafts.update(draft.id, { supportingDocs: remaining });
      toasts.show(`File ${name} dihapus.`, 'ok', 2000);
    } catch (err) {
      toasts.show(`Gagal menghapus file: ${(err as Error).message}`, 'err');
    }
  }

  function syncToTad() {
    const updatedMarkdown = syncDocumentationSection(draft.markdown, {
      prdTitle: draft.source?.prdTitle,
      figmaLinks,
      supportingDocs,
    });
    drafts.update(draft.id, { markdown: updatedMarkdown });
    drafts.saveNow();
    toasts.show('Tabel # Documentation di dokumen TAD berhasil diperbarui.', 'ok', 3500);
  }

  function fmtBytes(bytes?: number): string {
    if (!bytes || isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<Modal bind:open title="Dokumen Partner & Link Desain Figma" subtitle="Kelola referensi desain dan spesifikasi API partner untuk TAD dan AI Generator" width={680}>
  <div class="tabs">
    <button class="tab-btn" class:active={activeTab === 'figma'} onclick={() => (activeTab = 'figma')}>
      <Icon name="link" size={14} /> Link Figma ({figmaLinks.length})
    </button>
    <button class="tab-btn" class:active={activeTab === 'docs'} onclick={() => (activeTab = 'docs')}>
      <Icon name="paperclip" size={14} /> Dokumen Partner ({supportingDocs.length})
    </button>
  </div>

  <div class="content">
    {#if activeTab === 'figma'}
      <section class="section">
        <p class="desc">
          Masukkan URL desain Figma untuk halaman atau flow yang terkait dengan TAD ini. Link ini dicatat di TAD. Klik <strong>Ambil layar</strong> supaya Cockpit mengambil screenshot dan teks tiap layar untuk dibaca AI Generator.
        </p>

        <form class="add-form" onsubmit={(e) => { e.preventDefault(); addFigma(); }}>
          <div class="form-row">
            <input
              type="url"
              class="input figma-url-input"
              placeholder="https://www.figma.com/design/..."
              bind:value={newFigmaUrl}
              required
            />
            <input
              type="text"
              class="input figma-title-input"
              placeholder="Judul (opsional, mis. Desain Mobile / Backoffice)"
              bind:value={newFigmaTitle}
            />
            <button type="submit" class="btn btn-primary add-btn" disabled={!newFigmaUrl.trim()}>
              <Icon name="plus" size={14} /> Tambah
            </button>
          </div>
          {#if figmaError}
            <span class="err small">{figmaError}</span>
          {/if}
        </form>

        <div class="list">
          {#if !figmaLinks.length}
            <div class="empty-state">
              <Icon name="link" size={24} />
              <p class="muted">Belum ada link Figma yang ditambahkan.</p>
            </div>
          {:else}
            {#each figmaLinks as f (f.url)}
              <div class="item-card">
                <div class="item-info">
                  <span class="item-title">{f.title || 'Desain Figma'}</span>
                  <a class="item-link mono" href={f.url} target="_blank" rel="noreferrer" title="Buka di Figma">
                    {f.url} <Icon name="external" size={11} />
                  </a>
                </div>
                <button
                  type="button"
                  class="btn btn-sm fetch-btn"
                  onclick={() => screensPanel?.pick(f)}
                  title="Ambil screenshot dan teks layar dari Figma untuk AI Generator"
                >
                  <Icon name="download" size={13} /> {screensPanel?.setFor(f.url) ? 'Ambil ulang' : 'Ambil layar'}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost icon-btn delete-btn"
                  onclick={() => removeFigma(f.url)}
                  title="Hapus link Figma"
                  aria-label="Hapus link"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            {/each}
          {/if}
        </div>

        <FigmaScreensPanel bind:this={screensPanel} draftId={draft.id} />
      </section>
    {:else}
      <section class="section">
        <p class="desc">
          Unggah dokumen spesifikasi partner (API Swagger/OpenAPI YAML, JSON, PDF panduan integrasi, dsb.). AI Generator akan membaca file-file ini dari folder <code>docs/</code> saat menyusun endpoint dan skema payload.
        </p>

        <div class="upload-bar">
          <label class="btn btn-primary upload-label" class:disabled={uploading}>
            <Icon name="upload" size={14} />
            <span>{uploading ? 'Mengunggah file…' : 'Pilih File Dokumen Partner'}</span>
            <input
              type="file"
              multiple
              accept=".pdf,.yaml,.yml,.json,.md,.markdown,.txt,.docx,.png,.jpg,.jpeg"
              onchange={handleFileInput}
              disabled={uploading}
              style="display: none;"
            />
          </label>
          <span class="muted small">Mendukung PDF, OpenAPI/Swagger YAML/JSON, Markdown, TXT (maks. {MAX_FILE_MB}MB)</span>
        </div>

        {#if uploadError}
          <p class="err small">{uploadError}</p>
        {/if}

        {#if supportingDocs.some((d) => d.encrypted)}
          <div class="encrypted-warning">
            <Icon name="alert" size={14} />
            <span>Dokumen PDF yang ditandai <strong>Terenkripsi</strong> belum bisa dibaca AI. Klik <strong>Buka dengan password</strong> pada file tersebut.</span>
          </div>
        {/if}

        <div class="list">
          {#if !supportingDocs.length}
            <div class="empty-state">
              <Icon name="paperclip" size={24} />
              <p class="muted">Belum ada dokumen partner yang diunggah.</p>
            </div>
          {:else}
            {#each supportingDocs as doc (doc.name)}
              <div class="item-card" class:item-card-warn={doc.encrypted}>
                <div class="item-info">
                  <div class="doc-title-row">
                    <Icon name="doc" size={14} />
                    <span class="item-title mono">{doc.name}</span>
                    {#if doc.encrypted}
                      <span class="encrypted-badge" title="File PDF ini terenkripsi atau berproteksi password. AI tidak bisa membacanya sampai dibuka dengan password.">⚠️ Terenkripsi</span>
                    {/if}
                  </div>
                  {#if doc.size}
                    <span class="muted small">{fmtBytes(doc.size)}</span>
                  {/if}
                </div>
                {#if doc.encrypted}
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => unlockStoredDoc(doc.name)}>
                    <Icon name="unlock" size={13} /> Buka dengan password
                  </button>
                {/if}
                <button
                  type="button"
                  class="btn btn-ghost icon-btn delete-btn"
                  onclick={() => removeDoc(doc.name)}
                  title="Hapus file"
                  aria-label="Hapus file"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    {/if}
  </div>

  {#snippet footer()}
    <div class="modal-foot">
      <button
        type="button"
        class="btn btn-secondary sync-btn"
        onclick={syncToTad}
        title="Otomatis masukkan daftar link Figma & dokumen partner ke tabel # Documentation di TAD"
      >
        <Icon name="doc" size={13} />
        <span>Sinkronkan ke Tabel # Documentation TAD</span>
      </button>
      <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Selesai</button>
    </div>
  {/snippet}
</Modal>

<style>
  .tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    margin: -8px 0 16px;
    padding-bottom: 8px;
  }
  .tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .tab-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tab-btn.active {
    background: var(--surface-2);
    color: var(--accent);
    border-color: var(--border);
    font-weight: 600;
  }
  .desc {
    margin: 0 0 14px;
    font-size: 12.5px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .desc code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 4px;
    background: var(--surface-2);
    border-radius: 4px;
  }
  .add-form {
    margin-bottom: 16px;
  }
  .form-row {
    display: flex;
    gap: 8px;
  }
  .figma-url-input {
    flex: 2;
    min-width: 0;
  }
  .figma-title-input {
    flex: 1.5;
    min-width: 0;
  }
  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .upload-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .upload-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .upload-label.disabled {
    opacity: 0.6;
    pointer-events: none;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    overflow-y: auto;
    padding: 2px;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    background: var(--surface-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    gap: 8px;
    font-size: 12.5px;
  }
  .empty-state p {
    margin: 0;
  }
  .item-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease;
  }
  .item-card:hover {
    border-color: var(--border-strong);
  }
  .item-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .encrypted-warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: var(--warn-soft, rgba(234, 179, 8, 0.1));
    border: 1px solid var(--warn, #eab308);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text);
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .encrypted-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-size: 10.5px;
    font-weight: 600;
    border-radius: 4px;
    background: var(--warn-soft, rgba(234, 179, 8, 0.15));
    color: var(--warn, #d97706);
    border: 1px solid var(--warn, rgba(234, 179, 8, 0.3));
    white-space: nowrap;
  }
  .item-card-warn {
    border-color: var(--warn, rgba(234, 179, 8, 0.4));
    background: var(--warn-soft, rgba(234, 179, 8, 0.04));
  }
  .doc-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .item-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  .item-link {
    font-size: 11.5px;
    color: var(--accent);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .item-link:hover {
    text-decoration: underline;
  }
  .fetch-btn {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .delete-btn {
    color: var(--text-3);
  }
  .delete-btn:hover {
    color: var(--err);
    background: var(--err-soft);
  }
  .err {
    color: var(--err);
    margin-top: 4px;
  }
  .modal-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
  }
  .sync-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
