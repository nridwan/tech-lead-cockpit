<script lang="ts">
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { qa, runReport } from '../lib/qa/client';
  import { QA_CATEGORIES, QA_CATEGORY_LABELS, type QACategory, type QAEnvironment, type QAFlow, type QAGenerateJob, type QARun, type QAStepResult, type QAStepStatus, type QASuite } from '../lib/qa/types';
  import type { EstimateProject } from '../lib/estimate/types';
  import type { Draft } from '../tad/drafts.svelte';
  import E2EEnvironmentModal from './E2EEnvironmentModal.svelte';
  import E2ELogViewer from './E2ELogViewer.svelte';
  import { projectDrafts, projectTasks, prdContext } from './project-tasks';

  /** E2E flows and runs belong to the project, so a flow can span the project's TADs. */
  let { project, drafts }: { project: Pick<EstimateProject, 'id' | 'name' | 'draftIds'>; drafts: Draft[] } = $props();

  const ENV_KEY = 'tlc.qa.environment';
  const POLL_MS = 1500;

  // Tasks of all the project's TADs; only those with a Detail Task can be tested (the AI needs the spec).
  const tasks = $derived(projectTasks(project, drafts));
  const multiTad = $derived(project.draftIds.length > 1);

  let suite = $state<QASuite | null>(null);
  let environments = $state<QAEnvironment[]>([]);
  let envId = $state(savedEnvId());
  let envModalOpen = $state(false);
  let tab = $state<'flows' | 'results'>('flows');

  // Generation
  let showGenerate = $state(false);
  let selectedTasks = $state(new Set<string>());
  let categories = $state(new Set<QACategory>(['happy-path', 'validation', 'auth', 'business-edge-case', 'integration-chain']));
  let instructions = $state('');
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let append = $state(false);
  let job = $state<QAGenerateJob | null>(null);

  // Editing
  let openFlows = $state(new Set<string>());
  let editingId = $state<string | null>(null);
  let editText = $state('');
  let editError = $state('');

  // Runs
  let runs = $state<QARun[]>([]);
  // Full-screen request log of a run.
  let logOpen = $state(false);
  let logRunId = $state<string | undefined>();
  function openLog(runId?: string) {
    logRunId = runId ?? activeRun?.id ?? runs[0]?.id;
    logOpen = true;
  }

  // Search over the test cases (flows): name, description, category, tasks, steps (name, method, path, service).
  let flowQuery = $state('');
  let flowCategory = $state<QACategory | ''>('');
  const visibleFlows = $derived.by(() => {
    const flows = suite?.flows ?? [];
    const terms = flowQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return flows.filter((f) => {
      if (flowCategory && f.category !== flowCategory) return false;
      if (!terms.length) return true;
      const hay = [f.name, f.description, QA_CATEGORY_LABELS[f.category], ...f.taskTitles, ...f.steps.flatMap((st) => [st.name, st.request.method, st.request.path, st.service ?? ''])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  });
  let activeRun = $state<QARun | null>(null);
  let openSteps = $state(new Set<string>());
  let starting = $state(false);

  function savedEnvId(): string {
    try {
      return localStorage.getItem(ENV_KEY) ?? '';
    } catch {
      return '';
    }
  }

  $effect(() => {
    try {
      if (envId) localStorage.setItem(ENV_KEY, envId);
    } catch {
      /* ignore */
    }
  });

  const services = $derived([...new Set([...tasks.map((t) => t.service), ...(suite?.flows ?? []).flatMap((f) => f.steps.map((s) => s.service ?? ''))].filter(Boolean))]);
  const env = $derived(environments.find((e) => e.id === envId));
  const enabledFlows = $derived(suite?.flows.filter((f) => f.enabled) ?? []);
  const generating = $derived(job?.status === 'running');
  const running = $derived(activeRun?.status === 'running');
  /** Last result of each flow in the shown run, for the badges in the flow list. */
  const lastStatus = $derived(Object.fromEntries((activeRun?.flows ?? []).map((f) => [f.flowId, f.status])) as Record<string, QAStepStatus>);

  // Load everything for the project; also resumes a generation or run still going in the connector.
  $effect(() => {
    const id = project.id;
    untrack(() => void load(id));
  });

  async function load(id: string) {
    suite = null;
    activeRun = null;
    runs = [];
    job = null;
    editingId = null;
    selectedTasks = new Set(tasks.filter((t) => t.spec && /\[BACKEND\]/i.test(t.title)).map((t) => t.id));
    try {
      const [s, envs, rs, j] = await Promise.all([qa.suite(id, { projectName: project.name, draftIds: [...project.draftIds] }), qa.environments(), qa.runs(id), qa.latestJob(id)]);
      if (project.id !== id) return;
      suite = s;
      environments = envs;
      if (!envs.some((e) => e.id === envId)) envId = envs[0]?.id ?? '';
      runs = rs;
      activeRun = rs[0] ?? null;
      if (j?.status === 'running') {
        job = j;
        void pollJob(j.id);
      }
      if (activeRun?.status === 'running') void pollRun(activeRun.id);
      showGenerate = !s?.flows.length;
    } catch (e) {
      toasts.show(`E2E: ${(e as Error).message}`, 'err');
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function pollJob(id: string) {
    const projectId = project.id;
    while (project.id === projectId) {
      await sleep(POLL_MS);
      const j = await qa.job(id).catch(() => null);
      if (!j || project.id !== projectId) return;
      job = j;
      if (j.status === 'running') continue;
      if (j.status === 'done' && j.suite) {
        suite = j.suite;
        showGenerate = false;
        openFlows = new Set();
        toasts.show(`${j.suite.flows.length} flow E2E siap direview.`, 'ok');
      } else if (j.status === 'error') {
        toasts.show(`Gagal membuat skenario: ${j.error}`, 'err', 8000);
      }
      return;
    }
  }

  async function pollRun(id: string) {
    const projectId = project.id;
    while (project.id === projectId) {
      await sleep(POLL_MS);
      const r = await qa.run(projectId, id).catch(() => null);
      if (!r || project.id !== projectId) return;
      if (activeRun?.id === id) activeRun = r;
      runs = runs.map((x) => (x.id === id ? r : x));
      if (r.status !== 'running') {
        const s = r.summary;
        toasts.show(`E2E selesai: ${s.passedFlows}/${s.flows} flow lulus.`, s.passedFlows === s.flows ? 'ok' : 'err', 5000);
        return;
      }
    }
  }

  async function generate() {
    const picked = tasks.filter((t) => selectedTasks.has(t.id) && t.spec);
    if (!picked.length) return toasts.show('Pilih minimal satu task yang punya Detail Task.', 'err');
    if (!append && suite?.flows.length) {
      const ok = await confirmDialog({ title: 'Ganti skenario?', message: `${suite.flows.length} flow yang ada akan diganti hasil generate baru. Pilih "Tambahkan ke flow yang ada" untuk menyimpannya.`, confirmText: 'Ganti' });
      if (!ok) return;
    }
    try {
      job = await qa.generate({
        projectId: project.id,
        projectName: project.name,
        ai,
        tasks: picked.map((t) => ({ title: t.title, tadTitle: t.tadTitle, service: t.service, jiraKey: t.jiraKeys[0], spec: t.spec })),
        prdMarkdown: prdContext(projectDrafts(project, drafts)),
        categories: [...categories],
        instructions,
        existing: append ? $state.snapshot(suite?.flows ?? []) : undefined,
      });
      void pollJob(job.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function cancelGenerate() {
    if (job) job = await qa.cancelJob(job.id).catch(() => job);
  }

  async function persist(next: QASuite) {
    try {
      suite = await qa.saveSuite($state.snapshot(next) as QASuite);
    } catch (e) {
      toasts.show(`Gagal menyimpan: ${(e as Error).message}`, 'err');
    }
  }

  function toggleFlow(flow: QAFlow) {
    if (!suite) return;
    void persist({ ...suite, flows: suite.flows.map((f) => (f.id === flow.id ? { ...f, enabled: !f.enabled } : f)) });
  }

  function setAll(enabled: boolean) {
    if (suite) void persist({ ...suite, flows: suite.flows.map((f) => ({ ...f, enabled })) });
  }

  async function removeFlow(flow: QAFlow) {
    if (!suite) return;
    const ok = await confirmDialog({ title: 'Hapus flow?', message: `Hapus flow "${flow.name}"?`, confirmText: 'Hapus', danger: true });
    if (ok) void persist({ ...suite, flows: suite.flows.filter((f) => f.id !== flow.id) });
  }

  function startEdit(flow: QAFlow) {
    editingId = flow.id;
    editText = JSON.stringify($state.snapshot(flow), null, 2);
    editError = '';
    openFlows = new Set([...openFlows, flow.id]);
  }

  function addFlow() {
    const flow: QAFlow = {
      id: crypto.randomUUID(),
      name: 'Flow baru',
      description: '',
      category: 'happy-path',
      taskTitles: [],
      variables: {},
      enabled: true,
      steps: [{ id: crypto.randomUUID(), name: 'Step 1', service: services[0], request: { method: 'GET', path: '/health' }, assertions: [{ type: 'status', op: 'equals', expected: 200 }] }],
    };
    suite = suite ?? { projectId: project.id, projectName: project.name, flows: [], updatedAt: new Date().toISOString() };
    suite.flows = [...suite.flows, flow];
    startEdit(flow);
  }

  async function saveEdit() {
    if (!suite || !editingId) return;
    let parsed: QAFlow;
    try {
      parsed = JSON.parse(editText);
    } catch (e) {
      editError = `JSON tidak valid: ${(e as Error).message}`;
      return;
    }
    parsed.id = editingId;
    const flows = suite.flows.map((f) => (f.id === editingId ? parsed : f));
    try {
      suite = await qa.saveSuite({ ...($state.snapshot(suite) as QASuite), flows });
      editingId = null;
    } catch (e) {
      editError = (e as Error).message;
    }
  }

  async function cancelEdit() {
    editingId = null;
    // A new, never-saved flow disappears again.
    suite = (await qa.suite(project.id).catch(() => suite)) ?? suite;
  }

  async function run(flowIds?: string[]) {
    if (!env) {
      envModalOpen = true;
      return toasts.show('Pilih atau buat environment dulu.', 'err');
    }
    const count = flowIds?.length ?? enabledFlows.length;
    if (!count) return toasts.show('Centang minimal satu flow.', 'err');
    const writes = (suite?.flows ?? []).filter((f) => (flowIds ? flowIds.includes(f.id) : f.enabled)).some((f) => f.steps.some((s) => s.request.method !== 'GET'));
    if (writes && !env.readOnly) {
      const ok = await confirmDialog({
        title: 'Jalankan E2E?',
        message: `${count} flow akan mengirim request (termasuk POST/PUT/PATCH/DELETE) ke "${env.name}". Data di server tersebut bisa berubah.`,
        confirmText: 'Ya, jalankan',
      });
      if (!ok) return;
    }
    starting = true;
    try {
      const r = await qa.startRun({ projectId: project.id, environmentId: env.id, flowIds });
      runs = [r, ...runs];
      activeRun = r;
      tab = 'results';
      openSteps = new Set();
      void pollRun(r.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      starting = false;
    }
  }

  async function showRun(id: string) {
    activeRun = runs.find((r) => r.id === id) ?? null;
    openSteps = new Set();
    if (activeRun && !activeRun.flows.length) activeRun = await qa.run(project.id, id).catch(() => activeRun);
  }

  function copy(text: string, what: string) {
    void navigator.clipboard.writeText(text);
    toasts.show(`${what} disalin.`, 'ok', 1500);
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const STATUS: Record<QAStepStatus, { label: string; cls: string; icon: 'check' | 'x' | 'alert' | 'clock' | 'lock' }> = {
    pending: { label: 'Menunggu', cls: '', icon: 'clock' },
    running: { label: 'Berjalan', cls: 'st-run', icon: 'clock' },
    passed: { label: 'Lulus', cls: 'st-ok', icon: 'check' },
    failed: { label: 'Gagal', cls: 'st-err', icon: 'x' },
    error: { label: 'Error', cls: 'st-err', icon: 'alert' },
    skipped: { label: 'Dilewati', cls: '', icon: 'clock' },
    blocked: { label: 'Diblokir', cls: 'st-warn', icon: 'lock' },
  };

  const pretty = (body?: string) => {
    if (!body) return '(kosong)';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };
  const stepKey = (flowId: string, s: QAStepResult) => `${flowId}:${s.stepId}`;
</script>

<div class="e2e">
  <header class="head">
    <div>
      <h2>E2E Test Flow</h2>
      <p class="muted small">Skenario API end-to-end dari Detail Task semua TAD di proyek ini, dijalankan langsung dari laptop ke server pilihanmu.</p>
    </div>
    <div class="head-actions">
      <select class="input env-select" bind:value={envId} aria-label="Environment">
        {#if !environments.length}<option value="">Belum ada environment</option>{/if}
        {#each environments as e (e.id)}
          <option value={e.id}>{e.name}{e.readOnly ? ' (read-only)' : ''}</option>
        {/each}
      </select>
      <button class="btn btn-sm" onclick={() => (envModalOpen = true)}><Icon name="plug" size={13} /> Environment</button>
      <button class="btn btn-sm" class:btn-primary={showGenerate} onclick={() => (showGenerate = !showGenerate)} disabled={generating}><Icon name="sparkles" size={13} /> Generate</button>
      <button class="btn btn-primary btn-sm" onclick={() => run()} disabled={running || starting || !enabledFlows.length}>
        <Icon name="play" size={13} /> {running ? 'Berjalan…' : `Jalankan ${enabledFlows.length} flow`}
      </button>
    </div>
  </header>

  {#if generating}
    <div class="banner">
      <span class="spinner" aria-hidden="true"></span>
      <span>AI menyusun skenario E2E… <span class="muted">{job?.progress ?? ''}</span></span>
      <button class="btn btn-sm" onclick={cancelGenerate}>Batalkan</button>
    </div>
  {:else if showGenerate}
    <section class="card gen">
      <div class="gen-grid">
        <div>
          <h3>Task yang dites</h3>
          {#if !tasks.length}
            <p class="muted small">TAD di proyek ini belum berisi task di Development Scope.</p>
          {/if}
          <div class="task-list">
            {#each tasks as t (t.id)}
              <label class="check" class:disabled={!t.spec} title={t.spec ? '' : 'Detail Task untuk task ini belum ada'}>
                <input type="checkbox" checked={selectedTasks.has(t.id)} disabled={!t.spec} onchange={() => (selectedTasks = toggle(selectedTasks, t.id))} />
                <span class="mono task-title">{t.title}</span>
                {#if multiTad}<span class="chip">{t.tadTitle}</span>{/if}
                {#if !t.spec}<span class="chip chip-warn">tanpa Detail Task</span>{/if}
              </label>
            {/each}
          </div>
        </div>
        <div class="gen-side">
          <h3>Jenis skenario</h3>
          <div class="cats">
            {#each QA_CATEGORIES as c (c)}
              <label class="check"><input type="checkbox" checked={categories.has(c)} onchange={() => (categories = toggle(categories as Set<string>, c) as Set<QACategory>)} /> {QA_CATEGORY_LABELS[c]}</label>
            {/each}
          </div>
          <label class="field">
            <span>Instruksi tambahan (opsional)</span>
            <textarea class="input" rows="3" bind:value={instructions} placeholder="mis. fokus ke refund parsial, gunakan merchant {'{{merchantId}}'}"></textarea>
          </label>
          <AiPicker value={ai} onchange={(s) => (ai = s)} />
          {#if suite?.flows.length}
            <label class="check small"><input type="checkbox" bind:checked={append} /> Tambahkan ke {suite.flows.length} flow yang ada</label>
          {/if}
          <button class="btn btn-primary" onclick={generate} disabled={!selectedTasks.size}><Icon name="sparkles" size={14} /> Generate skenario E2E</button>
          <p class="muted small">AI hanya menerima teks Detail Task & PRD (tanpa akses file/jaringan). Token environment tidak pernah dikirim ke AI.</p>
        </div>
      </div>
    </section>
  {/if}

  <div class="tabs">
    <button class:active={tab === 'flows'} onclick={() => (tab = 'flows')}>Skenario ({suite?.flows.length ?? 0})</button>
    <button class:active={tab === 'results'} onclick={() => (tab = 'results')}>Hasil Run {#if runs.length}({runs.length}){/if}</button>
  </div>

  <div class="body">
    {#if tab === 'flows'}
      {#if suite?.notes}
        <details class="notes card">
          <summary><Icon name="alert" size={13} /> Asumsi & pertanyaan dari AI</summary>
          <p>{suite.notes}</p>
        </details>
      {/if}
      {#if !suite?.flows.length}
        <div class="empty muted">
          <Icon name="list" size={24} />
          <p>Belum ada skenario. Klik <strong>Generate</strong> untuk membuat dari Detail Task, atau tambah manual.</p>
          <button class="btn btn-sm" onclick={addFlow}><Icon name="plus" size={13} /> Tambah flow manual</button>
        </div>
      {:else}
        <div class="list-tools">
          <label class="flow-search">
            <Icon name="search" size={13} />
            <input type="search" bind:value={flowQuery} placeholder="Cari test case: nama, task, step, endpoint…" aria-label="Cari test case" />
          </label>
          <select class="input cat-select" bind:value={flowCategory} aria-label="Filter kategori">
            <option value="">Semua kategori</option>
            {#each QA_CATEGORIES as c (c)}<option value={c}>{QA_CATEGORY_LABELS[c]}</option>{/each}
          </select>
          {#if flowQuery || flowCategory}<span class="muted small">{visibleFlows.length} dari {suite.flows.length}</span>{/if}
          <button class="btn btn-ghost btn-sm" onclick={() => setAll(true)}>Centang semua</button>
          <button class="btn btn-ghost btn-sm" onclick={() => setAll(false)}>Kosongkan</button>
          <span class="grow"></span>
          <button class="btn btn-sm" onclick={addFlow}><Icon name="plus" size={13} /> Flow manual</button>
        </div>
        {#if !visibleFlows.length}
          <p class="muted small">Tidak ada test case yang cocok. <button class="link-btn" onclick={() => { flowQuery = ''; flowCategory = ''; }}>Reset pencarian</button></p>
        {/if}
        {#each visibleFlows as flow (flow.id)}
          <article class="card flow" class:disabled={!flow.enabled}>
            <div class="flow-head">
              <input type="checkbox" checked={flow.enabled} onchange={() => toggleFlow(flow)} aria-label="Ikut dijalankan" />
              <button class="flow-title" onclick={() => (openFlows = toggle(openFlows, flow.id))} aria-expanded={openFlows.has(flow.id)} aria-label="Detail flow {flow.name}">
                <Icon name="chevron" size={13} />
                <strong>{flow.name}</strong>
              </button>
              <span class="chip">{QA_CATEGORY_LABELS[flow.category]}</span>
              <span class="muted small">{flow.steps.length} step</span>
              {#if lastStatus[flow.id]}
                <span class="badge {STATUS[lastStatus[flow.id]].cls}">{STATUS[lastStatus[flow.id]].label}</span>
              {/if}
              <span class="grow"></span>
              <button class="btn btn-ghost btn-sm" onclick={() => run([flow.id])} disabled={running || starting} title="Jalankan flow ini saja"><Icon name="play" size={13} /></button>
              <button class="btn btn-ghost btn-sm" onclick={() => startEdit(flow)} title="Edit JSON flow"><Icon name="edit" size={13} /></button>
              <button class="btn btn-ghost btn-sm" onclick={() => removeFlow(flow)} title="Hapus flow"><Icon name="trash" size={13} /></button>
            </div>
            {#if openFlows.has(flow.id)}
              {#if flow.description}<p class="desc">{flow.description}</p>{/if}
              {#if flow.taskTitles.length}<p class="muted small mono">Task: {flow.taskTitles.join(' · ')}</p>{/if}
              {#if editingId === flow.id}
                <textarea class="input mono editor" rows="18" bind:value={editText} spellcheck="false"></textarea>
                {#if editError}<p class="err small">{editError}</p>{/if}
                <div class="edit-actions">
                  <span class="muted small">Field: name, description, category, taskTitles, variables, steps[] (service, request, extract, assertions, useEnvAuth)</span>
                  <button class="btn btn-sm" onclick={cancelEdit}>Batal</button>
                  <button class="btn btn-primary btn-sm" onclick={saveEdit}>Simpan</button>
                </div>
              {:else}
                {#if flow.variables && Object.keys(flow.variables).length}
                  <p class="vars small" title="Nilai contoh dari AI; variabel environment dengan nama yang sama menimpanya">Variabel contoh: {#each Object.entries(flow.variables) as [k, v] (k)}<code>{k}={v}</code> {/each}</p>
                {/if}
                <ol class="steps">
                  {#each flow.steps as step (step.id)}
                    <li>
                      <div class="step-line">
                        <span class="method m-{step.request.method.toLowerCase()}">{step.request.method}</span>
                        <span class="mono path">{step.request.path}</span>
                        {#if step.service}<span class="chip">{step.service}</span>{/if}
                        {#if step.useEnvAuth === false}<span class="chip" title="Tidak memakai auth environment">tanpa auth env</span>{/if}
                      </div>
                      <div class="muted small">{step.name}</div>
                      <div class="asserts small">
                        {#each step.assertions as a, i (i)}
                          <code>{a.type === 'status' ? `status ${Array.isArray(a.expected) ? a.expected.join('/') : a.expected}` : a.type === 'latency' ? `< ${a.expected}ms` : `${a.type === 'header' ? a.name : a.path} ${a.op}${a.expected !== undefined ? ` ${JSON.stringify(a.expected)}` : ''}`}</code>
                        {/each}
                        {#each Object.entries(step.extract ?? {}) as [k, v] (k)}
                          <code class="extract">{`{{${k}}}`} ← {v}</code>
                        {/each}
                      </div>
                    </li>
                  {/each}
                </ol>
              {/if}
            {/if}
          </article>
        {/each}
      {/if}
    {:else}
      {#if !activeRun}
        <div class="empty muted"><Icon name="play" size={24} /><p>Belum ada run. Pilih environment lalu klik <strong>Jalankan</strong>.</p></div>
      {:else}
        <div class="run-head">
          <select class="input" value={activeRun.id} onchange={(e) => showRun(e.currentTarget.value)} aria-label="Riwayat run">
            {#each runs as r (r.id)}
              <option value={r.id}>{new Date(r.startedAt).toLocaleString('id-ID')} · {r.environment.name} · {r.summary.passedFlows}/{r.summary.flows || r.flows.length} lulus{r.status === 'running' ? ' (berjalan)' : ''}</option>
            {/each}
          </select>
          <span class="badge {activeRun.status === 'running' ? 'st-run' : activeRun.summary.passedFlows === activeRun.summary.flows ? 'st-ok' : 'st-err'}">
            {activeRun.status === 'running' ? 'Berjalan' : activeRun.status === 'cancelled' ? 'Dibatalkan' : `${activeRun.summary.passedFlows}/${activeRun.summary.flows} flow lulus`}
          </span>
          <span class="muted small">{activeRun.summary.passedSteps}/{activeRun.summary.steps} step lulus</span>
          <span class="grow"></span>
          {#if activeRun.status === 'running'}
            <button class="btn btn-sm" onclick={() => activeRun && qa.cancelRun(activeRun.id)}>Batalkan</button>
          {:else}
            <button class="btn btn-sm" onclick={() => activeRun && copy(runReport(activeRun), 'Laporan')}><Icon name="copy" size={13} /> Salin laporan</button>
          {/if}
          <button class="btn btn-sm btn-primary" onclick={() => openLog()} title="Riwayat semua request dan response run ini, layar penuh"><Icon name="list" size={13} /> Log request</button>
        </div>
        {#each activeRun.flows as flow (flow.flowId)}
          <article class="card flow">
            <div class="flow-head">
              <span class="badge {STATUS[flow.status].cls}"><Icon name={STATUS[flow.status].icon} size={11} /> {STATUS[flow.status].label}</span>
              <strong>{flow.name}</strong>
              <span class="chip">{QA_CATEGORY_LABELS[flow.category]}</span>
            </div>
            <ol class="steps">
              {#each flow.steps as s (s.stepId)}
                <li class="result">
                  <button class="step-line clickable" onclick={() => (openSteps = toggle(openSteps, stepKey(flow.flowId, s)))} aria-expanded={openSteps.has(stepKey(flow.flowId, s))}>
                    <span class="badge {STATUS[s.status].cls}"><Icon name={STATUS[s.status].icon} size={11} /></span>
                    {#if s.request}<span class="method m-{s.request.method.toLowerCase()}">{s.request.method}</span>{/if}
                    <span class="step-name">{s.name}</span>
                    {#if s.response}<span class="mono small">HTTP {s.response.status}</span>{/if}
                    {#if s.durationMs !== undefined}<span class="muted small">{s.durationMs} ms</span>{/if}
                  </button>
                  {#if s.error}<p class="err small">{s.error}</p>{/if}
                  {#each s.assertions.filter((a) => !a.passed) as a, i (i)}
                    <p class="err small">✗ {a.message}</p>
                  {/each}
                  {#if openSteps.has(stepKey(flow.flowId, s))}
                    <div class="detail">
                      {#if s.assertions.length}
                        <ul class="assert-results small">
                          {#each s.assertions as a, i (i)}<li class:ok={a.passed} class:bad={!a.passed}>{a.passed ? '✓' : '✗'} {a.message}</li>{/each}
                        </ul>
                      {/if}
                      {#if s.extracted && Object.keys(s.extracted).length}
                        <p class="small">Diambil: {#each Object.entries(s.extracted) as [k, v] (k)}<code>{k}={v}</code> {/each}</p>
                      {/if}
                      {#if s.request}
                        <h4>Request</h4>
                        <pre class="mono">{s.request.method} {s.request.url}{'\n'}{Object.entries(s.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}{s.request.body ? `\n\n${pretty(s.request.body)}` : ''}</pre>
                      {/if}
                      {#if s.response}
                        <h4>Response {s.response.status}{s.response.truncated ? ' (dipotong)' : ''}</h4>
                        <pre class="mono">{pretty(s.response.body)}</pre>
                      {/if}
                      {#if s.curl}
                        <button class="btn btn-sm" onclick={() => copy(s.curl ?? '', 'Perintah curl')}><Icon name="copy" size={13} /> Salin curl</button>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
              {#if flow.status === 'pending' || flow.status === 'running'}
                <li class="muted small">{flow.status === 'running' ? 'Menjalankan…' : 'Menunggu giliran…'}</li>
              {/if}
            </ol>
          </article>
        {/each}
      {/if}
    {/if}
  </div>
</div>

<E2ELogViewer bind:open={logOpen} bind:runId={logRunId} {runs} />
<E2EEnvironmentModal bind:open={envModalOpen} bind:environments bind:selectedId={envId} {services} />

<style>
  .flow-search {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 220px;
    max-width: 380px;
    height: 30px;
    padding: 0 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-3);
  }
  .flow-search:focus-within {
    border-color: var(--accent);
  }
  .flow-search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
  }
  .cat-select {
    width: auto;
    font-size: 12.5px;
  }
  .link-btn {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .e2e {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow: hidden;
    padding: 16px 22px;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .head h2 {
    margin: 0 0 2px;
    font-size: 17px;
  }
  .head p {
    margin: 0;
  }
  .head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .env-select {
    width: auto;
    min-width: 180px;
    max-width: 260px;
  }
  .small {
    font-size: 12px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 12px 14px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    font-size: 13px;
  }
  .banner > span:nth-child(2) {
    flex: 1;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    border-right-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .gen {
    flex-shrink: 0;
    max-height: 46%;
    overflow-y: auto;
  }
  .gen h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .gen-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 18px;
  }
  .gen-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .task-list,
  .cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .check.disabled {
    opacity: 0.55;
  }
  .task-title {
    font-size: 11.5px;
    word-break: break-word;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 12px;
    font: inherit;
    font-size: 13px;
    color: var(--text-2, var(--text));
    cursor: pointer;
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 3px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 0;
    text-align: center;
  }
  .list-tools,
  .run-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .run-head select {
    max-width: 420px;
  }
  .grow {
    flex: 1;
  }
  .flow.disabled {
    opacity: 0.6;
  }
  .flow-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .flow-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .desc {
    margin: 8px 0 4px;
    font-size: 12.5px;
  }
  .vars code,
  .asserts code {
    margin-right: 4px;
  }
  .steps {
    margin: 8px 0 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .step-line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .step-line.clickable {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .step-name {
    font-size: 13px;
  }
  .path {
    font-size: 12px;
    word-break: break-all;
  }
  .method {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .m-get {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .m-delete {
    background: var(--err-soft);
    color: var(--err);
  }
  .m-put,
  .m-patch {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .asserts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;
  }
  .asserts code,
  .vars code {
    font-size: 11px;
  }
  .extract {
    color: var(--accent);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text);
  }
  .st-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .st-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .st-run {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .err {
    color: var(--err);
    margin: 3px 0 0;
  }
  .editor {
    width: 100%;
    margin-top: 8px;
    font-size: 12px;
    box-sizing: border-box;
    resize: vertical;
  }
  .edit-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .edit-actions .muted {
    flex: 1;
  }
  .detail {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .detail h4 {
    margin: 4px 0 0;
    font-size: 12px;
  }
  .detail pre {
    margin: 0;
    padding: 8px 10px;
    max-height: 280px;
    overflow: auto;
    font-size: 11.5px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .assert-results {
    margin: 0;
    padding-left: 4px;
    list-style: none;
  }
  .assert-results .ok {
    color: var(--ok);
  }
  .assert-results .bad {
    color: var(--err);
  }
  .notes summary {
    cursor: pointer;
    font-size: 12.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .notes p {
    white-space: pre-wrap;
    font-size: 12.5px;
    margin: 8px 0 0;
  }
  @media (max-width: 900px) {
    .gen-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
