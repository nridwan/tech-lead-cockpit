<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { ESTIMATE_ROLES, ROLE_LABELS, type Developer, type DeveloperJiraLoad, type EstimateProject, type EstimateRole, type Holiday } from '../lib/estimate/types';
  import { jira } from '../lib/jira/client';
  import { recommendMembers } from '../lib/roster/availability';
  import { roster } from '../lib/roster/client';
  import type { ActivityResponse, MemberRecommendation, TeamMember } from '../lib/roster/types';

  /**
   * Who from the roster fits this project, per role: earliest start first (by week, open Jira work
   * included), then the lighter Jira load, then the most familiar with the role's repos, with the
   * reasons visible. Adding fills a placeholder developer
   * ("Backend 2") when one is picked, so its task assignments stay.
   */
  let {
    project,
    members,
    projects,
    holidays,
    windowEnd,
    servicesRoot,
    excludeKeys = [],
    jiraOpts = {},
    onadd,
    onclose,
    onroster,
  }: {
    project: EstimateProject;
    members: TeamMember[];
    projects: EstimateProject[];
    holidays: Holiday[];
    windowEnd?: string;
    servicesRoot?: string;
    excludeKeys?: string[];
    jiraOpts?: { defaultDays?: number; staleDays?: number };
    onadd: (member: TeamMember, replaceId?: string) => void;
    onclose: () => void;
    onroster: () => void;
  } = $props();

  const rolesWithTasks = $derived(ESTIMATE_ROLES.filter((r) => project.tasks.some((t) => t.role === r)));
  const firstRole = (): EstimateRole => rolesWithTasks.find((r) => !project.developers.some((d) => d.role === r && d.memberId)) ?? rolesWithTasks[0] ?? 'BACKEND';
  let role = $state<EstimateRole>(firstRole());

  let activity = $state<ActivityResponse | undefined>();
  let loadingActivity = $state(false);
  /** Open Jira tickets per account (outside this project), with the issue lists. */
  let jiraDetail = $state<Record<string, DeveloperJiraLoad>>({});
  let loadingJira = $state(false);
  let jiraLoadedAt = $state('');
  let jiraError = $state('');
  let openTickets = $state<string | null>(null);
  const jiraLoads = $derived(
    Object.fromEntries(Object.entries(jiraDetail).map(([id, l]) => [id, { days: l.days, issues: l.issues.length, inProgress: l.issues.filter((i) => i.statusCategory === 'indeterminate').length }])),
  );
  let replaceFor = $state<Record<string, string>>({});

  const services = $derived([...new Set(project.tasks.filter((t) => t.service).map((t) => t.service))]);
  const placeholders = $derived(project.developers.filter((d) => d.role === role && !d.memberId));

  $effect(() => {
    const list = services;
    void loadActivity(list);
  });

  $effect(() => {
    const accounts = members.filter((m) => m.active && m.jira).map((m) => m.jira!.accountId);
    void loadJira(accounts);
  });

  async function loadActivity(list: string[]) {
    if (!list.length) return;
    loadingActivity = true;
    try {
      activity = await roster.activity(list, servicesRoot);
    } catch (e) {
      activity = { days: 180, services: [], error: (e as Error).message };
    } finally {
      loadingActivity = false;
    }
  }

  async function loadJira(accounts: string[]) {
    if (!accounts.length) return;
    loadingJira = true;
    try {
      const loads = await jira.loads(accounts, excludeKeys, jiraOpts);
      // Linked members with no open ticket come back missing: that is a known zero, not unknown.
      jiraDetail = Object.fromEntries(accounts.map((id) => [id, loads[id] ?? { accountId: id, displayName: id, days: 0, issues: [] }]));
      jiraLoadedAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      jiraError = '';
    } catch (e) {
      jiraError = (e as Error).message;
    } finally {
      loadingJira = false;
    }
  }

  const reloadJira = () => void loadJira(members.filter((m) => m.active && m.jira).map((m) => m.jira!.accountId));

  const recs = $derived<MemberRecommendation[]>(recommendMembers({ role, members, project, projects, holidays, jiraLoads, activity, windowEnd }));
  const roleMembers = $derived(members.filter((m) => m.role === role).length);
  const unmatched = $derived(activity?.services.filter((s) => !s.repo).map((s) => s.service) ?? []);

  function add(r: MemberRecommendation) {
    const target = replaceFor[r.member.id] ?? placeholders[0]?.id;
    onadd(r.member, target || undefined);
  }

  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const devLabel = (d: Developer) => d.name;
</script>

