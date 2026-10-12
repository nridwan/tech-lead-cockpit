<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { openExternal } from '../lib/open-external';
  import { releases } from '../lib/release/client';
  import type { MrPlan, Release, ReleaseService } from '../lib/release/types';

  /**
   * New release MR for one service: compares the source branch with the target first (commits,
   * files, env/migrations/queries, tickets), then creates it through the GitLab API (token with
   * scope api, confirmed) or opens GitLab's own form filled in.
   */
  let { release, service, onclose, oncreated }: { release: Release; service: ReleaseService; onclose: () => void; oncreated: (r: Release) => void } = $props();

  let open = $state(true);
  // The release's source branch is only the starting value; the field is edited here.
  let source = $state(untrack(() => release.sourceBranch ?? 'staging'));
  let plan = $state<MrPlan | null>(null);
  let loading = $state(false);
  let error = $state('');
  let title = $state('');
  let description = $state('');
  let creating = $state(false);

  onMount(() => void load());
  $effect(() => {
    if (!open) onclose();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      plan = await releases.mrPlan(release.id, service.id, source.trim());
      title = plan.title;
      description = plan.description;
    } catch (e) {
      error = (e as Error).message;
      plan = null;
    } finally {
      loading = false;
    }
  }

  async function create() {
    if (!plan) return;
    const ok = await confirmDialog({
      title: 'Buat MR di GitLab?',
      message: `MR ${plan.sourceBranch} → ${plan.targetBranch} akan dibuat di ${plan.projectPath} atas nama token GitLab kamu (${plan.commits.length} commit, ${plan.files} file).`,
      confirmText: 'Buat MR',
    });
    if (!ok) return;
    creating = true;
    try {
      const r = await releases.createMr(release.id, service.id, { sourceBranch: plan.sourceBranch, title, description });
      toasts.show(r.created ? `MR ${r.ref} dibuat.` : `MR ${r.ref} sudah ada, ditautkan ke rilis.`, 'ok', 4000);
      oncreated(r.release);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      creating = false;
    }
  }

  async function openForm() {
    if (!plan?.formUrl) return;
    await openExternal(plan.formUrl);
    toasts.show('Form MR dibuka di GitLab. Setelah dibuat, klik "Cari service & MR" atau tempel link MR-nya.', 'info', 6000);
  }

  const f = $derived(plan?.findings);
</script>

