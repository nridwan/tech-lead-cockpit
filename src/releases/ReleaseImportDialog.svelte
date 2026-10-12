<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import { storageToMarkdown } from '../lib/confluence/storage-to-markdown';
  import { extractPageId } from '../lib/prd/confluence-prd';
  import { releases } from '../lib/release/client';
  import { parseDeploymentStorage } from '../lib/release/deployment';
  import { importPreview, parseReleaseDoc, type ParsedReleaseDoc } from '../lib/release/import';
  import type { Release, ReleaseSource } from '../lib/release/types';

  /** Imports a release document (Confluence page, .md file or pasted text) into a release, like TAD import. */
  let { open = $bindable(false), release, onimported }: { open: boolean; release: Release; onimported: (r: Release) => void } = $props();

  let mode = $state<'confluence' | 'markdown'>('confluence');
  let pageInput = $state('');
  let markdown = $state('');
  /** The Confluence page's own markup: read as a deployment page when it has that layout. */
  let storage = $state('');
  let source = $state<Omit<ReleaseSource, 'importedAt'> | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');

  const deployment = $derived(storage ? parseDeploymentStorage(storage, source?.title) : null);
  const parsed = $derived<ParsedReleaseDoc | null>(deployment ?? (markdown.trim() ? parseReleaseDoc(markdown) : null));
  const preview = $derived(parsed ? importPreview(release, parsed) : null);
  /** Document services not in the release that the user ticks to add. */
  let addServices = $state<string[]>([]);
  let addKeys = $state(false);

  $effect(() => {
    if (open) {
      error = '';
      if (release.source?.kind === 'confluence' && release.source.pageId && !pageInput) pageInput = release.source.url ?? release.source.pageId;
    }
  });

  async function fetchPage() {
    const id = extractPageId(pageInput);
    if (!id) return void (error = 'Tempel link halaman Confluence atau ID halamannya.');
    loading = true;
    error = '';
    try {
      const page = await connector.page({ id });
      if (!page.storage) throw new Error('Isi halaman kosong atau tidak bisa diakses.');
      markdown = storageToMarkdown(page.storage, page.title).markdown;
      storage = page.storage;
      source = { kind: 'confluence', title: page.title, pageId: page.id, version: page.version, url: page.url };
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function readFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return void (error = 'File melebihi 2 MB.');
    markdown = await f.text();
    storage = '';
    source = { kind: 'markdown', title: f.name };
  }

  async function doImport() {
    if (!markdown.trim()) return;
    saving = true;
    try {
      const r = await releases.importDoc(release.id, markdown, source ?? { kind: 'markdown', title: 'Teks yang ditempel' }, storage || undefined, { addServices: [...addServices], addKeys });
      addServices = [];
      addKeys = false;
      onimported(r);
      toasts.show('Dokumen rilis diimport. Service, MR, env, query, dan langkah yang terbaca sudah masuk.', 'ok', 4000);
      open = false;
      markdown = '';
      storage = '';
      source = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open title="Import dokumen rilis" subtitle="Dari Confluence atau Markdown. Yang sudah ada di rilis tidak dihapus; yang baru ditambahkan." width={760}>
  <div class="wrap">
    <div class="seg" role="group">
      <button class:active={mode === 'confluence'} onclick={() => (mode = 'confluence')}><Icon name="confluence" size={13} /> Confluence</button>
      <button class:active={mode === 'markdown'} onclick={() => (mode = 'markdown')}><Icon name="doc" size={13} /> Markdown</button>
    </div>

    {#if mode === 'confluence'}
      <div class="row">
        <input class="input" bind:value={pageInput} placeholder="Link halaman atau draft Confluence (…/pages/123456/…, …resumedraft.action?draftId=…) atau ID halaman" onkeydown={(e) => e.key === 'Enter' && fetchPage()} />
        <button class="btn btn-primary btn-sm" onclick={fetchPage} disabled={loading || !pageInput.trim()}>{loading ? 'Mengambil…' : 'Ambil'}</button>
      </div>
    {:else}
      <div class="row">
        <label class="btn btn-sm"><Icon name="upload" size={13} /> Pilih file .md<input type="file" accept=".md,.markdown,.txt" hidden onchange={readFile} /></label>
        <span class="muted small">atau tempel teks di bawah</span>
      </div>
      <textarea class="input mono" rows="8" bind:value={markdown} placeholder="# Rilis v2.4.0&#10;&#10;| Service | MR | PIC |&#10;| --- | --- | --- |&#10;| core-payment | https://gitlab.example.com/payments/core-payment/-/merge_requests/12 | Budi |" oninput={() => { storage = ''; source ??= { kind: 'markdown', title: 'Teks yang ditempel' }; }}></textarea>
    {/if}

    {#if error}<p class="err small">{error}</p>{/if}

    {#if parsed}
      <section class="summary">
        <h4>Yang terbaca{source ? ` dari "${source.title}"` : ''}{deployment ? ' (format dokumen Deployment)' : ''}</h4>
        {#if deployment}
          <ul class="small">
            <li>Rilis: <strong>{deployment.date ?? '-'}</strong> {deployment.deploy.targetTime ?? ''} · status {deployment.deploy.statusTitle ?? '-'} · impact {deployment.deploy.impact ?? '-'}</li>
            <li>Peran: {deployment.deploy.roles.map((r) => `${r.label} (${r.people.length})`).join(', ') || '-'}</li>
            <li>Change Log: {deployment.deploy.changeLog.length} baris</li>
            <li>Service ({deployment.serviceDetails.length}, sesuai urutan deploy): {deployment.serviceDetails.map((s) => `${s.name}${s.envNames.length ? ` · ${s.envNames.length} env` : ''}${s.sql.length ? ` · ${s.sql.length} query` : ''}`).join('; ')}</li>
            <li>Release List: {deployment.deploy.releaseList?.jql ?? deployment.deploy.releaseList?.url ?? '-'}</li>
          </ul>
        {/if}
        <ul class="small" class:hidden={Boolean(deployment)}>
          <li>Versi: <strong>{parsed.version ?? 'tidak terbaca'}</strong> · Tanggal: <strong>{parsed.date ?? 'tidak terbaca'}</strong></li>
          <li>Service: {parsed.services.length ? parsed.services.map((s) => s.name).join(', ') : 'tidak ada tabel service'}</li>
          <li>MR: {parsed.mrs.length} link</li>
          <li>Tiket Jira: {parsed.jiraKeys.length ? parsed.jiraKeys.slice(0, 12).join(', ') + (parsed.jiraKeys.length > 12 ? ', …' : '') : 'tidak ada'}</li>
          <li>Env: {parsed.env.length ? parsed.env.join(', ') : 'tidak ada'}</li>
          <li>Query SQL: {parsed.sql.length} blok</li>
          <li>Langkah deploy: {parsed.deploySteps.length} · rollback: {parsed.rollbackSteps.length}</li>
        </ul>
        <p class="muted small">Tabel service dikenali dari judul kolom (Service, Repo, Aplikasi, Project, Modul). Langkah dikenali dari judul bagian (Deploy, Langkah, Runbook, Rollback).</p>
      </section>

      {#if preview}
        <section class="summary plan">
          <h4>Yang akan masuk ke rilis</h4>
          <p class="small">Dokumen mengikuti data rilis. Diambil: {deployment ? 'orang per peran, Deployment Room, jam rilis (kalau kosong), dan untuk service yang ada di rilis: blok .env, catatan pre/post-deploy, failover, updated by' : 'env, query, dan langkah dari dokumen'}. Tidak diambil: commit id, Change Log, Release List, bukti test, dan status (disusun dari rilis).</p>
          <p class="small"><strong>Service yang cocok dengan rilis ({preview.matched.length}):</strong> {preview.matched.map((m) => (m.doc === m.release ? m.release : `${m.doc} → ${m.release}`)).join(', ') || 'tidak ada'}</p>
          {#if preview.notInRelease.length}
            <p class="small"><strong>Ada di dokumen tapi tidak di rilis ({preview.notInRelease.length})</strong> — tidak ditambahkan kecuali dicentang:</p>
            <div class="checks">
              {#each preview.notInRelease as name (name)}
                <label class="small"><input type="checkbox" checked={addServices.includes(name)} onchange={(e) => (addServices = e.currentTarget.checked ? [...addServices, name] : addServices.filter((x) => x !== name))} /> {name}</label>
              {/each}
            </div>
          {/if}
          {#if preview.keys.length}
            <label class="small"><input type="checkbox" bind:checked={addKeys} /> Tambahkan {preview.keys.length} tiket Jira dari dokumen ke scope rilis ({preview.keys.slice(0, 8).join(', ')}{preview.keys.length > 8 ? ', …' : ''})</label>
          {/if}
        </section>
      {/if}
    {/if}

    <div class="actions">
      <button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Batal</button>
      <button class="btn btn-primary btn-sm" onclick={doImport} disabled={saving || !markdown.trim()}>{saving ? 'Mengimport…' : 'Import ke rilis'}</button>
    </div>
  </div>
</Modal>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .seg button.active {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .row,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .row > :global(.input) {
    flex: 1;
    width: auto;
  }
  .actions {
    justify-content: flex-end;
  }
  .summary {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .summary h4 {
    margin: 0 0 6px;
    font-size: 13px;
  }
  .summary ul {
    margin: 0;
    padding-left: 18px;
  }
  .hidden {
    display: none;
  }
  .plan {
    border: 1px solid var(--accent);
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .plan label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .small {
    font-size: 12px;
  }
  .err {
    color: var(--err);
  }
</style>