<div class="recs">
  <div class="head">
    <strong class="small"><Icon name="sparkles" size={13} /> Rekomendasi dari daftar tim</strong>
    <div class="roles" role="group" aria-label="Role">
      {#each ESTIMATE_ROLES as r (r)}
        <button class:active={role === r} onclick={() => (role = r)}>{ROLE_LABELS[r]}{rolesWithTasks.includes(r) ? '' : ' ·'}</button>
      {/each}
    </div>
    <button class="btn btn-ghost btn-sm" onclick={onroster}><Icon name="user" size={12} /> Daftar tim</button>
    <button class="btn btn-ghost btn-sm" onclick={onclose} aria-label="Tutup rekomendasi"><Icon name="x" size={12} /></button>
  </div>

  <p class="muted small">
    Diurutkan: paling cepat bisa mulai (per minggu, setelah tiket Jira terbukanya di luar proyek ini selesai dan pekerjaan di proyek lain), lalu beban Jira paling ringan, lalu paling sering commit di repo task {ROLE_LABELS[role]} proyek ini. Anggota yang bebannya tidak diketahui ditaruh di belakang. Ini bahan pertimbangan, bukan keputusan.
  </p>

  {#if !roleMembers}
    <div class="empty small">
      Belum ada {ROLE_LABELS[role]} di daftar tim.
      <button class="btn btn-sm" onclick={onroster}><Icon name="plus" size={12} /> Isi daftar tim</button>
    </div>
  {:else if !recs.length}
    <p class="muted small">Semua {ROLE_LABELS[role]} di daftar tim sedang nonaktif.</p>
  {:else}
    <ol class="list">
      {#each recs as r, i (r.member.id)}
        <li class:in={r.inProject}>
          <span class="rank">{i + 1}</span>
          <div class="body">
            <div class="who">
              <strong>{r.member.name}</strong>
              <span class="start" class:late={r.waitDays > 0}>mulai {fmt(r.availableFrom)}{r.waitDays > 0 ? ` · +${r.waitDays} hari kerja` : ''}</span>
              {#if r.jira}
                <button class="jira" class:heavy={r.jira.days >= 5} onclick={() => (openTickets = openTickets === r.member.id ? null : r.member.id)} title="Tiket Jira terbuka di luar proyek ini">
                  <Icon name="jira" size={10} /> {r.jira.issues ? `${r.jira.issues} tiket · ±${r.jira.days} hari` : 'Jira kosong'} {r.jira.issues ? (openTickets === r.member.id ? '▾' : '▸') : ''}
                </button>
              {:else}
                <span class="jira unknown" title={r.member.jira ? 'Beban Jira belum termuat' : 'Tautkan akun Jira di daftar tim'}><Icon name="jira" size={10} /> beban ?</span>
              {/if}
              {#if r.familiarity && r.familiarity.share > 0}<span class="fam" title="{r.familiarity.commits} commit di repo task {ROLE_LABELS[role]} proyek ini">{Math.round(r.familiarity.share * 100)}% commit repo proyek</span>{/if}
              {#if r.inProject}<span class="chip">di tim</span>{/if}
            </div>
            {#if openTickets === r.member.id && r.member.jira && jiraDetail[r.member.jira.accountId]?.issues.length}
              <ul class="tickets small">
                {#each jiraDetail[r.member.jira.accountId].issues as i (i.key)}
                  <li><span class="mono">{i.key}</span> {i.summary} <span class="muted">· {i.status} · {i.estimateDays} hari{i.source === 'default' ? ' (default)' : ''}{i.due ? ` · due ${i.due}` : ''}</span></li>
                {/each}
              </ul>
            {/if}
            <ul class="reasons small muted">
              <!-- The first reason is the start date, already shown in the badge. -->
              {#each r.reasons.slice(1) as reason (reason)}<li>{reason}</li>{/each}
            </ul>
          </div>
          {#if !r.inProject}
            <div class="act">
              {#if placeholders.length}
                <select class="input tiny" value={replaceFor[r.member.id] ?? placeholders[0].id} onchange={(e) => (replaceFor[r.member.id] = e.currentTarget.value)} aria-label="Isi slot untuk {r.member.name}">
                  {#each placeholders as p (p.id)}<option value={p.id}>Isi {devLabel(p)}</option>{/each}
                  <option value="">Tambah baru</option>
                </select>
              {/if}
              <button class="btn btn-sm btn-primary" onclick={() => add(r)}><Icon name="plus" size={12} /> {placeholders.length && (replaceFor[r.member.id] ?? placeholders[0].id) ? 'Pakai' : 'Tambah'}</button>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <p class="foot muted small">
    {#if loadingActivity}Membaca riwayat git…{:else if activity?.error}Riwayat git tidak terbaca ({activity.error}), jadi keahlian per repo tidak dihitung.{:else if activity}Riwayat git {activity.days} hari terakhir di folder Services.{#if unmatched.length} Service tanpa repo yang cocok: {unmatched.join(', ')}.{/if}{/if}
    {#if jiraError} Beban Jira tidak termuat: {jiraError}.{:else if loadingJira} Memuat beban Jira…{:else if jiraLoadedAt} Beban Jira dimuat {jiraLoadedAt} (tiket proyek ini tidak dihitung; tiket tanpa estimasi {jiraOpts.defaultDays ?? 0.5} hari).{/if}
    <button class="link-btn" onclick={reloadJira} disabled={loadingJira}>Muat ulang beban Jira</button>
  </p>
</div>

<style>
  .recs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .head strong {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
  }
  .roles {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .roles button {
    border: none;
    background: var(--surface);
    padding: 4px 10px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    color: var(--text);
  }
  .roles button.active {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list > li {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    gap: 8px;
    align-items: start;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .list > li.in {
    opacity: 0.7;
  }
  .rank {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--surface-hover);
    font-size: 11px;
    font-weight: 600;
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: 13px;
  }
  .start,
  .fam,
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--ok-soft);
  }
  .start.late {
    background: var(--warn-soft);
  }
  .fam {
    background: var(--accent-soft);
  }
  .chip {
    background: var(--surface-hover);
  }
  .reasons {
    margin: 4px 0 0;
    padding-left: 16px;
  }
  .reasons:empty {
    display: none;
  }
  .act {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tiny {
    width: auto;
    padding: 2px 6px;
    font-size: 12px;
  }
  .small {
    font-size: 12px;
  }
  .foot {
    margin: 0;
  }
  .jira {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border: none;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .jira.heavy {
    background: var(--warn-soft);
  }
  .jira.unknown {
    cursor: default;
    color: var(--text-3);
  }
  .tickets {
    margin: 6px 0 0;
    padding: 6px 10px;
    list-style: none;
    border-radius: 6px;
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
</style>
