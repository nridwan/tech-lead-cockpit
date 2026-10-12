<script lang="ts">
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { estimate } from '../lib/estimate/client';
  import { DEFAULT_HOLIDAYS, coveredYears } from '../lib/estimate/holidays';
  import { lockAssignments, recommendAssignees, schedule, type ScheduleResult } from '../lib/estimate/schedule';
  import { jira } from '../lib/jira/client';
  import type { JiraUser } from '../lib/jira/types';
  import { ESTIMATE_ROLES, ROLE_LABELS, roleOf, type Developer, type DeveloperJiraLoad, type EstimateJob, type EstimateProject, type EstimateRole, type EstimateTask, type Holiday, type JiraCandidate } from '../lib/estimate/types';
  import { loadServicesRoot } from '../tad/generator-client';
  import type { Draft } from '../tad/drafts.svelte';
  import HolidaysModal from './HolidaysModal.svelte';
  import MemberRecommendations from './MemberRecommendations.svelte';
  import RosterModal from './RosterModal.svelte';
  import { projectAvailability } from '../lib/roster/availability';
  import { rosterState } from '../lib/roster/store.svelte';
  import type { TeamMember } from '../lib/roster/types';
  import { analysisContext, projectDrafts, projectTasks } from './project-tasks';

  /** The project is owned (and saved) by the Projects view; this panel edits its estimate. */
  let { project = $bindable(), drafts, projects = [] }: { project: EstimateProject; drafts: Draft[]; projects?: EstimateProject[] } = $props();

  const POLL_MS = 1500;

  let holidays = $state<Holiday[]>(DEFAULT_HOLIDAYS);
  let customHolidays = $state(false);
  let holidaysOpen = $state(false);

  // AI
  let showAi = $state(false);
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let useCodebase = $state(true);
  let overwrite = $state(false);
  let instructions = $state('');
  let job = $state<EstimateJob | null>(null);
  let openReason = $state<string | null>(null);
  let openDeps = $state<string | null>(null);

  const tads = $derived(projectDrafts(project, drafts));
  const scopeTasks = $derived(projectTasks(project, drafts));
  const multiTad = $derived(tads.length > 1);
  const tadTitleOf = $derived(new Map(scopeTasks.map((t) => [t.id, t.tadTitle])));
  const servicesRoot = $derived(tads.find((d) => d.servicesRoot)?.servicesRoot || loadServicesRoot());

  /** Project tasks follow the TADs' Development Scope: new tasks appear unestimated, removed ones go. */
  function mergeTasks(existing: EstimateTask[]): EstimateTask[] {
    const byId = new Map(existing.map((t) => [t.id, t]));
    const ids = new Set(scopeTasks.map((t) => t.id));
    return scopeTasks.map((st) => {
      const t = byId.get(st.id);
      return t
        ? { ...t, service: st.service, role: t.roleManual ? t.role : roleOf(st.title), dependsOn: t.dependsOn.filter((d) => ids.has(d)) }
        : { id: st.id, draftId: st.draftId, title: st.title, service: st.service, role: roleOf(st.title), effortDays: null, dependsOn: [] };
    });
  }

  // Keep the task list in sync with the TADs (scope edits, TADs added/removed from the project).
  $effect(() => {
    const merged = mergeTasks(untrack(() => $state.snapshot(project.tasks) as EstimateTask[]));
    untrack(() => {
      if (JSON.stringify(merged) !== JSON.stringify($state.snapshot(project.tasks))) project.tasks = merged;
    });
  });

  // Holidays and a still-running AI job, per project.
  $effect(() => {
    const id = project.id;
    untrack(() => void load(id));
  });

  async function load(id: string) {
    job = null;
    showAi = project.tasks.every((t) => t.effortDays === null);
    try {
      const [h, j] = await Promise.all([estimate.holidays(), estimate.latestJob(id)]);
      if (project.id !== id) return;
      holidays = h.holidays;
      customHolidays = h.custom;
      if (j?.status === 'running') {
        job = j;
        void poll(j.id);
      }
    } catch (e) {
      toasts.show(`Estimasi: ${(e as Error).message}`, 'err');
    }
  }

  // Team roster: availability (other projects, leave) for developers linked to a member.
  const members = $derived(rosterState.members);
  let rosterOpen = $state(false);
  let showRecs = $state(false);
  $effect(() => {
    void rosterState.load();
  });
  const availability = $derived.by(() => {
    try {
      return projectAvailability(project, members, projects, holidays);
    } catch {
      return {};
    }
  });
  /** The project plus availability: what every schedule on this panel runs on. */
  const plan = $derived({ ...project, availability });

  const result = $derived.by((): ScheduleResult | { error: string } | null => {
    try {
      return schedule(plan, holidays);
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  const sched = $derived(result && !('error' in result) ? result : null);
  const byId = $derived(new Map((sched?.tasks ?? []).map((t) => [t.id, t])));
  const devName = (id?: string) => project.developers.find((d) => d.id === id)?.name ?? '';
  const years = $derived(coveredYears(holidays));
  const beyondCalendar = $derived(sched?.endDate ? Number(sched.endDate.slice(0, 4)) > Math.max(...years) : false);
  const estimated = $derived(project.tasks.filter((t) => t.effortDays !== null).length);

  // AI ------------------------------------------------------------------------------------

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function runAi() {
    if (overwrite && project.tasks.some((t) => t.effortDays !== null)) {
      const ok = await confirmDialog({ title: 'Timpa estimasi?', message: 'Effort dan dependency yang sudah kamu isi akan diganti usulan AI.', confirmText: 'Timpa' });
      if (!ok) return;
    }
    const specs = new Map(scopeTasks.map((t) => [t.id, t]));
    try {
      job = await estimate.start({
        projectId: project.id,
        projectName: project.name,
        ai,
        tasks: project.tasks.map((t) => ({ id: t.id, title: t.title, tadTitle: specs.get(t.id)?.tadTitle ?? '', service: t.service, role: t.role, spec: specs.get(t.id)?.spec ?? '' })),
        context: analysisContext(tads) || undefined,
        servicesRoot: useCodebase ? servicesRoot : undefined,
        instructions,
      });
      void poll(job.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function poll(id: string) {
    const projectId = project.id;
    while (project.id === projectId) {
      await sleep(POLL_MS);
      const j = await estimate.job(id).catch(() => null);
      if (!j || project.id !== projectId) return;
      job = j;
      if (j.status === 'running') continue;
      if (j.status === 'done' && j.result) apply(j.result);
      else if (j.status === 'error') toasts.show(`Estimasi AI gagal: ${j.error}`, 'err', 8000);
      if (j.touchedRepos?.length) toasts.show(`Peringatan: repo berubah saat AI berjalan: ${j.touchedRepos.join(', ')}. Periksa git status.`, 'err', 10000);
      return;
    }
  }

  function apply(r: NonNullable<EstimateJob['result']>) {
    const proposals = new Map(r.tasks.map((t) => [t.id, t]));
    let filled = 0;
    project.tasks = project.tasks.map((t) => {
      const p = proposals.get(t.id);
      if (!p) return t;
      const fill = overwrite || t.effortDays === null;
      if (fill) filled++;
      return {
        ...t,
        ai: { effortDays: p.effortDays, confidence: p.confidence, reason: p.reason },
        effortDays: fill ? p.effortDays : t.effortDays,
        dependsOn: overwrite || !t.dependsOn.length ? p.dependsOn : t.dependsOn,
      };
    });
    project.notes = r.notes;
    showAi = false;
    toasts.show(`Usulan AI masuk untuk ${proposals.size} task (${filled} effort terisi). Koreksi angkanya bila perlu.`, 'ok', 5000);
  }

  // Team ----------------------------------------------------------------------------------

  function addDev(role: EstimateRole) {
    const n = project.developers.filter((d) => d.role === role).length + 1;
    project.developers = [...project.developers, { id: crypto.randomUUID(), name: `${ROLE_LABELS[role]} ${n}`, role, allocation: 1 }];
  }

  function removeDev(dev: Developer) {
    project.developers = project.developers.filter((d) => d.id !== dev.id);
    project.tasks = project.tasks.map((t) => (t.assigneeId === dev.id ? { ...t, assigneeId: undefined } : t));
  }

  // Jira workload & recommendations -------------------------------------------------------

  const projectJiraKeys = $derived([...new Set(scopeTasks.flatMap((t) => t.jiraKeys))]);
  const jiraProjects = $derived([...new Set(projectJiraKeys.map((k) => k.split('-')[0]))]);
  const jiraOpts = $derived({ defaultDays: project.jiraDefaultDays ?? 0.5, staleDays: project.jiraStaleDays ?? 30 });
  /** Last loaded issue lists, by Jira account. */
  let loadDetail = $state<Record<string, DeveloperJiraLoad>>({});
  let openLoad = $state<string | null>(null);
  let loadingJira = $state(false);
  let linkFor = $state<string | null>(null);
  let userQuery = $state('');
  let userResults = $state<JiraUser[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let candidates = $state<JiraCandidate[] | null>(null);
  let loadingCandidates = $state(false);
  let candidateRole = $state<Record<string, EstimateRole>>({});
  let recFor = $state<string | null>(null);
  const recs = $derived(recFor ? recommendAssignees(plan, holidays, recFor) : []);
  const unassigned = $derived(project.tasks.filter((t) => !t.assigneeId && t.effortDays && byId.get(t.id)?.developerId).length);

  function searchUsers(q: string) {
    userQuery = q;
    clearTimeout(searchTimer);
    if (q.trim().length < 2) return void (userResults = []);
    searchTimer = setTimeout(async () => {
      try {
        userResults = await jira.users(q.trim());
      } catch (e) {
        toasts.show(`Jira: ${(e as Error).message}`, 'err');
      }
    }, 300);
  }

  function linkDev(d: Developer, u: { accountId: string; displayName: string }) {
    d.jira = { accountId: u.accountId, displayName: u.displayName };
    // A placeholder name ("Backend 2") takes the person's name.
    if (/^(Backend|Mobile FE|Web\/CMS FE) \d+$/.test(d.name)) d.name = u.displayName;
    d.jiraLoad = undefined;
    linkFor = null;
    userResults = [];
    userQuery = '';
    void refreshJiraLoads([d]);
  }

  function unlinkDev(d: Developer) {
    d.jira = undefined;
    d.jiraLoad = undefined;
  }

  async function refreshJiraLoads(only?: Developer[]) {
    const devs = (only ?? project.developers).filter((d) => d.jira);
    if (!devs.length) return void toasts.show('Tautkan developer ke akun Jira dulu (tombol "Jira" di baris developer).', 'info', 4000);
    loadingJira = true;
    try {
      const loads = await jira.loads(devs.map((d) => d.jira!.accountId), projectJiraKeys, jiraOpts);
      const loadedAt = new Date().toISOString();
      loadDetail = { ...loadDetail, ...loads };
      for (const d of devs) {
        const l = loads[d.jira!.accountId];
        if (l) d.jiraLoad = { days: l.days, issues: l.issues.length, loadedAt };
      }
      if (!only) toasts.show(`Beban Jira ${devs.length} developer diperbarui.`, 'ok', 2000);
    } catch (e) {
      toasts.show(`Jira: ${(e as Error).message}`, 'err');
    } finally {
      loadingJira = false;
    }
  }

  async function loadCandidates() {
    if (!jiraProjects.length) return void toasts.show('Task di proyek ini belum punya Jira key, jadi project Jira-nya tidak diketahui.', 'info', 4000);
    loadingCandidates = true;
    try {
      candidates = await jira.candidates(jiraProjects, projectJiraKeys, jiraOpts);
    } catch (e) {
      toasts.show(`Jira: ${(e as Error).message}`, 'err');
    } finally {
      loadingCandidates = false;
    }
  }

  function addCandidate(c: JiraCandidate) {
    if (project.developers.some((d) => d.jira?.accountId === c.accountId)) return void toasts.show(`${c.displayName} sudah ada di tim.`, 'info');
    const role = candidateRole[c.accountId] ?? 'BACKEND';
    project.developers = [
      ...project.developers,
      { id: crypto.randomUUID(), name: c.displayName, role, allocation: 1, jira: { accountId: c.accountId, displayName: c.displayName }, jiraLoad: { days: c.loadDays, issues: c.openIssues, loadedAt: new Date().toISOString() } },
    ];
    toasts.show(`${c.displayName} ditambahkan sebagai ${ROLE_LABELS[role]}.`, 'ok', 2000);
  }

  /** Adds a roster member to the team, or puts them in a placeholder slot (keeps its tasks). */
  function addMember(m: TeamMember, replaceId?: string) {
    if (project.developers.some((d) => d.memberId === m.id)) return void toasts.show(`${m.name} sudah ada di tim.`, 'info');
    const fields = { name: m.name, role: m.role, allocation: m.capacity, memberId: m.id, jira: m.jira, jiraLoad: undefined };
    const slot = replaceId ? project.developers.find((d) => d.id === replaceId) : undefined;
    if (slot) {
      Object.assign(slot, fields);
      toasts.show(`${m.name} mengisi slot ${ROLE_LABELS[m.role]}.`, 'ok', 2500);
    } else {
      project.developers = [...project.developers, { id: crypto.randomUUID(), ...fields }];
      toasts.show(`${m.name} ditambahkan sebagai ${ROLE_LABELS[m.role]}.`, 'ok', 2500);
    }
    if (m.jira) void refreshJiraLoads(project.developers.filter((d) => d.memberId === m.id));
  }

  function assign(t: EstimateTask, devId: string) {
    t.assigneeId = devId;
    recFor = null;
  }

  async function lockAll() {
    const ok = await confirmDialog({
      title: 'Kunci rekomendasi?',
      message: `${unassigned} task yang masih "Otomatis" akan dikunci ke developer yang dipilih penjadwal sekarang. Task yang sudah di-assign tidak berubah.`,
      confirmText: 'Kunci',
    });
    if (ok) project.tasks = lockAssignments(plan, holidays);
  }

  const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function toggleDep(task: EstimateTask, id: string) {
    task.dependsOn = task.dependsOn.includes(id) ? task.dependsOn.filter((d) => d !== id) : [...task.dependsOn, id];
  }

  function useAll() {
    project.tasks = project.tasks.map((t) => (t.ai ? { ...t, effortDays: t.ai.effortDays } : t));
  }

  // Display -------------------------------------------------------------------------------

  const fmtDate = (d?: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–');
  const fmtShort = (d?: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '–');
  const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} hari`;
  const shortTitle = (t: string) => t.replace(/^(\s*\[[^\]]*\])+\s*-?\s*/, '');
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  /** Short TAD label shown next to a task when the project has several TADs. */
  const tadLabel = (id: string) => (multiTad ? (tadTitleOf.get(id) ?? '') : '');
  const taskLabel = (id: string) => {
    const t = project.tasks.find((x) => x.id === id);
    return t ? `${shortTitle(t.title)}${multiTad ? ` (${tadTitleOf.get(id) ?? ''})` : ''}` : id;
  };

  function copyMarkdown() {
    if (!sched) return;
    const rows = project.tasks.map((t, i) => {
      const s = byId.get(t.id);
      return `| ${i + 1} |${multiTad ? ` ${tadTitleOf.get(t.id) ?? ''} |` : ''} ${t.title} | ${t.effortDays ?? '-'} | ${devName(s?.developerId) || '-'} | ${s?.startDate ? `${fmtShort(s.startDate)} – ${fmtShort(s.endDate)}` : '-'} |`;
    });
    const md = [
      `**Estimasi ${project.name}**`,
      '',
      `- TAD: ${tads.map((d) => tadTitleOf.get(project.tasks.find((t) => t.draftId === d.id)?.id ?? '') ?? d.id).join(', ') || '-'}`,
      `- Mulai: ${fmtDate(sched.startDate)} · Target selesai: ${fmtDate(sched.endDate)} (${sched.spanDays} hari kerja)`,
      `- Total effort: ${days(sched.totalEffort)} (${ESTIMATE_ROLES.filter((r) => sched.effortByRole[r]).map((r) => `${ROLE_LABELS[r]} ${days(sched.effortByRole[r])}`).join(', ')})`,
      `- Tim: ${project.developers.map((d) => `${d.name} (${ROLE_LABELS[d.role]}, ${pct(d.allocation)})`).join(', ') || '-'}`,
      '',
      `| No |${multiTad ? ' TAD |' : ''} Task | Effort (hari) | Developer | Jadwal |`,
      `|---|${multiTad ? '---|' : ''}---|---|---|---|`,
      ...rows,
    ].join('\n');
    void navigator.clipboard.writeText(md);
    toasts.show('Tabel estimasi disalin.', 'ok', 1500);
  }
</script>

<div class="est">
    <header class="head">
      <div>
        <h2>Estimasi Pengerjaan</h2>
        <p class="muted small">Effort per task (man-day) dari {tads.length} TAD diusulkan AI dan kamu koreksi; jadwal dihitung dari hari kerja, kapasitas tim, dan dependency.</p>
      </div>
      <div class="head-actions">
        <label class="inline">Mulai <input class="input date" type="date" bind:value={project.startDate} /></label>
        <label class="inline" title="Cuti bersama SKB dihitung sebagai hari libur"><input type="checkbox" bind:checked={project.skipCutiBersama} /> Cuti bersama libur</label>
        <button class="btn btn-sm" onclick={() => (holidaysOpen = true)}><Icon name="clock" size={13} /> Kalender libur</button>
        <button class="btn btn-sm" class:btn-primary={showAi} onclick={() => (showAi = !showAi)} disabled={job?.status === 'running'}><Icon name="sparkles" size={13} /> Estimasi AI</button>
        <button class="btn btn-sm" onclick={copyMarkdown} disabled={!sched}><Icon name="copy" size={13} /> Salin tabel</button>
      </div>
    </header>

    {#if job?.status === 'running'}
      <div class="banner">
        <span class="spinner" aria-hidden="true"></span>
        <span>AI menghitung effort{useCodebase ? ' sambil membaca codebase' : ''}… <span class="muted">{job.progress ?? ''}</span></span>
        <button class="btn btn-sm" onclick={async () => job && (job = await estimate.cancel(job.id))}>Batalkan</button>
      </div>
    {:else if showAi}
      <section class="card ai">
        <div class="ai-grid">
          <div class="ai-opts">
            <label class="check"><input type="checkbox" bind:checked={useCodebase} /> Telusuri codebase (hanya baca): <code>{servicesRoot}</code></label>
            <label class="check"><input type="checkbox" bind:checked={overwrite} /> Timpa effort & dependency yang sudah diisi</label>
            <label class="field">
              <span>Instruksi tambahan (opsional)</span>
              <textarea class="input" rows="2" bind:value={instructions} placeholder="mis. developer mobile masih baru di Flutter; integrasi partner X biasanya lama"></textarea>
            </label>
          </div>
          <div class="ai-run">
            <AiPicker value={ai} onchange={(s) => (ai = s)} />
            <button class="btn btn-primary" onclick={runAi} disabled={!project.tasks.length}><Icon name="sparkles" size={14} /> Usulkan effort {project.tasks.length} task</button>
            <p class="muted small">AI hanya mengusulkan man-day, confidence, dan dependency. Tanggal tetap dihitung di sini, bukan oleh AI.</p>
          </div>
        </div>
        {#if job?.status === 'error'}
          <p class="err small">Percobaan terakhir gagal: {job.error}</p>
        {/if}
      </section>
    {/if}

    <div class="body">
      {#if 'error' in (result ?? {})}
        <p class="err">{(result as { error: string }).error}</p>
      {/if}

      {#if sched}
        <section class="cards">
          <div class="card stat">
            <span class="label">Target selesai</span>
            <strong class="big">{sched.endDate ? fmtDate(sched.endDate) : '–'}</strong>
            <span class="muted small">{sched.complete ? 'Semua task terjadwal' : 'Belum lengkap — lihat peringatan'}</span>
          </div>
          <div class="card stat">
            <span class="label">Durasi</span>
            <strong class="big">{sched.spanDays} hari kerja</strong>
            <span class="muted small">{fmtShort(sched.startDate)} – {fmtShort(sched.endDate)}{sched.daysOff.length ? ` · ${sched.daysOff.length} hari libur dilewati` : ''}</span>
          </div>
          <div class="card stat">
            <span class="label">Total effort</span>
            <strong class="big">{days(sched.totalEffort)}</strong>
            <span class="muted small">{ESTIMATE_ROLES.filter((r) => sched.effortByRole[r]).map((r) => `${ROLE_LABELS[r]} ${days(sched.effortByRole[r])}`).join(' · ') || 'Belum ada effort'}</span>
          </div>
          <div class="card stat">
            <span class="label">Terestimasi</span>
            <strong class="big">{estimated}/{project.tasks.length} task</strong>
            <span class="muted small">{project.developers.length} developer</span>
          </div>
        </section>

        {#if sched.warnings.length || beyondCalendar}
          <div class="warnings">
            {#each sched.warnings as w (w)}<p><Icon name="alert" size={13} /> {w}</p>{/each}
            {#if beyondCalendar}<p><Icon name="alert" size={13} /> Jadwal melewati tahun {Math.max(...years)}; libur nasional tahun berikutnya belum ada di kalender, jadi hanya Sabtu–Minggu yang dilewati.</p>{/if}
          </div>
        {/if}
      {/if}

      <section class="card team">
        <div class="section-head">
          <h3>Tim</h3>
          <div class="add-devs">
            {#each ESTIMATE_ROLES as r (r)}
              <button class="btn btn-sm" onclick={() => addDev(r)}><Icon name="plus" size={12} /> {ROLE_LABELS[r]}</button>
            {/each}
            <button class="btn btn-sm" onclick={loadCandidates} disabled={loadingCandidates} title="Orang yang bisa di-assign di project Jira {jiraProjects.join(', ') || '-'}, beban paling ringan dulu"><Icon name="jira" size={12} /> {loadingCandidates ? 'Memuat…' : 'Kandidat dari Jira'}</button>
            <button class="btn btn-sm btn-primary" onclick={() => (showRecs = !showRecs)} title="Siapa dari daftar tim yang paling cepat tersedia dan paling paham repo proyek ini"><Icon name="sparkles" size={12} /> Rekomendasi</button>
            <button class="btn btn-sm" onclick={() => (rosterOpen = true)} title="Daftar semua anggota tim: role, Jira, email git, kapasitas, cuti"><Icon name="user" size={12} /> Daftar tim ({members.filter((m) => m.active).length})</button>
          </div>
        </div>
        {#if showRecs}
          <MemberRecommendations
            {project}
            {members}
            {projects}
            {holidays}
            windowEnd={sched?.endDate}
            {servicesRoot}
            excludeKeys={projectJiraKeys}
            {jiraOpts}
            onadd={addMember}
            onclose={() => (showRecs = false)}
            onroster={() => (rosterOpen = true)}
          />
        {/if}
        <div class="jira-bar">
          <label class="check small" title="Developer yang tertaut Jira baru mulai mengerjakan proyek setelah tiket Jira terbukanya (di luar proyek ini) selesai">
            <input type="checkbox" bind:checked={project.useJiraLoad} /> Hitung beban Jira
          </label>
          <label class="inline small" title="Tiket tanpa estimasi dihitung sekian hari">tiket tanpa estimasi <input class="input tiny" type="number" min="0.5" max="20" step="0.5" value={jiraOpts.defaultDays} oninput={(e) => (project.jiraDefaultDays = Number(e.currentTarget.value) || 0.5)} /> hari</label>
          <label class="inline small" title="Tiket yang tidak di-update selama ini dianggap basi dan diabaikan (0 = hitung semua)">abaikan tiket tak di-update &gt; <input class="input tiny" type="number" min="0" max="365" step="1" value={jiraOpts.staleDays} oninput={(e) => (project.jiraStaleDays = Math.max(0, Math.round(Number(e.currentTarget.value) || 0)))} /> hari</label>
          <button class="btn btn-sm" onclick={() => refreshJiraLoads()} disabled={loadingJira}><Icon name="refresh" size={12} /> {loadingJira ? 'Memuat…' : 'Muat beban Jira'}</button>
          <span class="muted small">Beban dari Jira hanya indikasi (tiket sering tidak digeser); koreksi angkanya per developer bila perlu.</span>
        </div>
        {#if candidates}
          <div class="candidates">
            <div class="cand-head">
              <strong class="small">Kandidat dari Jira ({jiraProjects.join(', ')}) · beban paling ringan dulu</strong>
              <button class="btn btn-ghost btn-sm" onclick={() => (candidates = null)} aria-label="Tutup kandidat"><Icon name="x" size={12} /></button>
            </div>
            <div class="cand-list">
              {#each candidates as c (c.accountId)}
                {@const inTeam = project.developers.some((d) => d.jira?.accountId === c.accountId)}
                <div class="cand" class:in-team={inTeam}>
                  <span class="cand-name">{c.displayName}</span>
                  <span class="muted small">{c.openIssues ? `${c.openIssues} tiket aktif · ${c.inProgress} in progress · ±${days(c.loadDays)}` : 'tidak ada tiket aktif'}</span>
                  {#if inTeam}
                    <span class="chip">di tim</span>
                  {:else}
                    <select class="input tiny-select" value={candidateRole[c.accountId] ?? 'BACKEND'} onchange={(e) => (candidateRole[c.accountId] = e.currentTarget.value as EstimateRole)} aria-label="Role {c.displayName}">
                      {#each ESTIMATE_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
                    </select>
                    <button class="btn btn-sm" onclick={() => addCandidate(c)}><Icon name="plus" size={12} /> Tambah</button>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if !project.developers.length}
          <p class="muted small">Tambahkan developer per role. Tanpa developer, task tidak bisa dijadwalkan.</p>
        {/if}
        <div class="devs">
          {#each project.developers as d (d.id)}
            {@const load = sched?.developers.find((x) => x.id === d.id)}
            <div class="dev">
              <input class="input name" bind:value={d.name} aria-label="Nama developer" />
              <select class="input" bind:value={d.role} aria-label="Role">
                {#each ESTIMATE_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
              </select>
              <label class="alloc" title="Porsi hari kerja untuk proyek ini">
                <input class="input" type="number" min="10" max="100" step="10" value={Math.round(d.allocation * 100)} oninput={(e) => (d.allocation = Math.min(1, Math.max(0.1, Number(e.currentTarget.value) / 100 || 1)))} aria-label="Alokasi persen" />%
              </label>
              <span class="muted small load">{load?.tasks ? `${days(load.effortDays)} · ${load.tasks} task · selesai ${fmtShort(load.finishDate)} · sibuk ${pct(load.utilization)}` : 'belum ada task'}{load?.availableFrom ? ` · baru tersedia ${fmtShort(load.availableFrom)}` : ''}{load?.leaveDays ? ` · cuti ${load.leaveDays} hari` : ''}</span>
              {#if d.memberId}
                <span class="chip" title={availability[d.id]?.fromReason ?? 'Ketersediaan dan cuti diambil dari daftar tim'}><Icon name="user" size={10} /> daftar tim</span>
              {/if}
              {#if d.jira}
                <span class="jira-link" title="Tertaut ke akun Jira {d.jira.displayName}">
                  <Icon name="jira" size={11} /> {d.jira.displayName}
                  <button class="x-btn" onclick={() => unlinkDev(d)} aria-label="Lepas tautan Jira {d.name}"><Icon name="x" size={10} /></button>
                </span>
                <label class="inline small jira-load" title="Beban Jira di luar proyek (hari kerja); bisa dikoreksi">
                  beban
                  <input class="input tiny" type="number" min="0" max="500" step="0.5" value={d.jiraLoad?.days ?? 0} oninput={(e) => (d.jiraLoad = { days: Math.max(0, Math.round((Number(e.currentTarget.value) || 0) * 2) / 2), issues: d.jiraLoad?.issues ?? 0, loadedAt: d.jiraLoad?.loadedAt ?? '' })} aria-label="Beban Jira {d.name}" />
                  hari
                </label>
                {#if loadDetail[d.jira.accountId]}
                  <button class="link-btn small" onclick={() => (openLoad = openLoad === d.id ? null : d.id)}>{d.jiraLoad?.issues ?? loadDetail[d.jira.accountId].issues.length} tiket {openLoad === d.id ? '▾' : '▸'}</button>
                {:else if d.jiraLoad?.loadedAt}
                  <span class="muted small" title="Dimuat {fmtTime(d.jiraLoad.loadedAt)}">{d.jiraLoad.issues} tiket</span>
                {/if}
              {:else}
                <button class="btn btn-ghost btn-sm" onclick={() => { linkFor = linkFor === d.id ? null : d.id; userQuery = ''; userResults = []; }} title="Tautkan ke akun Jira untuk menghitung bebannya"><Icon name="jira" size={12} /> Jira</button>
              {/if}
              <button class="btn btn-ghost btn-sm" onclick={() => removeDev(d)} aria-label="Hapus {d.name}"><Icon name="trash" size={13} /></button>
            </div>
            {#if linkFor === d.id}
              <div class="link-box">
                <!-- svelte-ignore a11y_autofocus -->
                <input class="input" value={userQuery} oninput={(e) => searchUsers(e.currentTarget.value)} placeholder="Cari nama / email di Jira" autofocus aria-label="Cari user Jira" />
                {#each userResults as u (u.accountId)}
                  <button class="user-opt" onclick={() => linkDev(d, u)}>{u.displayName}{u.emailAddress ? ` · ${u.emailAddress}` : ''}</button>
                {:else}
                  {#if userQuery.trim().length >= 2}<span class="muted small">Tidak ada hasil.</span>{/if}
                {/each}
              </div>
            {/if}
            {#if d.jira && openLoad === d.id && loadDetail[d.jira.accountId]}
              <ul class="load-list small">
                {#each loadDetail[d.jira.accountId].issues as i (i.key)}
                  <li><span class="mono">{i.key}</span> {i.summary} <span class="muted">· {i.status} · {days(i.estimateDays)}{i.source === 'default' ? ' (default)' : i.source === 'remaining' ? ' (sisa estimasi)' : ' (estimasi awal)'}{i.due ? ` · due ${fmtShort(i.due)}` : ''}</span></li>
                {:else}
                  <li class="muted">Tidak ada tiket yang masih perlu dikerjakan.</li>
                {/each}
                {#if loadDetail[d.jira.accountId].postDev?.length}
                  <li class="muted">Tidak dihitung, sudah lewat development: {loadDetail[d.jira.accountId].postDev!.map((i) => `${i.key} (${i.status})`).join(', ')}</li>
                {/if}
              </ul>
            {/if}
          {/each}
        </div>
      </section>

      <RosterModal bind:open={rosterOpen} bind:members={rosterState.members} {jiraProjects} excludeKeys={projectJiraKeys} {servicesRoot} />

      {#if project.notes}
        <details class="card notes">
          <summary><Icon name="alert" size={13} /> Asumsi & risiko dari AI</summary>
          <p>{project.notes}</p>
        </details>
      {/if}

      <section class="card">
        <div class="section-head">
          <h3>Task ({project.tasks.length})</h3>
          <div class="task-actions">
            {#if project.tasks.some((t) => t.ai && t.ai.effortDays !== t.effortDays)}
              <button class="btn btn-ghost btn-sm" onclick={useAll}>Pakai semua usulan AI</button>
            {/if}
            {#if unassigned}
              <button class="btn btn-ghost btn-sm" onclick={lockAll} title="Kunci task yang masih Otomatis ke developer pilihan penjadwal">Kunci {unassigned} rekomendasi</button>
            {/if}
          </div>
        </div>
        {#if !project.tasks.length}
          <p class="muted small">{tads.length ? 'Development Scope di TAD proyek ini belum berisi task.' : 'Tambahkan TAD ke proyek ini untuk mulai mengestimasi.'}</p>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Usulan AI</th>
                  <th>Effort (hari)</th>
                  <th>Bergantung pada</th>
                  <th>Developer</th>
                  <th>Jadwal</th>
                </tr>
              </thead>
              <tbody>
                {#each project.tasks as t (t.id)}
                  {@const s = byId.get(t.id)}
                  <tr class:critical={s?.critical}>
                    <td class="task">
                      <select
                        class="role r-{t.role.toLowerCase()}"
                        value={t.role}
                        onchange={(e) => {
                          t.role = e.currentTarget.value as EstimateRole;
                          t.roleManual = t.role !== roleOf(t.title) || undefined;
                          if (t.assigneeId && project.developers.find((d) => d.id === t.assigneeId)?.role !== t.role) t.assigneeId = undefined;
                        }}
                        title={t.roleManual ? 'Role diubah manual' : 'Role dari tag judul task; ubah bila salah'}
                        aria-label="Role {shortTitle(t.title)}"
                      >
                        {#each ESTIMATE_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}{t.roleManual && r === t.role ? ' ✎' : ''}</option>{/each}
                      </select>
                      <span class="title" title={t.title}>{shortTitle(t.title)}</span>
                      {#if multiTad}<span class="tad-tag small" title="TAD asal">{tadLabel(t.id)}</span>{/if}
                      <span class="muted small" title={s?.critical ? 'Task ini ada di rantai (dependency atau antrean developer) yang menentukan tanggal selesai' : undefined}>{t.service}{s?.critical ? ' · jalur kritis' : ''}</span>
                    </td>
                    <td class="ai-cell">
                      {#if t.ai}
                        <button class="ai-chip c-{t.ai.confidence}" onclick={() => (openReason = openReason === t.id ? null : t.id)} title="Lihat alasan">
                          {days(t.ai.effortDays)} · {t.ai.confidence === 'high' ? 'yakin' : t.ai.confidence === 'low' ? 'kurang yakin' : 'sedang'}
                        </button>
                        {#if openReason === t.id}<p class="reason small">{t.ai.reason || 'Tanpa alasan.'}</p>{/if}
                      {:else}<span class="muted small">–</span>{/if}
                    </td>
                    <td>
                      <input
                        class="input effort"
                        type="number"
                        min="0.5"
                        max="60"
                        step="0.5"
                        value={t.effortDays ?? ''}
                        placeholder="?"
                        oninput={(e) => {
                          const v = Number(e.currentTarget.value);
                          t.effortDays = e.currentTarget.value === '' || !(v > 0) ? null : Math.round(v * 2) / 2;
                        }}
                        aria-label="Effort hari {shortTitle(t.title)}"
                      />
                    </td>
                    <td class="deps">
                      <button class="dep-toggle" onclick={() => (openDeps = openDeps === t.id ? null : t.id)} aria-expanded={openDeps === t.id}>
                        {openDeps === t.id ? '▾' : '▸'} {t.dependsOn.length ? `${t.dependsOn.length} task` : 'Tidak ada'}
                      </button>
                      {#if openDeps === t.id}
                        <div class="dep-menu">
                          {#each project.tasks.filter((o) => o.id !== t.id) as o (o.id)}
                            <label class="check small"><input type="checkbox" checked={t.dependsOn.includes(o.id)} onchange={() => toggleDep(t, o.id)} /> {taskLabel(o.id)}</label>
                          {/each}
                        </div>
                      {/if}
                      {#each t.dependsOn as dep (dep)}<span class="dep small" title={taskLabel(dep)}>← {taskLabel(dep)}</span>{/each}
                    </td>
                    <td class="dev-cell">
                      <select class="input" value={t.assigneeId ?? ''} onchange={(e) => (t.assigneeId = e.currentTarget.value || undefined)} aria-label="Developer">
                        <option value="">Otomatis{s?.developerId && !t.assigneeId ? ` (${devName(s.developerId)})` : ''}</option>
                        {#each project.developers.filter((d) => d.role === t.role) as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
                      </select>
                      {#if t.effortDays && project.developers.filter((d) => d.role === t.role).length > 1}
                        <button class="link-btn small" onclick={() => (recFor = recFor === t.id ? null : t.id)} aria-expanded={recFor === t.id}>Rekomendasi {recFor === t.id ? '▾' : '▸'}</button>
                      {/if}
                      {#if recFor === t.id}
                        <div class="rec-menu">
                          {#each recs as r, i (r.developerId)}
                            <div class="rec" class:best={i === 0}>
                              <div>
                                <strong>{i === 0 ? '★ ' : ''}{r.name}</strong>
                                <span class="muted small">task selesai {fmtShort(r.taskEndDate)} · proyek {fmtShort(r.projectEndDate)} ({r.spanDays} hari kerja){r.jiraLoadDays ? ` · beban Jira ${days(r.jiraLoadDays)}` : ''}{r.queuedDays ? ` · antrean proyek ${days(r.queuedDays)}` : ''}</span>
                              </div>
                              {#if t.assigneeId === r.developerId}
                                <span class="chip">dipilih</span>
                              {:else}
                                <button class="btn btn-sm" onclick={() => assign(t, r.developerId)}>Pakai</button>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </td>
                    <td class="when">
                      {#if s?.startDate}
                        <span>{fmtShort(s.startDate)} – {fmtShort(s.endDate)}</span>
                        <span class="muted small">{s.spanDays} hari kerja{s.waitedFor ? ` · menunggu ${s.waitedFor.kind === 'dependency' ? 'task' : s.waitedFor.kind === 'jira' ? 'beban Jira' : s.waitedFor.kind === 'availability' ? s.waitedFor.title : 'developer'}` : ''}</span>
                      {:else if s?.issues.includes('unestimated')}<span class="muted small">isi effort</span>
                      {:else if s?.issues.includes('no-developer')}<span class="err small">tidak ada developer {ROLE_LABELS[t.role]}</span>
                      {:else if s?.issues.includes('cycle')}<span class="err small">dependency melingkar</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      {#if sched && sched.spanDays > 0}
        <section class="card">
          <div class="section-head">
            <h3>Timeline</h3>
            <span class="muted small">Garis merah = jalur kritis (rantai yang menentukan tanggal selesai) · 1 kolom = 1 hari kerja</span>
          </div>
          <div class="gantt" style="--span: {sched.spanDays}">
            <div></div>
            <div class="g-axis muted small"><span>{fmtShort(sched.startDate)}</span><span>{sched.spanDays} hari kerja</span><span>{fmtShort(sched.endDate)}</span></div>
            {#each project.tasks as t (t.id)}
              {@const s = byId.get(t.id)}
              {#if s?.startDate}
                <div class="g-label" title={taskLabel(t.id)}>{shortTitle(t.title)}</div>
                <div class="g-track">
                  <div
                    class="g-bar r-{t.role.toLowerCase()}"
                    class:critical={s.critical}
                    style="left: {(s.start / sched.spanDays) * 100}%; width: {Math.max(((s.finish - s.start) / sched.spanDays) * 100, 0.8)}%"
                    title="{shortTitle(t.title)} · {devName(s.developerId)} · {fmtShort(s.startDate)}–{fmtShort(s.endDate)}"
                  >
                    <span>{devName(s.developerId)}</span>
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </div>

<HolidaysModal bind:open={holidaysOpen} bind:holidays bind:custom={customHolidays} />

<style>
  .tad-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--surface-hover);
    color: var(--text-2, var(--text));
  }
  .est {
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
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }
  .input.date {
    width: auto;
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
  .ai-grid {
    display: grid;
    grid-template-columns: 1.3fr 1fr;
    gap: 16px;
  }
  .ai-opts,
  .ai-run {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .check code {
    font-size: 11.5px;
    word-break: break-all;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 3px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .label {
    font-size: 11.5px;
    color: var(--text-2, var(--text));
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .big {
    font-size: 17px;
  }
  .warnings {
    border: 1px solid var(--warn);
    background: var(--warn-soft);
    border-radius: var(--radius);
    padding: 8px 12px;
    font-size: 12.5px;
  }
  .warnings p {
    margin: 2px 0;
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .section-head h3 {
    margin: 0;
    font-size: 13.5px;
  }
  .add-devs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .devs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dev {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .dev > .name {
    width: 210px;
  }
  .dev > select {
    width: 130px;
  }
  .dev > .load {
    flex: 1;
    min-width: 180px;
  }
  .alloc {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .load {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  th {
    text-align: left;
    font-weight: 600;
    font-size: 11.5px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr.critical td:first-child {
    box-shadow: inset 3px 0 0 var(--err);
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 220px;
  }
  .title {
    font-weight: 500;
  }
  .role {
    align-self: flex-start;
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
  }
  select.role {
    border: none;
    font-family: inherit;
    cursor: pointer;
    appearance: none;
  }
  .r-backend {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .r-mobile-fe {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .r-web-fe {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .ai-cell {
    min-width: 130px;
  }
  .ai-chip {
    border: 1px solid var(--border);
    background: var(--surface-hover);
    color: var(--text);
    border-radius: 999px;
    padding: 2px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .c-high {
    border-color: var(--ok);
  }
  .c-low {
    border-color: var(--err);
  }
  .reason {
    margin: 6px 0 0;
    max-width: 280px;
  }
  .input.effort {
    width: 76px;
  }
  td select.input {
    min-width: 190px;
  }
  .deps {
    min-width: 150px;
  }
  .dep-toggle {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
  }
  .dep-menu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0;
    max-height: 200px;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .dep {
    display: block;
    color: var(--text-2, var(--text));
    margin-top: 2px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    display: flex;
    flex-direction: column;
    gap: 2px;
    white-space: nowrap;
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .gantt {
    display: grid;
    grid-template-columns: minmax(160px, 260px) 1fr;
    gap: 4px 10px;
    align-items: center;
  }
  .g-axis {
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding-bottom: 2px;
  }
  .g-label {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .g-track {
    position: relative;
    height: 20px;
    border-radius: 4px;
    background: repeating-linear-gradient(90deg, transparent 0, transparent calc(100% / var(--span) - 1px), var(--border) calc(100% / var(--span) - 1px), var(--border) calc(100% / var(--span)));
  }
  .g-bar {
    position: absolute;
    top: 2px;
    bottom: 2px;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    padding: 0 6px;
    box-sizing: border-box;
  }
  .g-bar span {
    font-size: 10.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .g-bar.critical {
    outline: 2px solid var(--err);
  }
  @media (max-width: 1000px) {
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .ai-grid {
      grid-template-columns: 1fr;
    }
    .dev {
      grid-template-columns: 1fr 1fr;
    }
  }
  .jira-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin: 4px 0 10px;
  }
  .input.tiny {
    width: 58px;
    padding: 2px 6px;
    font-size: 12px;
  }
  .tiny-select {
    width: auto;
    padding: 2px 6px;
    font-size: 12px;
  }
  .candidates {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .cand-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .cand-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 260px;
    overflow-y: auto;
    margin-top: 6px;
  }
  .cand {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 2fr auto auto;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .cand.in-team {
    opacity: 0.6;
  }
  .jira-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    white-space: nowrap;
  }
  .x-btn {
    display: inline-grid;
    place-items: center;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
  }
  .jira-load {
    white-space: nowrap;
  }
  .link-btn {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
  }
  .link-box {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 420px;
    margin: 0 0 8px 8px;
  }
  .user-opt {
    text-align: left;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    padding: 4px 8px;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .user-opt:hover {
    border-color: var(--accent);
  }
  .load-list {
    margin: 0 0 8px 8px;
    padding-left: 16px;
    max-height: 200px;
    overflow-y: auto;
  }
  .task-actions {
    display: flex;
    gap: 6px;
  }
  .dev-cell {
    min-width: 170px;
  }
  .rec-menu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    min-width: 280px;
  }
  .rec {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .rec > div {
    display: flex;
    flex-direction: column;
  }
  .rec.best strong {
    color: var(--ok);
  }
</style>