<Modal bind:open title="Buat MR ke {release.targetBranch}" subtitle="{service.name} · {service.gitlabPath}" width={860}>
  <div class="wrap">
    <div class="row">
      <label class="inline small">Branch sumber <input class="input mono src" bind:value={source} onkeydown={(e) => e.key === 'Enter' && load()} /></label>
      <span class="small">→ <span class="mono">{release.targetBranch}</span></span>
      <button class="btn btn-sm" onclick={load} disabled={loading || !source.trim()}><Icon name="refresh" size={12} /> {loading ? 'Membandingkan…' : 'Bandingkan'}</button>
    </div>

    {#if error}<p class="err small">{error}</p>{/if}

    {#if plan}
      {#if plan.existing}
        <div class="note"><Icon name="alert" size={13} /> Sudah ada MR terbuka untuk branch ini: <a href={plan.existing.webUrl} target="_blank" rel="noreferrer">{plan.existing.ref}</a>. "Buat MR" akan menautkannya ke rilis, bukan membuat MR kedua.</div>
      {/if}
      {#if plan.warnings.length}
        <div class="warn">{#each plan.warnings as w (w)}<p><Icon name="alert" size={12} /> {w}</p>{/each}</div>
      {/if}

      <div class="grid">
        <section>
          <h4>Perbandingan</h4>
          <p class="small">{plan.commits.length} commit · {plan.files} file{plan.truncated ? ' (sebagian, perbandingan terpotong)' : ''}</p>
          {#if f}
            <ul class="small findings">
              {#if f.envAdded.length}<li><strong>Env baru:</strong> <span class="mono">{f.envAdded.join(', ')}</span></li>{/if}
              {#if f.envReadInCode.length}<li><strong>Env dibaca di kode:</strong> <span class="mono">{f.envReadInCode.join(', ')}</span></li>{/if}
              {#if f.migrations.length}<li><strong>Migrasi:</strong> <span class="mono">{f.migrations.join(', ')}</span></li>{/if}
              {#if f.sqlOutside.length}<li class="w"><strong>Query manual:</strong> <span class="mono">{f.sqlOutside.join(', ')}</span></li>{/if}
              {#if f.modelWithoutMigration.length}<li class="w"><strong>Model berubah tanpa migrasi:</strong> <span class="mono">{f.modelWithoutMigration.join(', ')}</span></li>{/if}
              {#if f.commitsWithoutKey.length}<li class="w"><strong>{f.commitsWithoutKey.length} commit tanpa Jira key</strong></li>{/if}
              {#if !f.envAdded.length && !f.envReadInCode.length && !f.migrations.length && !f.sqlOutside.length}<li class="muted">Tidak membawa env, migrasi, atau query.</li>{/if}
            </ul>
          {/if}
          {#if plan.outOfScope.length}
            <h4 class="bad">Di luar scope, akan ikut terbawa ({plan.outOfScope.length})</h4>
            <ul class="small tickets">
              {#each plan.outOfScope as o (o.key)}<li class="missing"><span class="mono">{o.key}</span> {o.summary ?? 'tidak termuat dari Jira'}{o.commits[0] ? ` · ${o.commits[0]}` : ''}</li>{/each}
            </ul>
          {/if}
          {#if plan.tickets.length}
            <h4>Tiket {service.name}</h4>
            <ul class="small tickets">
              {#each plan.tickets as t (t.key)}<li class:missing={!t.inSource}><span class="mono">{t.key}</span> {t.summary} <span class="muted">· {t.status}{t.inSource ? '' : ' · belum ada di commit'}</span></li>{/each}
            </ul>
          {/if}
          {#if plan.commits.length}
            <h4>Commit</h4>
            <ul class="small commits">
              {#each plan.commits.slice(0, 30) as c (c.shortId)}<li><span class="mono">{c.shortId}</span> {c.title}</li>{/each}
              {#if plan.commits.length > 30}<li class="muted">… {plan.commits.length - 30} commit lain</li>{/if}
            </ul>
          {/if}
        </section>
        <section>
          <label class="field"><span>Judul MR</span><input class="input" bind:value={title} /></label>
          <label class="field"><span>Deskripsi</span><textarea class="input mono desc" rows="16" bind:value={description}></textarea></label>
        </section>
      </div>

      <div class="actions">
        <span class="muted small grow">
          {#if plan.canCreate === false}Token GitLab tidak punya scope <code>api</code>: pakai "Buka form di GitLab", atau buat token baru dengan scope api lalu simpan di Koneksi.{:else if plan.canCreate === undefined}Scope token tidak bisa dicek; kalau GitLab menolak, pakai "Buka form di GitLab".{/if}
        </span>
        <button class="btn btn-sm" onclick={openForm} disabled={!plan.formUrl}><Icon name="external" size={12} /> Buka form di GitLab</button>
        <button class="btn btn-primary btn-sm" onclick={create} disabled={creating || !title.trim() || plan.canCreate === false || !plan.sourceExists || !plan.targetExists || (!plan.commits.length && !plan.existing)}>
          <Icon name="merge" size={12} /> {creating ? 'Membuat…' : plan.existing ? 'Tautkan MR yang ada' : 'Buat MR'}
        </button>
      </div>
    {:else if loading}
      <p class="muted small">Membandingkan {source} dengan {release.targetBranch} di GitLab…</p>
    {/if}
  </div>
</Modal>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .src {
    width: 180px;
  }
  .grow {
    flex: 1;
    min-width: 200px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 16px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
  }
  ul {
    margin: 0;
    padding-left: 16px;
  }
  .commits,
  .tickets {
    max-height: 180px;
    overflow: auto;
  }
  .findings .w,
  .tickets .missing {
    color: var(--warn, #b45309);
  }
  .bad {
    color: var(--err);
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
  .desc {
    font-size: 12px;
  }
  .note,
  .warn {
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .warn p {
    margin: 0;
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
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
