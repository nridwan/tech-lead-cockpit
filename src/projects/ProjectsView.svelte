<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { estimate } from '../lib/estimate/client';
  import { DEFAULT_HOLIDAYS } from '../lib/estimate/holidays';
  import { nextWorkingDay } from '../lib/estimate/schedule';
  import type { EstimateProject } from '../lib/estimate/types';
  import { draftTitle, drafts } from '../tad/drafts.svelte';
  import TaskBoard from '../tad/TaskBoard.svelte';
  import E2EPanel from './E2EPanel.svelte';
  import EstimatePanel from './EstimatePanel.svelte';
  import OpsBoard from './OpsBoard.svelte';
  import ProjectProgressCard from './ProjectProgressCard.svelte';
  import { loadProjectProgress, type ProjectProgress } from '../lib/projects/project-progress';
  import { OPS_TITLE } from '../lib/projects/ops-tasks';
  import ScheduledReportModal from './ScheduledReportModal.svelte';

  type Tab = 'board' | 'estimate' | 'e2e';
  const TABS: Tab[] = ['board', 'estimate', 'e2e'];
  const TAB_KEY = 'tlc.projects.tab';
  const SAVE_MS = 700;

  let projects = $state<EstimateProject[]>([]);
  let loaded = $state(false);
  let current = $state<EstimateProject | null>(null);
  let tab = $state<Tab>(savedTab());
  let addingTad = $state(false);
  let scheduleOpen = $state(false);
  /** What the Task Board tab shows: one TAD at a time, or the project's tickets & bugs (`OPS`). */
  const OPS = 'ops';
  let boardTad = $state<string | null>(null);
  let saveError = $state('');
  let lastSaved = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function savedTab(): Tab {
    try {
      const t = localStorage.getItem(TAB_KEY) as Tab;
      return TABS.includes(t) ? t : 'board';
    } catch {
      return 'board';
    }
  }

  $effect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  });

  /**
   * `#/projects/<id>` selects a project; `#/projects/new?draft=<id>` opens the TAD's project (or
   * starts one from it). `tab` and `tad` pick the tab and the Task Board's TAD.
   */
  function parseHash(): { id?: string; newFromDraft?: string; isNew: boolean; tab?: Tab; tad?: string } {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const id = path.split('/')[1];
    const q = new URLSearchParams(query ?? '');
    const t = q.get('tab') as Tab | null;
    const extra = { tab: t && TABS.includes(t) ? t : undefined, tad: q.get('tad') ?? undefined };
    return id === 'new' ? { isNew: true, newFromDraft: q.get('draft') ?? undefined, ...extra } : { id: id || undefined, isNew: false, ...extra };
  }

  const draftList = $derived(drafts.drafts);
  const titleOf = (id: string) => {
    const d = draftList.find((x) => x.id === id);
    return d ? draftTitle(d) : 'TAD tidak ditemukan';
  };
  const boardDraft = $derived(current && boardTad && current.draftIds.includes(boardTad) ? (draftList.find((d) => d.id === boardTad) ?? null) : null);
  /** TADs not in any other project (a TAD belongs to at most one). */
  const freeDrafts = $derived(draftList.filter((d) => !projects.some((p) => p.id !== current?.id && p.draftIds.includes(d.id)) && !current?.draftIds.includes(d.id)));

  // Progress per project (all TADs + tickets & bugs). The open project is refreshed when its
  // TADs or sources change; the others load once in the background for the list.
  let progressById = $state<Record<string, ProjectProgress>>({});
  let progressLoading = $state<Record<string, boolean>>({});
  async function loadProgress(p: EstimateProject) {
    if (progressLoading[p.id]) return;
    progressLoading[p.id] = true;
    try {
      progressById[p.id] = await loadProjectProgress($state.snapshot(p) as EstimateProject, draftList);
    } catch {
      /* the card shows the last value */
    } finally {
      progressLoading[p.id] = false;
    }
  }
  const progressSig = $derived(current ? JSON.stringify([current.id, current.draftIds, current.jiraFilter ?? null, current.bugCaseIds ?? [], current.manualTasks ?? []]) : '');
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!progressSig || !draftList.length) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => untrack(() => current && void loadProgress(current)), 800);
    return () => clearTimeout(progressTimer);
  });
  let backgroundLoaded = false;
  $effect(() => {
    if (!loaded || !draftList.length || backgroundLoaded) return;
    backgroundLoaded = true;
    untrack(() => {
      void (async () => {
        for (const p of projects) if (p.id !== current?.id && !progressById[p.id]) await loadProgress(p);
      })();
    });
  });
  /** Opens the board on a part that has the picked status (the open one if it does). */
  function showStatus(value: string) {
    tab = 'board';
    const parts = current ? progressById[current.id]?.parts ?? [] : [];
    if (!value || !parts.length) return;
    const openId = boardTad === OPS ? parts.find((p) => p.kind === 'ops')?.id : boardTad;
    if (parts.find((p) => p.id === openId)?.statuses.includes(value)) return;
    const target = parts.find((p) => p.statuses.includes(value));
    if (target) openPart(target.id);
  }
  function openPart(id: string) {
    tab = 'board';
    boardTad = id.startsWith('ops:') ? OPS : id;
  }

  $effect(() => {
    untrack(() => void init());
    const onHash = () => void route();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  async function init() {
    try {
      projects = await estimate.projects();
    } catch (e) {
      toasts.show(`Proyek: ${(e as Error).message}`, 'err');
    }
    loaded = true;
    await route();
  }

  async function route() {
    if (!loaded) return;
    const h = parseHash();
    if (h.tab) tab = h.tab;
    if (h.tad) boardTad = h.tad;
    if (h.isNew) {
      // A TAD that already has a project opens that project instead.
      const owner = h.newFromDraft ? projects.find((p) => p.draftIds.includes(h.newFromDraft!)) : undefined;
      if (owner) return go(owner.id);
      return void create(h.newFromDraft);
    }
    const target = projects.find((p) => p.id === h.id) ?? (h.id ? undefined : projects[0]);
    if (target?.id === current?.id) return;
    await flush();
    current = target ? structuredClone($state.snapshot(target) as EstimateProject) : null;
    lastSaved = current ? JSON.stringify(current) : '';
    saveError = '';
    addingTad = false;
    if (boardTad !== OPS && !current?.draftIds.includes(boardTad ?? '')) boardTad = current?.draftIds[0] ?? OPS;
  }

  function go(id: string) {
    location.hash = `#/projects/${id}`;
  }

  async function create(fromDraft?: string) {
    const d = fromDraft ? draftList.find((x) => x.id === fromDraft) : undefined;
    try {
      const saved = await estimate.saveProject({
        id: '',
        name: d ? `Proyek ${draftTitle(d)}` : 'Proyek baru',
        draftIds: d ? [d.id] : [],
        startDate: nextWorkingDay(DEFAULT_HOLIDAYS),
        skipCutiBersama: true,
        developers: [],
        tasks: [],
        createdAt: '',
        updatedAt: '',
      });
      projects = [saved, ...projects];
      go(saved.id);
    } catch (e) {
      toasts.show(`Gagal membuat proyek: ${(e as Error).message}`, 'err');
    }
  }

  async function save(snapshot: string) {
    try {
      const saved = await estimate.saveProject(JSON.parse(snapshot));
      lastSaved = snapshot;
      saveError = '';
      projects = projects.map((p) => (p.id === saved.id ? saved : p));
    } catch (e) {
      saveError = (e as Error).message;
    }
  }

  /** Writes pending edits right away (before switching project). */
  async function flush() {
    clearTimeout(saveTimer);
    if (current && JSON.stringify(current) !== lastSaved) await save(JSON.stringify(current));
  }

  // Auto-save every edit (name, TADs, team, efforts…), debounced.
  $effect(() => {
    if (!current) return;
    const snapshot = JSON.stringify(current);
    if (snapshot === lastSaved) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(snapshot), SAVE_MS);
  });

  function addTad(id: string) {
    if (!current || !id) return;
    current.draftIds = [...current.draftIds, id];
    boardTad ??= id;
    addingTad = false;
  }

  async function removeTad(id: string) {
    if (!current) return;
    const estimated = current.tasks.filter((t) => t.draftId === id && t.effortDays !== null).length;
    if (estimated) {
      const ok = await confirmDialog({
        title: 'Keluarkan TAD?',
        message: `"${titleOf(id)}" punya ${estimated} task yang sudah diestimasi. Estimasi task-task itu ikut terhapus dari proyek ini.`,
        confirmText: 'Keluarkan',
        danger: true,
      });
      if (!ok) return;
    }
    current.draftIds = current.draftIds.filter((d) => d !== id);
    if (boardTad === id) boardTad = current.draftIds[0] ?? OPS;
  }

  async function remove() {
    if (!current) return;
    const ok = await confirmDialog({
      title: 'Hapus proyek?',
      message: `Hapus "${current.name}" beserta estimasinya? TAD-nya tidak ikut terhapus. Skenario E2E proyek ini tetap tersimpan di disk.`,
      confirmText: 'Hapus proyek',
      danger: true,
    });
    if (!ok) return;
    try {
      clearTimeout(saveTimer);
      projects = await estimate.deleteProject(current.id);
      current = null;
      lastSaved = '';
      location.hash = projects[0] ? `#/projects/${projects[0].id}` : '#/projects';
      if (!projects[0]) void route();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }
</script>

<div class="projects">
  <aside class="list">
    <div class="list-head">
      <h2>Proyek</h2>
      <button class="btn btn-primary btn-sm" onclick={() => create()}><Icon name="plus" size={13} /> Baru</button>
    </div>
    <p class="muted small hint">Satu proyek bisa berisi beberapa TAD dengan satu tim. Estimasi dan E2E test dihitung per proyek.</p>
    <button class="btn btn-sm schedule-btn" onclick={() => (scheduleOpen = true)} title="Kirim progres proyek otomatis ke WhatsApp lewat Hermes di VPS"><Icon name="clock" size={13} /> Laporan Terjadwal</button>
    {#if loaded && !projects.length}
      <p class="muted small">Belum ada proyek.</p>
    {/if}
    {#each projects as p (p.id)}
      <a class="item" class:active={p.id === current?.id} href="#/projects/{p.id}">
        <span class="avatar" aria-hidden="true">{(p.id === current?.id ? current.name : p.name).trim().charAt(0).toUpperCase() || '?'}</span>
        <span class="item-text">
          <strong>{p.id === current?.id ? current.name : p.name}</strong>
          <span class="muted small">{(p.id === current?.id ? current.draftIds : p.draftIds).length} TAD · {p.developers.length} developer</span>
          {#if progressById[p.id]?.stages.total}
            <span class="item-progress" title="Progres proyek">
              <span class="item-bar"><span style="width: {progressById[p.id].percent}%"></span></span>
              <span class="item-pct">{progressById[p.id].percent}%</span>
            </span>
          {/if}
        </span>
      </a>
    {/each}
  </aside>

  <section class="main">
    {#if !loaded}
      <div class="empty muted">Memuat proyek…</div>
    {:else if !current}
      <div class="empty">
        <Icon name="list" size={28} />
        <h2>Belum ada proyek dipilih</h2>
        <p class="muted">Buat proyek, tambahkan TAD-nya (bisa lebih dari satu), lalu hitung estimasi hari kerja dan jalankan E2E test untuk seluruh proyek.</p>
        <button class="btn btn-primary" onclick={() => create()}><Icon name="plus" size={14} /> Buat proyek</button>
      </div>
    {:else}
      <header class="head">
        <div class="title-row">
          <input class="input name" bind:value={current.name} aria-label="Nama proyek" />
          <span class="grow"></span>
          <button class="btn btn-ghost btn-sm delete-project" onclick={remove} title="Hapus proyek ini (TAD-nya tidak ikut terhapus)"><Icon name="trash" size={14} /> Hapus proyek</button>
        </div>
        <div class="tads">
          <span class="muted small">TAD:</span>
          {#each current.draftIds as id (id)}
            <span class="chip tad">
              <Icon name="doc" size={11} />
              <a href="#/tad/{id}" onclick={() => drafts.select(id)} title="Buka TAD">{titleOf(id)}</a>
              <button class="x" onclick={() => removeTad(id)} aria-label="Keluarkan {titleOf(id)} dari proyek"><Icon name="x" size={11} /></button>
            </span>
          {/each}
          {#if addingTad}
            <select class="input add-tad" onchange={(e) => addTad(e.currentTarget.value)} aria-label="Pilih TAD">
              <option value="">Pilih TAD…</option>
              {#each freeDrafts as d (d.id)}<option value={d.id}>{draftTitle(d)}</option>{/each}
            </select>
            <button class="btn btn-ghost btn-sm" onclick={() => (addingTad = false)}>Batal</button>
          {:else}
            <button class="btn btn-sm" onclick={() => (addingTad = true)} disabled={!freeDrafts.length} title={freeDrafts.length ? 'Tambahkan TAD ke proyek' : 'Semua TAD sudah masuk proyek'}><Icon name="plus" size={12} /> TAD</button>
          {/if}
        </div>
        {#if saveError}<p class="err small"><Icon name="alert" size={12} /> Belum tersimpan: {saveError}</p>{/if}
        <ProjectProgressCard progress={progressById[current.id] ?? null} loading={progressLoading[current.id]} onrefresh={() => current && loadProgress(current)} onopen={openPart} onstatus={showStatus} />
        <div class="tabs">
          <button class:active={tab === 'board'} onclick={() => (tab = 'board')}><Icon name="dashboard" size={14} /> Task Board</button>
          <button class:active={tab === 'estimate'} onclick={() => (tab = 'estimate')}><Icon name="clock" size={14} /> Estimasi</button>
          <button class:active={tab === 'e2e'} onclick={() => (tab = 'e2e')}><Icon name="play" size={14} /> E2E Test</button>
        </div>
      </header>
      <div class="panel">
        {#key current.id}
          {#if tab === 'board'}
            <div class="board-tab">
              <div class="tad-switch" role="group" aria-label="Sumber task">
                {#each current.draftIds as id (id)}
                  <button class:active={boardTad === id} onclick={() => (boardTad = id)}><Icon name="doc" size={12} /> {titleOf(id)}</button>
                {/each}
                <button class:active={boardTad === OPS} onclick={() => (boardTad = OPS)} title="Tiket Jira, kasus Bug Tracing, dan task manual di luar TAD"><Icon name="bug" size={12} /> {OPS_TITLE}</button>
              </div>
              {#if boardTad === OPS}
                <div class="board-wrap"><OpsBoard bind:project={current} /></div>
              {:else if boardDraft}
                {#key boardDraft.id}
                  <div class="board-wrap"><TaskBoard draft={boardDraft} /></div>
                {/key}
              {:else}
                <div class="empty muted">Pilih TAD di atas, atau buka {OPS_TITLE} untuk tiket dan bug di luar TAD.</div>
              {/if}
            </div>
          {:else if tab === 'estimate'}
            <EstimatePanel bind:project={current} drafts={draftList} {projects} />
          {:else}
            <E2EPanel project={current} drafts={draftList} />
          {/if}
        {/key}
      </div>
    {/if}
  </section>
</div>

<ScheduledReportModal bind:open={scheduleOpen} {projects} />

<style>
  .delete-project {
    color: var(--err);
  }
  .delete-project:hover {
    background: var(--err-soft);
  }
  .schedule-btn {
    align-self: stretch;
    justify-content: center;
    margin-bottom: 10px;
  }
  .projects {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100%;
    overflow: hidden;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 18px 12px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
  }
  .list-head h2 {
    margin: 0;
    font-size: 16px;
  }
  .hint {
    margin: 4px 4px 8px;
    line-height: 1.45;
  }
  .small {
    font-size: 12px;
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 10px;
    color: var(--text);
    text-decoration: none;
    font-size: 13px;
    transition: background 0.12s ease;
  }
  .item:hover {
    background: var(--surface-hover);
  }
  .item.active {
    background: var(--accent-soft);
  }
  .item.active::before {
    content: '';
    position: absolute;
    left: -12px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }
  .avatar {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text-2);
    font-weight: 600;
    font-size: 13px;
  }
  .item.active .avatar {
    background: var(--accent);
    color: var(--accent-text);
  }
  .item-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .item-text strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .item-progress {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
  }
  .item-bar {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: var(--surface-hover);
    overflow: hidden;
  }
  .item-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .item-pct {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .item-text {
    flex: 1;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    background: var(--bg);
  }
  .empty {
    margin: auto;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 24px;
  }
  .empty h2 {
    margin: 0;
    font-size: 17px;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 22px 0;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .input.name {
    font-size: 19px;
    font-weight: 600;
    max-width: 520px;
    padding: 4px 8px;
    margin-left: -8px;
    border-color: transparent;
    background: transparent;
    box-shadow: none;
  }
  .input.name:hover {
    border-color: var(--border);
  }
  .input.name:focus {
    border-color: var(--accent);
    background: var(--surface);
  }
  .tads {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tad {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .tad a {
    color: inherit;
    text-decoration: none;
  }
  .tad a:hover {
    color: var(--accent);
  }
  .x {
    display: inline-flex;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
  }
  .x:hover {
    opacity: 1;
    color: var(--err);
  }
  .add-tad {
    width: auto;
    max-width: 320px;
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin-top: 2px;
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 14px 9px;
    font: inherit;
    font-size: 13px;
    color: var(--text-2, var(--text));
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .panel {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .grow {
    flex: 1;
  }
  .board-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .board-wrap {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .tad-switch {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 14px 22px 0;
    padding: 4px;
    width: fit-content;
    max-width: calc(100% - 44px);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .tad-switch button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12.5px;
    padding: 5px 12px;
    border-radius: 9px;
    border: none;
    background: none;
    color: var(--text-2);
    cursor: pointer;
  }
  .tad-switch button:hover {
    color: var(--text);
  }
  .tad-switch button.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow);
  }
  @media (max-width: 860px) {
    .projects {
      grid-template-columns: 1fr;
    }
    .list {
      border-right: none;
      border-bottom: 1px solid var(--border);
      max-height: 180px;
    }
    .item.active::before {
      display: none;
    }
  }
</style>
