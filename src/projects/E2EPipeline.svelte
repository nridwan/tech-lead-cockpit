<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import type { QAAgentJob, QAPipeline, QAPlan, QAPlanStage } from '../lib/qa/types';

  /**
   * The multi-agent pipeline: the planner's journey map (reviewed and edited here), then one
   * writer agent per stage in parallel. Agents also show in Agent Tasks.
   */
  let {
    projectId,
    plan = $bindable(),
    pipeline = $bindable(),
    existingFlows,
    onsuite,
  }: { projectId: string; plan: QAPlan | null; pipeline: QAPipeline | null; existingFlows: number; onsuite: () => void } = $props();

  const POLL_MS = 2000;
  let concurrency = $state(3);
  let showPlan = $state(true);
  let saving = $state(false);
  let dirty = $state(false);

  const busy = $derived((pipeline?.agents ?? []).some((a) => a.status === 'running' || a.status === 'queued'));
  const doneCount = $derived((pipeline?.agents ?? []).filter((a) => a.status === 'done').length);

  // Polls while agents work; each finished writer has already merged its stage into the suite.
  let polling = false;
  $effect(() => {
    if (busy && !polling) void poll(projectId);
  });

  async function poll(id: string) {
    polling = true;
    let seenDone = doneCount;
    try {
      while (projectId === id) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const r = await qa.pipeline(id).catch(() => null);
        if (!r || projectId !== id) return;
        const wasPlanning = pipeline?.phase === 'planning';
        pipeline = r.pipeline;
        if (!dirty) plan = r.plan;
        const done = r.pipeline.agents.filter((a) => a.status === 'done').length;
        if (done !== seenDone) {
          seenDone = done;
          if (r.pipeline.agents.some((a) => a.role !== 'plan')) onsuite();
        }
        if (r.pipeline.agents.every((a) => a.status !== 'running' && a.status !== 'queued')) {
          report(r.pipeline, wasPlanning);
          return;
        }
      }
    } finally {
      polling = false;
    }
  }

  function report(p: QAPipeline, wasPlanning: boolean) {
    const failed = p.agents.filter((a) => a.status === 'error').length;
    if (wasPlanning || p.agents[0]?.role === 'plan') {
      if (p.agents[0]?.status === 'done') {
        showPlan = true;
        toasts.show('Rencana journey siap. Review tahapnya, lalu jalankan agent penulis.', 'ok', 5000);
      } else if (p.agents[0]?.status === 'error') toasts.show(`Perencana gagal: ${p.agents[0].error}`, 'err', 8000);
      return;
    }
    const role = p.agents[0]?.role === 'repair' ? 'Agent perbaikan' : 'Agent penulis';
    toasts.show(`${role} selesai: ${p.agents.length - failed}/${p.agents.length} berhasil.`, failed ? 'err' : 'ok', 5000);
    onsuite();
  }

  // Plan edits (local until saved).
  function edit(fn: (p: QAPlan) => void) {
    if (!plan) return;
    const next = $state.snapshot(plan) as QAPlan;
    fn(next);
    plan = next;
    dirty = true;
  }
  const moveStage = (i: number, d: -1 | 1) =>
    edit((p) => {
      const j = i + d;
      if (j < 0 || j >= p.stages.length) return;
      [p.stages[i], p.stages[j]] = [p.stages[j], p.stages[i]];
    });
  const removeStage = (i: number) => edit((p) => void p.stages.splice(i, 1));
  const removeEndpoint = (si: number, ei: number) => edit((p) => void p.stages[si].endpoints.splice(ei, 1));
  const setStage = (i: number, patch: Partial<QAPlanStage>) => edit((p) => Object.assign(p.stages[i], patch));
  const removeRule = (si: number, ri: number) => edit((p) => void p.stages[si].rules.splice(ri, 1));

  async function save(): Promise<boolean> {
    if (!plan) return false;
    if (!dirty) return true;
    saving = true;
    try {
      plan = await qa.savePlan($state.snapshot(plan) as QAPlan);
      dirty = false;
      return true;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
      return false;
    } finally {
      saving = false;
    }
  }

  async function write(stageIds?: string[]) {
    if (!plan || !(await save())) return;
    const stages = stageIds?.length ? plan.stages.filter((s) => stageIds.includes(s.id)) : plan.stages;
    if (!stageIds && existingFlows) {
      const ok = await confirmDialog({
        title: 'Tulis ulang test case?',
        message: `Test case di ${stages.length} tahap rencana diganti hasil agent penulis, per tahap begitu selesai. Test case di luar tahap rencana (mis. flow manual) tetap.`,
        confirmText: 'Tulis',
      });
      if (!ok) return;
    }
    try {
      pipeline = await qa.writeFromPlan(projectId, concurrency, stageIds);
      showPlan = false;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function cancelAll() {
    pipeline = (await qa.cancelPipeline(projectId).catch(() => null))?.pipeline ?? pipeline;
  }
  async function cancelOne(a: QAAgentJob) {
    await qa.cancelAgent(a.id).catch((e) => toasts.show((e as Error).message, 'err'));
  }

  const ROLE: Record<QAAgentJob['role'], string> = { plan: 'Perencana', write: 'Penulis', repair: 'Perbaikan' };
  const STATUS: Record<QAAgentJob['status'], { label: string; cls: string }> = {
    queued: { label: 'Antri', cls: '' },
    running: { label: 'Berjalan', cls: 'st-run' },
    done: { label: 'Selesai', cls: 'st-ok' },
    error: { label: 'Gagal', cls: 'st-err' },
    cancelled: { label: 'Dibatalkan', cls: '' },
  };
  const unverified = $derived(plan?.stages.flatMap((s) => s.endpoints).filter((e) => !e.verified).length ?? 0);
</script>

{#if pipeline?.agents.length && (busy || pipeline.agents.some((a) => a.role !== 'plan'))}
  <section class="card agents">
    <div class="sec-head">
      <h3><Icon name="sparkles" size={14} /> Agent E2E {busy ? `· ${pipeline.agents.filter((a) => a.status === 'running').length} berjalan, maks ${pipeline.concurrency} paralel` : ''}</h3>
      <span class="muted small">Juga tampil di Agent Tasks.</span>
      <span class="grow"></span>
      {#if busy}<button class="btn btn-sm" onclick={cancelAll}>Batalkan semua</button>{/if}
    </div>
    <ul class="agent-list">
      {#each pipeline.agents as a (a.id)}
        <li>
          <span class="badge {STATUS[a.status].cls}">{#if a.status === 'running'}<span class="spinner" aria-hidden="true"></span>{/if}{STATUS[a.status].label}</span>
          <span class="chip">{ROLE[a.role]}</span>
          <span class="agent-label">{a.label.replace(/^[^:]+:\s*/, '')}</span>
          <span class="muted small agent-msg">{a.status === 'running' ? (a.progress ?? '') : a.status === 'done' ? (a.result ?? '') : a.status === 'error' ? (a.error ?? '') : ''}</span>
          {#if a.status === 'running' || a.status === 'queued'}
            <button class="btn btn-ghost btn-sm" onclick={() => cancelOne(a)} title="Batalkan agent ini"><Icon name="x" size={12} /></button>
          {:else if a.role === 'write' && a.stageId && (a.status === 'error' || a.status === 'cancelled') && !busy}
            <button class="btn btn-ghost btn-sm" onclick={() => write([a.stageId ?? ''])} title="Jalankan ulang agent untuk tahap ini"><Icon name="refresh" size={12} /> Ulangi</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if pipeline?.phase === 'planning'}
  <div class="banner">
    <span class="spinner" aria-hidden="true"></span>
    <span>Agent perencana memetakan journey dari TAD dan kode… <span class="muted">{pipeline.agents[0]?.progress ?? ''}</span></span>
    <button class="btn btn-sm" onclick={cancelAll}>Batalkan</button>
  </div>
{:else if plan}
  <section class="card plan">
    <div class="sec-head">
      <button class="plan-toggle" onclick={() => (showPlan = !showPlan)} aria-expanded={showPlan}>
        <Icon name="chevron" size={13} />
        <h3>Rencana journey · {plan.stages.length} tahap</h3>
      </button>
      {#if unverified}<span class="chip chip-warn" title="Endpoint tanpa bukti file:line yang cocok di kode">{unverified} endpoint belum terverifikasi</span>{/if}
      {#if dirty}<span class="chip">belum disimpan</span>{/if}
      <span class="grow"></span>
      <span class="muted small">diperbarui {new Date(plan.updatedAt).toLocaleString('id-ID')}</span>
    </div>
    {#if showPlan}
      <p class="muted small">Urutan tahap = urutan journey (data dibuat dulu, lalu dipakai). Hapus atau ubah yang keliru sebelum agent penulis jalan: tiap tahap ditulis satu agent, paralel.</p>
      {#if plan.notes}<p class="notes small">{plan.notes}</p>{/if}
      <ol class="stages">
        {#each plan.stages as st, si (st.id)}
          <li class="stage">
            <div class="stage-top">
              <span class="num">{si + 1}</span>
              <input class="input stage-title" value={st.title} onchange={(e) => setStage(si, { title: e.currentTarget.value.trim() || st.title })} aria-label="Judul tahap" />
              <button class="btn btn-ghost btn-sm" onclick={() => moveStage(si, -1)} disabled={si === 0 || busy} aria-label="Naikkan">↑</button>
              <button class="btn btn-ghost btn-sm" onclick={() => moveStage(si, 1)} disabled={si === plan.stages.length - 1 || busy} aria-label="Turunkan">↓</button>
              <button class="btn btn-ghost btn-sm" onclick={() => write([st.id])} disabled={busy} title="Tulis ulang test case tahap ini saja"><Icon name="sparkles" size={12} /></button>
              <button class="btn btn-ghost btn-sm" onclick={() => removeStage(si)} disabled={busy || plan.stages.length === 1} title="Hapus tahap"><Icon name="trash" size={12} /></button>
            </div>
            <textarea class="input goal" rows="2" value={st.goal} onchange={(e) => setStage(si, { goal: e.currentTarget.value })} aria-label="Tujuan tahap"></textarea>
            {#if st.endpoints.length}
              <ul class="endpoints">
                {#each st.endpoints as ep, ei (ei)}
                  <li>
                    <span class="method m-{ep.method.toLowerCase()}">{ep.method}</span>
                    <span class="mono">{ep.path}</span>
                    {#if ep.service}<span class="chip">{ep.service}</span>{/if}
                    {#if ep.verified}
                      <span class="ok small mono" title="Ditemukan di kode">✓ {ep.evidence}</span>
                    {:else}
                      <span class="warn small mono" title="Bukti file:line tidak cocok atau tidak ada">⚠ {ep.evidence || 'tanpa bukti'}</span>
                    {/if}
                    <button class="btn btn-ghost btn-xs" onclick={() => removeEndpoint(si, ei)} aria-label="Hapus endpoint"><Icon name="x" size={11} /></button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="vars small">
              {#if st.consumes.length}<span class="muted">butuh</span> {#each st.consumes as v (v)}<code>{`{{${v}}}`}</code> {/each}{/if}
              {#if st.produces.length}<span class="muted">menghasilkan</span> {#each st.produces as v (v)}<code class="produce">{`{{${v}}}`}</code> {/each}{/if}
            </div>
            {#if st.rules.length}
              <ul class="rules small">
                {#each st.rules as r, ri (ri)}
                  <li>{r} <button class="btn btn-ghost btn-xs" onclick={() => removeRule(si, ri)} aria-label="Hapus aturan"><Icon name="x" size={10} /></button></li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
      <div class="plan-actions">
        {#if dirty}<button class="btn btn-sm" onclick={save} disabled={saving}>Simpan rencana</button>{/if}
        <span class="grow"></span>
        <label class="small conc">
          Agent paralel
          <select class="input" bind:value={concurrency}>
            {#each [1, 2, 3, 4, 5] as n (n)}<option value={n}>{n}</option>{/each}
          </select>
        </label>
        <button class="btn btn-primary" onclick={() => write()} disabled={busy || saving}>
          <Icon name="sparkles" size={14} /> Tulis test case ({plan.stages.length} agent, maks {concurrency} paralel)
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .agents,
  .plan {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    /* The panel itself doesn't scroll: these cards scroll inside, the test cases keep room below. */
    flex-shrink: 0;
    min-height: 0;
  }
  .plan {
    max-height: 62%;
  }
  .agents {
    max-height: 30%;
  }
  .agent-list,
  .stages {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .stages {
    padding-right: 4px;
  }
  .sec-head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sec-head h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 13.5px;
  }
  .plan-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .plan-toggle[aria-expanded='true'] :global(svg) {
    transform: rotate(90deg);
  }
  .grow {
    flex: 1;
  }
  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .agent-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 8px;
    border-radius: 8px;
    background: var(--surface-2);
  }
  .agent-label {
    font-weight: 600;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .agent-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    background: var(--surface-3, var(--border));
    color: var(--text-2);
    white-space: nowrap;
  }
  .st-run {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .st-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--accent-soft);
  }
  .banner > span:nth-child(2) {
    flex: 1;
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .notes {
    flex-shrink: 0;
    max-height: 90px;
    overflow-y: auto;
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--warn-soft);
    white-space: pre-wrap;
  }
  .stages {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stage {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
  }
  .stage-top {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .num {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-size: 11px;
    font-weight: 700;
  }
  .stage-title {
    flex: 1;
    font-weight: 600;
  }
  .goal {
    font-size: 12.5px;
    resize: vertical;
  }
  .endpoints,
  .rules {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .endpoints li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
  }
  .rules li {
    padding-left: 12px;
    position: relative;
  }
  .rules li::before {
    content: '•';
    position: absolute;
    left: 2px;
    color: var(--text-3);
  }
  .method {
    min-width: 46px;
    font-family: var(--mono, monospace);
    font-size: 11px;
    font-weight: 700;
  }
  .m-get {
    color: var(--ok);
  }
  .m-post {
    color: var(--accent);
  }
  .m-put,
  .m-patch {
    color: var(--warn);
  }
  .m-delete {
    color: var(--err);
  }
  .ok {
    color: var(--ok);
  }
  .warn {
    color: var(--warn);
  }
  .btn-xs {
    padding: 0 4px;
    min-height: 0;
    height: 18px;
  }
  .vars {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .produce {
    color: var(--ok);
  }
  .plan-actions {
    flex-shrink: 0;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .conc {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .conc select {
    width: auto;
  }
</style>
