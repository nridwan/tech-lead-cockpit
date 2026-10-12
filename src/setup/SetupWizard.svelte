<script lang="ts">
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { aiProviders } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { connector } from '../lib/confluence/client';
  import type { ConnectorStatus } from '../lib/confluence/api-types';
  import { figma } from '../lib/figma/client';
  import type { FigmaStatus } from '../lib/figma/types';
  import { gitlab } from '../lib/gitlab/client';
  import type { GitLabStatus } from '../lib/gitlab/types';
  import { jira } from '../lib/jira/client';
  import type { JiraProject, JiraStatus } from '../lib/jira/types';
  import { appSettings } from '../lib/settings/store.svelte';
  import { fetchServicesInfo, saveServicesRoot, type ServicesInfo } from '../tad/generator-client';

  /**
   * First-run setup (and re-run from Koneksi): everything Cockpit needs, without touching code or
   * .env files. Plain settings go to ~/.tech-lead-cockpit/settings.json, tokens to the Keychain.
   * Each step saves on "Simpan & lanjut" and can be tested and skipped.
   */
  const STEPS = [
    { id: 'welcome', label: 'Mulai' },
    { id: 'codebase', label: 'Codebase' },
    { id: 'atlassian', label: 'Jira & Confluence' },
    { id: 'gitlab', label: 'GitLab' },
    { id: 'figma', label: 'Figma' },
    { id: 'ai', label: 'AI' },
    { id: 'more', label: 'Integrasi lain' },
    { id: 'done', label: 'Ringkasan' },
  ] as const;
  type StepId = (typeof STEPS)[number]['id'];

  let step = $state<StepId>('welcome');
  let busy = $state(false);
  let err = $state('');
  const idx = $derived(STEPS.findIndex((s) => s.id === step));
  const s = $derived(appSettings.value);

  // Form state, filled from the saved settings when the wizard opens.
  let orgName = $state('');
  let servicesRoot = $state('');
  let baseBranch = $state('');
  let services = $state<ServicesInfo | null>(null);

  let atlKind = $state<'cloud' | 'datacenter'>('cloud');
  let cloudUrl = $state('');
  let cloudEmail = $state('');
  let cloudToken = $state('');
  let jiraUrl = $state('');
  let jiraToken = $state('');
  let confUrl = $state('');
  let confToken = $state('');
  let jiraProject = $state('');
  let projects = $state<JiraProject[]>([]);
  let jiraStatus = $state<JiraStatus | null>(null);
  let confStatus = $state<ConnectorStatus | null>(null);

  let gitlabUrl = $state('');
  let gitlabToken = $state('');
  let gitlabStatus = $state<GitLabStatus | null>(null);

  let figmaToken = $state('');
  let figmaStatus = $state<FigmaStatus | null>(null);

  let aiDefault = $state<AiSelection>({ provider: '9router', model: '' });
  let ihUrl = $state('');
  let ihModel = $state('');
  let ihKey = $state('');
  let nrUrl = $state('');
  let nrModel = $state('');
  let nrKey = $state('');

  $effect(() => {
    if (!appSettings.wizardOpen) return;
    untrack(() => fill());
  });

  function fill() {
    const v = appSettings.value;
    step = 'welcome';
    err = '';
    orgName = v.general.orgName;
    servicesRoot = v.workspace.servicesRoot;
    baseBranch = v.workspace.defaultBaseBranch;
    atlKind = !v.jira.baseUrl || /atlassian\.net/i.test(v.jira.baseUrl) ? 'cloud' : 'datacenter';
    cloudUrl = /atlassian\.net/i.test(v.jira.baseUrl) ? v.jira.baseUrl : '';
    cloudEmail = v.jira.email || v.confluence.email;
    jiraUrl = v.jira.baseUrl;
    confUrl = v.confluence.baseUrl;
    jiraProject = v.jira.defaultProject;
    gitlabUrl = v.gitlab.baseUrl;
    aiDefault = { provider: v.ai.defaultProvider, model: v.ai.defaultModel };
    ihUrl = v.ai.inferhub.baseUrl;
    ihModel = v.ai.inferhub.model;
    nrUrl = v.ai.ninerouter.baseUrl;
    nrModel = v.ai.ninerouter.model;
    cloudToken = jiraToken = confToken = gitlabToken = figmaToken = ihKey = nrKey = '';
    void checkServices();
    void testAtlassian(true);
    void testGitlab(true);
    void testFigma(true);
    void aiProviders.load(true);
  }

  async function run(fn: () => Promise<void>) {
    busy = true;
    err = '';
    try {
      await fn();
    } catch (e) {
      err = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function go(to: StepId) {
    err = '';
    step = to;
  }
  const next = () => go(STEPS[Math.min(idx + 1, STEPS.length - 1)].id);
  const back = () => go(STEPS[Math.max(idx - 1, 0)].id);

  async function skip() {
    if (!s.setup.skipped.includes(step)) await appSettings.save({ setup: { skipped: [...s.setup.skipped, step] } }).catch(() => {});
    next();
  }

  // Codebase ------------------------------------------------------------------------------

  async function checkServices() {
    services = null;
    services = await fetchServicesInfo(servicesRoot.trim()).catch((e) => ({ root: servicesRoot, exists: false, services: [], error: (e as Error).message, antigravity: { granted: false, settingsFile: '' } }));
  }

  const saveCodebase = () =>
    run(async () => {
      await checkServices();
      if (!services?.exists) throw new Error(services?.error ?? 'Folder codebase tidak ditemukan.');
      await appSettings.save({ general: { orgName: orgName.trim() }, workspace: { servicesRoot: servicesRoot.trim(), defaultBaseBranch: baseBranch.trim() || 'staging' } });
      saveServicesRoot(servicesRoot.trim());
      next();
    });

  // Atlassian -----------------------------------------------------------------------------

  async function testAtlassian(quiet = false) {
    [jiraStatus, confStatus] = await Promise.all([jira.status().catch(() => null), connector.status().catch(() => null)]);
    if (jiraStatus?.configured) projects = await jira.projects().catch(() => []);
    if (!quiet && !jiraStatus?.configured && !confStatus?.configured) throw new Error(jiraStatus?.error ?? confStatus?.error ?? 'Belum tersambung.');
  }

  const saveAtlassian = (thenNext: boolean) =>
    run(async () => {
      if (atlKind === 'cloud') {
        const base = cloudUrl.trim().replace(/\/+$/, '').replace(/\/wiki$/, '');
        if (!/^https:\/\/[^/]+\.atlassian\.net$/i.test(base)) throw new Error('URL Atlassian Cloud berbentuk https://namaorg.atlassian.net');
        if (!cloudEmail.trim()) throw new Error('Email akun Atlassian wajib diisi.');
        await appSettings.save({ jira: { baseUrl: base, auth: 'basic', email: cloudEmail.trim() }, confluence: { baseUrl: `${base}/wiki`, auth: 'basic', email: cloudEmail.trim() } });
        if (cloudToken.trim()) {
          await appSettings.saveSecret('jira', cloudToken.trim());
          await appSettings.saveSecret('confluence', cloudToken.trim());
        }
      } else {
        await appSettings.save({ jira: { baseUrl: jiraUrl.trim(), auth: 'bearer' }, confluence: { baseUrl: confUrl.trim(), auth: 'bearer' } });
        if (jiraToken.trim()) await appSettings.saveSecret('jira', jiraToken.trim());
        if (confToken.trim()) await appSettings.saveSecret('confluence', confToken.trim());
      }
      cloudToken = jiraToken = confToken = '';
      await testAtlassian();
      if (jiraProject) await appSettings.save({ jira: { defaultProject: jiraProject } });
      if (thenNext) next();
      else toasts.show('Koneksi Atlassian tersimpan.', 'ok', 2000);
    });

  // GitLab --------------------------------------------------------------------------------

  async function testGitlab(quiet = false) {
    gitlabStatus = await gitlab.status().catch(() => null);
    if (!quiet && !gitlabStatus?.configured) throw new Error(gitlabStatus?.error ?? 'Belum tersambung.');
  }

  const saveGitlab = () =>
    run(async () => {
      const base = gitlabUrl.trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(base)) throw new Error('URL GitLab harus https://');
      if (gitlabToken.trim()) {
        // Validates the token against GitLab before it replaces a working one.
        await gitlab.saveToken(gitlabToken.trim(), base);
        gitlabToken = '';
      }
      await appSettings.save({ gitlab: { baseUrl: base } });
      await testGitlab();
      next();
    });

  // Figma ---------------------------------------------------------------------------------

  async function testFigma(quiet = false) {
    figmaStatus = await figma.status().catch(() => null);
    if (!quiet && !figmaStatus?.configured) throw new Error(figmaStatus?.error ?? 'Belum tersambung.');
  }

  const saveFigma = () =>
    run(async () => {
      if (figmaToken.trim()) {
        // Validated against Figma before it replaces a working token.
        await figma.saveToken(figmaToken.trim());
        figmaToken = '';
        await appSettings.load();
      }
      await testFigma();
      next();
    });

  // AI ------------------------------------------------------------------------------------

  const saveAi = () =>
    run(async () => {
      await appSettings.save({
        ai: { defaultProvider: aiDefault.provider, defaultModel: aiDefault.model, inferhub: { baseUrl: ihUrl.trim(), model: ihModel.trim() }, ninerouter: { baseUrl: nrUrl.trim(), model: nrModel.trim() } },
      });
      if (ihKey.trim()) await appSettings.saveSecret('inferhub', ihKey.trim());
      if (nrKey.trim()) await appSettings.saveSecret('ninerouter', nrKey.trim());
      ihKey = nrKey = '';
      await aiProviders.load(true);
      const chosen = aiProviders.get(aiDefault.provider);
      if (chosen && !chosen.available) throw new Error(`${chosen.label} belum siap: ${chosen.note ?? 'cek pengaturannya'}. Pilih provider lain sebagai default, atau lengkapi dulu.`);
      next();
    });

  // Done ----------------------------------------------------------------------------------

  const checks = $derived([
    { label: 'Codebase Services', ok: Boolean(services?.exists), detail: services?.exists ? `${services.services.length} service di ${services.root}` : (services?.error ?? 'belum dicek') },
    { label: 'Jira', ok: Boolean(jiraStatus?.configured), detail: jiraStatus?.configured ? `${jiraStatus.user?.displayName ?? 'tersambung'} · ${s.jira.baseUrl}${s.jira.defaultProject ? ` · project ${s.jira.defaultProject}` : ''}` : (jiraStatus?.error ?? 'belum diatur') },
    { label: 'Confluence', ok: Boolean(confStatus?.configured), detail: confStatus?.configured ? `${confStatus.user ?? 'tersambung'} · ${s.confluence.baseUrl}` : (confStatus?.error ?? 'belum diatur') },
    { label: 'GitLab', ok: Boolean(gitlabStatus?.configured), detail: gitlabStatus?.configured ? `${gitlabStatus.user?.username ?? 'tersambung'} · ${s.gitlab.baseUrl}` : (gitlabStatus?.error ?? 'belum diatur') },
    { label: 'Figma', ok: Boolean(figmaStatus?.configured), detail: figmaStatus?.configured ? `${figmaStatus.user?.handle ?? 'tersambung'}${figmaStatus.user?.email ? ` · ${figmaStatus.user.email}` : ''}` : (figmaStatus?.error ?? 'belum diatur (opsional)') },
    { label: 'AI default', ok: Boolean(aiProviders.get(s.ai.defaultProvider)?.available), detail: `${aiProviders.get(s.ai.defaultProvider)?.label ?? s.ai.defaultProvider}${s.ai.defaultModel ? ` · ${s.ai.defaultModel}` : ''}` },
  ]);

  const finish = () =>
    run(async () => {
      await appSettings.save({ setup: { completedAt: new Date().toISOString() } });
      appSettings.wizardOpen = false;
      toasts.show('Setup selesai. Semua bisa diubah lagi lewat Koneksi → Jalankan setup.', 'ok', 4000);
    });

  function later() {
    try {
      sessionStorage.setItem('tlc.setup.later', '1');
    } catch {
      /* ignore */
    }
    appSettings.wizardOpen = false;
  }
</script>

{#if appSettings.wizardOpen}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div class="wizard">
      <aside class="steps">
        <h2 id="setup-title"><Icon name="plug" size={18} /> Setup Cockpit</h2>
        <ol>
          {#each STEPS as st, i (st.id)}
            <li class:active={st.id === step} class:done={i < idx}>
              <button onclick={() => go(st.id)} disabled={busy}><span class="n">{i < idx ? '✓' : i + 1}</span> {st.label}</button>
            </li>
          {/each}
        </ol>
        <p class="muted small">Pengaturan disimpan di <code>~/.tech-lead-cockpit/settings.json</code>; token di macOS Keychain. Tidak perlu mengubah kode atau file .env.</p>
      </aside>

      <section class="body">
        {#if step === 'welcome'}
          <h3>Selamat datang di Tech Lead Cockpit</h3>
          <p>Wizard ini menyiapkan semua yang dibutuhkan Cockpit: folder codebase, Jira & Confluence, GitLab, Figma, dan AI. Setiap langkah bisa dites dan dilewati, dan semuanya bisa diubah lagi kapan saja dari menu <strong>Koneksi</strong>.</p>
          {#if s.jira.baseUrl || s.gitlab.baseUrl || s.confluence.baseUrl}
            <p class="note"><Icon name="check" size={13} /> Pengaturan lama dari <code>.env.local</code> sudah dipindahkan ke sini. Cukup periksa dan lengkapi.</p>
          {/if}
          <label class="field">
            <span>Nama organisasi / tim (opsional)</span>
            <input class="input" bind:value={orgName} placeholder="mis. Tim Payment" />
          </label>
        {:else if step === 'codebase'}
          <h3>Folder codebase</h3>
          <p class="muted">Folder berisi semua repo service (satu subfolder per service). AI hanya <strong>membaca</strong> folder ini untuk menganalisa TAD, estimasi, bug tracing, dan trace kode; agent coding memakai salinan terpisah.</p>
          <div class="callout">
            <Icon name="alert" size={14} />
            <div>
              <strong>Kumpulkan semua repo service dalam satu folder.</strong> AI hanya memindai repo yang ada di folder ini, jadi repo yang di-clone di tempat lain tidak ikut dianalisa. Letakkan setiap repo (hasil <code>git clone</code>) langsung di bawah folder yang sama:
              <pre>~/Code/Services/
├── core-payment/
├── core-user/
└── portal-web/</pre>
            </div>
          </div>
          <label class="field">
            <span>Folder Services</span>
            <div class="row"><input class="input mono" bind:value={servicesRoot} placeholder="~/Documents/…/Services" onblur={checkServices} /><button class="btn btn-sm" onclick={checkServices}>Cek</button></div>
          </label>
          {#if services}
            {#if services.exists && !services.services.length}<p class="err small"><Icon name="alert" size={12} /> Folder ditemukan, tapi belum berisi repo service. Pindahkan atau clone semua repo ke folder ini.</p>
            {:else if services.exists}<p class="ok small"><Icon name="check" size={12} /> {services.services.length} service ditemukan: {services.services.slice(0, 6).join(', ')}{services.services.length > 6 ? ', …' : ''}</p>
            {:else}<p class="err small"><Icon name="alert" size={12} /> {services.error}</p>{/if}
          {/if}
          <label class="field">
            <span>Branch dasar default (untuk agent coding dan fix bug)</span>
            <input class="input mono" bind:value={baseBranch} placeholder="staging" />
          </label>
        {:else if step === 'atlassian'}
          <h3>Jira & Confluence</h3>
          <div class="seg" role="group">
            <button class:active={atlKind === 'cloud'} onclick={() => (atlKind = 'cloud')}>Atlassian Cloud · 1 API token</button>
            <button class:active={atlKind === 'datacenter'} onclick={() => (atlKind = 'datacenter')}>Server / Data Center · PAT</button>
          </div>
          {#if atlKind === 'cloud'}
            <p class="muted small">Untuk alamat <code>*.atlassian.net</code>: cukup <strong>email + satu API token</strong> untuk Jira dan Confluence sekaligus. Buat di <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">id.atlassian.com → Security → API tokens</a>.</p>
            <div class="grid2">
              <label class="field"><span>URL Atlassian</span><input class="input mono" bind:value={cloudUrl} placeholder="https://namaorg.atlassian.net" /></label>
              <label class="field"><span>Email akun</span><input class="input" bind:value={cloudEmail} placeholder="nama@perusahaan.com" autocomplete="off" /></label>
            </div>
            <label class="field"><span>API token {appSettings.secrets.jira ? '(tersimpan — kosongkan untuk tetap memakai yang lama)' : ''}</span><input class="input" type="password" bind:value={cloudToken} autocomplete="off" /></label>
          {:else}
            <p class="muted small">Hanya untuk Jira/Confluence yang di-hosting sendiri (bukan <code>*.atlassian.net</code>): masing-masing butuh <strong>Personal Access Token</strong> dari profilnya. Kalau alamatmu <code>*.atlassian.net</code>, pakai tab Atlassian Cloud.</p>
            <div class="grid2">
              <label class="field"><span>URL Jira</span><input class="input mono" bind:value={jiraUrl} placeholder="https://jira.perusahaan.co.id" /></label>
              <label class="field"><span>PAT Jira {appSettings.secrets.jira ? '(tersimpan)' : ''}</span><input class="input" type="password" bind:value={jiraToken} autocomplete="off" /></label>
              <label class="field"><span>URL Confluence</span><input class="input mono" bind:value={confUrl} placeholder="https://confluence.perusahaan.co.id" /></label>
              <label class="field"><span>PAT Confluence {appSettings.secrets.confluence ? '(tersimpan)' : ''}</span><input class="input" type="password" bind:value={confToken} autocomplete="off" /></label>
            </div>
          {/if}
          <div class="status-row">
            <span class="pill" class:pill-ok={jiraStatus?.configured}>Jira: {jiraStatus?.configured ? (jiraStatus.user?.displayName ?? 'tersambung') : (jiraStatus?.error ?? 'belum')}</span>
            <span class="pill" class:pill-ok={confStatus?.configured}>Confluence: {confStatus?.configured ? (confStatus.user ?? 'tersambung') : (confStatus?.error ?? 'belum')}</span>
            <button class="btn btn-sm" onclick={() => saveAtlassian(false)} disabled={busy}>{busy ? 'Mengetes…' : 'Simpan & tes koneksi'}</button>
          </div>
          {#if projects.length}
            <label class="field">
              <span>Project Jira default (tiket bug, workload)</span>
              <select class="input" bind:value={jiraProject}>
                <option value="">— pilih —</option>
                {#each projects as p (p.key)}<option value={p.key}>{p.key} · {p.name}</option>{/each}
              </select>
            </label>
          {/if}
        {:else if step === 'gitlab'}
          <h3>GitLab</h3>
          <p class="muted small">Untuk MR review, status MR di Task Board, dan push hasil agent. Buat Personal Access Token dengan scope <code>api</code> (atau <code>read_api</code> bila hanya membaca).</p>
          <div class="grid2">
            <label class="field"><span>URL GitLab</span><input class="input mono" bind:value={gitlabUrl} placeholder="https://gitlab.perusahaan.co.id" /></label>
            <label class="field"><span>Personal Access Token {appSettings.secrets.gitlab ? '(tersimpan)' : ''}</span><input class="input" type="password" bind:value={gitlabToken} autocomplete="off" /></label>
          </div>
          <div class="status-row">
            <span class="pill" class:pill-ok={gitlabStatus?.configured}>GitLab: {gitlabStatus?.configured ? `@${gitlabStatus.user?.username} · v${gitlabStatus.version ?? '?'}` : (gitlabStatus?.error ?? 'belum')}</span>
          </div>
          <p class="muted small">GitLab internal biasanya hanya bisa dijangkau saat VPN aktif.</p>
        {:else if step === 'figma'}
          <h3>Figma (opsional)</h3>
          <p class="muted small">Supaya Cockpit bisa <strong>mengambil layar desain</strong> dari link Figma di draft TAD: screenshot tiap layar dan seluruh teksnya disimpan ke workspace, lalu dibaca AI generator seperti dokumen biasa. Akses hanya membaca; Cockpit tidak pernah mengubah file Figma.</p>
          <ol class="howto small">
            <li>Buka Figma → klik avatar → <strong>Settings</strong> → tab <strong>Security</strong> → <strong>Personal access tokens</strong> → <strong>Generate new token</strong>.</li>
            <li>Beri nama (mis. <em>Tech Lead Cockpit</em>), pilih masa berlaku, dan centang scope <code>File content: Read-only</code>. Scope lain tidak perlu.</li>
            <li>Salin token (hanya ditampilkan sekali) lalu tempel di bawah.</li>
          </ol>
          <label class="field"><span>Personal access token {appSettings.secrets.figma ? '(tersimpan — kosongkan untuk tetap memakai yang lama)' : ''}</span><input class="input" type="password" bind:value={figmaToken} autocomplete="off" placeholder="figd_…" /></label>
          <div class="status-row">
            <span class="pill" class:pill-ok={figmaStatus?.configured}>Figma: {figmaStatus?.configured ? `${figmaStatus.user?.handle ?? 'tersambung'}${figmaStatus.user?.email ? ` · ${figmaStatus.user.email}` : ''}` : (figmaStatus?.error ?? 'belum')}</span>
          </div>
          <p class="muted small">Akun pemilik token harus bisa membuka file Figma yang dipakai. Saat token kedaluwarsa, buat yang baru dan simpan lagi di langkah ini.</p>
        {:else if step === 'ai'}
          <h3>AI</h3>
          <div class="providers">
            {#each aiProviders.list as p (p.id)}
              <div class="prov">
                <span class="dot" class:on={p.available}></span>
                <strong>{p.label}</strong>
                <span class="muted small">{p.available ? (p.version ? `v${p.version}` : 'siap') : (p.note ?? 'belum siap')}</span>
              </div>
            {/each}
          </div>
          <p class="muted small">Claude CLI dan Antigravity CLI dipasang di Mac lalu login sekali di Terminal (<code>claude</code> / <code>agy</code>). InferHub dan 9Router memakai API key:</p>
          <div class="grid3">
            <label class="field"><span>InferHub URL</span><input class="input mono" bind:value={ihUrl} /></label>
            <label class="field"><span>Model</span><input class="input mono" bind:value={ihModel} /></label>
            <label class="field"><span>API key {appSettings.secrets.inferhub ? '(tersimpan)' : ''}</span><input class="input" type="password" bind:value={ihKey} autocomplete="off" /></label>
            <label class="field"><span>9Router URL</span><input class="input mono" bind:value={nrUrl} placeholder="https://…/v1" /></label>
            <label class="field"><span>Model</span><input class="input mono" bind:value={nrModel} /></label>
            <label class="field"><span>API key {appSettings.secrets.ninerouter ? '(tersimpan)' : ''}</span><input class="input" type="password" bind:value={nrKey} autocomplete="off" /></label>
          </div>
          {#if appSettings.envOnly.length}
            <p class="note warn"><Icon name="alert" size={13} /> {appSettings.envOnly.join(', ')} masih tersimpan sebagai teks di <code>.env.local</code>. Isi key di atas agar tersimpan di Keychain, lalu hapus baris itu dari .env.local.</p>
          {/if}
          <label class="field">
            <span>AI default (generator TAD, estimasi, E2E, bug tracing)</span>
            <AiPicker value={aiDefault} onchange={(v) => (aiDefault = v)} />
          </label>
        {:else if step === 'more'}
          <h3>Integrasi lain (opsional)</h3>
          <p class="muted">Integrasi ini login langsung dari halamannya masing-masing, tidak perlu token di sini:</p>
          <ul class="more">
            <li><a href="#/whatsapp" onclick={later}><Icon name="chat" size={14} /> WhatsApp</a> — tautkan perangkat dengan QR untuk balas chat & kirim progress report.</li>
            <li><a href="#/teams" onclick={later}><Icon name="teams" size={14} /> Microsoft Teams</a> — login akun Microsoft untuk membaca & membalas chat.</li>
          </ul>
        {:else}
          <h3>Ringkasan</h3>
          <ul class="checks">
            {#each checks as c (c.label)}
              <li class:ok={c.ok}><span class="mark">{c.ok ? '✓' : '•'}</span><strong>{c.label}</strong> <span class="muted small">{c.detail}</span></li>
            {/each}
          </ul>
          <p class="muted small">Yang belum siap tetap bisa dilengkapi nanti dari menu Koneksi. Fitur yang membutuhkannya akan memberi tahu.</p>
        {/if}

        {#if err}<p class="err">{err}</p>{/if}

        <footer>
          <button class="btn btn-ghost btn-sm" onclick={later} disabled={busy}>Nanti saja</button>
          <span class="grow"></span>
          {#if idx > 0}<button class="btn btn-sm" onclick={back} disabled={busy}>Kembali</button>{/if}
          {#if step !== 'welcome' && step !== 'done' && step !== 'more'}<button class="btn btn-sm" onclick={skip} disabled={busy}>Lewati</button>{/if}
          {#if step === 'welcome'}
            <button class="btn btn-primary btn-sm" onclick={() => run(async () => { await appSettings.save({ general: { orgName: orgName.trim() } }); next(); })} disabled={busy}>Mulai</button>
          {:else if step === 'codebase'}
            <button class="btn btn-primary btn-sm" onclick={saveCodebase} disabled={busy}>Simpan & lanjut</button>
          {:else if step === 'atlassian'}
            <button class="btn btn-primary btn-sm" onclick={() => saveAtlassian(true)} disabled={busy}>Simpan & lanjut</button>
          {:else if step === 'gitlab'}
            <button class="btn btn-primary btn-sm" onclick={saveGitlab} disabled={busy}>Simpan & lanjut</button>
          {:else if step === 'figma'}
            <button class="btn btn-primary btn-sm" onclick={saveFigma} disabled={busy}>Simpan & lanjut</button>
          {:else if step === 'ai'}
            <button class="btn btn-primary btn-sm" onclick={saveAi} disabled={busy}>Simpan & lanjut</button>
          {:else if step === 'more'}
            <button class="btn btn-primary btn-sm" onclick={next}>Lanjut</button>
          {:else}
            <button class="btn btn-primary btn-sm" onclick={finish} disabled={busy}>Selesai</button>
          {/if}
        </footer>
      </section>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgb(10 14 22 / 0.55);
    backdrop-filter: blur(3px);
  }
  .wizard {
    display: grid;
    grid-template-columns: 220px 1fr;
    width: min(920px, 100%);
    max-height: calc(100vh - 32px);
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 16px;
    border-right: 1px solid var(--border);
    background: var(--bg);
  }
  .steps h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 15px;
  }
  .steps ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .steps button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .steps li.active button {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .n {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface-hover);
    font-size: 11px;
  }
  .steps li.done .n {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 22px 24px 18px;
    overflow-y: auto;
  }
  .body h3 {
    margin: 0;
    font-size: 17px;
  }
  .body p {
    margin: 0;
  }
  .small {
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .row .input {
    flex: 1;
  }
  .grid2,
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .grid3 {
    grid-template-columns: 1.4fr 1fr 1fr;
  }
  .seg {
    display: flex;
    gap: 6px;
  }
  .seg button {
    flex: 1;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .seg button.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
  }
  .howto {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-2);
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pill {
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--surface-hover);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .providers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .prov {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12.5px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-strong);
  }
  .dot.on {
    background: var(--ok);
  }
  .note {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--ok-soft);
    font-size: 12.5px;
  }
  .note.warn {
    background: var(--warn-soft);
  }
  .more,
  .checks {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
  }
  .more a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .checks li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .mark {
    width: 14px;
    color: var(--text-2, var(--text));
  }
  .checks li.ok .mark {
    color: var(--ok);
  }
  .ok {
    color: var(--ok);
  }
  .err {
    color: var(--err);
    font-size: 12.5px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .grow {
    flex: 1;
  }
  @media (max-width: 720px) {
    .wizard {
      grid-template-columns: 1fr;
    }
    .steps {
      display: none;
    }
    .grid2,
    .grid3,
    .providers {
      grid-template-columns: 1fr;
    }
  }
  .callout {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--warn-soft);
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .callout :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--warn);
  }
  .callout pre {
    margin: 6px 0 0;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
</style>
