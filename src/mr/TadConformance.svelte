<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { toasts } from '../components/toast.svelte';
  import { api } from '../lib/api-base';
  import { renderPreview } from '../lib/markdown/preview';
  import type { AiSelection } from '../lib/ai/types';
  import type { MrDetail } from '../lib/gitlab/types';
  import {
    checkConformance,
    conformancePrompt,
    detailTaskSpec,
    findTasksForKeys,
    parseScopeTasks,
    type CheckStatus,
    type TaskMatch,
  } from '../lib/tad/task-links';
  import { drafts, draftTitle } from '../tad/drafts.svelte';
  import BackgroundReviewCard from './BackgroundReviewCard.svelte';
  import { reviews } from '../lib/review/client';
  import { sameReviewScope, type ReviewJob } from '../lib/review/types';

  let {
    mr,
    ai,
    onAiChange,
  }: {
    mr: MrDetail;
    ai: AiSelection;
    onAiChange?: (sel: AiSelection) => void;
  } = $props();

  const AI_CONF_KEY = 'tlc.ai.tadConformance';

  function readSavedAi(): AiSelection {
    try {
      const raw = localStorage.getItem(AI_CONF_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { provider: '9router', model: 'ag/claude-sonnet-4-6' };
  }

  let localAi = $state<AiSelection>(readSavedAi());

  // Sync if parent ai prop changes and user hasn't explicitly customized local preference
  $effect(() => {
    if (!localStorage.getItem(AI_CONF_KEY) && ai) {
      localAi = ai;
    }
  });

  function updateAi(sel: AiSelection) {
    localAi = sel;
    try {
      localStorage.setItem(AI_CONF_KEY, JSON.stringify(sel));
    } catch {}
    onAiChange?.(sel);
  }

  /** Upper bound for the diff sent to the AI. */
  const MAX_AI_DIFF = 120_000;

  const autoMatches = $derived(findTasksForKeys(drafts.drafts, mr.jiraKeys));

  // Manual pick when the MR has no Jira key (or the TAD doesn't list it yet).
  let pickDraft = $state('');
  let pickTask = $state('');
  const pickTasks = $derived(pickDraft ? parseScopeTasks(drafts.drafts.find((d) => d.id === pickDraft)?.markdown ?? '') : []);
  const manual = $derived.by((): TaskMatch | undefined => {
    const d = drafts.drafts.find((x) => x.id === pickDraft);
    const task = pickTasks.find((t) => t.title === pickTask);
    return d && task ? { draftId: d.id, task, spec: detailTaskSpec(d.markdown, task.title) } : undefined;
  });

  let chosen = $state(0);
  const match = $derived(autoMatches[chosen] ?? manual);
  const checks = $derived(match?.spec ? checkConformance(match.spec, match.task, mr) : []);

  // Module-level cache so results survive tab switches in MrReviewView
  const conformanceCache = new Map<string, string>();

  let aiText = $state('');
  let aiFor = $state('');
  let running = $state(false);
  let abort: AbortController | undefined;
  /** When the inline check started, to tell whether it is newer than a background one. */
  let aiAt = $state(0);

  // A different MR or task invalidates the AI result.
  const key = $derived(`${mr.ref}@${mr.headSha ?? ''}::${match?.draftId ?? ''}::${match?.task.title ?? ''}`);

  $effect(() => {
    if (key && conformanceCache.has(key)) {
      aiText = conformanceCache.get(key) ?? '';
      aiFor = key;
    } else if (aiFor !== key && !running) {
      aiText = '';
      aiFor = '';
    }
  });

  // ── Background check: runs in the connector (listed in Agent Tasks), survives leaving the page ──
  let bgJobs = $state<ReviewJob[]>([]);
  let bgFor = $state('');
  let bgBusy = $state(false);
  const bgJob = $derived(
    match && bgFor === mr.webUrl ? bgJobs.find((j) => sameReviewScope(j, 'tad', { draftId: match.draftId, title: match.task.title })) : undefined,
  );
  const bgRunning = $derived(bgJob?.status === 'running');
  /** A finished background check is shown unless an inline check of this task is newer (or running). */
  const bgShown = $derived.by(() => {
    if (bgJob?.status !== 'done' || !bgJob.reply) return false;
    const inline = aiFor === key && Boolean(aiText || running);
    return !inline || (!running && Date.parse(bgJob.finishedAt ?? bgJob.createdAt) > aiAt);
  });
  const resultText = $derived(bgShown ? (bgJob?.reply ?? '') : aiFor === key ? aiText : '');

  async function loadBgJobs(url: string) {
    try {
      const list = (await reviews.list(url)).filter((j) => j.kind === 'tad');
      if (mr.webUrl !== url) return;
      bgJobs = list;
      bgFor = url;
    } catch {
      /* connector unreachable: the inline check still works */
    }
  }

  $effect(() => {
    const url = mr.webUrl;
    void loadBgJobs(url);
  });

  $effect(() => {
    const url = mr.webUrl;
    if (!bgRunning) return;
    const t = setInterval(() => void loadBgJobs(url), 4000);
    return () => clearInterval(t);
  });

  async function runInBackground() {
    if (!match?.spec || bgRunning || bgBusy) return;
    const m = match;
    const draft = drafts.drafts.find((d) => d.id === m.draftId);
    bgBusy = true;
    try {
      const job = await reviews.start({
        kind: 'tad',
        mr: { ref: mr.ref, webUrl: mr.webUrl, title: mr.title, headSha: mr.headSha, jiraKeys: mr.jiraKeys },
        task: { draftId: m.draftId, title: m.task.title, ...(draft ? { tadTitle: draftTitle(draft) } : {}) },
        prompt: conformancePrompt(m.spec!),
        context: diffContext(mr),
        ai: localAi,
      });
      bgJobs = [job, ...bgJobs.filter((j) => j.id !== job.id)];
      bgFor = mr.webUrl;
      toasts.show('Cek TAD berjalan di background. Boleh pindah halaman; hasilnya muncul di sini dan di Agent Tasks.', 'ok', 6000);
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      bgBusy = false;
    }
  }

  async function cancelBackground() {
    const job = bgJob;
    if (!job) return;
    bgBusy = true;
    try {
      await reviews.cancel(job.id);
      await loadBgJobs(job.mr.webUrl);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      bgBusy = false;
    }
  }

  function diffContext(d: MrDetail): string {
    let body = `MR: ${d.ref} — ${d.title}\nBranch: ${d.sourceBranch} → ${d.targetBranch}\n\n`;
    let skipped = 0;
    for (const f of d.changes) {
      const block = `### ${f.newPath} (+${f.additions} −${f.deletions})\n${f.truncated ? '(diff tidak tersedia)\n' : '```diff\n' + f.diff + '\n```\n'}\n`;
      if (body.length + block.length > MAX_AI_DIFF) {
        skipped++;
        continue;
      }
      body += block;
    }
    return skipped ? `${body}\n(${skipped} file lain tidak disertakan karena batas ukuran.)` : body;
  }

  async function runAi() {
    if (!match?.spec || running) return;
    running = true;
    aiText = '';
    aiFor = key;
    aiAt = Date.now();
    conformanceCache.set(key, '');
    abort = new AbortController();
    try {
      const res = await fetch(api('/api/connector/ai/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
        body: JSON.stringify({
          prompt: conformancePrompt(match.spec),
          context: diffContext(mr),
          mode: 'code-review',
          ai: localAi,
        }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failure = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const payload = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
          if (!payload || payload === '[DONE]') continue;
          let data: { kind?: string; text?: string; reply?: string; error?: string };
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.kind === 'text' && data.text) {
            aiText += (aiText ? '\n' : '') + data.text;
            conformanceCache.set(key, aiText);
          } else if (data.kind === 'done') {
            aiText = data.reply ?? aiText;
            conformanceCache.set(key, aiText);
          } else if (data.kind === 'error') {
            failure = data.error ?? 'AI gagal.';
          }
        }
      }
      if (failure) throw new Error(failure);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        aiText = `⚠️ Pengecekan gagal: ${(e as Error).message}`;
        conformanceCache.set(key, aiText);
        toasts.show((e as Error).message, 'err');
      }
    } finally {
      running = false;
    }
  }

  const ICON: Record<CheckStatus, { icon: 'check' | 'alert' | 'error' | 'eye'; tone: string; label: string }> = {
    ok: { icon: 'check', tone: 'ok', label: 'Sesuai' },
    warn: { icon: 'alert', tone: 'warn', label: 'Perlu dicek' },
    missing: { icon: 'error', tone: 'err', label: 'Belum ada' },
    info: { icon: 'eye', tone: 'muted', label: 'Info' },
  };
</script>

<div class="conf">
  {#if autoMatches.length > 1}
    <div class="pick">
      <span class="muted small">Beberapa task TAD cocok dengan Jira key MR ini:</span>
      <select class="input" bind:value={chosen}>
        {#each autoMatches as m, i (i)}
          <option value={i}>{m.task.title}</option>
        {/each}
      </select>
    </div>
  {/if}

  {#if !match}
    <div class="empty">
      <p>
        {#if mr.jiraKeys.length}
          Jira key <strong>{mr.jiraKeys.join(', ')}</strong> belum tercantum di kolom Jira Task pada TAD mana pun.
        {:else}
          MR ini tidak menyebut Jira key di branch, judul, deskripsi, maupun commit.
        {/if}
        Pilih task TAD-nya secara manual:
      </p>
      <div class="pick">
        <select class="input" bind:value={pickDraft} onchange={() => (pickTask = '')}>
          <option value="">Pilih TAD…</option>
          {#each drafts.sorted as d (d.id)}
            <option value={d.id}>{draftTitle(d)}</option>
          {/each}
        </select>
        <select class="input" bind:value={pickTask} disabled={!pickTasks.length}>
          <option value="">{pickDraft && !pickTasks.length ? 'Development Scope kosong' : 'Pilih task…'}</option>
          {#each pickTasks as t (t.title)}
            <option value={t.title}>{t.title}</option>
          {/each}
        </select>
      </div>
    </div>
  {:else}
    <header class="task">
      <span class="muted small">Task TAD · {draftTitle(drafts.drafts.find((d) => d.id === match.draftId)!)}</span>
      <a href="#/tad/{match.draftId}" class="task-title" onclick={() => drafts.select(match.draftId)}>{match.task.title}</a>
      <span class="muted small">
        Service: {match.task.service || '—'}{match.task.jiraKeys.length ? ` · Jira: ${match.task.jiraKeys.join(', ')}` : ''}
      </span>
    </header>

    {#if !match.spec}
      <p class="warn-box"><Icon name="alert" size={14} /> Detail Task untuk task ini tidak ditemukan di TAD, jadi spesifikasinya belum bisa dibandingkan.</p>
    {:else}
      <section>
        <h4>Cek otomatis</h4>
        <ul class="checks">
          {#each checks as c, i (i)}
            {@const s = ICON[c.status]}
            <li class="tone-{s.tone}">
              <span class="ic"><Icon name={s.icon} size={14} /></span>
              <span class="lbl">{c.label}</span>
              <span class="det">{c.detail}</span>
            </li>
          {/each}
        </ul>
      </section>

      <section>
        <div class="ai-config-card">
          <div class="config-row">
            <div class="config-label">
              <Icon name="bot" size={14} />
              <span>Model AI:</span>
            </div>
            <div class="picker-box">
              <AiPicker value={localAi} onchange={updateAi} disabled={running} />
            </div>
          </div>
        </div>

        <div class="ai-head">
          <h4>Cek dengan AI</h4>
          <div class="ai-actions">
            {#if running}
              <button class="btn btn-sm" onclick={() => abort?.abort()}><Icon name="x" size={12} /> Hentikan</button>
            {:else}
              <button class="btn btn-primary btn-sm" onclick={runAi}>
                <Icon name="sparkles" size={13} /> {resultText ? 'Cek ulang (Langsung)' : 'Bandingkan diff (Langsung)'}
              </button>
            {/if}
            <button class="btn btn-sm" onclick={runInBackground} disabled={bgRunning || bgBusy} title="Cek dijalankan connector di background dan tercatat di Agent Tasks; boleh pindah halaman">
              <Icon name="bot" size={13} /> {bgRunning ? 'Berjalan di background…' : 'Jalankan di background'}
            </button>
          </div>
        </div>
        <p class="muted small">AI membandingkan diff dengan Description, Endpoint, Method, Header, Payload, dan Response task ini, lalu memberi checklist ✓ / ⚠ / ✗ beserta bukti.</p>
        {#if bgJob}
          <BackgroundReviewCard job={bgJob} headSha={mr.headSha} busy={bgBusy} oncancel={cancelBackground} />
        {/if}
        {#if resultText}
          {#if bgShown}<p class="muted small">Hasil cek background di atas{bgJob?.ai.model ? ` (${bgJob.ai.model})` : ''}.</p>{/if}
          <div class="md">{@html renderPreview(resultText).html}</div>
        {:else if running}
          <p class="muted">Membandingkan… (1–3 menit untuk MR besar)</p>
        {/if}
      </section>

      <details>
        <summary>Spesifikasi task dari TAD</summary>
        <pre class="spec">{match.spec.text}</pre>
      </details>
    {/if}
  {/if}

</div>

<style>
  .conf {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .small {
    font-size: 12.5px;
  }
  .pick {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pick select {
    flex: 1 1 260px;
    min-width: 0;
  }
  .empty p {
    margin: 0 0 10px;
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--accent-soft);
  }
  .task-title {
    font-weight: 500;
    color: var(--accent);
    text-decoration: none;
  }
  h4 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 500;
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .checks li {
    display: grid;
    grid-template-columns: 20px minmax(120px, max-content) 1fr;
    gap: 8px;
    align-items: start;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    font-size: 13px;
  }
  .ic {
    display: inline-flex;
    padding-top: 2px;
  }
  .lbl {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .det {
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .tone-ok .ic {
    color: var(--ok);
  }
  .tone-warn .ic {
    color: var(--warn);
  }
  .tone-err .ic {
    color: var(--err);
  }
  .tone-muted .ic {
    color: var(--text-3);
  }

  .ai-config-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    margin-bottom: 12px;
  }
  .config-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .config-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  .picker-box {
    flex: 1 1 300px;
    min-width: 0;
  }

  .ai-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-head h4 {
    margin: 0;
  }
  .ai-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .md {
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--surface-2);
    font-size: 13.5px;
    line-height: 1.6;
    overflow-x: auto;
  }
  .warn-box {
    display: flex;
    gap: 6px;
    margin: 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 13px;
  }
  details summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--text-2);
  }
  .spec {
    margin: 8px 0 0;
    padding: 12px;
    max-height: 360px;
    overflow: auto;
    border-radius: 10px;
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
