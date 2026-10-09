<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import AgentTaskLogViewer from '../components/AgentTaskLogViewer.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import TraceResult from './TraceResult.svelte';
  import { loadAiSelection, saveAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { traces as codeTraces } from '../lib/trace/client';
  import { agents, AgentApiError, groupByStatus, isLive } from '../lib/agents/client';
  import { AGENT_LIMITS, type AgentTask, type AgentTaskStatus } from '../lib/agents/types';
  import { bugs } from '../lib/bugs/client';
  import type { BugJob } from '../lib/bugs/types';

  let tasks = $state<AgentTask[]>([]);
  /** Tracing agents of Bug Tracing: analyses that run in the background before any task exists. */
  let traces = $state<BugJob[]>([]);
  let listError = $state('');
  let loading = $state(true);
  let busy = $state<Record<string, boolean>>({});

  let steerFor = $state<string | null>(null);
  let steerText = $state('');

  let expandedLogId = $state<string | null>(null);
  function toggleTaskLog(id: string) {
    expandedLogId = expandedLogId === id ? null : id;
  }

  // Every run of Cockpit's local coding agents: TAD tasks from the Task Board and fixes from Bug Tracing.
  const groups = $derived(groupByStatus(tasks));
  const KIND_LABEL: Record<string, string> = { general: 'Umum', review: 'Review MR', implement: 'Implement task', trace: 'Trace kode', e2e: 'E2E test' };

  // Code trace: one question box; the answer is traced in the background and listed below.
  let question = $state('');
  let traceAi = $state<AiSelection>(loadAiSelection('generator'));
  let tracing = $state(false);
  let openTrace = $state<string | null>(null);

  async function startTrace(e: SubmitEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    tracing = true;
    try {
      const t = await codeTraces.ask(q, traceAi);
      question = '';
      toasts.show('Trace berjalan di background. Hasilnya muncul di daftar ini.', 'ok');
      await refresh();
      const task = tasks.find((x) => x.links?.traceId === t.id);
      if (task) openTrace = task.id;
    } catch (err) {
      toasts.show(errMsg(err), 'err', 6000);
    } finally {
      tracing = false;
    }
  }

  /**
   * Opens where a run's diff, push and revise live: a bug fix in its Bug Tracing case (draft id
   * `bug-<caseId>`), a TAD task on the Task Board of the TAD's project.
   */
  function openTaskBoard(t: AgentTask) {
    const draftId = t.links?.draftId;
    if (!draftId) return;
    if (draftId.startsWith('bug-')) {
      location.hash = `#/bugs/${encodeURIComponent(draftId.slice(4))}`;
      return;
    }
    const id = encodeURIComponent(draftId);
    location.hash = `#/projects/new?draft=${id}&tab=board&tad=${id}`;
  }
  const hasLive = $derived(tasks.some(isLive) || traces.some((j) => j.status === 'running'));
  const TRACE_LABEL: Record<BugJob['status'], string> = { running: 'Menelusuri', done: 'Analisa selesai', error: 'Gagal', cancelled: 'Dibatalkan' };
  const TRACE_CHIP: Record<BugJob['status'], string> = { running: 'chip-accent', done: 'chip-ok', error: 'chip-err', cancelled: '' };

  async function cancelTrace(j: BugJob) {
    if (!(await confirmDialog({ title: 'Batalkan tracing?', message: `Hentikan agent tracing untuk "${j.caseTitle ?? 'bug'}"?`, confirmText: 'Batalkan tracing', danger: true }))) return;
    try {
      await bugs.cancel(j.id);
      traces = await bugs.jobs();
    } catch (e) {
      toasts.show(errMsg(e), 'err');
    }
  }

  const STATUS_LABEL: Record<AgentTaskStatus, string> = {
    pending: 'Pending',
    queued: 'Antri',
    running: 'Berjalan',
    blocked: 'Menunggu review kamu',
    completed: 'Selesai',
    failed: 'Gagal',
    cancelled: 'Dibatalkan',
  };
  const STATUS_CHIP: Record<AgentTaskStatus, string> = {
    pending: '',
    queued: 'chip-accent',
    running: 'chip-accent',
    blocked: 'chip-warn',
    completed: 'chip-ok',
    failed: 'chip-err',
    cancelled: '',
  };

  const errMsg = (e: unknown) => (e instanceof AgentApiError || e instanceof Error ? e.message : String(e));
  const fmt = (ts?: string) => (ts ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  async function refresh() {
    void bugs
      .jobs()
      .then((j) => (traces = j))
      .catch(() => {});
    try {
      tasks = await agents.list({ limit: 100 });
      listError = '';
    } catch (e) {
      listError = errMsg(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  // Poll quickly while something is running, slowly otherwise.
  $effect(() => {
    const ms = hasLive ? 4000 : 20000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  });

  async function act(t: AgentTask, label: string, fn: () => Promise<unknown>): Promise<boolean> {
    busy[t.id] = true;
    try {
      await fn();
      toasts.show(`${label}: ${t.title}`, 'ok');
      await refresh();
      return true;
    } catch (err) {
      toasts.show(errMsg(err), 'err', 6000);
      return false;
    } finally {
      busy[t.id] = false;
    }
  }

  async function cancel(t: AgentTask) {
    const ok = await confirmDialog({
      title: 'Batalkan run?',
      message: `Agent coding untuk "${t.title}" akan dihentikan.`,
      confirmText: 'Batalkan',
      danger: true,
    });
    if (!ok) return;
    await act(t, 'Dibatalkan', () => agents.cancel(t.id));
  }

  async function sendSteer(t: AgentTask) {
    if (await act(t, 'Revisi terkirim', () => agents.steer(t.id, steerText))) {
      steerText = '';
      steerFor = null;
    }
  }

  async function completeTask(t: AgentTask) {
    const ok = await confirmDialog({
      title: 'Tandai Selesai',
      message: `Tandai task "${t.title}" sebagai selesai?`,
      confirmText: 'Tandai Selesai',
    });
    if (!ok) return;
    await act(t, 'Task ditandai selesai', () => agents.complete(t.id, 'Ditandai selesai oleh user.'));
  }

  let syncingMrs = $state(false);
  async function syncMrs() {
    syncingMrs = true;
    try {
      const res = await agents.syncMrs();
      toasts.show(res.updated > 0 ? `${res.updated} task otomatis diperbarui dari status MR GitLab.` : 'Semua task sudah sinkron dengan GitLab.', 'ok');
      await refresh();
    } catch (e) {
      toasts.show(errMsg(e), 'err');
    } finally {
      syncingMrs = false;
    }
  }
</script>

<section class="page">
  <header>
    <div>
      <h1>Agent Tasks</h1>
      <p class="muted">
        Semua agent lokal di satu tempat: trace logic code, agent tracing bug (analisa di background), lalu agent coding untuk task TAD dan task dari analisa bug. Diff, push, dan review
        tetap di tanganmu; task otomatis selesai saat MR-nya merged.
      </p>
    </div>
    <div class="actions">
      <button class="btn btn-sm" disabled={syncingMrs} onclick={syncMrs} title="Cek status merge MR di GitLab">
        <Icon name="merge" size={14} /> {syncingMrs ? 'Mengecek GitLab…' : 'Sync MR GitLab'}
      </button>
      <button class="btn btn-sm" onclick={refresh}><Icon name="refresh" size={14} /> Muat ulang</button>
    </div>
  </header>

  <form class="trace-box" onsubmit={startTrace}>
    <textarea
      class="input"
      rows="2"
      bind:value={question}
      placeholder="Trace logic code: tanya apa saja, mis. &quot;Gimana alur refund dari callback sampai saldo kembali?&quot;"
      onkeydown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
      }}
    ></textarea>
    <div class="trace-actions">
      <span class="muted small">Agent membaca codebase Services (hanya baca) di background; tiap bukti file:baris dicek ulang.</span>
      <span class="grow"></span>
      <AiPicker value={traceAi} onchange={(s) => { traceAi = s; saveAiSelection('generator', s); }} disabled={tracing} />
      <button class="btn btn-sm btn-primary" type="submit" disabled={tracing || !question.trim()}><Icon name="search" size={13} /> {tracing ? 'Memulai…' : 'Trace'}</button>
    </div>
  </form>

  {#if traces.length}
    <h3 class="group">Agent tracing bug · {traces.length}</h3>
    <div class="list">
      {#each traces as j (j.id)}
        <article class="task">
          <div class="task-head">
            <div class="task-title">
              <strong>{j.caseTitle ?? 'Bug'}</strong>
              <span class="tags"><span class="chip">Tracing bug</span></span>
              <span class="muted small">Mulai {fmt(j.startedAt)}{j.finishedAt ? ` · selesai ${fmt(j.finishedAt)}` : ''}</span>
            </div>
            <span class="chip {TRACE_CHIP[j.status]}">{TRACE_LABEL[j.status]}</span>
          </div>
          {#if j.status === 'running' && j.progress}<div class="progress"><p class="small">{j.progress}</p></div>{/if}
          {#if j.error}<p class="err small">{j.error}</p>{/if}
          <div class="actions">
            <a class="btn btn-sm btn-primary" href="#/bugs/{j.caseId}"><Icon name="eye" size={14} /> {j.status === 'done' ? 'Lihat analisa & buat task' : 'Buka bug'}</a>
            {#if j.status === 'running'}
              <button class="btn btn-sm btn-danger" onclick={() => cancelTrace(j)}><Icon name="x" size={14} /> Batalkan</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  {#if listError}
    <p class="err">{listError}</p>
  {:else if loading}
    <p class="muted">Memuat…</p>
  {:else if !tasks.length}
    <div class="empty">
      <Icon name="bot" size={28} />
      <p>Belum ada agent task. Ajukan trace di atas, atau mulai agent coding dari Task Board proyek / task hasil analisa di Bug Tracing.</p>
    </div>
  {:else}
    {#each groups as g (g.status)}
      <h3 class="group">{STATUS_LABEL[g.status]} · {g.tasks.length}</h3>
      <div class="list">
        {#each g.tasks as t (t.id)}
          <article class="task" class:blocked={t.status === 'blocked'}>
            <div class="task-head">
              <div class="task-title">
                <strong>{t.title}</strong>
                <span class="tags">
                  <span class="chip">{KIND_LABEL[t.kind ?? 'general']}</span>
                  {#if t.links?.jiraKey}<span class="chip chip-accent">{t.links.jiraKey}</span>{/if}
                  {#if t.links?.repo}<span class="muted small mono">{t.links.repo}{t.links.branch ? ` · ${t.links.branch}` : ''}</span>{/if}
                </span>
                <span class="muted small">
                  {#if t.links?.tadTitle}{t.links.tadTitle} · {/if}{t.provider}{t.model ? ` / ${t.model}` : ''} · percobaan {t.attempts} · diperbarui {fmt(t.updatedAt)}
                </span>
              </div>
              <span class="chip {STATUS_CHIP[t.status]}">{STATUS_LABEL[t.status]}</span>
            </div>

            {#if t.progress && (t.progress.percent !== undefined || t.progress.message)}
              <div class="progress">
                {#if t.progress.percent !== undefined}
                  <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.progress.percent}>
                    <span style="width: {Math.max(0, Math.min(100, t.progress.percent))}%"></span>
                  </div>
                {/if}
                {#if t.progress.message}<p class="small">{t.progress.message}</p>{/if}
              </div>
            {/if}
            {#if t.error}<p class="err small">{t.error}</p>{/if}

            {#if t.kind === 'e2e'}
            <div class="actions">
              {#if t.links?.qaProjectId}
                <a class="btn btn-sm btn-primary" href="#/projects/{t.links.qaProjectId}?tab=e2e"><Icon name="eye" size={14} /> Buka tab E2E proyek</a>
              {/if}
              {#if t.status === 'queued' || t.status === 'running'}
                <button class="btn btn-sm btn-danger" disabled={busy[t.id]} onclick={() => cancel(t)}><Icon name="x" size={14} /> Batalkan</button>
              {/if}
            </div>
            {:else if t.kind === 'trace'}
            <div class="actions">
              {#if t.links?.traceId}
                <button class="btn btn-sm btn-primary" onclick={() => (openTrace = openTrace === t.id ? null : t.id)}>
                  <Icon name="eye" size={14} /> {openTrace === t.id ? 'Tutup hasil' : 'Lihat hasil & tanya lanjutan'}
                </button>
              {/if}
              {#if t.status === 'queued' || t.status === 'running'}
                <button class="btn btn-sm btn-danger" disabled={busy[t.id]} onclick={() => cancel(t)}><Icon name="x" size={14} /> Batalkan</button>
              {/if}
            </div>
            {#if openTrace === t.id && t.links?.traceId}
              <TraceResult traceId={t.links.traceId} onchange={refresh} />
            {/if}
            {:else}
            <div class="actions">
              {#if t.links?.draftId}
                <button class="btn btn-sm btn-primary" onclick={() => openTaskBoard(t)}><Icon name="eye" size={14} /> Diff, push & revisi di Task Board</button>
              {/if}
              {#if t.links?.mrUrl}
                <a class="btn btn-sm" href={t.links.mrUrl} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Halaman MR baru</a>
              {/if}
              {#if t.status === 'blocked' || t.status === 'completed' || t.status === 'failed'}
                <button class="btn btn-sm" disabled={busy[t.id]} onclick={() => (steerFor = steerFor === t.id ? null : t.id)}>Revisi</button>
              {/if}
              {#if t.status === 'queued' || t.status === 'running'}
                <button class="btn btn-sm btn-danger" disabled={busy[t.id]} onclick={() => cancel(t)}><Icon name="x" size={14} /> Batalkan</button>
              {/if}
              {#if t.status !== 'completed' && t.status !== 'cancelled'}
                <button class="btn btn-sm btn-ghost" disabled={busy[t.id]} onclick={() => completeTask(t)} title="Tandai task ini sudah selesai (misal MR sudah merged)">
                  <Icon name="check" size={14} /> Tandai selesai
                </button>
              {/if}
              <button class="btn btn-sm btn-ghost" onclick={() => toggleTaskLog(t.id)} title="Cek log progress task">
                <Icon name="list" size={14} /> {expandedLogId === t.id ? 'Tutup log' : 'Log progress'}
              </button>
            </div>
            {#if steerFor === t.id}
              <div class="steer">
                <textarea class="input" rows="3" bind:value={steerText} maxlength={AGENT_LIMITS.steer} placeholder="Catatan review / jawaban untuk agent coding…"></textarea>
                <button class="btn btn-sm btn-primary" disabled={busy[t.id] || !steerText.trim()} onclick={() => sendSteer(t)}>Kirim ke agent</button>
              </div>
            {/if}

            {#if expandedLogId === t.id}
              <AgentTaskLogViewer taskId={t.id} task={t} />
            {/if}
            {/if}
          </article>
        {/each}
      </div>
    {/each}
  {/if}
</section>

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 28px 24px;
    height: 100%;
    overflow: auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 16px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 22px;
  }
  header p {
    margin: 0;
  }
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
    color: var(--text-2);
  }
  .trace-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .trace-box textarea {
    resize: vertical;
  }
  .trace-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .empty {
    display: grid;
    place-items: center;
    gap: 4px;
    padding: 48px;
    color: var(--text-3);
    border: 1px dashed var(--border-strong);
    border-radius: 10px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .task {
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .task.blocked {
    border-color: var(--warn);
  }
  .task-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .task-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .progress {
    margin-top: 8px;
  }
  .progress p {
    margin: 4px 0 0;
    color: var(--text-2);
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .actions:empty {
    display: none;
  }
  .steer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-top: 8px;
  }
  .err {
    color: var(--err);
    margin: 6px 0 0;
  }
  .small {
    font-size: 12px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 2px 0;
  }
</style>
