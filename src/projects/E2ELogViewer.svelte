<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import type { QARun, QAStepResult, QAStepStatus } from '../lib/qa/types';

  /**
   * Full-screen request log of an E2E run: every request in the order it was sent, and for the
   * selected one the request (method, URL, headers, body), the response (status, time, headers,
   * body), assertions, extracted variables and a cURL to reproduce it.
   */
  let { open = $bindable(false), runs, runId = $bindable() }: { open: boolean; runs: QARun[]; runId?: string } = $props();

  interface Entry {
    key: string;
    index: number;
    flow: string;
    step: QAStepResult;
  }

  type Filter = 'all' | 'failed' | 'passed';
  type Tab = 'request' | 'response' | 'assertions' | 'curl';
  let filter = $state<Filter>('all');
  let method = $state('');
  let query = $state('');
  let selectedKey = $state<string | null>(null);
  let tab = $state<Tab>('response');

  const run = $derived(runs.find((r) => r.id === runId) ?? runs[0]);
  const entries = $derived<Entry[]>(
    (run?.flows ?? []).flatMap((f) => f.steps.map((s) => ({ flow: f.name, step: s, key: `${f.flowId}:${s.stepId}` }))).map((e, index) => ({ ...e, index: index + 1 })),
  );
  const isFailure = (s: QAStepStatus) => s === 'failed' || s === 'error' || s === 'blocked';
  const methods = $derived([...new Set(entries.map((e) => e.step.request?.method).filter((m): m is string => Boolean(m)))]);
  const visible = $derived.by(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      if (filter === 'failed' && !isFailure(e.step.status)) return false;
      if (filter === 'passed' && e.step.status !== 'passed') return false;
      if (method && e.step.request?.method !== method) return false;
      if (!terms.length) return true;
      const hay = [e.flow, e.step.name, e.step.request?.url, e.step.request?.body, e.step.response?.body, String(e.step.response?.status ?? ''), e.step.error].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  });
  const selected = $derived(visible.find((e) => e.key === selectedKey) ?? visible[0]);
  const failures = $derived(entries.filter((e) => isFailure(e.step.status)).length);

  // Pick the first failure when a run is opened, so the interesting request is shown first.
  $effect(() => {
    void run?.id;
    const firstFail = entries.find((e) => isFailure(e.step.status));
    selectedKey = (firstFail ?? entries[0])?.key ?? null;
  });

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') open = false;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      const i = visible.findIndex((x) => x.key === selected?.key);
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        selectedKey = next.key;
        document.getElementById(`log-${next.key}`)?.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  const time = (iso?: string) =>
    iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + `.${String(new Date(iso).getMilliseconds()).padStart(3, '0')}` : '—';
  const pathOf = (url?: string) => {
    if (!url) return '—';
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  };
  const hostOf = (url?: string) => {
    try {
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  };
  function pretty(body?: string): string {
    if (body === undefined || body === '') return '';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  const statusClass = (code?: number) => (!code ? 'code-none' : code < 300 ? 'code-ok' : code < 400 ? 'code-redirect' : code < 500 ? 'code-client' : 'code-server');
  const LABEL: Record<QAStepStatus, string> = { pending: 'Menunggu', running: 'Berjalan', passed: 'Lulus', failed: 'Gagal', error: 'Error', skipped: 'Dilewati', blocked: 'Diblokir' };

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show(`${what} disalin.`, 'ok', 1500);
    } catch {
      toasts.show('Gagal menyalin.', 'err');
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="log" role="dialog" aria-modal="true" aria-label="Log request E2E">
    <header class="top">
      <div class="title">
        <Icon name="list" size={16} />
        <strong>Log Request E2E</strong>
      </div>
      {#if runs.length}
        <select class="input run-select" bind:value={runId} aria-label="Pilih run">
          {#each runs as r (r.id)}
            <option value={r.id}>{new Date(r.startedAt).toLocaleString('id-ID')} · {r.environment.name} · {r.summary.passedSteps}/{r.summary.steps} step lulus{r.status === 'running' ? ' (berjalan)' : ''}</option>
          {/each}
        </select>
      {/if}
      <span class="grow"></span>
      <span class="muted small">↑↓ pindah request · Esc tutup</span>
      <button class="btn btn-sm" onclick={() => (open = false)}><Icon name="x" size={13} /> Tutup</button>
    </header>

    {#if !run}
      <div class="empty muted">Belum ada run.</div>
    {:else}
      <div class="toolbar">
        <label class="search">
          <Icon name="search" size={13} />
          <input type="search" bind:value={query} placeholder="Cari flow, step, URL, body request/response, status…" aria-label="Cari request" />
        </label>
        <div class="seg" role="group" aria-label="Filter hasil">
          <button class:active={filter === 'all'} onclick={() => (filter = 'all')}>Semua <span class="count">{entries.length}</span></button>
          <button class:active={filter === 'failed'} onclick={() => (filter = 'failed')}>Gagal <span class="count">{failures}</span></button>
          <button class:active={filter === 'passed'} onclick={() => (filter = 'passed')}>Lulus <span class="count">{entries.length - failures}</span></button>
        </div>
        {#if methods.length > 1}
          <select class="input method-select" bind:value={method} aria-label="Filter method">
            <option value="">Semua method</option>
            {#each methods as m (m)}<option value={m}>{m}</option>{/each}
          </select>
        {/if}
        <span class="muted small">{run.environment.name}{run.environment.readOnly ? ' (read-only)' : ''} · mulai {new Date(run.startedAt).toLocaleString('id-ID')}</span>
      </div>

      <div class="body">
        <div class="list" role="listbox" aria-label="Riwayat request">
          <div class="row head">
            <span>#</span><span>Waktu</span><span>Method</span><span>Request</span><span>Status</span><span>Durasi</span>
          </div>
          {#each visible as e (e.key)}
            <button id="log-{e.key}" class="row" class:sel={selected?.key === e.key} class:fail={isFailure(e.step.status)} role="option" aria-selected={selected?.key === e.key} onclick={() => (selectedKey = e.key)}>
              <span class="num">{e.index}</span>
              <span class="mono small">{time(e.step.startedAt)}</span>
              <span class="method m-{(e.step.request?.method ?? 'none').toLowerCase()}">{e.step.request?.method ?? '—'}</span>
              <span class="req">
                <span class="path mono">{pathOf(e.step.request?.url)}</span>
                <span class="muted small">{e.flow} › {e.step.name}</span>
              </span>
              <span class="code {statusClass(e.step.response?.status)}">{e.step.response?.status ?? LABEL[e.step.status]}</span>
              <span class="mono small dur">{e.step.durationMs !== undefined ? `${e.step.durationMs} ms` : '—'}</span>
            </button>
          {:else}
            <p class="muted small none">Tidak ada request yang cocok.</p>
          {/each}
        </div>

        <section class="detail">
          {#if selected}
            {@const s = selected.step}
            <div class="summary">
              <div class="line">
                <span class="method m-{(s.request?.method ?? 'none').toLowerCase()}">{s.request?.method ?? '—'}</span>
                <span class="mono url">{s.request?.url ?? '(request tidak dikirim)'}</span>
                {#if s.request?.url}<button class="icon-btn" onclick={() => copy(s.request?.url ?? '', 'URL')} title="Salin URL" aria-label="Salin URL"><Icon name="copy" size={12} /></button>{/if}
              </div>
              <div class="facts">
                <span class="badge st-{s.status}">{LABEL[s.status]}</span>
                {#if s.response}<span class="code {statusClass(s.response.status)}">HTTP {s.response.status}</span>{/if}
                {#if s.durationMs !== undefined}<span class="muted small">{s.durationMs} ms</span>{/if}
                <span class="muted small">{time(s.startedAt)}</span>
                {#if s.request?.url}<span class="muted small">host {hostOf(s.request.url)}</span>{/if}
                <span class="muted small">#{selected.index} · {selected.flow} › {s.name}</span>
              </div>
              {#if s.error}<p class="err">{s.error}</p>{/if}
            </div>

            <div class="tabs" role="tablist">
              <button role="tab" class:active={tab === 'request'} onclick={() => (tab = 'request')}>Request</button>
              <button role="tab" class:active={tab === 'response'} onclick={() => (tab = 'response')}>Response</button>
              <button role="tab" class:active={tab === 'assertions'} onclick={() => (tab = 'assertions')}>
                Assertions {#if s.assertions.length}<span class="count {s.assertions.some((a) => !a.passed) ? 'bad' : ''}">{s.assertions.filter((a) => a.passed).length}/{s.assertions.length}</span>{/if}
              </button>
              <button role="tab" class:active={tab === 'curl'} onclick={() => (tab = 'curl')}>cURL</button>
            </div>

            <div class="pane">
              {#if tab === 'request'}
                {#if !s.request}
                  <p class="muted">Request tidak dikirim{s.error ? `: ${s.error}` : '.'}</p>
                {:else}
                  <h4>Headers</h4>
                  {#if Object.keys(s.request.headers).length}
                    <table class="kv"><tbody>{#each Object.entries(s.request.headers) as [k, v] (k)}<tr><td class="mono">{k}</td><td class="mono">{v}</td></tr>{/each}</tbody></table>
                  {:else}<p class="muted small">Tidak ada header.</p>{/if}
                  <div class="body-head">
                    <h4>Body</h4>
                    {#if s.request.body}<button class="btn btn-xs" onclick={() => copy(pretty(s.request?.body), 'Body request')}><Icon name="copy" size={11} /> Salin</button>{/if}
                  </div>
                  {#if s.request.body}<pre class="code-block">{pretty(s.request.body)}</pre>{:else}<p class="muted small">Tanpa body.</p>{/if}
                {/if}
              {:else if tab === 'response'}
                {#if !s.response}
                  <p class="muted">Tidak ada response{s.error ? `: ${s.error}` : '.'}</p>
                {:else}
                  <h4>Headers</h4>
                  {#if Object.keys(s.response.headers).length}
                    <table class="kv"><tbody>{#each Object.entries(s.response.headers) as [k, v] (k)}<tr><td class="mono">{k}</td><td class="mono">{v}</td></tr>{/each}</tbody></table>
                  {:else}<p class="muted small">Tidak ada header.</p>{/if}
                  <div class="body-head">
                    <h4>Body{s.response.truncated ? ' (dipotong)' : ''}</h4>
                    {#if s.response.body}<button class="btn btn-xs" onclick={() => copy(pretty(s.response?.body), 'Body response')}><Icon name="copy" size={11} /> Salin</button>{/if}
                  </div>
                  {#if s.response.body}<pre class="code-block">{pretty(s.response.body)}</pre>{:else}<p class="muted small">Body kosong.</p>{/if}
                  {#if s.extracted && Object.keys(s.extracted).length}
                    <h4>Variabel yang diambil</h4>
                    <table class="kv"><tbody>{#each Object.entries(s.extracted) as [k, v] (k)}<tr><td class="mono">{`{{${k}}}`}</td><td class="mono">{v}</td></tr>{/each}</tbody></table>
                  {/if}
                {/if}
              {:else if tab === 'assertions'}
                {#if !s.assertions.length}
                  <p class="muted small">Tidak ada assertion.</p>
                {:else}
                  <ul class="asserts">
                    {#each s.assertions as a, i (i)}
                      <li class:bad={!a.passed}>
                        <Icon name={a.passed ? 'check' : 'x'} size={12} />
                        <span>{a.message}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              {:else}
                {#if s.curl}
                  <div class="body-head"><h4>Reproduksi</h4><button class="btn btn-xs" onclick={() => copy(s.curl ?? '', 'cURL')}><Icon name="copy" size={11} /> Salin</button></div>
                  <pre class="code-block">{s.curl}</pre>
                {:else}<p class="muted small">Tidak ada cURL untuk step ini.</p>{/if}
              {/if}
            </div>
          {:else}
            <p class="muted">Pilih request di kiri.</p>
          {/if}
        </section>
      </div>
    {/if}
  </div>
{/if}

<style>
  .log {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .run-select {
    width: auto;
    max-width: 460px;
  }
  .grow {
    flex: 1;
  }
  .small {
    font-size: 12px;
  }
  .empty {
    margin: auto;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 260px;
    max-width: 520px;
    height: 32px;
    padding: 0 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-3);
  }
  .search:focus-within {
    border-color: var(--accent);
  }
  .search input {
    flex: 1;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .seg button.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }
  .count {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--surface-hover);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .count.bad {
    background: var(--err-soft);
    color: var(--err);
  }
  .method-select {
    width: auto;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(420px, 44%) 1fr;
  }
  .list {
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }
  .row {
    display: grid;
    grid-template-columns: 34px 96px 64px minmax(0, 1fr) 70px 70px;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 12px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.sel {
    background: var(--accent-soft);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .row.fail .num {
    color: var(--err);
    font-weight: 700;
  }
  .row.head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-2);
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    cursor: default;
  }
  .num {
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .req {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .req > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    font-size: 12px;
  }
  .dur {
    text-align: right;
  }
  .none {
    padding: 16px;
  }
  .method {
    display: inline-block;
    min-width: 46px;
    padding: 1px 6px;
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    text-align: center;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .m-get {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .m-post {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .m-put,
  .m-patch {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .m-delete {
    background: var(--err-soft);
    color: var(--err);
  }
  .code {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
  }
  .code-ok {
    color: var(--ok);
  }
  .code-redirect {
    color: var(--accent);
  }
  .code-client {
    color: var(--warn);
  }
  .code-server,
  .code-none {
    color: var(--err);
  }
  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .url {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    word-break: break-all;
  }
  .facts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    background: var(--surface-2);
  }
  .st-passed {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-failed,
  .st-error {
    background: var(--err-soft);
    color: var(--err);
  }
  .st-blocked {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .err {
    margin: 0;
    color: var(--err);
    font-size: 12.5px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
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
    color: var(--accent);
    font-weight: 600;
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px 20px;
  }
  h4 {
    margin: 12px 0 6px;
    font-size: 12px;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .body-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .kv {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .kv td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    word-break: break-all;
  }
  .kv td:first-child {
    width: 34%;
    color: var(--text-2);
  }
  .code-block {
    margin: 0;
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .asserts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .asserts li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--ok-soft);
    color: var(--ok);
    font-size: 12.5px;
  }
  .asserts li.bad {
    background: var(--err-soft);
    color: var(--err);
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
    gap: 4px;
  }
  @media (max-width: 900px) {
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: 45% 55%;
    }
    .list {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
