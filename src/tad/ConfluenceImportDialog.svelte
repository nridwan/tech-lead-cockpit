<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import type { ConnectorStatus, PageInfo } from '../lib/confluence/api-types';
  import { storageToMarkdown } from '../lib/confluence/storage-to-markdown';
  import { extractPageId } from '../lib/prd/confluence-prd';
  import { drafts, type Draft } from './drafts.svelte';

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let status = $state<ConnectorStatus | null>(null);
  let checkingStatus = $state(false);

  // Search state
  let searchQuery = $state('TAD');
  let spaceFilter = $state('');
  let pages = $state<PageInfo[]>([]);
  let searching = $state(false);
  let searchError = $state('');

  // Direct URL / ID input
  let directInput = $state('');
  let importingId = $state<string | null>(null);
  let importError = $state('');

  function extractJiraKeys(text: string): string[] {
    const matches = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/g);
    return matches ? [...new Set(matches)] : [];
  }

  $effect(() => {
    if (!open) return;
    loadStatusAndInitialSearch();
  });

  async function loadStatusAndInitialSearch() {
    checkingStatus = true;
    searchError = '';
    importError = '';
    try {
      status = await connector.status();
      if (status?.configured) {
        await doSearch();
      }
    } catch (e: any) {
      status = null;
    } finally {
      checkingStatus = false;
    }
  }

  async function doSearch() {
    if (!status?.configured) return;
    searching = true;
    searchError = '';
    try {
      const q = searchQuery.trim() || 'TAD';
      pages = await connector.searchPages(q, spaceFilter.trim() || undefined);
    } catch (e: any) {
      searchError = e.message || 'Gagal mencari halaman di Confluence.';
      pages = [];
    } finally {
      searching = false;
    }
  }

  async function importByDirectInput() {
    const pageId = extractPageId(directInput);
    if (!pageId) {
      importError = 'Masukkan ID halaman atau URL Confluence yang valid.';
      return;
    }
    await importPage(pageId);
  }

  async function importPage(pageId: string) {
    importingId = pageId;
    importError = '';
    try {
      // 1. Fetch page with full storage format
      const page = await connector.page({ id: pageId });
      if (!page.storage) {
        throw new Error('Konten storage halaman kosong atau tidak bisa diakses.');
      }

      // 2. Convert Confluence XHTML to Markdown
      const { markdown, hasToc } = storageToMarkdown(page.storage, page.title);
      const jiraKeys = extractJiraKeys(page.title + ' ' + (page.storage || ''));

      // 3. Create or update local draft
      const spaceKey = page.spaceKey || spaceFilter.trim();
      const existingDraft = findExistingDraft(page.id);

      if (existingDraft) {
        drafts.update(existingDraft.id, {
          markdown,
          storageOptions: {
            ...existingDraft.storageOptions,
            toc: hasToc,
          },
          confluence: {
            ...existingDraft.confluence,
            spaceKey: spaceKey || existingDraft.confluence.spaceKey,
            pageId: page.id,
            version: page.version,
            url: page.url,
            publishedAt: new Date().toISOString(),
          },
          source: {
            jiraKeys,
          },
        });
        drafts.applyRevision(existingDraft.id, markdown, `Import ulang dari Confluence (v${page.version})`);
        drafts.select(existingDraft.id);
        drafts.saveNow();
        toasts.show(`TAD "${page.title}" berhasil diperbarui dari Confluence!`, 'ok');
      } else {
        const newDraft = drafts.create(
          markdown,
          {
            jiraKeys,
          },
          undefined,
          `Diimpor dari Confluence: ${page.title} (v${page.version})`,
          {
            spaceKey,
            parentId: '',
            pageId: page.id,
            version: page.version,
            url: page.url,
            publishedAt: new Date().toISOString(),
          }
        );
        drafts.update(newDraft.id, {
          storageOptions: {
            ...newDraft.storageOptions,
            toc: hasToc,
          },
        });
        toasts.show(`TAD "${page.title}" berhasil diimpor ke workspace lokal!`, 'ok');
      }

      open = false;
      directInput = '';
    } catch (e: any) {
      importError = `Gagal mengimpor halaman: ${e.message}`;
      toasts.show(importError, 'err');
    } finally {
      importingId = null;
    }
  }

  function findExistingDraft(pageId: string): Draft | undefined {
    return drafts.drafts.find((d) => d.confluence.pageId === pageId);
  }

  function openExistingDraft(draftId: string) {
    drafts.select(draftId);
    open = false;
  }
