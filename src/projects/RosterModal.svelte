<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { ESTIMATE_ROLES, ROLE_LABELS, type EstimateRole, type JiraCandidate } from '../lib/estimate/types';
  import { jira } from '../lib/jira/client';
  import type { JiraUser } from '../lib/jira/types';
  import { roster } from '../lib/roster/client';
  import type { GitAuthor, LeaveRange, TeamMember } from '../lib/roster/types';

  /**
   * The team roster: everyone who can be staffed on a project, kept once for every estimate.
   * Role, Jira account, git e-mails (for the familiarity signal), capacity and leave.
   */
  let {
    open = $bindable(false),
    members = $bindable([]),
    jiraProjects = [],
    excludeKeys = [],
    servicesRoot,
  }: {
    open: boolean;
    members: TeamMember[];
    /** Jira projects of the current estimate, for "Impor dari Jira". */
    jiraProjects?: string[];
    excludeKeys?: string[];
    servicesRoot?: string;
  } = $props();

  type Draft = { id?: string; name: string; role: EstimateRole; capacity: number; jira?: { accountId: string; displayName: string }; gitEmails: string[]; leaves: LeaveRange[]; active: boolean; note: string };
  const blank = (): Draft => ({ name: '', role: 'BACKEND', capacity: 1, gitEmails: [], leaves: [], active: true, note: '' });

  let editing = $state<Draft | null>(null);
  let saving = $state(false);
  let filter = $state('');

  // Jira link search inside the form.
  let userQuery = $state('');
  let userResults = $state<JiraUser[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  // Git authors (to pick e-mails).
  let authors = $state<GitAuthor[] | null>(null);
  let authorsError = $state('');
  let emailQuery = $state('');

  // Jira import.
  let candidates = $state<JiraCandidate[] | null>(null);
  let loadingCandidates = $state(false);
  let candidateRole = $state<Record<string, EstimateRole>>({});

  let leaveStart = $state('');
  let leaveEnd = $state('');
  let leaveNote = $state('');

  const shown = $derived(
    members.filter((m) => {
      const q = filter.trim().toLowerCase();
      return !q || m.name.toLowerCase().includes(q) || ROLE_LABELS[m.role].toLowerCase().includes(q) || m.gitEmails.some((e) => e.includes(q));
    }),
  );
  const today = new Date().toISOString().slice(0, 10);

  function edit(m?: TeamMember) {
    editing = m ? { id: m.id, name: m.name, role: m.role, capacity: m.capacity, jira: m.jira, gitEmails: [...m.gitEmails], leaves: m.leaves.map((l) => ({ ...l })), active: m.active, note: m.note ?? '' } : blank();
    userQuery = '';
    userResults = [];
    emailQuery = '';
    leaveStart = leaveEnd = leaveNote = '';
    void loadAuthors();
  }

  async function loadAuthors() {
    if (authors || authorsError) return;
    try {
      authors = await roster.gitAuthors(servicesRoot);
    } catch (e) {
      authorsError = (e as Error).message;
    }
  }

  /** Authors whose name or e-mail shares a word with the member's name, most active first. */
  const suggested = $derived.by(() => {
    if (!editing || !authors) return [];
    const q = emailQuery.trim().toLowerCase();
    const tokens = editing.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const taken = new Set(editing.gitEmails);
    return authors
      .filter((a) => !taken.has(a.email))
      .filter((a) => (q ? a.email.includes(q) || a.name.toLowerCase().includes(q) : tokens.some((t) => a.name.toLowerCase().includes(t) || a.email.split('@')[0].includes(t))))
      .slice(0, 8);
  });

  function addEmail(email: string) {
    if (!editing) return;
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) return void toasts.show('Email git tidak valid.', 'err', 2500);
    if (!editing.gitEmails.includes(e)) editing.gitEmails = [...editing.gitEmails, e];
    emailQuery = '';
  }

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

  function linkJira(u: JiraUser) {
    if (!editing) return;
    editing.jira = { accountId: u.accountId, displayName: u.displayName };
    if (!editing.name.trim()) editing.name = u.displayName;
    if (u.emailAddress && !editing.gitEmails.length && authors?.some((a) => a.email === u.emailAddress!.toLowerCase())) editing.gitEmails = [u.emailAddress.toLowerCase()];
    userQuery = '';
    userResults = [];
  }

  function addLeave() {
    if (!editing || !leaveStart) return;
    const end = leaveEnd || leaveStart;
    if (end < leaveStart) return void toasts.show('Tanggal akhir cuti sebelum tanggal mulai.', 'err', 2500);
    editing.leaves = [...editing.leaves, { start: leaveStart, end, ...(leaveNote.trim() ? { note: leaveNote.trim() } : {}) }].sort((a, b) => a.start.localeCompare(b.start));
    leaveStart = leaveEnd = leaveNote = '';
  }

  async function save() {
    if (!editing) return;
    saving = true;
    try {
      members = await roster.save({ ...editing, note: editing.note.trim() || undefined });
      toasts.show(`${editing.name} tersimpan di daftar tim.`, 'ok', 2000);
      editing = null;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 5000);
    } finally {
      saving = false;
    }
  }

  async function remove(m: TeamMember) {
    const ok = await confirmDialog({ title: 'Hapus dari daftar tim?', message: `${m.name} tidak akan direkomendasikan lagi. Developer di proyek yang sudah memakainya tetap ada, tapi cuti dan alokasi proyek lain tidak lagi dihitung.`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    try {
      members = await roster.remove(m.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function toggleActive(m: TeamMember) {
    try {
      members = await roster.save({ ...m, active: !m.active });
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function loadCandidates() {
    if (!jiraProjects.length) return void toasts.show('Proyek ini belum punya Jira key, jadi project Jira-nya tidak diketahui. Tambahkan anggota manual lalu tautkan Jira-nya.', 'info', 5000);
    loadingCandidates = true;
    try {
      candidates = await jira.candidates(jiraProjects, excludeKeys);
    } catch (e) {
      toasts.show(`Jira: ${(e as Error).message}`, 'err');
    } finally {
      loadingCandidates = false;
    }
  }

  async function importCandidate(c: JiraCandidate) {
    try {
      members = await roster.save({ name: c.displayName, role: candidateRole[c.accountId] ?? 'BACKEND', jira: { accountId: c.accountId, displayName: c.displayName }, gitEmails: c.email && authors?.some((a) => a.email === c.email!.toLowerCase()) ? [c.email.toLowerCase()] : [], capacity: 1, leaves: [], active: true });
      toasts.show(`${c.displayName} ditambahkan ke daftar tim.`, 'ok', 2000);
    } catch (e) {
      toasts.show((e as Error).message, 'err', 5000);
    }
  }

  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const upcomingLeaves = (m: TeamMember) => m.leaves.filter((l) => l.end >= today);
</script>

<Modal bind:open title="Daftar Tim" subtitle="Siapa saja yang bisa dialokasikan ke proyek. Diisi sekali, dipakai semua estimasi." width={820}>
  <div class="wrap">
    {#if editing}
      <section class="form">
        <h4>{editing.id ? `Ubah ${editing.name}` : 'Anggota baru'}</h4>
        <div class="grid">
          <label class="field"><span>Nama</span><input class="input" bind:value={editing.name} placeholder="Nama lengkap" /></label>
          <label class="field">
            <span>Role</span>
            <select class="input" bind:value={editing.role}>
              {#each ESTIMATE_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
            </select>
          </label>
          <label class="field" title="Porsi hari kerja yang tersedia untuk pekerjaan proyek (sisanya untuk support, meeting, dsb.)">
            <span>Kapasitas</span>
            <span class="row"><input class="input num" type="number" min="10" max="100" step="10" value={Math.round(editing.capacity * 100)} oninput={(e) => editing && (editing.capacity = Math.min(1, Math.max(0.1, Number(e.currentTarget.value) / 100 || 1)))} />%</span>
          </label>
        </div>

        <div class="field">
          <span>Akun Jira</span>
          {#if editing.jira}
            <span class="chip-row"><span class="chip"><Icon name="jira" size={11} /> {editing.jira.displayName}</span><button class="link-btn small" onclick={() => editing && (editing.jira = undefined)}>Lepas</button></span>
          {:else}
            <input class="input" value={userQuery} oninput={(e) => searchUsers(e.currentTarget.value)} placeholder="Cari nama / email di Jira (untuk beban tiket)" />
            {#each userResults as u (u.accountId)}
              <button class="opt" onclick={() => linkJira(u)}>{u.displayName}{u.emailAddress ? ` · ${u.emailAddress}` : ''}</button>
            {/each}
          {/if}
        </div>

        <div class="field">
          <span>Email git <span class="muted">(untuk melihat siapa yang paling sering commit di repo proyek)</span></span>
          <span class="chip-row">
            {#each editing.gitEmails as e (e)}
              <span class="chip mono">{e}<button class="x" onclick={() => editing && (editing.gitEmails = editing.gitEmails.filter((x) => x !== e))} aria-label="Hapus {e}"><Icon name="x" size={10} /></button></span>
            {:else}
              <span class="muted small">Belum ada.</span>
            {/each}
          </span>
          <span class="row">
            <input class="input" bind:value={emailQuery} placeholder="Cari author git atau ketik email" onkeydown={(e) => e.key === 'Enter' && emailQuery.includes('@') && addEmail(emailQuery)} />
            <button class="btn btn-sm" onclick={() => addEmail(emailQuery)} disabled={!emailQuery.includes('@')}>Tambah</button>
          </span>
          {#if authorsError}
            <span class="muted small">Author git tidak bisa dibaca: {authorsError}</span>
          {:else if suggested.length}
            <span class="chip-row">
              {#each suggested as a (a.email)}
                <button class="sugg" onclick={() => addEmail(a.email)} title="{a.commits} commit di {a.repos.join(', ')}"><Icon name="plus" size={10} /> {a.name} · <span class="mono">{a.email}</span></button>
              {/each}
            </span>
          {/if}
        </div>

        <div class="field">
          <span>Cuti</span>
          {#each editing.leaves as l, i (`${l.start}-${l.end}-${i}`)}
            <span class="chip-row"><span class="chip">{fmt(l.start)}{l.end !== l.start ? ` – ${fmt(l.end)}` : ''}{l.note ? ` · ${l.note}` : ''}</span><button class="link-btn small" onclick={() => editing && (editing.leaves = editing.leaves.filter((_, j) => j !== i))}>Hapus</button></span>
          {/each}
          <span class="row">
            <input class="input" type="date" bind:value={leaveStart} aria-label="Mulai cuti" />
            <input class="input" type="date" bind:value={leaveEnd} min={leaveStart} aria-label="Akhir cuti" />
            <input class="input" bind:value={leaveNote} placeholder="Keterangan (opsional)" />
            <button class="btn btn-sm" onclick={addLeave} disabled={!leaveStart}>Tambah</button>
          </span>
        </div>

        <label class="field"><span>Catatan</span><input class="input" bind:value={editing.note} placeholder="mis. fokus payment, sedang onboarding" /></label>
        <label class="check"><input type="checkbox" bind:checked={editing.active} /> Aktif (direkomendasikan untuk proyek)</label>

        <div class="actions">
          <button class="btn btn-ghost btn-sm" onclick={() => (editing = null)} disabled={saving}>Batal</button>
          <button class="btn btn-primary btn-sm" onclick={save} disabled={saving || !editing.name.trim()}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
        </div>
      </section>
    {:else}
      <div class="toolbar">
        <input class="input search" bind:value={filter} placeholder="Cari nama, role, atau email" />
        <button class="btn btn-sm" onclick={loadCandidates} disabled={loadingCandidates} title="Orang yang bisa di-assign di project Jira {jiraProjects.join(', ') || '-'}"><Icon name="jira" size={12} /> {loadingCandidates ? 'Memuat…' : 'Impor dari Jira'}</button>
        <button class="btn btn-primary btn-sm" onclick={() => edit()}><Icon name="plus" size={12} /> Tambah anggota</button>
      </div>

      {#if candidates}
        <div class="cands">
          <div class="cands-head"><strong class="small">Dari Jira ({jiraProjects.join(', ')})</strong><button class="btn btn-ghost btn-sm" onclick={() => (candidates = null)} aria-label="Tutup"><Icon name="x" size={12} /></button></div>
          {#each candidates as c (c.accountId)}
            {@const has = members.some((m) => m.jira?.accountId === c.accountId)}
            <div class="cand">
              <span class="grow">{c.displayName}{c.email ? ` · ${c.email}` : ''}</span>
              {#if has}
                <span class="chip">sudah di daftar</span>
              {:else}
                <select class="input tiny" value={candidateRole[c.accountId] ?? 'BACKEND'} onchange={(e) => (candidateRole[c.accountId] = e.currentTarget.value as EstimateRole)} aria-label="Role {c.displayName}">
                  {#each ESTIMATE_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
                </select>
                <button class="btn btn-sm" onclick={() => importCandidate(c)}><Icon name="plus" size={12} /> Tambah</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if !members.length}
        <div class="empty">
          <Icon name="user" size={24} />
          <p>Daftar tim masih kosong. Tambahkan anggota satu per satu, atau impor dari Jira lalu lengkapi role dan email git-nya.</p>
        </div>
      {:else}
        <ul class="list">
          {#each shown as m (m.id)}
            <li class:inactive={!m.active}>
              <div class="who">
                <strong>{m.name}</strong>
                <span class="role r-{m.role.toLowerCase()}">{ROLE_LABELS[m.role]}</span>
                {#if !m.active}<span class="chip">nonaktif</span>{/if}
              </div>
              <div class="meta small muted">
                <span>{m.jira ? `Jira: ${m.jira.displayName}` : 'Jira belum ditautkan'}</span>
                <span>{m.gitEmails.length ? `${m.gitEmails.length} email git` : 'email git belum diisi'}</span>
                {#if m.capacity < 1}<span>kapasitas {Math.round(m.capacity * 100)}%</span>{/if}
                {#each upcomingLeaves(m).slice(0, 2) as l (l.start)}<span>cuti {fmt(l.start)}{l.end !== l.start ? `–${fmt(l.end)}` : ''}</span>{/each}
              </div>
              <div class="row-actions">
                <button class="btn btn-ghost btn-sm" onclick={() => toggleActive(m)}>{m.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                <button class="btn btn-ghost btn-sm" onclick={() => edit(m)}><Icon name="edit" size={12} /> Ubah</button>
                <button class="btn btn-ghost btn-sm" onclick={() => remove(m)} aria-label="Hapus {m.name}"><Icon name="trash" size={12} /></button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .toolbar,
  .row,
  .actions,
  .cand,
  .cands-head,
  .chip-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .row > :global(.input) {
    flex: 1 1 140px;
    width: auto;
    min-width: 0;
  }
  .row > :global(.input.num) {
    flex: 0 0 80px;
  }
  .row > :global(.btn) {
    flex: none;
  }
  .search,
  .grow {
    flex: 1;
    min-width: 160px;
  }
  .actions {
    justify-content: flex-end;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form h4 {
    margin: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .field > span:first-child {
    font-weight: 600;
  }
  .num {
    width: 80px;
  }
  .tiny {
    width: auto;
    padding: 2px 6px;
    font-size: 12px;
  }
  .opt,
  .sugg {
    text-align: left;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .opt:hover,
  .sugg:hover {
    background: var(--surface-hover);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface-hover);
    font-size: 11.5px;
  }
  .x {
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-3);
    display: inline-flex;
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .cands {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    max-height: 260px;
    overflow: auto;
    font-size: 13px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px;
    color: var(--text-3);
    text-align: center;
    font-size: 13px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .list li {
    display: grid;
    grid-template-columns: minmax(180px, 1.2fr) 2fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }
  .list li + li {
    border-top: 1px solid var(--border);
  }
  .list li.inactive {
    opacity: 0.6;
  }
  .who,
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }
  .role {
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--accent-soft);
  }
  .row-actions {
    display: flex;
    gap: 2px;
  }
  .small {
    font-size: 12px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  @media (max-width: 720px) {
    .grid,
    .list li {
      grid-template-columns: 1fr;
    }
  }
</style>
