<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { appSettings } from '../lib/settings/store.svelte';
  import { figma } from '../lib/figma/client';
  import type { FigmaFetchedSet, FigmaScreenList } from '../lib/figma/types';

  /**
   * Fetches Figma screens into the draft's AI workspace (figma/<set>/: PNG per screen + index.md
   * with the on-screen text). The generator then points the AI at those files.
   */
  let { draftId }: { draftId: string } = $props();

  const MAX = 30;

  let configured = $state<boolean | null>(null);
  let statusError = $state('');
  let sets = $state<FigmaFetchedSet[]>([]);
  let picking = $state<{ url: string; title?: string; list: FigmaScreenList | null; error: string } | null>(null);
  let selected = $state<string[]>([]);
  let loadingList = $state(false);
  let fetching = $state(false);
  let thumbs = $state<Record<string, string>>({});

  const selectedCount = $derived(selected.length);

  $effect(() => {
    if (!draftId) return;
    void init(draftId);
  });

  async function init(id: string) {
    const st = await figma.status().catch((e) => ({ configured: false, tokenPresent: false, error: (e as Error).message }));
    configured = st.configured;
    statusError = st.configured ? '' : (st.error ?? '');
    sets = await figma.fetched(id, st.configured).catch(() => []);
    void loadThumbs();
  }

  /** Called by the link list: open the screen picker for one Figma link. */
  export async function pick(link: { url: string; title?: string }) {
    picking = { url: link.url, title: link.title, list: null, error: '' };
    selected = [];
    loadingList = true;
    try {
      const list = await figma.screens(link.url);
      if (!picking || picking.url !== link.url) return;
      picking.list = list;
      const previous = sets.find((s) => s.url === link.url);
      const prevIds = previous ? previous.screens.map((s) => s.id).filter((id) => list.screens.some((x) => x.id === id)) : [];
      selected = (prevIds.length ? prevIds : list.selected).slice(0, MAX);
    } catch (e) {
      if (picking) picking.error = (e as Error).message;
    } finally {
      loadingList = false;
    }
  }

  export function setFor(url: string): FigmaFetchedSet | undefined {
    return sets.find((s) => s.url === url);
  }

  function toggle(id: string) {
    if (selected.includes(id)) selected = selected.filter((x) => x !== id);
    else if (selected.length < MAX) selected = [...selected, id];
    else toasts.show(`Maksimal ${MAX} layar sekali ambil.`, 'info', 2500);
  }

  function selectAll() {
    if (!picking?.list) return;
    selected = picking.list.screens.map((s) => s.id).slice(0, MAX);
  }

  async function fetchSelected() {
    if (!picking?.list || !selected.length) return;
    fetching = true;
    try {
      const { set, sets: all } = await figma.fetchScreens(draftId, picking.url, selected, picking.title);
      sets = all;
      picking = null;
      toasts.show(`${set.screens.length} layar dari Figma siap dibaca AI generator.`, 'ok', 3500);
      void loadThumbs(true);
    } catch (e) {
      toasts.show(`Gagal mengambil layar: ${(e as Error).message}`, 'err', 6000);
    } finally {
      fetching = false;
    }
  }

  async function remove(set: FigmaFetchedSet) {
    const ok = await confirmDialog({
      title: 'Hapus layar Figma?',
      message: `Hapus ${set.screens.length} layar "${set.title || set.fileName}" dari workspace AI draft ini? Link Figma-nya tetap ada.`,
      confirmText: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    try {
      sets = await figma.deleteFetched(draftId, set.id);
    } catch (e) {
      toasts.show(`Gagal menghapus: ${(e as Error).message}`, 'err');
    }
  }

  async function loadThumbs(reload = false) {
    if (reload) clearThumbs();
    for (const set of sets) {
      for (const s of set.screens) {
        if (!s.image) continue;
        const key = `${set.id}/${s.image}`;
        if (thumbs[key]) continue;
        try {
          thumbs[key] = await figma.imageObjectUrl(draftId, set.id, s.image);
        } catch {
          /* the list still works without a thumbnail */
        }
      }
    }
  }

  function clearThumbs() {
    for (const u of Object.values(thumbs)) URL.revokeObjectURL(u);
    thumbs = {};
  }

  onDestroy(clearThumbs);

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  };

  function openSetup() {
    appSettings.wizardOpen = true;
  }
</script>

{#if configured === false}
  <div class="notice">
    <Icon name="key" size={14} />
    <span>
      Hubungkan Figma dulu supaya Cockpit bisa mengambil layar desain untuk AI generator.
      {#if statusError && !/belum disimpan/i.test(statusError)}<span class="err">{statusError}</span>{/if}
    </span>
    <button class="btn btn-sm" onclick={openSetup}>Buka Setup</button>
  </div>
{/if}

{#if picking}
  <div class="picker">
    <div class="picker-head">
      <div>
        <strong>Pilih layar</strong>
        {#if picking.list}<span class="muted small"> · {picking.list.nodeName}{picking.list.nodeName !== picking.list.fileName ? ` — ${picking.list.fileName}` : ''}</span>{/if}
      </div>
      <button class="btn btn-ghost btn-sm" onclick={() => (picking = null)} disabled={fetching}>Batal</button>
    </div>
    {#if loadingList}
      <p class="muted small">Membaca struktur frame dari Figma…</p>
    {:else if picking.error}
      <p class="err small">{picking.error}</p>
    {:else if picking.list}
      {#if !picking.list.screens.length}
        <p class="muted small">Tidak ada frame yang bisa dijadikan layar di link ini. Salin link ke frame atau section yang berisi layar.</p>
      {:else}
        {#if picking.list.wholeFile}<p class="muted small">Link ini menunjuk ke seluruh file. Pilih layar yang relevan, atau salin link ke frame/section tertentu agar lebih fokus.</p>{/if}
        <div class="picker-tools">
          <span class="small">{selectedCount} dari {picking.list.screens.length} layar dipilih (maks {MAX})</span>
          <button class="btn btn-ghost btn-sm" onclick={selectAll}>Pilih semua</button>
          <button class="btn btn-ghost btn-sm" onclick={() => (selected = [])}>Kosongkan</button>
        </div>
        <ul class="screen-list">
          {#each picking.list.screens as s (s.id)}
            <li>
              <label>
                <input type="checkbox" checked={selected.includes(s.id)} onchange={() => toggle(s.id)} />
                <span class="screen-name">{s.name}</span>
                <span class="muted small">{s.parent ? `${s.parent} · ` : ''}{s.width}×{s.height}</span>
              </label>
            </li>
          {/each}
        </ul>
        <div class="picker-foot">
          <span class="muted small">Screenshot dan seluruh teks tiap layar disimpan di workspace AI draft ini. Tidak ada yang diubah di Figma.</span>
          <button class="btn btn-primary btn-sm" onclick={fetchSelected} disabled={fetching || !selectedCount}>
            {fetching ? 'Mengambil dari Figma…' : `Ambil ${selectedCount} layar`}
          </button>
        </div>
      {/if}
    {/if}
  </div>
{/if}

{#if sets.length}
  <div class="sets">
    <h4><Icon name="image" size={14} /> Layar yang sudah diambil untuk AI ({sets.reduce((n, s) => n + s.screens.length, 0)})</h4>
    {#each sets as set (set.id)}
      <div class="set">
        <div class="set-head">
          <div class="set-info">
            <strong>{set.title || set.fileName}</strong>
            <span class="muted small">{set.screens.length} layar · diambil {fmtDate(set.fetchedAt)}</span>
            {#if set.stale}<span class="badge-warn">Desain sudah berubah di Figma</span>{/if}
          </div>
          <button class="btn btn-ghost btn-sm" onclick={() => pick({ url: set.url, title: set.title })} disabled={fetching || configured === false} title="Ambil ulang dari Figma">
            <Icon name="refresh" size={13} /> Ambil ulang
          </button>
          <button class="btn btn-ghost btn-sm icon-only" onclick={() => remove(set)} title="Hapus dari workspace AI" aria-label="Hapus layar Figma">
            <Icon name="trash" size={13} />
          </button>
        </div>
        <div class="thumbs">
          {#each set.screens as s (s.id)}
            <figure title={`${s.name} · ${s.textCount} teks`}>
              {#if s.image && thumbs[`${set.id}/${s.image}`]}
                <img src={thumbs[`${set.id}/${s.image}`]} alt={s.name} loading="lazy" />
              {:else}
                <div class="ph"><Icon name="image" size={16} /></div>
              {/if}
              <figcaption>{s.name}</figcaption>
            </figure>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .notice span {
    flex: 1;
  }
  .err {
    color: var(--err);
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .picker-head,
  .picker-tools,
  .picker-foot,
  .set-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .picker-head > div,
  .set-info {
    flex: 1;
    min-width: 0;
  }
  .picker-tools .small {
    flex: 1;
  }
  .picker-foot {
    justify-content: space-between;
  }
  .screen-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .screen-list li + li {
    border-top: 1px solid var(--border);
  }
  .screen-list label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 13px;
  }
  .screen-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sets {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sets h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
    font-size: 13px;
  }
  .set {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .set-info {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }
  .badge-warn {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--warn-soft);
    font-size: 11px;
  }
  .icon-only {
    padding-inline: 6px;
  }
  .thumbs {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  figure {
    flex: 0 0 96px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  figure img,
  .ph {
    width: 96px;
    height: 140px;
    object-fit: cover;
    object-position: top;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
  }
  .ph {
    display: grid;
    place-items: center;
    color: var(--text-3);
  }
  figcaption {
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 12px;
  }
</style>
