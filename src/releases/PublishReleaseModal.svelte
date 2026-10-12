<script lang="ts">
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import { releases } from '../lib/release/client';
  import { deploymentStorage, deploymentTitle } from '../lib/release/deployment';
  import type { Release, ReleaseReport } from '../lib/release/types';
  import { appSettings } from '../lib/settings/store.svelte';

  /** Publishes the release document to Confluence (new page, or a new version of the page it went to before). */
  let { open = $bindable(false), release, report, onpublished }: { open: boolean; release: Release; report: ReleaseReport | null; onpublished: (r: Release) => void } = $props();

  const SPACE_KEY = 'tlc.release.space';
  const PARENT_KEY = 'tlc.release.parent';
  let spaceKey = $state('');
  let parentId = $state('');
  let title = $state('');
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) return;
    error = '';
    title = deploymentTitle(release);
    try {
      spaceKey ||= localStorage.getItem(SPACE_KEY) ?? '';
      parentId ||= localStorage.getItem(PARENT_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
  });

  async function publish() {
    if (!spaceKey.trim() || !title.trim()) return;
    const update = release.published?.pageId;
    const ok = await confirmDialog({ title: update ? 'Perbarui halaman Confluence?' : 'Publish ke Confluence?', message: update ? `Halaman "${title}" akan diperbarui ke versi baru.` : `Halaman baru "${title}" akan dibuat di space ${spaceKey.trim()}.`, confirmText: update ? 'Perbarui' : 'Publish' });
    if (!ok) return;
    busy = true;
    error = '';
    try {
      // Same layout as the team's deployment pages.
      const storage = deploymentStorage(release, report, { jiraBaseUrl: appSettings.value.jira.baseUrl });
      const expectedVersion = update ? (await connector.pageVersion(update)).version : undefined;
      const res = await connector.publish({
        spaceKey: spaceKey.trim(),
        title: title.trim(),
        storage,
        ...(parentId.trim() ? { parentId: parentId.trim() } : {}),
        ...(update ? { pageId: update, expectedVersion } : {}),
        versionMessage: 'Diperbarui dari Tech Lead Cockpit',
        attachments: [],
        context: { draftId: release.id, jiraKeys: release.jiraKeys.slice(0, 50) },
      });
      try {
        localStorage.setItem(SPACE_KEY, spaceKey.trim());
        localStorage.setItem(PARENT_KEY, parentId.trim());
      } catch {
        /* storage blocked */
      }
      const saved = await releases.save({ ...release, published: { pageId: res.page.id, version: res.page.version, url: res.page.url, at: new Date().toISOString() } });
      onpublished(saved);
      toasts.show(`Dokumen rilis ${res.action === 'create' ? 'dipublish' : 'diperbarui'} di Confluence.`, 'ok', 3000);
      open = false;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open title={release.published ? 'Perbarui dokumen rilis di Confluence' : 'Publish dokumen rilis ke Confluence'} width={560}>
  <div class="wrap">
    <label class="field"><span>Space key</span><input class="input mono" bind:value={spaceKey} placeholder="mis. ENG" disabled={Boolean(release.published)} /></label>
    <label class="field"><span>ID halaman induk (opsional)</span><input class="input mono" bind:value={parentId} placeholder="mis. 123456789" disabled={Boolean(release.published)} /></label>
    <label class="field"><span>Judul halaman</span><input class="input" bind:value={title} /></label>
    <p class="muted small">Format dokumen Deployment: info rilis, Change Log, Deployment List (urutan deploy, lalu Pre-deploy, Commit id, Post-deploy, Failover Strategy per service), Release List, Document Control, Post Deployment Test, dan Post Deployment issues.{release.published ? ' Kalau halaman sudah diubah orang lain sejak publish terakhir, Cockpit menolak menimpa.' : ''}</p>
    {#if error}<p class="err small">{error}</p>{/if}
    <div class="actions">
      <button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Batal</button>
      <button class="btn btn-primary btn-sm" onclick={publish} disabled={busy || !spaceKey.trim() || !title.trim()}>{busy ? 'Memproses…' : release.published ? 'Perbarui' : 'Publish'}</button>
    </div>
  </div>
</Modal>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .field > span {
    font-weight: 600;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
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
