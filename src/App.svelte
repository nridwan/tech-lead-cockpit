<script lang="ts">
  import Icon, { type IconName } from './components/Icon.svelte';
  import Toasts from './components/Toasts.svelte';
  import TadWorkspace from './tad/TadWorkspace.svelte';
  import ProjectsView from './projects/ProjectsView.svelte';
  import ReleasesView from './releases/ReleasesView.svelte';
  import BugsView from './bugs/BugsView.svelte';
  import BugTraceWatcher from './bugs/BugTraceWatcher.svelte';
  import SetupWizard from './setup/SetupWizard.svelte';
  import { appSettings } from './lib/settings/store.svelte';
  import ConnectionsView from './views/ConnectionsView.svelte';
  import AuditView from './views/AuditView.svelte';
  import MrReviewView from './mr/MrReviewView.svelte';
  import WhatsAppView from './whatsapp/WhatsAppView.svelte';
  import AssistantView from './assistant/AssistantView.svelte';
  import TeamsView from './teams/TeamsView.svelte';
  import DashboardView from './views/DashboardView.svelte';
  import AgentTasksView from './views/AgentTasksView.svelte';
  import LockScreen from './components/LockScreen.svelte';
  import RemoteIndicator from './components/RemoteIndicator.svelte';
  import SecurityModal from './components/SecurityModal.svelte';
  import ConfirmModal from './components/ConfirmModal.svelte';
  import PasswordPromptModal from './components/PasswordPromptModal.svelte';
  import { security } from './lib/auth/security.svelte';
  import { reportSync } from './lib/report/sync.svelte';
  import { theme } from './lib/theme.svelte';
  import { teams } from './lib/teams/client';
  import type { TeamsUser } from './lib/teams/types';

  let securityModalOpen = $state(false);
  // Keeps the VPS copy of the scheduled progress report fresh while the app is open.
  reportSync.start();

  type View = 'dashboard' | 'assistant' | 'agents' | 'mr' | 'tad' | 'projects' | 'releases' | 'bugs' | 'teams' | 'whatsapp' | 'connections' | 'audit';

  // Main views live in the top pill bar; settings-like views in the side rail.
  const NAV: { id: View; label: string; icon: IconName; soon?: string; rail?: boolean }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'assistant', label: 'AI Assistant', icon: 'sparkles' },
    { id: 'agents', label: 'Agent Tasks', icon: 'bot' },
    { id: 'mr', label: 'MR Review', icon: 'merge' },
    { id: 'tad', label: 'TAD', icon: 'doc' },
    { id: 'projects', label: 'Proyek', icon: 'list' },
    { id: 'releases', label: 'Rilis', icon: 'send' },
    { id: 'bugs', label: 'Bug Tracing', icon: 'bug' },
    { id: 'teams', label: 'Teams', icon: 'teams' },
    { id: 'whatsapp', label: 'WhatsApp', icon: 'chat' },
    { id: 'connections', label: 'Koneksi', icon: 'plug', rail: true },
    { id: 'audit', label: 'Audit log', icon: 'history', rail: true },
  ];

  function fromHash(): View {
    // `#/tad/<id>` style links still open the view itself.
    const v = location.hash.replace('#/', '').split(/[/?]/)[0] as View;
    return NAV.some((n) => n.id === v) ? v : 'dashboard';
  }

  let view = $state<View>(fromHash());
  let user = $state<TeamsUser | null>(null);

  const initials = $derived(
    (user?.displayName ?? 'Tech Lead')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join(''),
  );

  $effect(() => {
    teams
      .status()
      .then((s) => (user = s.connected ? (s.user ?? null) : null))
      .catch(() => {});
  });

  // Settings from the setup wizard; the wizard opens on its own until setup is finished.
  $effect(() => {
    if (!security.isUnlocked) return;
    void appSettings.load().then(() => {
      let later = false;
      try {
        later = sessionStorage.getItem('tlc.setup.later') === '1';
      } catch {
        /* ignore */
      }
      if (location.hash.startsWith('#/setup') || (!appSettings.error && !appSettings.setupDone && !later)) appSettings.wizardOpen = true;
    });
  });

  $effect(() => {
    const onHash = () => {
      if (location.hash.startsWith('#/setup')) appSettings.wizardOpen = true;
      view = fromHash();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

{#if !security.isUnlocked}
  <LockScreen />
{:else}
  <BugTraceWatcher />
  <SetupWizard />
  <div class="frame">
    <header class="topbar">
      <a class="brand pill" href="#/dashboard" aria-label="Tech Lead Cockpit">
        <span class="logo" aria-hidden="true">TL</span>
        <span class="brand-name">Cockpit</span>
      </a>

      <nav class="tabs pill" aria-label="Navigasi utama">
        {#each NAV.filter((n) => !n.rail) as item (item.id)}
          <a href="#/{item.id}" class:active={view === item.id} aria-current={view === item.id ? 'page' : undefined} title={item.soon ? `${item.label} · ${item.soon}` : item.label}>
            <span class="tab-icon"><Icon name={item.icon} size={16} /></span>
            <span class="tab-label">{item.label}</span>
          </a>
        {/each}
      </nav>

      <RemoteIndicator />

      <button class="lock-btn pill" onclick={() => security.lock()} title="Kunci Cockpit sekarang">
        <Icon name="lock" size={15} />
        <span class="lock-label">Kunci</span>
      </button>

      <div class="user pill" title={user ? `${user.displayName} · ${user.email}` : 'Hubungkan MS Teams untuk menampilkan profil'}>
        <span class="avatar" aria-hidden="true">{initials}</span>
        <span class="who">
          <strong>{user?.displayName ?? 'Tech Lead'}</strong>
          <small>{user?.email ?? 'Lokal · read-only default'}</small>
        </span>
      </div>
    </header>

    <aside class="rail" aria-label="Pengaturan">
      <div class="rail-group" role="group" aria-label="Tema">
        <button class:active={theme.effective === 'light'} onclick={() => theme.set('light')} title="Tema terang" aria-pressed={theme.effective === 'light'}>
          <Icon name="sun" size={18} />
        </button>
        <button class:active={theme.effective === 'dark'} onclick={() => theme.set('dark')} title="Tema gelap" aria-pressed={theme.effective === 'dark'}>
          <Icon name="moon" size={18} />
        </button>
      </div>

      <div class="rail-group">
        {#each NAV.filter((n) => n.rail) as item (item.id)}
          <a href="#/{item.id}" class:current={view === item.id} aria-current={view === item.id ? 'page' : undefined} title={item.label}>
            <Icon name={item.icon} size={18} />
          </a>
        {/each}
      </div>

      <div class="rail-group rail-foot">
        <button class="rail-btn" onclick={() => (securityModalOpen = true)} title="Pengaturan Keamanan & PIN">
          <Icon name="shield" size={18} />
        </button>
      </div>
    </aside>

    <main>
      <!-- A crash in one view must not take the whole app (or the unlock) down with it. -->
      <svelte:boundary onerror={(e) => console.error('[view]', e)}>
        {#if view === 'dashboard'}
          <DashboardView />
        {:else if view === 'assistant'}
          <AssistantView />
        {:else if view === 'agents'}
          <AgentTasksView />
        {:else if view === 'tad'}
          <TadWorkspace />
        {:else if view === 'projects'}
          <ProjectsView />
        {:else if view === 'releases'}
          <ReleasesView />
        {:else if view === 'bugs'}
          <BugsView />
        {:else if view === 'teams'}
          <TeamsView />
        {:else if view === 'whatsapp'}
          <WhatsAppView />
        {:else if view === 'connections'}
          <ConnectionsView />
        {:else if view === 'audit'}
          <AuditView />
        {:else if view === 'mr'}
          <MrReviewView />
        {/if}
        {#snippet failed(error, reset)}
          <div class="view-error">
            <h2>Halaman ini gagal ditampilkan</h2>
            <p class="muted">{(error as Error)?.message ?? String(error)}</p>
            <div class="view-error-actions">
              <button class="btn" onclick={reset}>Coba lagi</button>
              <a class="btn btn-primary" href="#/dashboard" onclick={() => setTimeout(reset)}>Ke Dashboard</a>
            </div>
          </div>
        {/snippet}
      </svelte:boundary>
    </main>
  </div>
{/if}

<SecurityModal bind:open={securityModalOpen} />
<ConfirmModal />
<PasswordPromptModal />
<Toasts />

<style>
  .frame {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'top top'
      'rail main';
    gap: 14px 16px;
    height: calc(100vh - 24px);
    margin: 12px;
    padding: 14px 16px 16px;
    border-radius: 28px;
    background: var(--bg);
  }
  .pill {
    display: flex;
    align-items: center;
    background: var(--surface);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
  }

  .topbar {
    grid-area: top;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .brand {
    gap: 10px;
    padding: 6px 16px 6px 6px;
    text-decoration: none;
    color: var(--text);
    flex-shrink: 0;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .brand-name {
    font-weight: 500;
    font-size: 16px;
    letter-spacing: -0.01em;
  }

  .tabs {
    gap: 2px;
    margin: 0 auto;
    padding: 5px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs a {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 16px;
    border-radius: 999px;
    color: var(--text-2);
    text-decoration: none;
    font-size: 15px;
    font-weight: 400;
    white-space: nowrap;
    transition: background 0.12s, color 0.12s;
  }
  .tabs a:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .tabs a.active {
    background: var(--ink);
    color: var(--ink-text);
  }
  .tab-icon {
    display: none;
  }

  .user {
    gap: 10px;
    padding: 5px 16px 5px 5px;
    flex-shrink: 0;
    max-width: 260px;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .who strong,
  .who small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who strong {
    font-weight: 500;
    font-size: 14px;
  }
  .who small {
    color: var(--text-3);
    font-size: 12px;
  }

  .lock-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 16px;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.15s ease;
  }
  .lock-btn:hover {
    color: var(--err);
    background: var(--err-soft);
  }
  .lock-label {
    font-size: 13px;
  }

  .rail {
    grid-area: rail;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  .rail-group button,
  .rail-group a,
  .rail-btn {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .rail-group button:hover,
  .rail-group a:hover,
  .rail-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .rail-group button.active {
    background: var(--surface-2);
    color: var(--text);
  }
  .rail-group a.current {
    background: var(--ink);
    color: var(--ink-text);
  }
  .rail-foot {
    margin-top: auto;
  }
  .rail-btn {
    color: var(--accent);
  }

  main {
    grid-area: main;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: var(--radius-lg);
  }

  @media (max-width: 1180px) {
    .tab-icon {
      display: inline-flex;
    }
    .tabs a:not(.active) .tab-label {
      display: none;
    }
    .tabs a:not(.active) {
      padding: 0 12px;
    }
  }
  @media (max-width: 860px) {
    .frame {
      margin: 0;
      height: 100vh;
      border-radius: 0;
      padding: 10px;
      gap: 10px;
      grid-template-columns: 48px minmax(0, 1fr);
    }
    .brand-name,
    .who {
      display: none;
    }
    .brand,
    .user {
      padding: 5px;
    }
    .tabs {
      margin: 0;
      flex: 1;
    }
    .rail-group button,
    .rail-group a,
    .rail-btn {
      width: 36px;
      height: 36px;
    }
  }
  .view-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .view-error h2 {
    margin: 0;
    font-weight: 500;
  }
  .view-error p {
    max-width: 560px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .view-error-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
</style>
