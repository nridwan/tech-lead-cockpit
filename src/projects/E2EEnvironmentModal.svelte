<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import { matchDatabases, matchScore } from '../lib/qa/db-match';
  import { emptyEnvironment, type QAEnvironment } from '../lib/qa/types';

  let {
    open = $bindable(false),
    environments = $bindable([]),
    services = [],
    selectedId = $bindable(''),
  }: {
    open: boolean;
    environments: QAEnvironment[];
    /** Service names from the TAD, offered as rows for their base URLs. */
    services?: string[];
    selectedId?: string;
  } = $props();

  let editing = $state<QAEnvironment | null>(null);
  let servicesText = $state('');
  let headersText = $state('');
  let variablesText = $state('');
  let secretVarsText = $state('');
  let secretVarsInitial = '';
  let secret = $state('');
  let clearSecret = $state(false);
  let saving = $state(false);
  let error = $state('');
  // Databases: one server (one login) and a database per service.
  let serverPassword = $state('');
  let serverStatus = $state<{ ok: boolean; text: string } | 'testing' | null>(null);
  let serverDbs = $state<string[]>([]);
  let listing = $state(false);
  let rowStatus = $state<Record<number, { ok: boolean; text: string } | 'testing'>>({});
  /** Services matched automatically but not word for word: the user should look at them. */
  let uncertain = $state(new Set<string>());

  /** Services to map: the environment's base URLs and the project's TAD services. */
  const knownServices = $derived([...new Set([...Object.keys(fromLinesSafe(servicesText)), ...services])].filter(Boolean).sort());
  function fromLinesSafe(text: string): Record<string, string> {
    try {
      return fromLines(text, '=');
    } catch {
      return {};
    }
  }

  async function savedId(): Promise<string | undefined> {
    const ok = await save(true);
    return ok ? editing?.id || selectedId : undefined;
  }

  async function testServer() {
    serverStatus = 'testing';
    const id = await savedId();
    if (!id) return void (serverStatus = { ok: false, text: error || 'Simpan environment gagal.' });
    try {
      serverStatus = { ok: true, text: `Terhubung · ${await qa.testDatabase(id)}` };
    } catch (e) {
      serverStatus = { ok: false, text: (e as Error).message };
    }
  }

  /** Lists the server's databases and maps every service without one to its best match. */
  async function listAndMatch() {
    if (!editing) return;
    listing = true;
    try {
      const id = await savedId();
      if (!id) return;
      serverDbs = await qa.listDatabases(id);
      const mapped = new Set((editing.databases ?? []).map((d) => (d.service ?? d.name).toLowerCase()));
      const free = serverDbs.filter((d) => !(editing?.databases ?? []).some((x) => x.database === d));
      const matches = matchDatabases(knownServices.filter((sv) => !mapped.has(sv.toLowerCase())), free);
      const added = Object.entries(matches).map(([service, database]) => ({ name: service, service, database }));
      uncertain = new Set(added.filter((a) => matchScore(a.service, a.database) < 1).map((a) => a.service));
      editing.databases = [...(editing.databases ?? []), ...added];
      const left = knownServices.filter((sv) => !mapped.has(sv.toLowerCase()) && !matches[sv]).length;
      toasts.show(`${serverDbs.length} database di server · ${added.length} service dicocokkan${uncertain.size ? ` (${uncertain.size} perlu diperiksa)` : ''}${left ? ` · ${left} service tanpa pasangan` : ''}. Periksa lalu simpan.`, 'ok', 7000);
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      listing = false;
    }
  }

  function addRow() {
    if (!editing) return;
    editing.databases = [...(editing.databases ?? []), { name: '', service: '', database: '' }];
  }
  function removeRow(i: number) {
    if (!editing?.databases) return;
    editing.databases = editing.databases.filter((_, j) => j !== i);
  }
  async function testRow(i: number) {
    const d = editing?.databases?.[i];
    if (!d) return;
    rowStatus[i] = 'testing';
    const id = await savedId();
    if (!id) return void (rowStatus[i] = { ok: false, text: error || 'Simpan gagal.' });
    try {
      await qa.testDatabase(id, d.service || d.name);
      rowStatus[i] = { ok: true, text: 'OK' };
    } catch (e) {
      rowStatus[i] = { ok: false, text: (e as Error).message };
    }
  }

  const toLines = (r: Record<string, string>, sep: string) =>
    Object.entries(r)
      .map(([k, v]) => `${k}${sep}${v}`)
      .join('\n');

  function fromLines(text: string, sep: ':' | '=', what = 'Baris'): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf(sep);
      if (i <= 0) throw new Error(`${what} "${t.slice(0, 40)}" harus berformat nama ${sep} nilai.`);
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  }

  function edit(env: QAEnvironment | null) {
    const e = env ? structuredClone($state.snapshot(env)) : emptyEnvironment();
    // Offer the TAD's services that have no URL yet, so the user only fills in the blanks.
    const services_ = { ...e.services };
    for (const s of services) if (!Object.keys(services_).some((k) => k.toLowerCase() === s.toLowerCase())) services_[s] = '';
    editing = e;
    servicesText = toLines(services_, ' = ');
    headersText = toLines(e.headers, ': ');
    variablesText = toLines(e.variables, ' = ');
    // Stored values are never sent back to the UI: names only, an empty value keeps the stored one.
    secretVarsInitial = (e.secretVariableNames ?? []).map((n) => `${n} = `).join('\n');
    secretVarsText = secretVarsInitial;
    secret = '';
    clearSecret = false;
    error = '';
    e.databases ??= [];
    e.dbServer ??= { host: '', port: 5432, user: '' };
    serverPassword = '';
    serverStatus = null;
    rowStatus = {};
  }

  async function save(keepOpen = false): Promise<boolean> {
    if (!editing) return false;
    error = '';
    let env: QAEnvironment;
    let secretVariables: Record<string, string> | undefined;
    try {
      secretVariables = secretVarsText.trim() === secretVarsInitial.trim() ? undefined : fromLines(secretVarsText, '=', 'Variabel rahasia');
      env = {
        ...$state.snapshot(editing),
        services: Object.fromEntries(Object.entries(fromLines(servicesText, '=')).filter(([, v]) => v)),
        headers: fromLines(headersText, ':'),
        variables: fromLines(variablesText, '='),
        dbServer: editing.dbServer?.host?.trim() ? $state.snapshot(editing.dbServer) : undefined,
        databases: (editing.databases ?? []).filter((d) => (d.service || d.name).trim() || d.database.trim()).map((d) => ({ ...$state.snapshot(d), name: (d.service || d.name).trim(), service: d.service?.trim() || undefined })),
      };
    } catch (e) {
      error = (e as Error).message;
      return false;
    }
    saving = true;
    try {
      const before = new Set(environments.map((e) => e.id));
      environments = await qa.saveEnvironment(env, clearSecret ? '' : secret || undefined, secretVariables, undefined, serverPassword || undefined);
      const saved = env.id ? env.id : environments.find((e) => !before.has(e.id))?.id;
      if (saved) selectedId = saved;
      secret = '';
      serverPassword = '';
      if (keepOpen) {
        const fresh = environments.find((e) => e.id === saved);
        if (fresh && editing) Object.assign(editing, { id: fresh.id, hasSecret: fresh.hasSecret, dbServerPassword: fresh.dbServerPassword, dbPasswords: fresh.dbPasswords });
      } else {
        editing = null;
        toasts.show('Environment tersimpan.', 'ok', 2000);
      }
      return true;
    } catch (e) {
      error = (e as Error).message;
      return false;
    } finally {
      saving = false;
    }
  }

  async function remove(env: QAEnvironment) {
    const ok = await confirmDialog({ title: 'Hapus environment?', message: `Hapus "${env.name}" beserta token-nya di Keychain?`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    try {
      environments = await qa.deleteEnvironment(env.id);
      if (selectedId === env.id) selectedId = environments[0]?.id ?? '';
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  const secretLabel = $derived(editing?.auth.type === 'basic' ? 'Password' : 'Token');
</script>

<Modal bind:open title="Environment E2E" subtitle="Server tujuan test: base URL per service, header, variabel, dan auth" width={760} onclose={() => (editing = null)}>
  {#if !editing}
    <div class="env-list">
      {#if !environments.length}
        <p class="muted">Belum ada environment. Tambahkan server dev/staging/lokal yang akan dites.</p>
      {/if}
      {#each environments as env (env.id)}
        <div class="env-row">
          <div class="env-info">
            <strong>{env.name}</strong>
            <span class="muted small mono">{env.baseUrl || '(tanpa base URL default)'}{Object.keys(env.services).length ? ` · ${Object.keys(env.services).length} service` : ''}</span>
          </div>
          <div class="env-tags">
            {#if env.readOnly}<span class="chip chip-ok">Read-only</span>{/if}
            {#if env.secretVariableNames?.length}<span class="chip" title={env.secretVariableNames.join(', ')}><Icon name="lock" size={11} /> {env.secretVariableNames.length} rahasia</span>{/if}
            {#if env.auth.type !== 'none'}<span class="chip {env.hasSecret ? '' : 'chip-warn'}"><Icon name="key" size={11} /> {env.auth.type}{env.hasSecret ? '' : ' (token kosong)'}</span>{/if}
          </div>
          <button class="btn btn-sm" onclick={() => edit(env)}><Icon name="edit" size={13} /> Ubah</button>
          <button class="btn btn-ghost btn-sm" onclick={() => remove(env)} aria-label="Hapus {env.name}"><Icon name="trash" size={13} /></button>
        </div>
      {/each}
      <button class="btn btn-primary btn-sm add" onclick={() => edit(null)}><Icon name="plus" size={13} /> Tambah environment</button>
    </div>
  {:else}
    <form class="env-form" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <div class="grid2">
        <label class="field">
          <span>Nama</span>
          <input class="input" bind:value={editing.name} placeholder="mis. Staging" required />
        </label>
        <label class="field">
          <span>Base URL default</span>
          <input class="input mono" bind:value={editing.baseUrl} placeholder="https://api-staging.internal.net" />
        </label>
      </div>

      <label class="field">
        <span>Base URL per service <em class="muted">(satu per baris: <code>nama-service = https://…</code>; kosong = pakai default)</em></span>
        <textarea class="input mono" rows="5" bind:value={servicesText} placeholder="core-payment = https://payment-staging.internal.net&#10;merchant-service = http://localhost:8081"></textarea>
      </label>

      <div class="grid2">
        <label class="field">
          <span>Header default <em class="muted">(<code>Nama: nilai</code>)</em></span>
          <textarea class="input mono" rows="4" bind:value={headersText}></textarea>
        </label>
        <label class="field">
          <span>Variabel <em class="muted">(<code>nama = nilai</code>, dipakai sebagai <code>{'{{nama}}'}</code>)</em></span>
          <textarea class="input mono" rows="4" bind:value={variablesText} placeholder="merchantId = M-0001&#10;username = qa.tester"></textarea>
        </label>
      </div>

      <label class="field">
        <span>Variabel rahasia <em class="muted">(kredensial uji, PIN, OTP statis: <code>nama = nilai</code>; disimpan di Keychain dan disamarkan di hasil. Nilai kosong = tetap pakai yang tersimpan, hapus baris = hapus variabel)</em></span>
        <textarea class="input mono" rows="3" bind:value={secretVarsText} placeholder="password = …&#10;pin = …" autocomplete="off" spellcheck="false"></textarea>
      </label>

      <div class="grid3">
        <label class="field">
          <span>Auth</span>
          <select class="input" bind:value={editing.auth.type}>
            <option value="none">Tanpa auth</option>
            <option value="bearer">Bearer token</option>
            <option value="basic">Basic (username + password)</option>
            <option value="header">Header API key</option>
          </select>
        </label>
        {#if editing.auth.type === 'header'}
          <label class="field">
            <span>Nama header</span>
            <input class="input mono" bind:value={editing.auth.headerName} placeholder="X-Api-Key" />
          </label>
        {:else if editing.auth.type === 'basic'}
          <label class="field">
            <span>Username</span>
            <input class="input" bind:value={editing.auth.username} autocomplete="off" />
          </label>
        {/if}
        {#if editing.auth.type !== 'none'}
          <label class="field">
            <span>{secretLabel} {editing.hasSecret ? '(tersimpan di Keychain)' : ''}</span>
            <input class="input" type="password" bind:value={secret} autocomplete="off" placeholder={editing.hasSecret ? 'Kosongkan untuk tetap memakai yang lama' : `${secretLabel} untuk environment ini`} disabled={clearSecret} />
            {#if editing.hasSecret}
              <label class="check small"><input type="checkbox" bind:checked={clearSecret} /> Hapus {secretLabel.toLowerCase()} tersimpan</label>
            {/if}
          </label>
        {/if}
      </div>

      <div class="grid2">
        <label class="check">
          <input type="checkbox" bind:checked={editing.readOnly} />
          <span><strong>Read-only</strong>: hanya request GET yang dikirim. Aktifkan untuk server yang datanya tidak boleh berubah.</span>
        </label>
        <label class="field">
          <span>Timeout per request (detik)</span>
          <input class="input" type="number" min="1" max="300" value={Math.round(editing.timeoutMs / 1000)} oninput={(e) => editing && (editing.timeoutMs = Number(e.currentTarget.value) * 1000)} />
        </label>
      </div>

      <section class="dbs">
        <div class="dbs-head">
          <strong>Database (hanya baca)</strong>
          <span class="muted small">PostgreSQL, untuk data nyata variabel uji dan cek data setelah request. Hanya SELECT di transaksi read-only, sehingga data tidak bisa diubah atau dihapus.</span>
        </div>
        {#if editing.dbServer}
          <div class="db-grid">
            <label class="field"><span>Host server</span><input class="input mono" bind:value={editing.dbServer.host} placeholder="172.31.135.20" /></label>
            <label class="field"><span>Port</span><input class="input mono" type="number" bind:value={editing.dbServer.port} placeholder="5432" /></label>
            <label class="field"><span>User</span><input class="input mono" bind:value={editing.dbServer.user} autocomplete="off" placeholder="readonly_user" /></label>
            <label class="field">
              <span>Password {editing.dbServerPassword ? '(tersimpan)' : ''}</span>
              <input class="input" type="password" bind:value={serverPassword} autocomplete="off" placeholder={editing.dbServerPassword ? 'Kosongkan untuk tetap memakai yang lama' : 'Password database'} />
            </label>
          </div>
          <div class="db-actions">
            <label class="check small"><input type="checkbox" bind:checked={editing.dbServer.ssl} /> SSL</label>
            <span class="grow"></span>
            {#if serverStatus === 'testing'}<span class="muted small">Menghubungkan…</span>{:else if serverStatus}<span class="small {serverStatus.ok ? 'ok' : 'err'}">{serverStatus.text}</span>{/if}
            <button class="btn btn-sm" type="button" onclick={testServer} disabled={saving || !editing.dbServer.host || !editing.dbServer.user}>Simpan & tes koneksi</button>
          </div>
        {/if}

        <div class="dbs-head map-head">
          <strong class="small">Database per service ({editing.databases?.length ?? 0})</strong>
          <span class="grow"></span>
          <button class="btn btn-sm btn-primary" type="button" onclick={listAndMatch} disabled={listing || saving || !editing.dbServer?.host || !editing.dbServer?.user}>{listing ? 'Mengambil…' : 'Ambil daftar database & cocokkan'}</button>
          <button class="btn btn-sm" type="button" onclick={addRow}><Icon name="plus" size={12} /> Baris</button>
        </div>
        {#if editing.databases?.length}
          <div class="map">
            <div class="map-row head"><span>Service</span><span>Database</span><span></span></div>
            {#each editing.databases as d, i (i)}
              <div class="map-row" class:check-me={uncertain.has(d.service ?? '')} title={uncertain.has(d.service ?? '') ? 'Cocok sebagian: pastikan database ini memang milik service tersebut' : undefined}>
                <input class="input mono" bind:value={d.service} list="db-services" placeholder="core-promo-ultimate" aria-label="Service" oninput={() => { const n = new Set(uncertain); n.delete(d.service ?? ''); uncertain = n; }} />
                <input class="input mono" bind:value={d.database} list="db-names" placeholder="promo_db" aria-label="Nama database" />
                <span class="row-actions">
                  {#if uncertain.has(d.service ?? '')}<span class="warn-tag small">periksa</span>{/if}
                  {#if rowStatus[i] === 'testing'}<span class="muted small">…</span>{:else if rowStatus[i]}{@const st = rowStatus[i] as { ok: boolean; text: string }}<span class="small {st.ok ? 'ok' : 'err'}" title={st.text}>{st.ok ? 'OK' : 'Gagal'}</span>{/if}
                  <button class="btn btn-ghost btn-xs" type="button" onclick={() => testRow(i)} disabled={saving || !d.database} title="Tes database ini">Tes</button>
                  <button class="btn btn-ghost btn-xs" type="button" onclick={() => removeRow(i)} aria-label="Hapus baris"><Icon name="trash" size={11} /></button>
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="muted small">Isi server lalu klik <strong>Ambil daftar database & cocokkan</strong>: nama database di server dicocokkan otomatis dengan nama service. Bisa juga tambah baris manual.</p>
        {/if}
        <datalist id="db-services">{#each knownServices as sv (sv)}<option value={sv}></option>{/each}</datalist>
        <datalist id="db-names">{#each serverDbs as dn (dn)}<option value={dn}></option>{/each}</datalist>
        <p class="muted small">Saat generate, AI hanya membaca skema database milik service dari task yang dipilih. Saran: pakai user yang hanya punya izin SELECT.</p>
      </section>

      <p class="muted small">Token, password, dan variabel rahasia disimpan di macOS Keychain, tidak pernah dikirim ke AI, dan disamarkan (<code>***</code>) di hasil run maupun perintah curl. Variabel biasa tersimpan sebagai teks di <code>~/.tech-lead-cockpit/qa</code>.</p>
      {#if error}<p class="err small">{error}</p>{/if}
      <div class="form-actions">
        <button type="button" class="btn btn-sm" onclick={() => (editing = null)}>Batal</button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan environment'}</button>
      </div>
    </form>
  {/if}
</Modal>

<style>
  .env-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .env-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .env-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .env-info .small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .env-tags {
    display: flex;
    gap: 6px;
  }
  .add {
    align-self: flex-start;
    margin-top: 4px;
  }
  .env-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .grid2,
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .grid3 {
    grid-template-columns: repeat(3, 1fr);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .field em {
    font-style: normal;
    font-size: 11.5px;
  }
  textarea {
    resize: vertical;
    font-size: 12px;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12.5px;
    line-height: 1.4;
  }
  .check.small {
    margin-top: 4px;
    font-size: 11.5px;
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .small {
    font-size: 12px;
  }
  @media (max-width: 720px) {
    .grid2,
    .grid3 {
      grid-template-columns: 1fr;
    }
  }
  .dbs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .dbs-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .db-grid {
    display: grid;
    grid-template-columns: 2fr 90px 1.2fr 1.4fr;
    gap: 8px;
  }
  .map-head {
    margin-top: 6px;
  }
  .map {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 320px;
    overflow-y: auto;
  }
  .map-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 170px;
    align-items: center;
    gap: 6px;
  }
  .map-row.head {
    position: sticky;
    top: 0;
    background: var(--surface-2);
    font-size: 11px;
    color: var(--text-3);
    text-transform: uppercase;
  }
  .map-row .input {
    font-size: 12px;
    padding-top: 4px;
    padding-bottom: 4px;
  }
  .map-row.check-me .input {
    border-color: var(--warn);
  }
  .warn-tag {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-weight: 600;
  }
  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
  }
  .db-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .ok {
    color: var(--ok);
  }
</style>
