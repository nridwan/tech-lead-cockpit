<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import type { ConnectorStatus } from '../lib/confluence/api-types';
  import { connector, ConnectorRequestError } from '../lib/confluence/client';
  import { jira } from '../lib/jira/client';
  import type { JiraStatus, JiraIssue } from '../lib/jira/types';
  import { aiProviders } from '../lib/ai/providers.svelte';
  import AiUsageMeter from '../components/AiUsageMeter.svelte';
  import { teams } from '../lib/teams/client';
  import type { TeamsStatus } from '../lib/teams/types';
  import { toasts } from '../components/toast.svelte';
  import { figma } from '../lib/figma/client';
  import type { FigmaStatus } from '../lib/figma/types';
  import { gitlab } from '../lib/gitlab/client';
  import type { GitLabStatus } from '../lib/gitlab/types';
  import { appSettings } from '../lib/settings/store.svelte';

  let status = $state<ConnectorStatus | null>(null);
  let jiraStatus = $state<JiraStatus | null>(null);
  let teamsStatus = $state<TeamsStatus | null>(null);
  let recentJiraIssues = $state<JiraIssue[]>([]);
  let loadingJiraIssues = $state(false);

  let error = $state('');
  let loading = $state(false);

  // Setup form state
  let showAtlassianSetup = $state(false);
  let atlassianUrl = $state(appSettings.value.jira.baseUrl);
  let atlassianEmail = $state(appSettings.value.jira.email);
  let atlassianToken = $state('');
  let syncBoth = $state(true);
  let savingAtlassian = $state(false);

  let gitlabStatus = $state<GitLabStatus | null>(null);
  let showGitlabSetup = $state(false);
  let gitlabUrl = $state(appSettings.value.gitlab.baseUrl);
  let gitlabToken = $state('');
  let savingGitlab = $state(false);

  async function handleSaveGitlab() {
    if (!gitlabToken.trim()) return;
    savingGitlab = true;
    try {
      const { user } = await gitlab.saveToken(gitlabToken.trim(), gitlabUrl.trim());
      toasts.show(`GitLab terhubung sebagai ${user.name} (@${user.username}).`, 'ok');
      gitlabToken = '';
      showGitlabSetup = false;
      gitlabStatus = await gitlab.status().catch(() => null);
    } catch (e: any) {
      toasts.show(`Gagal menghubungkan GitLab: ${e.message}`, 'err');
    } finally {
      savingGitlab = false;
    }
  }

  let figmaStatus = $state<FigmaStatus | null>(null);
  let showFigmaSetup = $state(false);
  let figmaToken = $state('');
  let savingFigma = $state(false);

  async function handleSaveFigma() {
    if (!figmaToken.trim()) return;
    savingFigma = true;
    try {
      const { user } = await figma.saveToken(figmaToken.trim());
      toasts.show(`Figma terhubung sebagai ${user.handle}.`, 'ok');
      figmaToken = '';
      showFigmaSetup = false;
      figmaStatus = await figma.status().catch(() => null);
    } catch (e: any) {
      toasts.show(`Gagal menghubungkan Figma: ${e.message}`, 'err');
    } finally {
      savingFigma = false;
    }
  }

  async function refresh() {
    loading = true;
    error = '';
    try {
      status = await connector.status().catch(() => null);
      jiraStatus = await jira.status().catch(() => null);
      teamsStatus = await teams.status().catch(() => null);
      gitlabStatus = await gitlab.status().catch(() => null);
      if (gitlabStatus?.baseUrl) gitlabUrl = gitlabStatus.baseUrl;
      figmaStatus = await figma.status().catch(() => null);

      if (jiraStatus?.configured && jiraStatus.user) {
        loadRecentIssues();
      }
    } catch (e) {
      error = e instanceof ConnectorRequestError ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadRecentIssues() {
    loadingJiraIssues = true;
    try {
      recentJiraIssues = await jira.issues('assignee = currentUser() ORDER BY updated DESC', 5);
    } catch {
      recentJiraIssues = [];
    } finally {
      loadingJiraIssues = false;
    }
  }

  async function handleSaveAtlassian() {
    if (!atlassianToken.trim()) {
      toasts.show('Masukkan Atlassian API Token.', 'err');
      return;
    }
    savingAtlassian = true;
    try {
      await jira.saveToken({
        baseUrl: atlassianUrl.trim(),
        email: atlassianEmail.trim(),
        token: atlassianToken.trim(),
        syncConfluence: syncBoth,
      });
      toasts.show('Koneksi Atlassian (Jira & Confluence) berhasil disimpan!', 'ok');
      showAtlassianSetup = false;
      atlassianToken = '';
      await refresh();
    } catch (e: any) {
      toasts.show(`Gagal menyimpan koneksi: ${e.message}`, 'err');
    } finally {
      savingAtlassian = false;
    }
  }

  onMount(() => {
    refresh();
    aiProviders.load(true);
  });

  const PLANNED: { name: string; phase: string }[] = [];
</script>

<section class="page">
  <header>
    <div>
      <h1>Koneksi</h1>
      <p class="muted">Token disimpan dengan aman di macOS Keychain dan hanya dibaca oleh connector lokal — tidak pernah dikirim keluar.</p>
    </div>
    <div class="head-actions">
      <button class="btn" onclick={() => (appSettings.wizardOpen = true)}><Icon name="plug" /> Jalankan setup</button>
      <button class="btn" onclick={refresh} disabled={loading}><Icon name="refresh" /> Cek ulang</button>
    </div>
  </header>

  <!-- Atlassian Quick Setup Banner / Modal Box -->
  {#if showAtlassianSetup}
    <div class="setup-box">
      <div class="setup-head">
        <div class="setup-title">
          <Icon name="plug" size={20} />
          <strong>Setup Koneksi Atlassian (Jira & Confluence)</strong>
        </div>
        <button class="btn btn-icon btn-ghost" onclick={() => (showAtlassianSetup = false)}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <p class="setup-desc muted">
        Untuk Atlassian Cloud (<code>*.atlassian.net</code>), cukup satu <strong>Atlassian API Token</strong> untuk menghubungkan Jira dan Confluence sekaligus. Untuk Server/Data Center, gunakan <strong>Jalankan setup</strong>.
      </p>

      <div class="setup-form">
        <div class="form-row">
          <label for="atl-url">Base URL Jira</label>
          <input id="atl-url" type="text" bind:value={atlassianUrl} placeholder="https://namaorg.atlassian.net" />
        </div>

        <div class="form-row">
          <label for="atl-email">Email Akun Atlassian</label>
          <input id="atl-email" type="email" bind:value={atlassianEmail} placeholder="nama@perusahaan.com" />
        </div>

        <div class="form-row">
          <label for="atl-token">Atlassian API Token</label>
          <input
            id="atl-token"
            type="password"
            bind:value={atlassianToken}
            placeholder="Paste API token dari id.atlassian.com…"
          />
          <small class="form-help">
            Belum punya token? Buat token di
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
              id.atlassian.com/manage-profile/security/api-tokens <Icon name="external" size={11} />
            </a> (Label: Tech Lead Cockpit).
          </small>
        </div>

        <div class="form-check">
          <label>
            <input type="checkbox" bind:checked={syncBoth} />
            Hubungkan Confluence juga secara otomatis (<code>{atlassianUrl.replace(/\/+$/, '')}/wiki</code>)
          </label>
        </div>

        <div class="setup-actions">
          <button class="btn btn-primary" onclick={handleSaveAtlassian} disabled={savingAtlassian || !atlassianToken.trim()}>
            {#if savingAtlassian}
              Menyimpan…
            {:else}
              <Icon name="check" size={14} /> Simpan ke Keychain & Hubungkan
            {/if}
          </button>
          <button class="btn btn-ghost" onclick={() => (showAtlassianSetup = false)}>Batal</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Card: GitLab -->
  <article class="card">
    <div class="card-head">
      <Icon name="merge" size={20} />
      <h2>GitLab (internal, via VPN)</h2>
      {#if loading}
        <span class="chip">Mengecek…</span>
      {:else if gitlabStatus?.configured}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Terhubung</span>
      {:else}
        <span class="chip chip-warn">Belum terhubung</span>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={() => (showGitlabSetup = !showGitlabSetup)}>
        <Icon name="edit" size={13} /> {gitlabStatus?.tokenPresent ? 'Ubah Token' : 'Setup Token'}
      </button>
    </div>

    {#if gitlabStatus}
      <dl>
        <dt>Base URL</dt><dd class="mono">{gitlabStatus.baseUrl ?? '—'}</dd>
        <dt>Akses</dt><dd>Read-only (Personal Access Token, scope <code>read_api</code>)</dd>
        <dt>Token di Keychain</dt><dd>{gitlabStatus.tokenPresent ? 'Ada (tech-lead-cockpit.gitlab)' : 'Belum ada'}</dd>
        {#if gitlabStatus.user}
          <dt>Login sebagai</dt><dd><strong>{gitlabStatus.user.name}</strong> (@{gitlabStatus.user.username})</dd>
        {/if}
        {#if gitlabStatus.version}<dt>Versi GitLab</dt><dd>{gitlabStatus.version}</dd>{/if}
      </dl>
      {#if gitlabStatus.error && gitlabStatus.tokenPresent}<p class="alert"><Icon name="alert" /> {gitlabStatus.error}</p>{/if}
    {/if}

    {#if showGitlabSetup}
      <div class="setup-form gitlab-setup">
        <div class="form-row">
          <label for="gl-url">Base URL GitLab</label>
          <input id="gl-url" type="text" bind:value={gitlabUrl} placeholder="https://gitlab.perusahaan.co.id" />
        </div>
        <div class="form-row">
          <label for="gl-token">Personal Access Token</label>
          <input id="gl-token" type="password" bind:value={gitlabToken} placeholder="glpat-…" autocomplete="off" />
          <small class="form-help">
            Buat di
            <a href="{gitlabUrl.replace(/\/+$/, '')}/-/user_settings/personal_access_tokens" target="_blank" rel="noreferrer">
              GitLab → User Settings → Access Tokens <Icon name="external" size={11} />
            </a>
            dengan scope <strong>read_api</strong> saja. Token dicek dulu ke GitLab, lalu disimpan di Keychain. Alternatif lewat Terminal: <code>npm run token:gitlab</code>.
          </small>
        </div>
        <div class="setup-actions">
          <button class="btn btn-primary" onclick={handleSaveGitlab} disabled={savingGitlab || !gitlabToken.trim()}>
            {#if savingGitlab}Mengecek…{:else}<Icon name="check" size={14} /> Simpan ke Keychain & Hubungkan{/if}
          </button>
          <button class="btn btn-ghost" onclick={() => (showGitlabSetup = false)}>Batal</button>
        </div>
      </div>
    {:else if !gitlabStatus?.tokenPresent}
      <div class="setup-cta">
        <p class="muted font-sm">Klik <strong>Setup Token</strong> untuk menghubungkan GitLab internal. Pastikan VPN aktif.</p>
      </div>
    {/if}
  </article>

  <!-- Card: Figma -->
  <article class="card">
    <div class="card-head">
      <Icon name="image" size={20} />
      <h2>Figma (opsional)</h2>
      {#if loading}
        <span class="chip">Mengecek…</span>
      {:else if figmaStatus?.configured}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Terhubung</span>
      {:else}
        <span class="chip chip-warn">Belum terhubung</span>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={() => (showFigmaSetup = !showFigmaSetup)}>
        <Icon name="edit" size={13} /> {figmaStatus?.tokenPresent ? 'Ubah Token' : 'Setup Token'}
      </button>
    </div>

    {#if figmaStatus}
      <dl>
        <dt>Dipakai untuk</dt><dd>Mengambil layar desain (screenshot + teks) dari link Figma di draft TAD untuk AI generator</dd>
        <dt>Akses</dt><dd>Read-only (Personal Access Token, scope <code>File content: Read-only</code>)</dd>
        <dt>Token di Keychain</dt><dd>{figmaStatus.tokenPresent ? 'Ada (tech-lead-cockpit.figma)' : 'Belum ada'}</dd>
        {#if figmaStatus.user}
          <dt>Login sebagai</dt><dd><strong>{figmaStatus.user.handle}</strong>{figmaStatus.user.email ? ` (${figmaStatus.user.email})` : ''}</dd>
        {/if}
      </dl>
      {#if figmaStatus.error && figmaStatus.tokenPresent}<p class="alert"><Icon name="alert" /> {figmaStatus.error}</p>{/if}
    {/if}

    {#if showFigmaSetup}
      <div class="setup-form">
        <div class="form-row">
          <label for="fg-token">Personal Access Token</label>
          <input id="fg-token" type="password" bind:value={figmaToken} placeholder="figd_…" autocomplete="off" />
          <small class="form-help">
            Buat di Figma → avatar → <strong>Settings</strong> → <strong>Security</strong> → <strong>Personal access tokens</strong>, dengan scope <strong>File content: Read-only</strong> saja. Token dicek dulu ke Figma, lalu disimpan di Keychain.
          </small>
        </div>
        <div class="setup-actions">
          <button class="btn btn-primary" onclick={handleSaveFigma} disabled={savingFigma || !figmaToken.trim()}>
            {#if savingFigma}Mengecek…{:else}<Icon name="check" size={14} /> Simpan ke Keychain & Hubungkan{/if}
          </button>
          <button class="btn btn-ghost" onclick={() => (showFigmaSetup = false)}>Batal</button>
        </div>
      </div>
    {:else if !figmaStatus?.tokenPresent}
      <div class="setup-cta">
        <p class="muted font-sm">Klik <strong>Setup Token</strong> supaya Cockpit bisa mengambil layar dari link Figma di draft TAD.</p>
      </div>
    {/if}
  </article>

  <!-- Card: Jira -->
  <article class="card">
    <div class="card-head">
      <Icon name="jira" size={20} />
      <h2>Jira</h2>
      {#if loading}
        <span class="chip">Mengecek…</span>
      {:else if jiraStatus?.configured && jiraStatus.user}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Terhubung</span>
      {:else}
        <span class="chip chip-warn">Belum terhubung</span>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={() => (showAtlassianSetup = !showAtlassianSetup)}>
        <Icon name="edit" size={13} /> {jiraStatus?.configured ? 'Ubah Token' : 'Setup Token'}
      </button>
    </div>

    {#if jiraStatus}
      <dl>
        <dt>Base URL</dt><dd class="mono">{jiraStatus.baseUrl ?? '—'}</dd>
        <dt>Tipe</dt><dd>{jiraStatus.flavor === 'cloud' ? 'Cloud' : jiraStatus.flavor === 'datacenter' ? 'Data Center / Server' : '—'}</dd>
        <dt>Auth</dt><dd>{!jiraStatus.baseUrl ? '—' : jiraStatus.auth === 'basic' ? `Email (${jiraStatus.email ?? '—'}) + API token` : 'Personal Access Token'}</dd>
        <dt>Token di Keychain</dt><dd>{jiraStatus.tokenPresent ? 'Ada (tech-lead-cockpit.jira)' : 'Belum ada'}</dd>
        {#if jiraStatus.user}
          <dt>Login sebagai</dt>
          <dd>
            <strong>{jiraStatus.user.displayName}</strong>
            {#if jiraStatus.user.emailAddress} ({jiraStatus.user.emailAddress}){/if}
          </dd>
        {/if}
      </dl>
      {#if jiraStatus.error}<p class="alert"><Icon name="alert" /> {jiraStatus.error}</p>{/if}

      <!-- Recent Assigned Issues Preview -->
      {#if jiraStatus.configured && jiraStatus.user}
        <div class="jira-issues-preview">
          <div class="preview-head">
            <strong>Tiket Saya Terkini ({recentJiraIssues.length})</strong>
            {#if jiraStatus.baseUrl}
              <a href="{jiraStatus.baseUrl}/jira/your-work" target="_blank" rel="noreferrer" class="btn btn-xs">
                Buka Jira <Icon name="external" size={11} />
              </a>
            {/if}
          </div>
          {#if loadingJiraIssues}
            <small class="muted">Memuat tiket…</small>
          {:else if recentJiraIssues.length === 0}
            <small class="muted">Tidak ada tiket aktif yang ditugaskan saat ini.</small>
          {:else}
            <div class="issues-list">
              {#each recentJiraIssues as issue}
                <a href={issue.url} target="_blank" rel="noreferrer" class="issue-item">
                  <span class="issue-key mono">{issue.key}</span>
                  <span class="issue-summary">{issue.summary}</span>
                  <span class="issue-status">{issue.status}</span>
                </a>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}

    {#if !jiraStatus?.configured && !showAtlassianSetup}
      <div class="setup-cta">
        <p class="muted font-sm">Klik tombol <strong>Setup Token</strong> di atas untuk memasukkan Atlassian API Token kamu.</p>
      </div>
    {/if}
  </article>

  <!-- Card: Confluence -->
  <article class="card">
    <div class="card-head">
      <Icon name="confluence" size={20} />
      <h2>Confluence</h2>
      {#if loading}
        <span class="chip">Mengecek…</span>
      {:else if status?.configured && status.user}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Terhubung</span>
      {:else}
        <span class="chip chip-warn">Belum terhubung</span>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={() => (showAtlassianSetup = !showAtlassianSetup)}>
        <Icon name="edit" size={13} /> {status?.configured ? 'Ubah Token' : 'Setup Token'}
      </button>
    </div>

    {#if status}
      <dl>
        <dt>Base URL</dt><dd class="mono">{status.baseUrl ?? '—'}</dd>
        <dt>Tipe</dt><dd>{status.flavor === 'cloud' ? 'Cloud' : status.flavor === 'datacenter' ? 'Data Center / Server' : '—'}</dd>
        <dt>Auth</dt><dd>{!status.baseUrl ? '—' : status.auth === 'basic' ? 'Email + API token' : status.auth === 'bearer' ? 'Personal Access Token' : '—'}</dd>
        <dt>Token di Keychain</dt><dd>{status.tokenPresent ? 'Ada (tech-lead-cockpit.confluence)' : 'Belum ada'}</dd>
        {#if status.user}<dt>Login sebagai</dt><dd><strong>{status.user}</strong></dd>{/if}
      </dl>
      {#if status.error}<p class="alert"><Icon name="alert" /> {status.error}</p>{/if}
    {:else if error}
      <p class="alert"><Icon name="alert" /> {error}</p>
    {/if}

    {#if !status?.user && !showAtlassianSetup}
      <details>
        <summary>Cara menghubungkan manual via Terminal</summary>
        <ol>
          <li>Salin <code>.env.example</code> menjadi <code>.env.local</code>, isi <code>CONFLUENCE_BASE_URL</code> dan <code>CONFLUENCE_AUTH</code>.</li>
          <li>
            Buat token:
            <ul>
              <li><strong>Cloud:</strong> id.atlassian.com → Security → API tokens (<code>CONFLUENCE_AUTH=basic</code>).</li>
              <li><strong>Data Center:</strong> Profile → Personal Access Tokens (<code>CONFLUENCE_AUTH=bearer</code>).</li>
            </ul>
          </li>
          <li>Simpan token ke Keychain: <code>npm run token:confluence</code> atau gunakan form <strong>Setup Token</strong> di atas.</li>
        </ol>
      </details>
    {/if}
  </article>

  <!-- Card: Microsoft Teams -->
  <article class="card">
    <div class="card-head">
      <Icon name="teams" size={20} />
      <h2>Microsoft Teams</h2>
      {#if teamsStatus?.connected}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Terhubung</span>
      {:else}
        <span class="chip chip-warn">Belum terhubung</span>
      {/if}
      <a href="#/teams" class="btn btn-sm btn-ghost">Buka MS Teams <Icon name="external" size={12} /></a>
    </div>

    {#if teamsStatus?.connected}
      <dl>
        <dt>User</dt><dd><strong>{teamsStatus.user?.displayName ?? '—'}</strong> ({teamsStatus.user?.email ?? '—'})</dd>
        <dt>Tenant ID</dt><dd class="mono">{teamsStatus.tenantId}</dd>
        <dt>Client ID</dt><dd class="mono">{teamsStatus.clientId}</dd>
        <dt>Fitur</dt><dd>Baca chat 1:1, grup, channel Teams, deteksi MR GitLab, balas chat AI</dd>
      </dl>
    {:else}
      <p class="muted" style="margin-top: 12px; font-size: 13px;">
        Belum terhubung. Buka menu <strong>MS Teams</strong> di navigasi samping untuk menghubungkan akun Microsoft kantor menggunakan kode login cepat (Device Code Flow).
      </p>
    {/if}
  </article>

  <!-- AI Providers -->
  {#each aiProviders.list as p (p.id)}
    <article class="card">
      <div class="card-head">
        <Icon name="sparkles" size={20} />
        <h2>{p.label}</h2>
        {#if p.available}
          <span class="chip {p.warning ? 'chip-warn' : 'chip-ok'}"><Icon name={p.warning ? 'alert' : 'check'} size={12} /> {p.version ? `v${p.version} · ` : ''}{p.models.length - 1} model</span>
        {:else}
          <span class="chip chip-warn">Belum siap</span>
        {/if}
      </div>
      {#if p.note || p.warning}<p class="alert"><Icon name="alert" /> {p.note ?? p.warning}</p>{/if}
      {#if p.id === 'inferhub' && !p.available}
        <details>
          <summary>Cara menghubungkan InferHub</summary>
          <ol>
            <li>Buka dashboard InferHub di <a href="https://inferhub.dev/dashboard" target="_blank" rel="noreferrer">inferhub.dev/dashboard</a> dan salin API key Anda (awalan <code>sk-airo-</code>).</li>
            <li>Simpan token ke Keychain: jalankan <code>npm run token:inferhub</code> di Terminal (atau isi <code>INFERHUB_API_KEY</code> di <code>.env.local</code>).</li>
            <li>Opsional: tentukan model default dengan <code>INFERHUB_MODEL=ag/claude-sonnet-4-6</code> di <code>.env.local</code>.</li>
            <li>Klik tombol <em>Cek ulang</em> di atas untuk memverifikasi koneksi.</li>
          </ol>
        </details>
      {/if}
      {#if p.id === '9router' && !p.available}
        <details>
          <summary>Cara menghubungkan 9Router</summary>
          <ol>
            <li>Pastikan gateway 9Router sudah berjalan (default di <code>http://localhost:20128</code>).</li>
            <li>Jika 9Router berjalan di port/host lain, atur <code>NINEROUTER_BASE_URL=http://localhost:20128</code> di <code>.env.local</code>.</li>
            <li>Jika 9Router memakai API Key (Master Key), simpan ke Keychain lewat <code>npm run token:9router</code> di Terminal atau isi <code>NINEROUTER_API_KEY</code> di <code>.env.local</code>.</li>
            <li>Opsional: tentukan model default dengan <code>NINEROUTER_MODEL=nama-model</code> di <code>.env.local</code>.</li>
            <li>Klik tombol <em>Cek ulang</em> di atas untuk memverifikasi koneksi.</li>
          </ol>
        </details>
      {/if}
      {#if p.available}
        <div class="usage-block">
          <h3>{p.id === 'inferhub' ? 'Saldo akun' : p.id === '9router' ? 'Status gateway' : 'Limit pemakaian'}</h3>
          <AiUsageMeter provider={p.id} />
        </div>
      {/if}
    </article>
  {/each}

  {#each PLANNED as p (p.name)}
    <article class="card planned">
      <div class="card-head">
        <Icon name="plug" size={20} />
        <h2>{p.name}</h2>
        <span class="chip">{p.phase}</span>
      </div>
    </article>
  {/each}
</section>

<style>
  .head-actions {
    display: flex;
    gap: 8px;
  }
  .page {
    max-width: 760px;
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
    margin-bottom: 20px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 22px;
  }
  header p {
    margin: 0;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 12px;
    box-shadow: var(--shadow);
  }
  .card.planned {
    opacity: 0.7;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .card-head h2 {
    flex: 1;
    margin: 0;
    font-size: 15px;
  }
  dl {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 6px 12px;
    margin: 14px 0 0;
  }
  dt {
    color: var(--text-3);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .setup-box {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
  .setup-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .setup-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
  }
  .setup-desc {
    font-size: 13px;
    margin: 0 0 16px;
    line-height: 1.5;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .form-row label {
    font-size: 12px;
    font-weight: 600;
  }
  .form-row input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text);
  }
  .form-row input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .form-help {
    font-size: 11px;
    color: var(--text-3);
  }
  .form-check {
    margin: 4px 0;
  }
  .form-check label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .setup-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .setup-cta {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
  }
  .jira-issues-preview {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .preview-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .issues-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .issue-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: var(--text);
    font-size: 12px;
    transition: background 0.15s ease;
  }
  .issue-item:hover {
    background: var(--bg);
    border-color: var(--accent);
  }
  .issue-key {
    font-weight: 700;
    color: var(--accent);
    flex-shrink: 0;
  }
  .issue-summary {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .issue-status {
    font-size: 11px;
    padding: 2px 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    flex-shrink: 0;
  }
  .usage-block {
    margin-top: 12px;
  }
  .usage-block h3 {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .alert {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 14px 0 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
  }
  details {
    margin-top: 14px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  ol {
    padding-left: 20px;
    color: var(--text-2);
    line-height: 1.75;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .gitlab-setup {
    margin-top: 12px;
  }
</style>
