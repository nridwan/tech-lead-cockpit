<script lang="ts">
  import { DEFAULT_FAILOVER, serviceCommit } from '../lib/release/deployment';
  import type { DeployPerson, MrCheck, Release, ReleaseItem, ReleaseService } from '../lib/release/types';
  import PeoplePicker from './PeoplePicker.svelte';

  /** One service's rows of the deployment page that are not derived from the checks. */
  let { service, checks, release }: { service: ReleaseService; checks: MrCheck[]; release: Release } = $props();

  // Queries and migrations of this service: shown in the document's Pre-deploy, edited here.
  const mine = (i: ReleaseItem) => (i.kind === 'sql' || i.kind === 'migration') && i.service?.toLowerCase() === service.name.toLowerCase();
  const queries = $derived(release.items.filter(mine));
  function addQuery() {
    release.items = [...release.items, { id: crypto.randomUUID(), kind: 'sql', label: 'Query baru', service: service.name, detail: '', source: 'manual', done: false }];
  }
  function dropQuery(id: string) {
    release.items = release.items.filter((i) => i.id !== id);
  }

  const fromMr = $derived(serviceCommit({ ...service, commitId: undefined }, checks));
  const lines = (v?: string[]) => (v ?? []).join('\n');
  const toLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  let updatedBy = $state<DeployPerson[]>([]);
  $effect.pre(() => {
    updatedBy = service.updatedBy ? [service.updatedBy] : [];
  });
</script>

<div class="fields">
  <label class="field">
    <span>Commit id</span>
    <input class="input mono" value={service.commitId ?? ''} oninput={(e) => (service.commitId = e.currentTarget.value.trim() || undefined)} placeholder={fromMr ? `${fromMr} (dari MR)` : 'sha commit yang dideploy'} />
  </label>
  <label class="field">
    <span>Failover Strategy</span>
    <input class="input" value={service.failover ?? ''} oninput={(e) => (service.failover = e.currentTarget.value || undefined)} placeholder={DEFAULT_FAILOVER} />
  </label>
  <label class="field wide">
    <span>Blok .env (Pre-deploy "Update .env"; env baru dari cek MR ditambahkan sebagai KEY=)</span>
    <textarea class="input mono" rows="3" value={service.envBlock ?? ''} oninput={(e) => (service.envBlock = e.currentTarget.value || undefined)} placeholder="KEY=value"></textarea>
  </label>
  <label class="field">
    <span>Pre-deploy lain (satu per baris)</span>
    <textarea class="input" rows="2" value={lines(service.preDeploy)} oninput={(e) => (service.preDeploy = toLines(e.currentTarget.value))}></textarea>
  </label>
  <label class="field">
    <span>Post-deploy (satu per baris)</span>
    <textarea class="input" rows="2" value={lines(service.postDeploy)} oninput={(e) => (service.postDeploy = toLines(e.currentTarget.value))}></textarea>
  </label>
  <div class="field wide">
    <span>Query &amp; migrasi (Pre-deploy)</span>
    {#each queries as q (q.id)}
      <div class="query">
        <div class="qhead">
          <span class="tag">{q.kind === 'sql' ? 'query' : 'migrasi'}{q.source === 'ai' ? ' · AI' : ''}</span>
          <input class="input" bind:value={q.label} aria-label="Judul" />
          <button class="btn btn-sm btn-ghost" onclick={() => dropQuery(q.id)} aria-label="Hapus">✕</button>
        </div>
        {#if q.kind === 'sql'}<textarea class="input mono" rows="3" bind:value={q.detail} placeholder="SQL yang dijalankan"></textarea>{/if}
        {#if q.note}<span class="muted">{q.note}</span>{/if}
      </div>
    {:else}
      <span class="muted">Tidak ada.</span>
    {/each}
    <button class="btn btn-sm add" onclick={addQuery}>+ Query</button>
  </div>
  <div class="field wide">
    <span>Updated by</span>
    <PeoplePicker bind:people={() => updatedBy, (v) => { updatedBy = v; service.updatedBy = v[0]; }} single label="orang" />
  </div>
</div>

<style>
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
  }
  .field > span {
    font-weight: 600;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .query {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0;
    border-bottom: 1px dashed var(--border);
  }
  .qhead {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .qhead .input {
    flex: 1;
  }
  .tag {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--surface-hover);
    white-space: nowrap;
  }
  .muted {
    color: var(--text-3);
    font-weight: 400;
  }
  .add {
    align-self: flex-start;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  @media (max-width: 760px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>
