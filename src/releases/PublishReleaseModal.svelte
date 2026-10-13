<script lang="ts">
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import { releases } from '../lib/release/client';
  import { deploymentStorage, deploymentTitle } from '../lib/release/deployment';
  import type { Release, ReleaseReport } from '../lib/release/types';
  import { appSettings } from '../lib/settings/store.svelte';

  /**
   * Publishes the release document to Confluence: a new page, a new version of the page it went to
   * before, or the page the release was imported from (e.g. the team's draft deployment page).
   * Drafts can stay drafts. An update is refused when someone changed the page in between.
   */
  let { open = $bindable(false), release, report, onpublished }: { open: boolean; release: Release; report: ReleaseReport | null; onpublished: (r: Release) => void } = $props();

  const SPACE_KEY = 'tlc.release.space';
  const PARENT_KEY = 'tlc.release.parent';
  type Target = 'imported' | 'published' | 'new';
  const importedId = $derived(release.source?.kind === 'confluence' ? release.source.pageId : undefined);
  let target = $state<Target>('new');
  let spaceKey = $state('');
  let parentId = $state('');
  let title = $state('');
  let asDraft = $state(false);
  let pageInfo = $state<{ title: string; status?: string; url: string; spaceKey: string } | null>(null);
  let busy = $state(false);
  let error = $state('');

  /** The page an update goes to (none for a new page). */
  const pageId = $derived(target === 'imported' ? importedId : target === 'published' ? release.published?.pageId : undefined);

  $effect(() => {
    if (!open) return;
    error = '';
    title = deploymentTitle(release);
    // The page this release already belongs to comes first.
    target = release.published?.pageId ? 'published' : importedId ? 'imported' : 'new';
    try {
      spaceKey ||= localStorage.getItem(SPACE_KEY) ?? '';
      parentId ||= localStorage.getItem(PARENT_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
  });

  // An existing page: its space, title and whether it is still a draft.
  $effect(() => {
    const id = pageId;
    pageInfo = null;
    if (!open || !id) return;
    void connector
      .page({ id })
      .then((p) => {
        if (pageId !== id) return;
        pageInfo = { title: p.title, status: p.status, url: p.url, spaceKey: p.spaceKey };
        spaceKey = p.spaceKey || spaceKey;
        title = p.title || title;
        asDraft = p.status === 'draft';
      })
      .catch((e: Error) => (error = `Halaman Confluence ${id} tidak terbaca: ${e.message}`));
  });

  async function publish() {
    if (!spaceKey.trim() || !title.trim()) return;
    const update = pageId;
    const ok = await confirmDialog({
      title: update ? 'Perbarui halaman Confluence?' : 'Publish ke Confluence?',
      message: update
        ? `Isi halaman "${pageInfo?.title ?? title}" diganti dengan dokumen rilis dari Cockpit${asDraft ? ' (tetap sebagai draft, belum terbit)' : ' (versi baru, terbit)'}.`
        : `Halaman baru "${title}" akan dibuat di space ${spaceKey.trim()}${asDraft ? ' sebagai draft' : ''}.`,
      confirmText: update ? 'Perbarui' : 'Publish',
      danger: target === 'imported',
    });
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
        ...(parentId.trim() && !update ? { parentId: parentId.trim() } : {}),
        ...(update ? { pageId: update, expectedVersion } : {}),
        ...(asDraft ? { asDraft: true } : {}),
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
      // Later updates go to the same page.
      const saved = await releases.save({ ...release, published: { pageId: res.page.id, version: res.page.version, url: res.page.url, at: new Date().toISOString() } });
      onpublished(saved);
      toasts.show(`Dokumen rilis ${res.action === 'create' ? 'dipublish' : 'diperbarui'} di Confluence${asDraft ? ' (draft)' : ''}.`, 'ok', 3000);
      open = false;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open title="Update dokumen rilis ke Confluence" width={600}>
  <div class="wrap">
    <div class="field">
      <span>Tujuan</span>
      {#if importedId}<label class="opt"><input type="radio" bind:group={target} value="imported" /> Perbarui halaman yang diimport: <strong>{release.source?.title}</strong></label>{/if}
      {#if release.published?.pageId && release.published.pageId !== importedId}<label class="opt"><input type="radio" bind:group={target} value="published" /> Perbarui halaman yang dipublish dari Cockpit{release.published.url ? '' : ` (#${release.published.pageId})`}</label>{/if}
      <label class="opt"><input type="radio" bind:group={target} value="new" /> Buat halaman baru</label>
    </div>
    {#if pageId}
      <p class="small">{#if pageInfo}Halaman <a href={pageInfo.url} target="_blank" rel="noreferrer">{pageInfo.title}</a> · {pageInfo.status === 'draft' ? 'masih draft' : 'sudah terbit'}{pageInfo.spaceKey ? ` · space ${pageInfo.spaceKey}` : ''}{:else}Membaca halaman…{/if}</p>
      <!-- Confluence does not give the space of a draft: then it is typed (remembered). -->
      {#if pageInfo && !pageInfo.spaceKey}<label class="field"><span>Space key halaman ini</span><input class="input mono" bind:value={spaceKey} placeholder="mis. ENG" /></label>{/if}
    {:else}
      <label class="field"><span>Space key</span><input class="input mono" bind:value={spaceKey} placeholder="mis. ENG" /></label>
      <label class="field"><span>ID halaman induk (opsional)</span><input class="input mono" bind:value={parentId} placeholder="mis. 123456789" /></label>
    {/if}
    <label class="field"><span>Judul halaman</span><input class="input" bind:value={title} /></label>
    <label class="opt small"><input type="checkbox" bind:checked={asDraft} /> Simpan sebagai draft (belum terbit)</label>
    <p class="muted small">Isi mengikuti tab Dokumen (format dokumen Deployment tim).{pageId ? ' Kalau halaman diubah orang lain sejak terakhir dibaca, Cockpit menolak menimpa.' : ''}</p>
    {#if error}<p class="err small">{error}</p>{/if}
    <div class="actions">
      <button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Batal</button>
      <button class="btn btn-primary btn-sm" onclick={publish} disabled={busy || !spaceKey.trim() || !title.trim() || (Boolean(pageId) && !pageInfo)}>{busy ? 'Memproses…' : pageId ? 'Perbarui' : 'Publish'}</button>
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
  .opt {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 400;
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
