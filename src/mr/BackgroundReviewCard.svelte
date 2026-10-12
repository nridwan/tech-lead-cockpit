<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { ReviewJob } from '../lib/review/types';

  let {
    job,
    headSha,
    busy = false,
    oncancel,
  }: {
    job: ReviewJob;
    /** Current head of the MR; a review of an older head is marked as outdated. */
    headSha?: string;
    busy?: boolean;
    oncancel?: () => void;
  } = $props();

  const LABEL: Record<ReviewJob['status'], string> = { running: 'Berjalan', done: 'Selesai', error: 'Gagal', cancelled: 'Dibatalkan' };
  const CHIP: Record<ReviewJob['status'], string> = { running: 'chip-accent', done: 'chip-ok', error: 'chip-err', cancelled: '' };
  const outdated = $derived(Boolean(job.mr.headSha && headSha && job.mr.headSha !== headSha));
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
</script>

<div class="bg-card" class:running={job.status === 'running'}>
  <span class="ic"><Icon name="bot" size={16} /></span>
  <div class="info">
    <div class="title">
      <strong>Review di background</strong>
      <span class="chip {CHIP[job.status]}">{LABEL[job.status]}</span>
      {#if outdated}<span class="chip chip-warn" title="Commit {job.mr.headSha?.slice(0, 8)}">Diff sudah berubah sejak review ini</span>{/if}
    </div>
    <div class="meta muted">
      {job.ai.provider}{job.ai.model ? ` / ${job.ai.model}` : ''} · mulai {time(job.createdAt)}{job.finishedAt ? ` · selesai ${time(job.finishedAt)}` : ''}
    </div>
    {#if job.status === 'running'}
      <div class="meta">{job.progress || 'Mereview diff…'} <span class="muted">Boleh tinggalkan halaman ini; hasilnya muncul di sini dan di Agent Tasks.</span></div>
    {:else if job.error && job.status === 'error'}
      <div class="meta err">{job.error}</div>
    {/if}
  </div>
  <div class="actions">
    {#if job.status === 'running' && oncancel}
      <button class="btn btn-sm" disabled={busy} onclick={oncancel}><Icon name="x" size={12} /> Batalkan</button>
    {/if}
    <a class="btn btn-sm" href="#/agents" title="Buka di Agent Tasks"><Icon name="external" size={12} /> Agent Tasks</a>
  </div>
</div>

<style>
  .bg-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: 4px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .bg-card.running {
    border-left-color: var(--accent);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 8px;
    background: var(--surface);
    color: var(--accent);
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13.5px;
  }
  .meta {
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .err {
    color: var(--err);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
</style>
