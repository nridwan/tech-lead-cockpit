<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { releases } from '../lib/release/client';
  import type { Release, ReleaseReport } from '../lib/release/types';
  import { rosterState } from '../lib/roster/store.svelte';
  import { teams } from '../lib/teams/client';
  import type { TeamsChat } from '../lib/teams/types';

  /**
   * Asks a Teams group or channel to review the release MRs: pick MRs, chat, deadline and
   * reviewers, check the preview, then send (confirmed, recorded in the audit log).
   */
  let { open = $bindable(false), release, report, onshared }: { open: boolean; release: Release; report: ReleaseReport | null; onshared: (r: Release) => void } = $props();

  let chats = $state<TeamsChat[] | null>(null);
  let chatError = $state('');
  let chatQuery = $state('');
  let chatId = $state('');
  let picked = $state<string[]>([]);
  let deadline = $state('');
  let reviewers = $state<string[]>([]);
  let reviewerInput = $state('');
  let note = $state('');
  let reminder = $state(false);
  let preview = $state('');
  let sending = $state(false);
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const mrs = $derived([...release.services].sort((a, b) => a.order - b.order).flatMap((s) => s.mrs.map((m) => ({ service: s.name, mr: m, check: report?.mrs.find((c) => c.ref === m.ref) }))));
  /** Still waiting for review: open and below the approvals the release needs. */
  const waiting = $derived(mrs.filter((x) => !x.check || (x.check.state === 'opened' && x.check.approvals.count < release.minApprovals)).map((x) => x.mr.ref));
  const shownChats = $derived(
    (chats ?? [])
      .filter((c) => c.chatType !== 'oneOnOne' && c.chatType !== 'notes')
      .filter((c) => !chatQuery.trim() || c.title.toLowerCase().includes(chatQuery.trim().toLowerCase()))
      .slice(0, 50),
  );
  const chat = $derived((chats ?? []).find((c) => c.id === chatId));

  // Defaults each time the modal opens (not when data changes while it is open).
  $effect(() => {
    if (!open) return;
    untrack(() => {
      picked = waiting.length ? [...waiting] : mrs.map((x) => x.mr.ref);
      chatId = release.teamsChat?.id ?? '';
      reminder = release.shares.length > 0;
      void rosterState.load();
      void loadChats();
    });
  });

  async function loadChats() {
    if (chats) return;
    try {
      chats = await teams.chats();
      chatError = '';
    } catch (e) {
      chatError = (e as Error).message;
    }
  }

  $effect(() => {
    if (!open || !picked.length) return void (preview = '');
    const req = { mrRefs: [...picked], deadline, reviewers: [...reviewers], note, reminder };
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      preview = await releases.sharePreview(release.id, req).then((r) => r.text).catch((e) => `Pratinjau gagal: ${(e as Error).message}`);
    }, 300);
  });

  function toggle(ref: string) {
    picked = picked.includes(ref) ? picked.filter((r) => r !== ref) : [...picked, ref];
  }
  function addReviewer(name: string) {
    const n = name.trim();
    if (n && !reviewers.includes(n)) reviewers = [...reviewers, n];
    reviewerInput = '';
  }

  async function send() {
    const target = chat ? { id: chat.id, name: chat.title } : release.teamsChat?.id === chatId ? release.teamsChat : undefined;
    if (!target || !picked.length) return;
    const ok = await confirmDialog({ title: 'Kirim ke Teams?', message: `Pesan review ${picked.length} MR akan dikirim ke "${target.name}" atas nama akun Teams kamu.`, confirmText: 'Kirim' });
    if (!ok) return;
    sending = true;
    try {
      const r = await releases.share(release.id, target, { mrRefs: [...picked], deadline, reviewers: [...reviewers], note, reminder });
      onshared(r);
      toasts.show(`Permintaan review terkirim ke ${target.name}.`, 'ok', 3000);
      open = false;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      sending = false;
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const people = $derived(rosterState.members.filter((m) => m.active && !reviewers.includes(m.name)));
</script>

<Modal bind:open title="Share MR ke Teams" subtitle="Minta review MR ke {release.targetBranch} di grup atau channel Teams" width={820}>
  <div class="grid">
    <div class="col">
      <h4>MR ({picked.length} dipilih)</h4>
      <div class="mr-list">
        {#each mrs as x (x.mr.ref)}
          <label class="mr">
            <input type="checkbox" checked={picked.includes(x.mr.ref)} onchange={() => toggle(x.mr.ref)} />
            <span><strong>{x.service}</strong> · <span class="mono">{x.mr.ref}</span>{#if x.check && !x.check.error} <span class="muted small">· {x.check.state === 'merged' ? 'merged' : `${x.check.approvals.count}/${release.minApprovals} approval`}</span>{/if}</span>
          </label>
        {/each}
      </div>
      <div class="quick small">
        <button class="link-btn" onclick={() => (picked = [...waiting])}>Hanya yang menunggu review ({waiting.length})</button>
        <button class="link-btn" onclick={() => (picked = mrs.map((x) => x.mr.ref))}>Semua</button>
      </div>

      <h4>Grup / channel Teams</h4>
      {#if chatError}
        <p class="err small">{chatError} <a href="#/teams">Buka halaman Teams</a> untuk login.</p>
      {:else if !chats}
        <p class="muted small">Memuat chat Teams…</p>
      {:else}
        <input class="input" bind:value={chatQuery} placeholder="Cari nama grup atau channel" />
        <div class="chat-list">
          {#each shownChats as c (c.id)}
            <button class="chat" class:on={c.id === chatId} onclick={() => (chatId = c.id)}><Icon name={c.chatType === 'channel' ? 'hash' : 'teams'} size={12} /> {c.title}</button>
          {:else}
            <span class="muted small">Tidak ada grup yang cocok.</span>
          {/each}
        </div>
      {/if}

      <label class="field"><span>Tenggat review</span><input class="input" bind:value={deadline} placeholder="mis. Kamis 16.00" /></label>
      <div class="field">
        <span>Reviewer</span>
        <div class="chips">
          {#each reviewers as r (r)}<span class="chip">{r}<button class="x" onclick={() => (reviewers = reviewers.filter((x) => x !== r))} aria-label="Hapus {r}"><Icon name="x" size={10} /></button></span>{/each}
        </div>
        <div class="row">
          <input class="input" list="roster-people" bind:value={reviewerInput} placeholder="Nama (dari Daftar Tim atau ketik)" onkeydown={(e) => e.key === 'Enter' && addReviewer(reviewerInput)} />
          <datalist id="roster-people">{#each people as p (p.id)}<option value={p.name}></option>{/each}</datalist>
          <button class="btn btn-sm" onclick={() => addReviewer(reviewerInput)} disabled={!reviewerInput.trim()}>Tambah</button>
        </div>
        <span class="muted small">Nama ditulis tebal di pesan (bukan mention Teams).</span>
      </div>
      <label class="field"><span>Catatan</span><textarea class="input" rows="2" bind:value={note} placeholder="mis. Tolong fokus ke perubahan migrasi di core-payment"></textarea></label>
      <label class="check small"><input type="checkbox" bind:checked={reminder} /> Tandai sebagai pengingat</label>
    </div>

    <div class="col">
      <h4>Pratinjau</h4>
      <pre class="preview">{preview || 'Pilih minimal satu MR.'}</pre>
      {#if !report}<p class="muted small">Jalankan cek dulu supaya pesan memuat pipeline, approval, dan env/migrasi tiap MR.</p>{/if}
      {#if release.shares.length}
        <h4>Riwayat share</h4>
        <ul class="history small">
          {#each [...release.shares].reverse().slice(0, 6) as s (s.at)}<li>{fmt(s.at)} · {s.chatName} · {s.mrRefs.length} MR</li>{/each}
        </ul>
      {/if}
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-ghost btn-sm" onclick={() => (open = false)}>Batal</button>
    <button class="btn btn-primary btn-sm" onclick={send} disabled={sending || !picked.length || !chatId}><Icon name="send" size={13} /> {sending ? 'Mengirim…' : 'Kirim ke Teams'}</button>
  </div>
</Modal>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
  }
  .mr-list,
  .chat-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
  }
  .mr {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 4px 6px;
    font-size: 13px;
  }
  .chat {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .chat:hover {
    background: var(--surface-hover);
  }
  .chat.on {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .quick {
    display: flex;
    gap: 12px;
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font: inherit;
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
  .row {
    display: flex;
    gap: 6px;
  }
  .row > :global(.input) {
    flex: 1;
    width: auto;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface-hover);
    font-size: 12px;
  }
  .x {
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-3);
    display: inline-flex;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .preview {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: inherit;
    font-size: 12.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 380px;
    overflow: auto;
  }
  .history {
    margin: 0;
    padding-left: 16px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .small {
    font-size: 12px;
  }
  .err {
    color: var(--err);
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
