<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { renderPreview } from '../lib/markdown/preview';
  import { reviews } from '../lib/review/client';
  import type { ReviewJob } from '../lib/review/types';

  let { reviewId, onchange }: { reviewId: string; onchange?: () => void } = $props();

  const POLL_MS = 3_000;
  let job = $state<ReviewJob | null>(null);
  let error = $state('');

  async function load() {
    try {
      job = await reviews.get(reviewId);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void reviewId;
    void load();
  });

  // Poll while the review runs; tell the list when it finishes.
  $effect(() => {
    if (job?.status !== 'running') return;
    const t = setInterval(async () => {
      await load();
      if (job?.status !== 'running') onchange?.();
    }, POLL_MS);
    return () => clearInterval(t);
  });

  function copy() {
    if (!job?.reply) return;
    void navigator.clipboard.writeText(job.reply);
    toasts.show('Hasil review disalin.', 'ok');
  }
</script>

<div class="result">
  {#if error}
    <p class="err small">{error}</p>
  {:else if !job}
    <p class="muted small">Memuat hasil…</p>
  {:else if job.status === 'running'}
    <p class="muted small">{job.progress || 'Mereview diff…'}</p>
  {:else if job.reply}
    <div class="bar">
      <span class="muted small">{job.kind === 'tad' ? `Cek TAD · ${job.task?.title ?? ''}` : 'Review MR'} · {job.mr.ref}</span>
      <button class="btn btn-sm btn-ghost" onclick={copy}><Icon name="copy" size={13} /> Salin</button>
    </div>
    <div class="md">{@html renderPreview(job.reply).html}</div>
  {:else}
    <p class="muted small">{job.error ?? 'Tidak ada hasil.'}</p>
  {/if}
</div>

<style>
  .result {
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    max-height: 520px;
    overflow: auto;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .small {
    font-size: 12.5px;
    margin: 0;
  }
  .err {
    color: var(--err);
  }
</style>