</script>

<Modal bind:open title="Import Dokumen TAD dari Confluence" subtitle="Tarik dokumen arsitektur dari Confluence ke workspace lokal untuk diedit dan diperbarui dengan AI tools." width={840} height={640}>
  <div class="import-layout">
    <!-- Status Connection Card -->
    {#if checkingStatus}
      <div class="conn-bar">
        <span class="muted font-xs">Memeriksa koneksi Confluence…</span>
      </div>
    {:else if !status?.configured}
      <div class="alert alert-warn conn-alert">
        <Icon name="alert" size={16} />
        <div class="conn-alert-body">
          <strong>Confluence belum terhubung.</strong>
          <p>Hubungkan kredensial Atlassian Anda terlebih dahulu agar Cockpit dapat membaca halaman Confluence.</p>
          <a href="#/connections" class="btn btn-sm btn-primary" onclick={() => (open = false)}>
            Ke Halaman Koneksi
          </a>
        </div>
      </div>
    {:else}
      <div class="conn-bar connected">
        <div class="conn-user">
          <span class="dot-ok"></span>
          <span>Terhubung ke Confluence: <strong>{status.user || status.baseUrl}</strong></span>
        </div>
        <span class="conn-tag">Cloud / DC Ready</span>
      </div>

      <!-- Quick Direct Link / ID Import Box -->
      <section class="card direct-card">
        <div class="direct-head">
          <Icon name="link" size={15} />
          <strong>Import Cepat via URL / Page ID:</strong>
        </div>
        <div class="direct-input-row">
          <input
            type="text"
            class="input mono"
            placeholder="Tempelkan URL halaman atau draft Confluence (…/pages/123456789/…, …resumedraft.action?draftId=…) atau Page ID"
            bind:value={directInput}
            onkeydown={(e) => e.key === 'Enter' && importByDirectInput()}
            disabled={importingId !== null}
          />
          <button
            type="button"
            class="btn btn-primary"
            onclick={importByDirectInput}
            disabled={importingId !== null || !directInput.trim()}
          >
            {#if importingId && directInput.includes(importingId)}
              <Icon name="refresh" size={14} /> Mengimpor…
            {:else}
              <Icon name="download" size={14} /> Import
            {/if}
          </button>
        </div>
        {#if importError}
          <div class="error-text font-xs">{importError}</div>
        {/if}
      </section>

      <!-- Auto-Discovery / Search Area -->
      <section class="card search-card">
        <div class="search-head">
          <div class="search-title">
            <Icon name="search" size={15} />
            <strong>Pencarian Dokumen di Confluence:</strong>
          </div>
        </div>

        <div class="search-bar-row">
          <div class="input-with-label flex-grow">
            <label for="search-query-inp">Kata Kunci Judul:</label>
            <input
              id="search-query-inp"
              type="text"
              class="input"
              placeholder="misal: TAD, Architecture, Payment, Core..."
              bind:value={searchQuery}
              onkeydown={(e) => e.key === 'Enter' && doSearch()}
              disabled={searching || importingId !== null}
            />
          </div>

          <div class="input-with-label space-inp">
            <label for="search-space-inp">Space Key (Opsional):</label>
            <input
              id="search-space-inp"
              type="text"
              class="input mono"
              placeholder="misal: ENG / MP"
              bind:value={spaceFilter}
              onkeydown={(e) => e.key === 'Enter' && doSearch()}
              disabled={searching || importingId !== null}
            />
          </div>

          <button
            type="button"
            class="btn btn-primary btn-search"
            onclick={doSearch}
            disabled={searching || importingId !== null || !searchQuery.trim()}
          >
            {#if searching}
              <Icon name="refresh" size={14} /> Mencari…
            {:else}
              <Icon name="search" size={14} /> Cari
            {/if}
          </button>
        </div>

        <!-- Search Results Table / List -->
        {#if searching}
          <div class="search-state-box">
            <Icon name="refresh" size={20} />
            <span>Mencari dokumen TAD di Confluence…</span>
          </div>
        {:else if searchError}
          <div class="alert alert-err">
            <Icon name="alert" size={16} />
            <span>{searchError}</span>
          </div>
        {:else if pages.length === 0}
          <div class="search-state-box empty">
            <Icon name="doc" size={24} />
            <span>Tidak ada halaman yang cocok dengan kata kunci "{searchQuery}".</span>
            <span class="muted font-xs">Coba ubah kata kunci atau gunakan input URL halaman langsung di atas.</span>
          </div>
        {:else}
          <div class="pages-list">
            <div class="list-meta muted font-xs">
              Ditemukan {pages.length} halaman di Confluence:
            </div>
            {#each pages as p (p.id)}
              {@const existingDraft = findExistingDraft(p.id)}
              <div class="page-item" class:is-imported={Boolean(existingDraft)}>
                <div class="page-info">
                  <div class="page-title-row">
                    <strong class="page-title">{p.title}</strong>
                    <span class="badge-space">{p.spaceKey}</span>
                    <span class="badge-version">v{p.version}</span>
                    {#if existingDraft}
                      <span class="badge-imported">Sudah Ada di Lokal</span>
                    {/if}
                  </div>
                  <div class="page-meta muted font-xs">
                    <span>ID: {p.id}</span>
                    {#if p.url}
                      <span>•</span>
                      <a href={p.url} target="_blank" rel="noopener noreferrer" class="link-external">
                        Buka di Confluence <Icon name="external" size={11} />
                      </a>
                    {/if}
                  </div>
                </div>

                <div class="page-actions">
                  {#if existingDraft}
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      onclick={() => openExistingDraft(existingDraft.id)}
                    >
                      Buka Draft
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      onclick={() => importPage(p.id)}
                      disabled={importingId === p.id}
                    >
                      {importingId === p.id ? 'Mengimpor…' : 'Import Ulang'}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      onclick={() => importPage(p.id)}
                      disabled={importingId === p.id}
                    >
                      {#if importingId === p.id}
                        <Icon name="refresh" size={13} /> Mengimpor…
                      {:else}
                        <Icon name="download" size={13} /> Import ke Lokal
                      {/if}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>Tutup</button>
  {/snippet}
</Modal>

<style>
  .import-layout {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-height: 72vh;
    overflow-y: auto;
    padding-right: 2px;
  }

  .conn-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12px;
  }
  .conn-bar.connected {
    background: rgba(16, 185, 129, 0.08);
    border-color: rgba(16, 185, 129, 0.25);
  }
  .conn-user {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
  }
  .dot-ok {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #10b981;
  }
  .conn-tag {
    font-size: 11px;
    color: #10b981;
    font-weight: 600;
  }

  .conn-alert {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .conn-alert-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .direct-card {
    background: var(--surface-2);
  }
  .direct-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text-1);
  }
  .direct-input-row {
    display: flex;
    gap: 8px;
  }
  .direct-input-row input {
    flex: 1;
    font-size: 12px;
  }
  .error-text {
    color: #ef4444;
  }

  .search-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .search-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-1);
  }
  .search-bar-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .input-with-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .input-with-label label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
  }
  .flex-grow {
    flex: 1;
  }
  .space-inp {
    width: 140px;
  }
  .btn-search {
    height: 34px;
    padding: 0 14px;
  }

  .search-state-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 8px;
    color: var(--text-2);
    font-size: 12.5px;
    text-align: center;
  }
  .search-state-box.empty {
    color: var(--text-3);
  }

  .pages-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 280px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .list-meta {
    margin-bottom: 2px;
  }
  .page-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    gap: 12px;
    transition: border-color 0.15s ease;
  }
  .page-item:hover {
    border-color: var(--primary);
  }
  .page-item.is-imported {
    border-left: 3px solid #10b981;
  }
  .page-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .page-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .page-title {
    font-size: 13px;
    color: var(--text-1);
  }
  .badge-space {
    font-size: 10.5px;
    font-weight: 600;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--font-mono, monospace);
  }
  .badge-version {
    font-size: 10.5px;
    color: var(--text-2);
    background: var(--surface);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .badge-imported {
    font-size: 10px;
    font-weight: 600;
    background: rgba(16, 185, 129, 0.12);
    color: #10b981;
    padding: 1px 6px;
    border-radius: 4px;
  }
  .page-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .link-external {
    color: var(--primary);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .link-external:hover {
    text-decoration: underline;
  }
  .page-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
</style>
