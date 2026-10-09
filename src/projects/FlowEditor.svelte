<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { QA_CATEGORIES, QA_CATEGORY_LABELS, QA_METHODS, QA_VALUE_OPS, type QAAssertion, type QADataQuery, type QAFlow, type QAMethod, type QAStep, type QAValueOp } from '../lib/qa/types';
  import { parseCurl } from '../lib/qa/curl';

  /**
   * Form editor for one E2E flow (a test case): no JSON needed. Steps can be filled field by field
   * or from a pasted cURL; a JSON mode stays for power users.
   */
  let {
    flow,
    services,
    serviceUrls = {},
    taskTitles,
    databases = [],
    onsave,
    oncancel,
  }: {
    flow: QAFlow;
    services: string[];
    /** Service → base URL of the selected environment, to recognise the service of a pasted cURL. */
    serviceUrls?: Record<string, string>;
    taskTitles: string[];
    databases?: string[];
    onsave: (flow: QAFlow) => Promise<string | void>;
    oncancel: () => void;
  } = $props();

  type Extra = { type: 'json' | 'header' | 'latency' | 'db'; target: string; op: QAValueOp; expected: string; db: string; sql: string; column: string };
  interface StepForm {
    id: string;
    name: string;
    service: string;
    method: QAMethod;
    path: string;
    headers: string;
    query: string;
    body: string;
    status: string;
    extract: string;
    extras: Extra[];
    useEnvAuth: boolean;
    curl: string;
    curlOpen: boolean;
  }

  const lines = (r?: Record<string, string>, sep = ' = ') => Object.entries(r ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
  function record(text: string, sep: '=' | ':' | '←', what: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [i, raw] of text.split('\n').entries()) {
      const line = raw.trim();
      if (!line) continue;
      const at = line.indexOf(sep);
      if (at <= 0) throw new Error(`${what} baris ${i + 1}: format "nama ${sep} nilai".`);
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
  }
  const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  function parseValue(v: string): unknown {
    const t = v.trim();
    if (t === '') return undefined;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  function toStepForm(s: QAStep): StepForm {
    const status = s.assertions.find((a) => a.type === 'status');
    const extras: Extra[] = s.assertions
      .filter((a) => a.type !== 'status')
      .map((a) => ({
        type: a.type as Extra['type'],
        target: a.type === 'json' ? a.path : a.type === 'header' ? a.name : '',
        op: a.type === 'latency' ? 'lt' : (a as { op: QAValueOp }).op,
        expected: show(a.expected),
        db: a.type === 'db' ? a.db : (databases[0] ?? ''),
        sql: a.type === 'db' ? a.sql : '',
        column: a.type === 'db' ? (a.column ?? '') : '',
      }));
    return {
      id: s.id,
      name: s.name,
      service: s.service ?? '',
      method: s.request.method,
      path: s.request.path,
      headers: lines(s.request.headers, ': '),
      query: lines(s.request.query),
      body: s.request.body === undefined ? '' : typeof s.request.body === 'string' ? s.request.body : JSON.stringify(s.request.body, null, 2),
      status: status ? (Array.isArray(status.expected) ? status.expected.join(', ') : String(status.expected)) : '200',
      extract: lines(s.extract, ' ← '),
      extras,
      useEnvAuth: s.useEnvAuth !== false,
      curl: '',
      curlOpen: false,
    };
  }

  const newStep = (n: number): StepForm => ({ ...toStepForm({ id: crypto.randomUUID(), name: `Step ${n}`, service: services[0], request: { method: 'GET', path: '/' }, assertions: [] }), status: '200' });

  // The form is filled once from the flow being edited; changes stay local until saved.
  const initial = untrack(() => structuredClone($state.snapshot(flow)) as QAFlow);
  let mode = $state<'form' | 'json'>('form');
  let name = $state(initial.name);
  let description = $state(initial.description);
  let category = $state(initial.category);
  let stage = $state(initial.stage ?? '');
  let tasks = $state(new Set(initial.taskTitles));
  let variables = $state(lines(initial.variables));
  let dataQueries = $state<QADataQuery[]>(initial.dataQueries ?? []);
  let steps = $state<StepForm[]>(initial.steps.map(toStepForm));
  let openStep = $state<string | null>(initial.steps.length === 1 ? initial.steps[0].id : null);
  let json = $state('');
  let error = $state('');
  let saving = $state(false);

  function build(): QAFlow {
    if (!name.trim()) throw new Error('Nama flow wajib diisi.');
    if (!steps.length) throw new Error('Tambahkan minimal satu step.');
    return {
      id: flow.id,
      name: name.trim(),
      description: description.trim(),
      category,
      ...(stage.trim() ? { stage: stage.trim() } : {}),
      taskTitles: [...tasks],
      variables: record(variables, '=', 'Variabel'),
      ...(dataQueries.length ? { dataQueries: dataQueries.filter((q) => q.name.trim() && q.sql.trim()).map((q) => ({ ...q, name: q.name.trim().replace(/^\{\{|\}\}$/g, ''), column: q.column?.trim() || undefined })) } : {}),
      enabled: flow.enabled,
      steps: steps.map((s, i) => {
        const where = `Step ${i + 1} (${s.name || 'tanpa nama'})`;
        if (!s.path.trim()) throw new Error(`${where}: path wajib diisi.`);
        let body: unknown;
        if (s.method !== 'GET' && s.body.trim()) {
          try {
            body = JSON.parse(s.body);
          } catch {
            throw new Error(`${where}: body bukan JSON yang valid. Pakai tombol "Rapikan" untuk mengecek.`);
          }
        }
        const statuses = s.status.split(/[\s,/]+/).filter(Boolean).map(Number);
        if (statuses.some((n) => !Number.isInteger(n) || n < 100 || n > 599)) throw new Error(`${where}: status harus angka 100–599, mis. 200 atau 200, 201.`);
        const assertions: QAAssertion[] = [];
        if (statuses.length) assertions.push(statuses.length > 1 ? { type: 'status', op: 'in', expected: statuses } : { type: 'status', op: 'equals', expected: statuses[0] });
        for (const x of s.extras) {
          if (x.type === 'latency') assertions.push({ type: 'latency', op: 'lt', expected: Number(x.expected) || 3000 });
          else if (x.type === 'json' && x.target.trim()) assertions.push({ type: 'json', path: x.target.trim().startsWith('$') ? x.target.trim() : `$.${x.target.trim()}`, op: x.op, expected: parseValue(x.expected) });
          else if (x.type === 'header' && x.target.trim()) assertions.push({ type: 'header', name: x.target.trim(), op: x.op, expected: parseValue(x.expected) });
          else if (x.type === 'db' && x.sql.trim()) assertions.push({ type: 'db', db: x.db, sql: x.sql.trim(), op: x.op, ...(x.column.trim() ? { column: x.column.trim() } : {}), expected: parseValue(x.expected) });
        }
        const extract = Object.fromEntries(Object.entries(record(s.extract, '←', `${where} ambil nilai`)).map(([k, v]) => [k.replace(/^\{\{|\}\}$/g, ''), v]));
        return {
          id: s.id,
          name: s.name.trim() || `Step ${i + 1}`,
          service: s.service || undefined,
          request: { method: s.method, path: s.path.trim().startsWith('/') ? s.path.trim() : `/${s.path.trim()}`, headers: record(s.headers, ':', `${where} header`), query: record(s.query, '=', `${where} query`), body },
          assertions,
          extract,
          ...(s.useEnvAuth ? {} : { useEnvAuth: false }),
        };
      }),
    };
  }

  function switchMode(next: 'form' | 'json') {
    error = '';
    if (next === mode) return;
    try {
      if (next === 'json') json = JSON.stringify(build(), null, 2);
      else {
        const f = JSON.parse(json) as QAFlow;
        name = f.name ?? '';
        description = f.description ?? '';
        category = f.category ?? 'happy-path';
        stage = f.stage ?? '';
        tasks = new Set(f.taskTitles ?? []);
        variables = lines(f.variables);
        dataQueries = f.dataQueries ?? [];
        steps = (f.steps ?? []).map((s) => toStepForm({ ...s, id: s.id ?? crypto.randomUUID(), assertions: s.assertions ?? [] }));
      }
      mode = next;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function save() {
    error = '';
    let f: QAFlow;
    try {
      f = mode === 'json' ? ({ ...JSON.parse(json), id: flow.id } as QAFlow) : build();
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    saving = true;
    const problem = await onsave(f).catch((e: Error) => e.message);
    saving = false;
    if (problem) error = problem;
  }

  function addStep() {
    const s = newStep(steps.length + 1);
    steps = [...steps, s];
    openStep = s.id;
  }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    steps = next;
  }
  function duplicate(i: number) {
    const copy = { ...structuredClone($state.snapshot(steps[i])), id: crypto.randomUUID(), name: `${steps[i].name} (salinan)` } as StepForm;
    steps = [...steps.slice(0, i + 1), copy, ...steps.slice(i + 1)];
    openStep = copy.id;
  }
  function removeStep(i: number) {
    steps = steps.filter((_, j) => j !== i);
  }
  function formatBody(s: StepForm) {
    try {
      s.body = JSON.stringify(JSON.parse(s.body), null, 2);
      error = '';
    } catch (e) {
      error = `Body ${s.name}: JSON tidak valid (${(e as Error).message}).`;
    }
  }

  /** Fills a step from a pasted cURL; the service is recognised from the environment's URLs. */
  function applyCurl(s: StepForm) {
    const c = parseCurl(s.curl);
    if (!c) {
      error = 'cURL tidak bisa dibaca. Tempel perintah lengkap, mis. curl -X POST https://host/v1/x -H "…" -d \'{…}\'.';
      return;
    }
    const match = Object.entries(serviceUrls).find(([, base]) => base && c.url.startsWith(base.replace(/\/+$/, '')));
    const basePath = match ? new URL(match[1]).pathname.replace(/\/+$/, '') : '';
    s.method = (QA_METHODS as readonly string[]).includes(c.method) ? (c.method as QAMethod) : 'GET';
    s.service = match?.[0] ?? s.service;
    s.path = (c.path.startsWith(basePath) ? c.path.slice(basePath.length) : c.path) || '/';
    s.query = lines(c.query);
    // The environment adds auth; keep the other headers.
    s.headers = lines(Object.fromEntries(Object.entries(c.headers).filter(([k]) => !/^(authorization|content-length|host)$/i.test(k))), ': ');
    s.body = c.body ? (() => { try { return JSON.stringify(JSON.parse(c.body), null, 2); } catch { return c.body; } })() : '';
    s.curl = '';
    s.curlOpen = false;
    error = '';
  }

  const extraNew = (): Extra => ({ type: 'json', target: '', op: 'equals', expected: '', db: databases[0] ?? '', sql: '', column: '' });
</script>

<div class="editor">
  <div class="mode" role="tablist">
    <button role="tab" class:active={mode === 'form'} onclick={() => switchMode('form')}>Form</button>
    <button role="tab" class:active={mode === 'json'} onclick={() => switchMode('json')}>JSON</button>
  </div>

  {#if mode === 'json'}
    <textarea class="input mono json" rows="20" bind:value={json} spellcheck="false"></textarea>
  {:else}
    <div class="grid2">
      <label class="field"><span>Nama test case</span><input class="input" bind:value={name} placeholder="mis. Reserve promo dengan kuota tersedia" /></label>
      <label class="field">
        <span>Kategori</span>
        <select class="input" bind:value={category}>{#each QA_CATEGORIES as c (c)}<option value={c}>{QA_CATEGORY_LABELS[c]}</option>{/each}</select>
      </label>
    </div>
    <label class="field"><span>Tahap journey <em class="muted">(urutan alur, mis. "1. Buat data promo (CMS)")</em></span><input class="input" bind:value={stage} placeholder="2. Approval & aktivasi" /></label>
    <label class="field"><span>Deskripsi <em class="muted">(tujuan & kondisi awal)</em></span><textarea class="input" rows="2" bind:value={description}></textarea></label>

    {#if taskTitles.length}
      <details class="box">
        <summary>Task terkait <span class="muted small">({tasks.size} dipilih)</span></summary>
        <div class="tasks">
          {#each taskTitles as t (t)}
            <label class="check small"><input type="checkbox" checked={tasks.has(t)} onchange={() => { const n = new Set(tasks); if (n.has(t)) n.delete(t); else n.add(t); tasks = n; }} /> {t}</label>
          {/each}
        </div>
      </details>
    {/if}

    <label class="field">
      <span>Variabel contoh <em class="muted">(<code>nama = nilai</code>, dipakai sebagai <code>{'{{nama}}'}</code>; variabel environment menimpanya)</em></span>
      <textarea class="input mono" rows="2" bind:value={variables} placeholder="merchantId = M-0001"></textarea>
    </label>

    {#if databases.length}
      <div class="box">
        <div class="box-head">
          <strong class="small">Data nyata dari database</strong>
          <span class="muted small">diambil sebelum request pertama · hanya SELECT</span>
          <span class="grow"></span>
          <button class="btn btn-xs" onclick={() => (dataQueries = [...dataQueries, { name: '', db: databases[0], sql: '' }])}><Icon name="plus" size={11} /> Data</button>
        </div>
        {#each dataQueries as q, i (i)}
          <div class="dq">
            <input class="input mono" bind:value={q.name} placeholder="promoId" aria-label="Nama variabel" />
            <select class="input" bind:value={q.db} aria-label="Database">{#each databases as d (d)}<option value={d}>{d}</option>{/each}</select>
            <input class="input mono" bind:value={q.column} placeholder="kolom (opsional)" aria-label="Kolom" />
            <button class="btn btn-ghost btn-xs" onclick={() => (dataQueries = dataQueries.filter((_, j) => j !== i))} aria-label="Hapus"><Icon name="trash" size={11} /></button>
            <textarea class="input mono sql" rows="2" bind:value={q.sql} placeholder="SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1"></textarea>
          </div>
        {/each}
      </div>
    {/if}

    <div class="steps-head">
      <strong>Step ({steps.length})</strong>
      <span class="grow"></span>
      <button class="btn btn-sm" onclick={addStep}><Icon name="plus" size={12} /> Step</button>
    </div>

    {#each steps as s, i (s.id)}
      <div class="step" class:open={openStep === s.id}>
        <div class="step-bar">
          <button class="step-toggle" onclick={() => (openStep = openStep === s.id ? null : s.id)} aria-expanded={openStep === s.id}>
            <span class="num">{i + 1}</span>
            <span class="method m-{s.method.toLowerCase()}">{s.method}</span>
            <span class="mono path">{s.path || '/'}</span>
            <span class="muted small">{s.name}{s.service ? ` · ${s.service}` : ''}</span>
          </button>
          <button class="icon" onclick={() => move(i, -1)} disabled={i === 0} title="Naik" aria-label="Naikkan step">↑</button>
          <button class="icon" onclick={() => move(i, 1)} disabled={i === steps.length - 1} title="Turun" aria-label="Turunkan step">↓</button>
          <button class="icon" onclick={() => duplicate(i)} title="Duplikat" aria-label="Duplikat step"><Icon name="copy" size={11} /></button>
          <button class="icon" onclick={() => removeStep(i)} title="Hapus" aria-label="Hapus step"><Icon name="trash" size={11} /></button>
        </div>

        {#if openStep === s.id}
          <div class="step-body">
            <div class="curl-row">
              {#if s.curlOpen}
                <textarea class="input mono" rows="3" bind:value={s.curl} placeholder={`curl -X POST 'https://host/v1/promos/reserve' -H 'Content-Type: application/json' -d '{"promoId":"P1"}'`}></textarea>
                <div class="row-actions">
                  <button class="btn btn-sm btn-primary" onclick={() => applyCurl(s)} disabled={!s.curl.trim()}>Isi dari cURL</button>
                  <button class="btn btn-ghost btn-sm" onclick={() => (s.curlOpen = false)}>Batal</button>
                </div>
              {:else}
                <button class="link" onclick={() => (s.curlOpen = true)}><Icon name="upload" size={11} /> Tempel cURL untuk mengisi otomatis</button>
              {/if}
            </div>

            <div class="grid-req">
              <label class="field"><span>Nama step</span><input class="input" bind:value={s.name} /></label>
              <label class="field">
                <span>Service</span>
                <input class="input mono" bind:value={s.service} list="flow-services" placeholder="default environment" />
              </label>
              <label class="field">
                <span>Method</span>
                <select class="input" bind:value={s.method}>{#each QA_METHODS as m (m)}<option value={m}>{m}</option>{/each}</select>
              </label>
              <label class="field path-field"><span>Path</span><input class="input mono" bind:value={s.path} placeholder="/v1/promos/{'{{promoId}}'}/reserve" /></label>
            </div>

            <div class="grid2">
              <label class="field"><span>Header <em class="muted">(<code>Nama: nilai</code>)</em></span><textarea class="input mono" rows="2" bind:value={s.headers} placeholder="X-Channel: MOBILE"></textarea></label>
              <label class="field"><span>Query <em class="muted">(<code>nama = nilai</code>)</em></span><textarea class="input mono" rows="2" bind:value={s.query} placeholder="page = 1"></textarea></label>
            </div>

            {#if s.method !== 'GET'}
              <label class="field">
                <span class="label-row">Body (JSON) <button class="link" onclick={() => formatBody(s)}>Rapikan & cek</button></span>
                <textarea class="input mono" rows="6" bind:value={s.body} placeholder={'{\n  "promoId": "{{promoId}}",\n  "amount": 10000\n}'} spellcheck="false"></textarea>
              </label>
            {/if}

            <div class="grid2">
              <label class="field"><span>Status yang diharapkan</span><input class="input mono" bind:value={s.status} placeholder="200 atau 200, 201" /></label>
              <label class="field"><span>Ambil nilai dari response <em class="muted">(<code>nama ← $.data.id</code>)</em></span><textarea class="input mono" rows="2" bind:value={s.extract} placeholder="reservationId ← $.data.id"></textarea></label>
            </div>

            <div class="box">
              <div class="box-head">
                <strong class="small">Cek tambahan</strong>
                <span class="grow"></span>
                <button class="btn btn-xs" onclick={() => (s.extras = [...s.extras, extraNew()])}><Icon name="plus" size={11} /> Cek</button>
              </div>
              {#each s.extras as x, j (j)}
                <div class="extra">
                  <select class="input" bind:value={x.type} aria-label="Jenis cek">
                    <option value="json">Field JSON</option>
                    <option value="header">Header</option>
                    <option value="latency">Waktu respons</option>
                    {#if databases.length}<option value="db">Data DB</option>{/if}
                  </select>
                  {#if x.type === 'latency'}
                    <span class="muted small">kurang dari</span>
                    <input class="input mono" bind:value={x.expected} placeholder="3000" aria-label="Batas ms" /><span class="muted small">ms</span>
                  {:else}
                    {#if x.type === 'db'}
                      <select class="input" bind:value={x.db} aria-label="Database">{#each databases as d (d)}<option value={d}>{d}</option>{/each}</select>
                      <input class="input mono" bind:value={x.column} placeholder="kolom (opsional)" aria-label="Kolom" />
                    {:else}
                      <input class="input mono" bind:value={x.target} placeholder={x.type === 'json' ? '$.data.status' : 'Content-Type'} aria-label="Target" />
                    {/if}
                    <select class="input" bind:value={x.op} aria-label="Operator">{#each QA_VALUE_OPS as o (o)}<option value={o}>{o}</option>{/each}</select>
                    {#if x.op !== 'exists' && x.op !== 'not_exists'}<input class="input mono" bind:value={x.expected} placeholder="nilai, mis. PENDING" aria-label="Nilai" />{/if}
                  {/if}
                  <button class="btn btn-ghost btn-xs" onclick={() => (s.extras = s.extras.filter((_, k) => k !== j))} aria-label="Hapus cek"><Icon name="trash" size={11} /></button>
                  {#if x.type === 'db'}<textarea class="input mono sql" rows="2" bind:value={x.sql} placeholder={"SELECT status FROM reservations WHERE id = '{{reservationId}}'"}></textarea>{/if}
                </div>
              {:else}
                <p class="muted small">Opsional: cek field response, header, waktu respons, atau data di DB.</p>
              {/each}
            </div>

            <label class="check small"><input type="checkbox" bind:checked={s.useEnvAuth} /> Pakai auth environment (matikan untuk step login atau uji tanpa auth)</label>
          </div>
        {/if}
      </div>
    {/each}
    <datalist id="flow-services">{#each services as sv (sv)}<option value={sv}></option>{/each}</datalist>
  {/if}

  {#if error}<p class="err small">{error}</p>{/if}
  <div class="actions">
    <span class="grow"></span>
    <button class="btn btn-sm" onclick={oncancel} disabled={saving}>Batal</button>
    <button class="btn btn-primary btn-sm" onclick={save} disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan test case'}</button>
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .mode {
    display: inline-flex;
    align-self: flex-start;
    padding: 3px;
    gap: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .mode button {
    padding: 4px 14px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .mode button.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-sm);
  }
  .json {
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-2);
  }
  .label-row {
    display: flex;
    justify-content: space-between;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .grid-req {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 110px;
    gap: 10px;
  }
  .path-field {
    grid-column: 1 / -1;
  }
  .box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
  }
  .box summary {
    cursor: pointer;
    font-size: 12.5px;
  }
  .box-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tasks {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    max-height: 180px;
    overflow-y: auto;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .small {
    font-size: 12px;
  }
  .grow {
    flex: 1;
  }
  .dq,
  .extra {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .dq .input,
  .extra .input {
    width: auto;
    flex: 1;
    min-width: 110px;
    font-size: 12px;
  }
  .sql {
    flex-basis: 100% !important;
  }
  .steps-head {
    display: flex;
    align-items: center;
    margin-top: 4px;
  }
  .step {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
  }
  .step.open {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .step-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
  }
  .step-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 4px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .step-toggle .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .num {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface-2);
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .method {
    padding: 1px 6px;
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    background: var(--surface-2);
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
  .icon {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--border);
  }
  .curl-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row-actions {
    display: flex;
    gap: 6px;
  }
  .link {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
    gap: 4px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .err {
    margin: 0;
    color: var(--err);
  }
  @media (max-width: 760px) {
    .grid2,
    .grid-req {
      grid-template-columns: 1fr;
    }
  }
</style>
