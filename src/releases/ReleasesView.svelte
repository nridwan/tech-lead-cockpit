<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { estimate } from '../lib/estimate/client';
  import { OPEN_MR_KEY } from '../lib/gitlab/client';
  import type { EstimateProject } from '../lib/estimate/types';
  import { renderPreview } from '../lib/markdown/preview';
  import { releases } from '../lib/release/client';
  import { releaseMarkdown } from '../lib/release/document';
  import { deploymentStorage, deploymentTitle } from '../lib/release/deployment';
  import { storageToPreviewHtml } from '../lib/release/preview';
  import { appSettings } from '../lib/settings/store.svelte';
  import PreviewPane from '../tad/PreviewPane.svelte';
  import { mrRefFromUrl, removeServices, resetDocumentData, serviceForPath, servicesOutsideScope } from '../lib/release/import';
  import { DEFAULT_MR_TITLE, mrTitle } from '../lib/release/mr';
  import { bringsSummary } from '../lib/release/share';
  import { RELEASE_STATUSES, RELEASE_STATUS_LABELS, type MrCheck, type Release, type ReleaseItem, type ReleaseReport, type ReleaseService } from '../lib/release/types';
  import PublishReleaseModal from './PublishReleaseModal.svelte';
  import ReleaseImportDialog from './ReleaseImportDialog.svelte';
  import ShareMrModal from './ShareMrModal.svelte';
  import CreateMrModal from './CreateMrModal.svelte';
  import DeployInfoForm from './DeployInfoForm.svelte';
  import ServiceDeployFields from './ServiceDeployFields.svelte';

  /**
   * Release management: the MRs into the production branch of every service in a release, what
   * they bring to the server (env, migrations, queries), the tickets they cover, the runbook, the
   * release document, and the review request to a Teams group.
   */

  const SAVE_MS = 600;
  type Tab = 'board' | 'checklist' | 'tickets' | 'doc';

  let list = $state<Release[]>([]);
  let loaded = $state(false);
  let current = $state<Release | null>(null);
  let lastSaved = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveError = $state('');
  let report = $state<ReleaseReport | null>(null);
  let projects = $state<EstimateProject[]>([]);
  let derivedCodenames = $state<string[]>([]);
  let tab = $state<Tab>('board');
  let busy = $state<'' | 'discover' | 'check'>('');
  let importOpen = $state(false);
  let shareOpen = $state(false);
  let publishOpen = $state(false);
  let mrFor = $state<ReleaseService | null>(null);
  let openDetail = $state<Record<string, boolean>>({});
  let mrInput = $state<Record<string, string>>({});
  let newItem = $state<{ kind: ReleaseItem['kind']; label: string; service: string }>({ kind: 'env', label: '', service: '' });
  let newStep = $state<{ kind: 'deploy' | 'rollback'; text: string }>({ kind: 'deploy', text: '' });
  let codenameText = $state('');
  let keysText = $state('');

  const checkOf = (ref: string): MrCheck | undefined => report?.mrs.find((c) => c.ref === ref);
  const allMrs = $derived(current ? current.services.flatMap((s) => s.mrs) : []);
  const pendingItems = $derived(current ? current.items.filter((i) => !i.done).length : 0);
  const docMd = $derived(current ? releaseMarkdown(current, report) : '');
  const outside = $derived(current ? servicesOutsideScope(current, report) : []);
  /** The page that will be published, rendered like the TAD preview. */
  const previewHtml = $derived.by(() => {
    if (!current || tab !== 'doc') return '';
    const people = new Map<string, string>();
    for (const r of current.deploy?.roles ?? []) for (const p of r.people) if (p.accountId) people.set(p.accountId, p.name);
    for (const s of current.services) if (s.updatedBy?.accountId) people.set(s.updatedBy.accountId, s.updatedBy.name);
    const body = deploymentStorage($state.snapshot(current) as Release, report, { jiraBaseUrl: appSettings.value.jira.baseUrl });
    return `<h1>${deploymentTitle(current).replace(/</g, '&lt;')}</h1>${storageToPreviewHtml(body, people)}`;
  });

  function idFromHash(): string | undefined {
    const m = location.hash.match(/^#\/releases\/([A-Za-z0-9_-]+)/);
    return m?.[1];
  }

  $effect(() => {
    untrack(() => void init());
    const onHash = () => void open(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  async function init() {
    try {
      [list, projects] = await Promise.all([releases.list(), estimate.projects().catch(() => [])]);
    } catch (e) {
      toasts.show(`Rilis: ${(e as Error).message}`, 'err');
    }
    loaded = true;
    await open(idFromHash() ?? list[0]?.id);
  }

  async function open(id?: string) {
    await flush();
    if (!id) return void (current = null);
    if (current?.id === id) return;
    const r = list.find((x) => x.id === id) ?? (await releases.get(id).catch(() => undefined));
    if (!r) return void (current = null);
    setCurrent(r);
    report = await releases.report(id).catch(() => null);
    derivedCodenames = await releases.codenames(id).catch(() => []);
  }

  function setCurrent(r: Release) {
    current = r;
    lastSaved = JSON.stringify(r);
    codenameText = r.codenames.join(', ');
    keysText = r.jiraKeys.join(', ');
    list = list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list];
  }

  async function save(snapshot: string) {
    try {
      const saved = await releases.save(JSON.parse(snapshot));
      lastSaved = snapshot;
      saveError = '';
      list = list.map((x) => (x.id === saved.id ? saved : x));
    } catch (e) {
      saveError = (e as Error).message;
    }
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (current && JSON.stringify(current) !== lastSaved) await save(JSON.stringify(current));
  }

  // Auto-save every edit, debounced.
  $effect(() => {
    if (!current) return;
    const snapshot = JSON.stringify(current);
    if (snapshot === lastSaved) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(snapshot), SAVE_MS);
  });

  async function create() {
    await flush();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await releases.save({ name: `Rilis ${today}`, version: '', targetBranch: 'master', sourceBranch: 'staging', minApprovals: 1, projectIds: [], codenames: [], jiraKeys: [], services: [], items: [], steps: [], shares: [], accepted: [], status: 'draft' });
      setCurrent(r);
      report = null;
      derivedCodenames = [];
      location.hash = `#/releases/${r.id}`;
    } catch (e) {
      toasts.show(`Gagal membuat rilis: ${(e as Error).message}`, 'err');
    }
  }

  async function remove() {
    if (!current) return;
    const ok = await confirmDialog({ title: 'Hapus rilis?', message: `Rilis "${current.name}" dan checklist-nya dihapus dari Cockpit. MR, tiket, dan halaman Confluence tidak ikut terhapus.`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    clearTimeout(saveTimer);
    list = await releases.remove(current.id);
    current = null;
    location.hash = list[0] ? `#/releases/${list[0].id}` : '#/releases';
  }

  /** Runs a server action on the saved release and takes its result as the new state. */
  async function act(kind: 'discover' | 'check') {
    if (!current) return;
    await flush();
    busy = kind;
    try {
      if (kind === 'discover') {
        const r = await releases.discover(current.id);
        setCurrent(r.release);
        derivedCodenames = await releases.codenames(r.release.id).catch(() => derivedCodenames);
        toasts.show(`${r.addedMrs} MR dan ${r.addedServices} service baru ditemukan.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`, r.warnings.length ? 'info' : 'ok', 6000);
      } else {
        const r = await releases.check(current.id);
        setCurrent(r.release);
        report = r.report;
        toasts.show(r.report.warnings.length ? `Cek selesai: ${r.report.warnings.length} hal perlu perhatian.` : 'Cek selesai: tidak ada masalah.', r.report.warnings.length ? 'info' : 'ok', 5000);
      }
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      busy = '';
    }
  }

  /** Ready/released while the code does not match the scope needs a second look. */
  async function changeStatus(el: HTMLSelectElement) {
    if (!current) return;
    const next = el.value as Release['status'];
    if ((next === 'ready' || next === 'released') && (!report || !report.scope?.matched)) {
      const why = !report ? 'Cek rilis belum dijalankan.' : `Scope belum sesuai: ${report.scope.missing} tiket belum ada di kode, ${report.scope.carried} tiket di luar scope terbawa, ${report.scope.commitsWithoutKey} commit tanpa Jira key.`;
      const ok = await confirmDialog({ title: `Tandai "${RELEASE_STATUS_LABELS[next]}"?`, message: `${why} Tetap ubah status?`, confirmText: 'Tetap ubah', danger: true });
      if (!ok) {
        el.value = current.status;
        return;
      }
    }
    current.status = next;
  }

  let acceptNote = $state<Record<string, string>>({});
  function includeInScope(key: string) {
    if (!current || current.jiraKeys.includes(key)) return;
    current.jiraKeys = [...current.jiraKeys, key];
    keysText = current.jiraKeys.join(', ');
    toasts.show(`${key} masuk scope. Jalankan cek lagi untuk memperbarui status.`, 'info', 3500);
  }
  function acceptCarried(key: string) {
    if (!current) return;
    current.accepted = [...(current.accepted ?? []).filter((a) => a.key !== key), { key, ...(acceptNote[key]?.trim() ? { note: acceptNote[key].trim() } : {}), at: new Date().toISOString() }];
    toasts.show(`${key} ditandai sengaja ikut. Jalankan cek lagi untuk memperbarui status.`, 'info', 3500);
  }
  function unaccept(key: string) {
    if (!current) return;
    current.accepted = (current.accepted ?? []).filter((a) => a.key !== key);
  }

  function applyCodenames() {
    if (!current) return;
    current.codenames = [...new Set(codenameText.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  }
  function applyKeys() {
    if (!current) return;
    current.jiraKeys = [...new Set(keysText.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g) ?? [])];
  }
  function toggleProject(id: string) {
    if (!current) return;
    current.projectIds = current.projectIds.includes(id) ? current.projectIds.filter((p) => p !== id) : [...current.projectIds, id];
  }

  function addService() {
    if (!current) return;
    current.services = [...current.services, { id: crypto.randomUUID(), name: `service-${current.services.length + 1}`, mrs: [], order: current.services.length + 1 }];
  }
  function removeService(s: ReleaseService) {
    if (!current) return;
    current.services = current.services.filter((x) => x.id !== s.id).map((x, i) => ({ ...x, order: i + 1 }));
  }
  function move(s: ReleaseService, dir: -1 | 1) {
    if (!current) return;
    const arr = [...current.services].sort((a, b) => a.order - b.order);
    const i = arr.findIndex((x) => x.id === s.id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    current.services = arr.map((x, k) => ({ ...x, order: k + 1 }));
  }
  function addMr(s: ReleaseService) {
    if (!current) return;
    const ref = mrRefFromUrl((mrInput[s.id] ?? '').trim());
    if (!ref) return void toasts.show('Tempel link MR GitLab (…/-/merge_requests/123).', 'err', 3000);
    const key = `${ref.projectPath}!${ref.iid}`;
    if (allMrs.some((m) => m.ref === key)) return void toasts.show('MR itu sudah ada di rilis ini.', 'info');
    const owner = current.services.find((x) => x.id === s.id)!;
    owner.mrs = [...owner.mrs, { ref: key, projectPath: ref.projectPath, iid: ref.iid, webUrl: ref.webUrl, via: 'manual' }];
    owner.gitlabPath ??= ref.projectPath;
    mrInput[s.id] = '';
    const other = serviceForPath(current.services, ref.projectPath);
    if (other && other.id !== s.id) toasts.show(`Catatan: repo MR ini tampak milik service ${other.name}.`, 'info', 4000);
  }
  async function removeOutside() {
    if (!current || !outside.length) return;
    const ok = await confirmDialog({ title: 'Hapus service di luar scope?', message: `${outside.map((s) => s.name).join(', ')} tidak punya tiket scope dan tidak punya MR. Service ini dan item checklist-nya dihapus dari rilis.`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    const next = removeServices($state.snapshot(current) as Release, outside.map((s) => s.id));
    current.services = next.services;
    current.items = next.items;
    current.steps = next.steps;
    toasts.show(`${outside.length} service dihapus dari rilis.`, 'ok', 2500);
  }

  async function resetDoc() {
    if (!current) return;
    const ok = await confirmDialog({ title: 'Susun ulang dokumen dari data rilis?', message: 'Change Log, Release List, bukti test, status, actual, link, dan commit id manual dikosongkan, lalu dokumen disusun dari rilis (commit dari MR, tiket dari scope). Orang per peran, Deployment Room, jam rilis, dan isian per service lain tetap.', confirmText: 'Kosongkan' });
    if (!ok) return;
    const next = resetDocumentData($state.snapshot(current) as Release);
    current.services = next.services;
    current.deploy = next.deploy;
    toasts.show('Dokumen sekarang mengikuti data rilis.', 'ok', 2500);
  }

  /** Opens an MR in MR Review (diff per file, AI review incl. background, TAD conformance). */
  async function reviewMr(webUrl: string) {
    await flush();
    try {
      sessionStorage.setItem(OPEN_MR_KEY, webUrl);
    } catch {
      /* storage blocked: MR Review opens on its list */
    }
    location.hash = '#/mr';
  }

  function removeMr(s: ReleaseService, ref: string) {
    if (!current) return;
    const owner = current.services.find((x) => x.id === s.id)!;
    owner.mrs = owner.mrs.filter((m) => m.ref !== ref);
  }

  function toggleItem(i: ReleaseItem) {
    i.done = !i.done;
    i.doneAt = i.done ? new Date().toISOString() : undefined;
  }
  function addItem() {
    if (!current || !newItem.label.trim()) return;
    current.items = [...current.items, { id: crypto.randomUUID(), kind: newItem.kind, label: newItem.label.trim(), ...(newItem.service ? { service: newItem.service } : {}), source: 'manual', done: false }];
    newItem = { ...newItem, label: '' };
  }
  function addStep() {
    if (!current || !newStep.text.trim()) return;
    current.steps = [...current.steps, { id: crypto.randomUUID(), kind: newStep.kind, text: newStep.text.trim(), done: false }];
    newStep = { ...newStep, text: '' };
  }

  async function copyDoc() {
    try {
      await navigator.clipboard.writeText(docMd);
      toasts.show('Dokumen rilis (Markdown) disalin.', 'ok', 2000);
    } catch {
      toasts.show('Tidak bisa menyalin ke clipboard.', 'err');
    }
  }

  function onImported(r: Release) {
    setCurrent(r);
    tab = 'board';
  }

  const pipeClass = (p?: string) => (p === 'success' ? 'ok' : p === 'failed' || p === 'canceled' ? 'err' : p ? 'warn' : '');
  const stateLabel = (c?: MrCheck) => (!c ? 'belum dicek' : c.error ? 'gagal dicek' : c.state === 'merged' ? 'merged' : c.state === 'closed' ? 'ditutup' : c.draft ? 'draft' : 'terbuka');
  const fmt = (d?: string) => (d ? new Date(d.length > 10 ? d : `${d}T00:00:00Z`).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', ...(d.length > 10 ? { hour: '2-digit', minute: '2-digit' } : { timeZone: 'UTC' }) }) : '');
  const kindLabel: Record<ReleaseItem['kind'], string> = { env: 'Env baru', migration: 'Migrasi', sql: 'Query manual' };
</script>

<div class="releases">
  <aside class="list">
    <div class="list-head">
      <h2>Rilis</h2>
      <button class="btn btn-primary btn-sm" onclick={create}><Icon name="plus" size={13} /> Baru</button>
    </div>
    <p class="muted small hint">Satu rilis = semua MR ke branch produksi dari service yang ikut, plus env, migrasi, query, dan langkah deploy-nya.</p>
    {#if loaded && !list.length}<p class="muted small">Belum ada rilis.</p>{/if}
    {#each list as r (r.id)}
      <a class="item" class:active={r.id === current?.id} href="#/releases/{r.id}">
        <strong>{r.id === current?.id ? current.name : r.name}{(r.id === current?.id ? current.version : r.version) ? ` ${r.id === current?.id ? current.version : r.version}` : ''}</strong>
        <span class="muted small">{r.date ? fmt(r.date) : 'tanggal belum diisi'} · {r.services.length} service</span>
        <span class="st st-{r.status}">{RELEASE_STATUS_LABELS[r.status]}</span>
      </a>
    {/each}
  </aside>

  <section class="main">
    {#if !loaded}
      <div class="empty muted">Memuat rilis…</div>
    {:else if !current}
      <div class="empty">
        <Icon name="send" size={28} />
        <h2>Belum ada rilis dipilih</h2>
        <p class="muted">Buat rilis, pilih proyek yang ikut (atau import dokumen rilis), lalu biarkan Cockpit mencari MR ke master per service dan mengecek env, migrasi, dan query yang perlu dijalankan.</p>
        <button class="btn btn-primary" onclick={create}><Icon name="plus" size={14} /> Buat rilis</button>
      </div>
    {:else}
      <header class="head">
        <div class="title-row">
          <input class="input name" bind:value={current.name} aria-label="Nama rilis" />
          <input class="input ver" bind:value={current.version} placeholder="versi, mis. v2.4.0" aria-label="Versi" />
          <input class="input date" type="date" bind:value={current.date} aria-label="Tanggal rilis" />
          <select class="input status" value={current.status} onchange={(e) => changeStatus(e.currentTarget)} aria-label="Status">
            {#each RELEASE_STATUSES as s (s)}<option value={s}>{RELEASE_STATUS_LABELS[s]}</option>{/each}
          </select>
          <button class="btn btn-ghost btn-sm danger" onclick={remove} title="Hapus rilis"><Icon name="trash" size={14} /></button>
        </div>
        <div class="meta-row">
          <label class="inline small" title="Branch asal MR rilis baru">Branch sumber <input class="input tiny mono" value={current.sourceBranch ?? 'staging'} oninput={(e) => current && (current.sourceBranch = e.currentTarget.value.trim() || 'staging')} /></label>
          <label class="inline small">Branch target <input class="input tiny mono" bind:value={current.targetBranch} /></label>
          <label class="inline small" title="Placeholder: {'{TARGET}'} {'{RELEASE}'} {'{VERSION}'} {'{SERVICE}'} {'{CODENAME}'}">Judul MR <input class="input mono tmpl" value={current.mrTitleTemplate ?? ''} oninput={(e) => current && (current.mrTitleTemplate = e.currentTarget.value || undefined)} placeholder={DEFAULT_MR_TITLE} /></label>
          {#if current.services[0]}<span class="muted small">contoh: {mrTitle(current, current.services[0])}</span>{/if}
          <label class="inline small" title="Approval minimal per MR sebelum rilis dianggap siap">Approval minimal <input class="input tiny" type="number" min="0" max="5" bind:value={current.minApprovals} /></label>
          {#if saveError}<span class="err small">Gagal menyimpan: {saveError}</span>{/if}
        </div>
        <div class="scope">
          <div class="scope-col">
            <span class="label">Proyek yang ikut</span>
            <div class="chips">
              {#each projects as p (p.id)}
                <button class="chip-btn" class:on={current.projectIds.includes(p.id)} onclick={() => toggleProject(p.id)}>{p.name}</button>
              {:else}
                <span class="muted small">Belum ada proyek di Cockpit.</span>
              {/each}
            </div>
          </div>
          <div class="scope-col">
            <span class="label" title="Tiket dengan CODENAME ini ([TYPE][SERVICE][CODENAME] - …) ikut rilis walau tidak ada di TAD">Codename</span>
            <input class="input" bind:value={codenameText} onblur={applyCodenames} placeholder="mis. SWITCHING, TECH-DEBT" />
            {#if derivedCodenames.length}<span class="muted small">Dipakai: {derivedCodenames.join(', ')} (termasuk dari judul task TAD)</span>{/if}
          </div>
          <div class="scope-col">
            <span class="label">Tiket tambahan</span>
            <input class="input" bind:value={keysText} onblur={applyKeys} placeholder="mis. MU-120, MU-121" />
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-primary" onclick={() => act('discover')} disabled={!!busy} title="Cari service yang disentuh tiket rilis dan MR ke branch target di GitLab"><Icon name="search" size={13} /> {busy === 'discover' ? 'Mencari…' : 'Cari service & MR'}</button>
          <button class="btn btn-sm btn-primary" onclick={() => act('check')} disabled={!!busy || !allMrs.length} title="Cek tiap MR: env baru, migrasi, query manual, commit tanpa Jira key, approval, pipeline, dan tiket yang belum ikut"><Icon name="check" size={13} /> {busy === 'check' ? 'Mengecek…' : 'Jalankan cek'}</button>
          <button class="btn btn-sm" onclick={() => (importOpen = true)}><Icon name="upload" size={13} /> Import dokumen</button>
          <button class="btn btn-sm" onclick={async () => { await flush(); shareOpen = true; }} disabled={!allMrs.length}><Icon name="teams" size={13} /> Share MR ke Teams</button>
          <button class="btn btn-sm" onclick={async () => { await flush(); publishOpen = true; }}><Icon name="confluence" size={13} /> Publish ke Confluence</button>
          {#if report}<span class="muted small">Cek terakhir {fmt(report.checkedAt)}</span>{/if}
        </div>
      </header>

      {#if report?.warnings.length}
        <div class="warnings">
          {#each report.warnings as w (w)}<p><Icon name="alert" size={13} /> {w}</p>{/each}
        </div>
      {/if}

      {#if report?.scope}
        {@const sc = report.scope}
        <div class="scope-card" class:ok={sc.matched}>
          <strong><Icon name={sc.matched ? 'check' : 'alert'} size={14} /> {sc.matched ? 'Scope sesuai: kode di MR rilis sama dengan scope rilis.' : 'Scope belum sesuai dengan kode yang akan dirilis.'}</strong>
          <span class="small">
            {sc.inCode}/{sc.tickets} tiket scope ada di kode ·
            <span class:bad={sc.missing}>{sc.missing} belum ada di kode</span> ·
            <span class:bad={sc.carried}>{sc.carried} di luar scope terbawa</span> ·
            <span class:bad={sc.commitsWithoutKey}>{sc.commitsWithoutKey} commit tanpa Jira key</span>{sc.accepted ? ` · ${sc.accepted} sengaja ikut` : ''}
          </span>
          {#if !sc.matched}<button class="link-btn small" onclick={() => (tab = 'tickets')}>Lihat detail</button>{/if}
        </div>
      {/if}

      <div class="tabs">
        <button class:active={tab === 'board'} onclick={() => (tab = 'board')}><Icon name="dashboard" size={14} /> Papan ({current.services.length})</button>
        <button class:active={tab === 'checklist'} onclick={() => (tab = 'checklist')}><Icon name="list" size={14} /> Checklist {pendingItems ? `(${pendingItems} belum)` : ''}</button>
        <button class:active={tab === 'tickets'} onclick={() => (tab = 'tickets')}><Icon name="jira" size={14} /> Tiket {report ? `(${report.tickets.length})` : ''}</button>
        <button class:active={tab === 'doc'} onclick={() => (tab = 'doc')}><Icon name="doc" size={14} /> Dokumen</button>
      </div>

      <div class="body">
        {#if tab === 'board'}
          {#if outside.length}
            <div class="outside">
              <Icon name="alert" size={13} />
              <span class="small">{outside.length} service tidak punya tiket scope dan tidak punya MR: <strong>{outside.map((s) => s.name).join(', ')}</strong>. Biasanya sisa import dokumen lama.</span>
              <button class="btn btn-sm" onclick={removeOutside}><Icon name="trash" size={12} /> Hapus dari rilis</button>
            </div>
          {/if}
          {#if !current.services.length}
            <p class="muted">Belum ada service. Pilih proyek atau codename di atas lalu klik <strong>Cari service & MR</strong>, import dokumen rilis, atau tambah manual.</p>
          {/if}
          {#each [...current.services].sort((a, b) => a.order - b.order) as s (s.id)}
            {@const noMr = report?.servicesWithoutMr.some((x) => x.toLowerCase() === s.name.toLowerCase())}
            <div class="svc" class:missing={noMr || !s.mrs.length} class:faded={outside.some((o) => o.id === s.id)}>
              <div class="svc-head">
                <span class="order">{s.order}</span>
                <span class="mv">
                  <button class="icon-btn" onclick={() => move(s, -1)} aria-label="Naikkan urutan">▲</button>
                  <button class="icon-btn" onclick={() => move(s, 1)} aria-label="Turunkan urutan">▼</button>
                </span>
                <input class="input svc-name" bind:value={s.name} aria-label="Nama service" />
                {#if outside.some((o) => o.id === s.id)}<span class="badge b-err">di luar scope</span>{/if}
                <input class="input mono path" bind:value={s.gitlabPath} placeholder="group/repo di GitLab" aria-label="Path GitLab" />
                <input class="input mono src" value={s.sourceBranch ?? ''} oninput={(e) => (s.sourceBranch = e.currentTarget.value.trim() || undefined)} placeholder={current.sourceBranch ?? 'staging'} title="Branch sumber MR rilis untuk service ini (kosong = {current.sourceBranch ?? 'staging'})" aria-label="Branch sumber" />
                <input class="input pic" bind:value={s.pic} placeholder="PIC" aria-label="PIC" />
                <button class="btn btn-ghost btn-sm" onclick={() => removeService(s)} aria-label="Hapus service {s.name}"><Icon name="trash" size={12} /></button>
              </div>
              {#if !s.mrs.length}
                <p class="err small no-mr"><Icon name="alert" size={12} /> Belum ada MR ke {current.targetBranch}. <button class="btn btn-sm btn-primary" onclick={async () => { await flush(); mrFor = s; }} disabled={!s.gitlabPath} title={s.gitlabPath ? `Buat MR ${s.sourceBranch ?? current.sourceBranch ?? 'staging'} ke ${current.targetBranch}` : 'Isi path GitLab dulu'}><Icon name="merge" size={12} /> Buat MR</button></p>
              {/if}
              {#each s.mrs as m (m.ref)}
                {@const c = checkOf(m.ref)}
                <div class="mr">
                  <div class="mr-main">
                    <a href={m.webUrl} target="_blank" rel="noreferrer" class="mono">{m.ref}</a>
                    <span class="mr-title">{c?.title ?? m.title ?? ''}</span>
                    <span class="badge b-{c?.state ?? 'none'}">{stateLabel(c)}</span>
                    {#if c && !c.error}
                      {#if c.pipeline}<span class="badge b-{pipeClass(c.pipeline)}">pipeline {c.pipeline}</span>{/if}
                      {#if c.state === 'opened'}<span class="badge" class:b-ok={c.approvals.count >= current.minApprovals} class:b-warn={c.approvals.count < current.minApprovals} title={c.approvals.by.join(', ')}>{c.approvals.count}/{current.minApprovals} approval</span>{/if}
                      {#if c.hasConflicts}<span class="badge b-err">konflik</span>{/if}
                      {#if c.targetBranch !== current.targetBranch}<span class="badge b-err">ke {c.targetBranch}</span>{/if}
                    {/if}
                    <button class="btn btn-sm btn-ghost" onclick={() => reviewMr(m.webUrl)} title="Buka di MR Review: diff per file, review AI (bisa di background), dan cek kesesuaian TAD"><Icon name="eye" size={12} /> Review</button>
                    <button class="icon-btn" onclick={() => removeMr(s, m.ref)} aria-label="Lepas MR {m.ref}"><Icon name="x" size={11} /></button>
                  </div>
                  {#if c && !c.error}
                    <div class="findings small">
                      {#if c.envAdded.length}<span><strong>Env baru:</strong> <span class="mono">{c.envAdded.join(', ')}</span></span>{/if}
                      {#if c.envReadInCode.length}<span title="Dibaca di kode baru; pastikan ada di server"><strong>Env dibaca di kode:</strong> <span class="mono">{c.envReadInCode.join(', ')}</span></span>{/if}
                      {#if c.migrations.length}<span><strong>Migrasi:</strong> <span class="mono">{c.migrations.join(', ')}</span></span>{/if}
                      {#if c.sqlOutside.length}<span class="warn-text"><strong>SQL di luar folder migrasi:</strong> <span class="mono">{c.sqlOutside.join(', ')}</span></span>{/if}
                      {#if c.modelWithoutMigration.length}<span class="warn-text"><strong>Model berubah tanpa migrasi:</strong> <span class="mono">{c.modelWithoutMigration.join(', ')}</span></span>{/if}
                      {#if c.commitsWithoutKey.length}<span class="warn-text"><strong>{c.commitsWithoutKey.length} commit tanpa Jira key</strong> <span class="muted">({c.commitsWithoutKey.slice(0, 3).join('; ')}{c.commitsWithoutKey.length > 3 ? '; …' : ''})</span></span>{/if}
                      {#each report?.outOfScope.filter((o) => o.mrs.includes(m.ref)) ?? [] as o (o.key)}
                        <span class="err-text"><strong>Di luar scope:</strong> <span class="mono">{o.key}</span> {o.summary ?? ''}{o.commits[0] ? ` · ${o.commits[0]}` : ''}</span>
                      {/each}
                      {#if c.diffTruncated}<span class="muted">Diff terpotong: cek env secara manual.</span>{/if}
                      {#if !bringsSummary(c) && !c.envReadInCode.length && !c.commitsWithoutKey.length && !c.modelWithoutMigration.length}<span class="muted">Tidak membawa env, migrasi, atau query.</span>{/if}
                    </div>
                  {:else if c?.error}
                    <p class="err small">{c.error}</p>
                  {/if}
                </div>
              {/each}
              <button class="link-btn small" onclick={() => (openDetail[s.id] = !openDetail[s.id])}>{openDetail[s.id] ? '▾' : '▸'} Detail deployment (commit id, .env, pre/post-deploy, failover)</button>
              {#if openDetail[s.id]}<ServiceDeployFields service={s} checks={report?.mrs ?? []} />{/if}
              <div class="add-mr">
                <input class="input mono" value={mrInput[s.id] ?? ''} oninput={(e) => (mrInput[s.id] = e.currentTarget.value)} placeholder="Tempel link MR ke {current.targetBranch}" aria-label="Link MR" onkeydown={(e) => e.key === 'Enter' && addMr(s)} />
                <button class="btn btn-sm" onclick={() => addMr(s)}><Icon name="plus" size={12} /> MR</button>
                {#if s.mrs.length}<button class="btn btn-sm btn-ghost" onclick={async () => { await flush(); mrFor = s; }} disabled={!s.gitlabPath}><Icon name="merge" size={12} /> Buat MR lain</button>{/if}
              </div>
            </div>
          {/each}
          <button class="btn btn-sm" onclick={addService}><Icon name="plus" size={12} /> Service</button>
        {:else if tab === 'checklist'}
          {#each ['env', 'migration', 'sql'] as const as kind (kind)}
            {@const items = current.items.filter((i) => i.kind === kind)}
            <section class="group">
              <h4>{kindLabel[kind]} ({items.filter((i) => !i.done).length} belum)</h4>
              {#each items as i (i.id)}
                <label class="check-item" class:done={i.done}>
                  <input type="checkbox" checked={i.done} onchange={() => toggleItem(i)} />
                  <span>{#if i.service}<strong>{i.service}:</strong>&nbsp;{/if}<span class="mono">{i.label}</span> <span class="muted small">· {i.source === 'check' ? 'dari cek MR' : i.source === 'import' ? 'dari dokumen' : 'manual'}{i.done && i.doneAt ? ` · selesai ${fmt(i.doneAt)}` : ''}</span></span>
                  <button class="icon-btn" onclick={(e) => { e.preventDefault(); current && (current.items = current.items.filter((x) => x.id !== i.id)); }} aria-label="Hapus item"><Icon name="x" size={11} /></button>
                </label>
                {#if i.detail && i.detail !== i.label}<pre class="sql">{i.detail}</pre>{/if}
              {:else}
                <p class="muted small">Tidak ada.</p>
              {/each}
            </section>
          {/each}
          <div class="add-row">
            <select class="input tiny-select" bind:value={newItem.kind} aria-label="Jenis">
              <option value="env">Env baru</option><option value="migration">Migrasi</option><option value="sql">Query manual</option>
            </select>
            <input class="input" bind:value={newItem.label} placeholder="Nama env / file migrasi / query" />
            <select class="input tiny-select" bind:value={newItem.service} aria-label="Service">
              <option value="">service…</option>
              {#each current.services as s (s.id)}<option value={s.name}>{s.name}</option>{/each}
            </select>
            <button class="btn btn-sm" onclick={addItem} disabled={!newItem.label.trim()}><Icon name="plus" size={12} /> Tambah</button>
          </div>

          {#each ['deploy', 'rollback'] as const as kind (kind)}
            {@const steps = current.steps.filter((s) => s.kind === kind)}
            <section class="group">
              <h4>{kind === 'deploy' ? 'Langkah deploy' : 'Rollback'}</h4>
              {#each steps as st, n (st.id)}
                <label class="check-item" class:done={st.done}>
                  <input type="checkbox" checked={st.done} onchange={() => { st.done = !st.done; st.doneAt = st.done ? new Date().toISOString() : undefined; }} />
                  <span>{n + 1}. {st.text}</span>
                  <button class="icon-btn" onclick={(e) => { e.preventDefault(); current && (current.steps = current.steps.filter((x) => x.id !== st.id)); }} aria-label="Hapus langkah"><Icon name="x" size={11} /></button>
                </label>
              {:else}
                <p class="muted small">Belum ada.</p>
              {/each}
            </section>
          {/each}
          <div class="add-row">
            <select class="input tiny-select" bind:value={newStep.kind} aria-label="Jenis langkah"><option value="deploy">Deploy</option><option value="rollback">Rollback</option></select>
            <input class="input" bind:value={newStep.text} placeholder="mis. Deploy core-payment, jalankan migrasi, smoke test" onkeydown={(e) => e.key === 'Enter' && addStep()} />
            <button class="btn btn-sm" onclick={addStep} disabled={!newStep.text.trim()}><Icon name="plus" size={12} /> Langkah</button>
          </div>
        {:else if tab === 'tickets'}
          {#if !report}
            <p class="muted">Klik <strong>Jalankan cek</strong> untuk melihat tiket rilis (dari TAD, codename, dan tiket tambahan) dan apakah sudah masuk MR.</p>
          {:else}
            <table class="tbl">
              <thead><tr><th>Tiket</th><th>Judul</th><th>Status</th><th>Sumber</th><th>Di MR rilis</th></tr></thead>
              <tbody>
                {#each report.tickets as t (t.key)}
                  <tr class:missing={!t.inMrs.length}>
                    <td class="mono">{t.key}</td>
                    <td>{t.summary}</td>
                    <td><span class="badge" class:b-ok={t.devDone} class:b-warn={!t.devDone}>{t.status}</span></td>
                    <td class="small">{t.from === 'tad' ? 'TAD' : t.from === 'codename' ? 'codename' : 'tambahan'}</td>
                    <td class="small">{t.inMrs.length ? t.inMrs.join(', ') : 'belum'}</td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="muted">Tidak ada tiket. Pilih proyek, isi codename, atau tambah tiket.</td></tr>
                {/each}
              </tbody>
            </table>
            <h4 class:err-text={report.outOfScope.length}>Di luar scope, ikut terbawa di kode ({report.outOfScope.length})</h4>
            {#if report.outOfScope.length}
              <p class="muted small">Jira key ini ada di commit MR rilis tapi bukan bagian dari scope (TAD, codename, tiket tambahan). Keluarkan commit-nya dari branch rilis, masukkan tiketnya ke scope, atau tandai sengaja ikut.</p>
              <table class="tbl">
                <thead><tr><th>Tiket</th><th>Judul</th><th>Status</th><th>MR</th><th>Commit</th><th></th></tr></thead>
                <tbody>
                  {#each report.outOfScope as o (o.key)}
                    <tr class="missing">
                      <td class="mono">{o.key}</td>
                      <td>{o.summary ?? 'tidak termuat dari Jira'}{o.codename ? ` · codename ${o.codename}` : ''}</td>
                      <td class="small">{o.status ?? '-'}</td>
                      <td class="small">{o.mrs.join(', ')}</td>
                      <td class="small">{o.commits.slice(0, 2).join('; ')}</td>
                      <td class="acts">
                        <button class="btn btn-sm" onclick={() => includeInScope(o.key)}>Masukkan ke scope</button>
                        <input class="input tiny-note" placeholder="alasan (opsional)" value={acceptNote[o.key] ?? ''} oninput={(e) => (acceptNote[o.key] = e.currentTarget.value)} />
                        <button class="btn btn-sm btn-ghost" onclick={() => acceptCarried(o.key)}>Sengaja ikut</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="muted small">Tidak ada tiket di luar scope di kode MR rilis.</p>
            {/if}
            {#if current.accepted?.length}
              <h4>Ditandai sengaja ikut</h4>
              <ul class="small">{#each current.accepted as a (a.key)}<li><span class="mono">{a.key}</span>{a.note ? ` · ${a.note}` : ''} <button class="link-btn" onclick={() => unaccept(a.key)}>batalkan</button></li>{/each}</ul>
            {/if}
            {#if report.badTitles.length}
              <h4>Judul tiket tidak mengikuti format [TYPE][SERVICE][CODENAME] - Nama</h4>
              <ul class="small">{#each report.badTitles as b (b.key)}<li><span class="mono">{b.key}</span> {b.summary}</li>{/each}</ul>
            {/if}
          {/if}
        {:else}
          <div class="doc-bar">
            {#if current.source}
              <span class="small">Sumber: {current.source.kind === 'confluence' ? 'Confluence' : 'Markdown'} · <strong>{current.source.title}</strong>{current.source.version ? ` · versi ${current.source.version}` : ''} · diimport {fmt(current.source.importedAt)}</span>
              {#if current.source.url}<a class="small" href={current.source.url} target="_blank" rel="noreferrer">Buka <Icon name="external" size={11} /></a>{/if}
            {/if}
            {#if current.published}<span class="small">Dipublish ke Confluence versi {current.published.version} {#if current.published.url}<a href={current.published.url} target="_blank" rel="noreferrer">Buka <Icon name="external" size={11} /></a>{/if}</span>{/if}
            <button class="btn btn-sm" onclick={copyDoc}><Icon name="copy" size={12} /> Salin Markdown</button>
            <button class="btn btn-sm btn-ghost" onclick={resetDoc} title="Kosongkan isi dokumen lama (Change Log, Release List, bukti test, status, commit id manual) supaya dokumen mengikuti data rilis"><Icon name="refresh" size={12} /> Susun ulang dari data rilis</button>
          </div>
          <DeployInfoForm release={current} />
          <div class="docs">
            <article class="doc rich">
              <h4>Pratinjau dokumen Deployment (seperti di Confluence)</h4>
              <div class="release-preview"><PreviewPane html={previewHtml} embedded /></div>
            </article>
            {#if current.docMarkdown}
              <article class="doc">
                <h4>Dokumen yang diimport</h4>
                <div class="md">{@html renderPreview(current.docMarkdown).html}</div>
              </article>
            {/if}
          </div>
          <label class="field"><span class="label">Catatan rilis</span><textarea class="input" rows="3" bind:value={current.notes}></textarea></label>
        {/if}
      </div>
    {/if}
  </section>
</div>

{#if current}
  <ReleaseImportDialog bind:open={importOpen} release={current} onimported={onImported} />
  <ShareMrModal bind:open={shareOpen} release={current} {report} onshared={(r) => setCurrent(r)} />
  <PublishReleaseModal bind:open={publishOpen} release={current} {report} onpublished={(r) => setCurrent(r)} />
  {#if mrFor}
    <CreateMrModal release={current} service={mrFor} onclose={() => (mrFor = null)} oncreated={(r) => { setCurrent(r); mrFor = null; }} onchanged={(r) => setCurrent(r)} />
  {/if}
{/if}

<style>
  .releases {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100%;
    overflow: hidden;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 12px;
    border-right: 1px solid var(--border);
    overflow: auto;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .list-head h2 {
    margin: 0;
    font-size: 16px;
  }
  .hint {
    margin: 0 0 6px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    color: var(--text);
    text-decoration: none;
  }
  .item:hover {
    background: var(--surface-hover);
  }
  .item.active {
    background: var(--accent-soft);
  }
  .st {
    align-self: flex-start;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--surface-hover);
  }
  .st-review {
    background: var(--warn-soft);
  }
  .st-ready,
  .st-released {
    background: var(--ok-soft);
  }
  .st-rolled-back {
    background: var(--err-soft);
  }
  .main {
    display: flex;
    flex-direction: column;
    overflow: auto;
    padding: 16px 20px;
    gap: 12px;
    min-width: 0;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin: auto;
    max-width: 520px;
    text-align: center;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .title-row,
  .meta-row,
  .actions,
  .doc-bar,
  .add-row,
  .add-mr {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .title-row .name {
    flex: 1 1 240px;
    font-size: 16px;
    font-weight: 600;
  }
  .title-row .ver {
    width: 150px;
  }
  .title-row .date {
    width: 160px;
  }
  .title-row .status {
    width: 140px;
  }
  .title-row > :global(.input),
  .add-row > :global(.input),
  .add-mr > :global(.input) {
    width: auto;
  }
  .add-row > :global(.input:not(select)),
  .add-mr > :global(.input) {
    flex: 1 1 200px;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tiny {
    width: 90px;
  }
  .tmpl {
    width: 200px;
  }
  .tiny-select {
    width: auto;
  }
  .danger {
    color: var(--err);
  }
  .scope {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr;
    gap: 12px;
  }
  .scope-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .label {
    font-size: 12px;
    font-weight: 600;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip-btn {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .chip-btn.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
  }
  .warnings {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .warnings p {
    margin: 0;
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .svc {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .svc.missing {
    border-color: var(--err);
  }
  .svc.faded {
    opacity: 0.6;
  }
  .outside {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
  }
  .svc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .svc-head > :global(.input) {
    width: auto;
  }
  .svc-name {
    flex: 1 1 160px;
    font-weight: 600;
  }
  .path {
    flex: 1 1 200px;
  }
  .pic {
    flex: 0 1 140px;
  }
  .svc-head .src {
    flex: 0 1 150px;
  }
  .no-mr {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .order {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent-soft);
    font-size: 12px;
    font-weight: 600;
  }
  .mv {
    display: flex;
    flex-direction: column;
  }
  .icon-btn {
    border: none;
    background: none;
    padding: 0 2px;
    cursor: pointer;
    color: var(--text-3);
    font-size: 9px;
    line-height: 1;
  }
  .mr {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .mr-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .mr-title {
    flex: 1 1 200px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--surface-hover);
  }
  .b-ok,
  .b-merged {
    background: var(--ok-soft);
  }
  .b-warn,
  .b-opened {
    background: var(--warn-soft);
  }
  .b-err,
  .b-closed {
    background: var(--err-soft);
  }
  .findings {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .scope-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 10px 12px;
    border: 1px solid var(--err);
    border-radius: var(--radius-sm);
    background: var(--err-soft);
  }
  .scope-card.ok {
    border-color: var(--ok, #16a34a);
    background: var(--ok-soft);
  }
  .scope-card strong {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .bad,
  .err-text {
    color: var(--err);
    font-weight: 600;
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .tiny-note {
    width: 140px;
    padding: 2px 6px;
    font-size: 12px;
  }
  .warn-text {
    color: var(--warn, #b45309);
  }
  .group h4 {
    margin: 6px 0;
    font-size: 13px;
  }
  .check-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }
  .check-item span {
    flex: 1;
  }
  .check-item.done span {
    text-decoration: line-through;
    color: var(--text-3);
  }
  .sql {
    margin: 0 0 6px 24px;
    padding: 8px;
    border-radius: 6px;
    background: var(--surface-2);
    font-size: 12px;
    overflow-x: auto;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .tbl th,
  .tbl td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }
  .tbl td.mono {
    white-space: nowrap;
  }
  .tbl tr.missing td {
    background: var(--err-soft);
  }
  .docs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }
  .doc {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: auto;
    max-height: 70vh;
  }
  .doc h4 {
    margin: 0 0 8px;
  }
  .md {
    font-size: 13px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .md :global(table) {
    border-collapse: collapse;
  }
  .md :global(td),
  .md :global(th) {
    border: 1px solid var(--border);
    padding: 4px 6px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .doc.rich {
    grid-column: 1 / -1;
    max-height: none;
  }
  .release-preview :global(.lozenge) {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    background: #dfe1e6;
    color: #42526e;
  }
  .release-preview :global(.lz-blue) {
    background: #deebff;
    color: #0747a6;
  }
  .release-preview :global(.lz-green) {
    background: #e3fcef;
    color: #006644;
  }
  .release-preview :global(.lz-yellow) {
    background: #fff0b3;
    color: #172b4d;
  }
  .release-preview :global(.lz-red) {
    background: #ffebe6;
    color: #bf2600;
  }
  .release-preview :global(.lz-purple) {
    background: #eae6ff;
    color: #403294;
  }
  .release-preview :global(ul.tasks) {
    list-style: none;
    padding-left: 0;
    margin: 2px 0;
  }
  .release-preview :global(li.task .box) {
    font-size: 15px;
  }
  .release-preview :global(li.task.done) {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .release-preview :global(.panel) {
    margin: 8px 0;
    padding: 10px 14px;
    border-radius: 4px;
    background: #deebff;
    color: #172b4d;
  }
  .release-preview :global(.panel-note) {
    background: #eae6ff;
  }
  .release-preview :global(.mention) {
    padding: 0 6px;
    border-radius: 10px;
    background: #dfe1e6;
    color: #172b4d;
    font-size: 12.5px;
  }
  .release-preview :global(th.numberingColumn),
  .release-preview :global(td.numberingColumn) {
    width: 32px;
    text-align: center;
    color: var(--text-3);
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
  @media (max-width: 900px) {
    .releases {
      grid-template-columns: 1fr;
    }
    .scope {
      grid-template-columns: 1fr;
    }
  }
</style>
