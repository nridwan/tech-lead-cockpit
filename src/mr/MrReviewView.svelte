<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { toasts } from '../components/toast.svelte';
  import { renderPreview } from '../lib/markdown/preview';
  import { api } from '../lib/api-base';
  import { gitlab, OPEN_MR_KEY } from '../lib/gitlab/client';
  import { jira } from '../lib/jira/client';
  import { DEFAULT_AI_SELECTION, type AiSelection } from '../lib/ai/types';
  import {
    type GitLabStatus,
    type MrDetail,
    type MrScope,
    type MrSummary,
    type PipelineStatus,
    type ReviewStrictness,
    REVIEW_STRICTNESS_OPTIONS,
    buildMrReviewPrompt,
  } from '../lib/gitlab/types';
  import DiffFile from './DiffFile.svelte';
  import TadConformance from './TadConformance.svelte';
  import JiraPanel from './JiraPanel.svelte';
  import BackgroundReviewCard from './BackgroundReviewCard.svelte';
  import { reviews } from '../lib/review/client';
  import type { ReviewJob } from '../lib/review/types';
  import { verdictOf, type ReviewVerdict } from '../lib/tad/task-links';

  const AI_KEY = 'tlc.ai.mrReview';
  const RECENT_KEY = 'tlc.mr.recent';
  const STRICTNESS_KEY = 'tlc.mr.strictness';
  const CUSTOM_INSTRUCTION_KEY = 'tlc.mr.customInstruction';
  /** Upper bound for the diff sent to the AI. */
  const MAX_AI_DIFF = 150_000;

  type Recent = { url: string; ref: string; title: string };

  function readJson<T>(key: string, fallback: T, store: Storage = localStorage): T {
    try {
      return (JSON.parse(store.getItem(key) ?? 'null') as T) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* convenience only */
    }
  }

  let status = $state<GitLabStatus | null>(null);
  let scope = $state<MrScope | 'recent'>('reviewer');
  let lists = $state<Partial<Record<MrScope, MrSummary[]>>>({});
  let loadingList = $state(false);
  let listError = $state('');
  let query = $state('');
  let pasteUrl = $state('');
  let recent = $state<Recent[]>(readJson(RECENT_KEY, []));

  let mr = $state<MrDetail | null>(null);
  let loadingMr = $state(false);
  let tab = $state<'overview' | 'files' | 'commits' | 'ai' | 'tad'>('overview');
  /** Drives the suggested Jira move: merged MRs move on regardless of the review text. */
  const reviewVerdict = $derived.by((): ReviewVerdict | undefined => {
    if (mr?.state === 'merged') return 'merged';
    return reviewText ? verdictOf(reviewText) : undefined;
  });
  let jiraBase = $state<string | undefined>();
  let fileFilter = $state('');
  let mrWrapFiles = $state(false);

  let ai = $state<AiSelection>(readJson(AI_KEY, DEFAULT_AI_SELECTION));
  let strictness = $state<ReviewStrictness>(readJson(STRICTNESS_KEY, 'standard'));
  let customInstruction = $state<string>(readJson(CUSTOM_INSTRUCTION_KEY, ''));

  function setStrictness(s: ReviewStrictness) {
    strictness = s;
    writeJson(STRICTNESS_KEY, s);
  }

  $effect(() => {
    writeJson(CUSTOM_INSTRUCTION_KEY, customInstruction);
  });

  const activeStrictnessOption = $derived(
    REVIEW_STRICTNESS_OPTIONS.find((o) => o.id === strictness) ?? REVIEW_STRICTNESS_OPTIONS[1]
  );

  let aiText = $state('');
  let aiRunning = $state(false);
  let aiFor = $state<string | null>(null);
  let aiAbort: AbortController | undefined;
  /** When the inline review started, to tell whether it is newer than a background one. */
  let aiAt = $state(0);

  // ── Background review: runs in the connector (listed in Agent Tasks), survives leaving the page ──
  let bgJobs = $state<ReviewJob[]>([]);
  let bgFor = $state('');
  let bgBusy = $state(false);
  const bgJob = $derived(mr && bgFor === mr.webUrl ? bgJobs.find((j) => j.kind === 'mr') : undefined);
  const bgRunning = $derived(bgJob?.status === 'running');
  /** A finished background review is shown unless an inline review of this MR is newer (or running). */
  const bgShown = $derived.by(() => {
    if (bgJob?.status !== 'done' || !bgJob.reply) return false;
    const inline = Boolean(mr && aiFor === mr.ref && (aiText || aiRunning));
    return !inline || (!aiRunning && Date.parse(bgJob.finishedAt ?? bgJob.createdAt) > aiAt);
  });
  const reviewText = $derived(bgShown ? (bgJob?.reply ?? '') : mr && aiFor === mr.ref ? aiText : '');

  async function loadBgJobs(url: string) {
    try {
      const list = await reviews.list(url);
      if (mr?.webUrl !== url) return;
      const before = bgFor === url ? bgJobs.find((j) => j.kind === 'mr') : undefined;
      const after = list.find((j) => j.kind === 'mr');
      if (before?.status === 'running' && after?.id === before.id && after.status !== 'running') {
        toasts.show(after.status === 'done' ? `Review background ${after.mr.ref} selesai.` : `Review background ${after.mr.ref}: ${after.error ?? after.status}`, after.status === 'done' ? 'ok' : 'err');
      }
      bgJobs = list;
      bgFor = url;
    } catch {
      /* connector unreachable: the inline review still works */
    }
  }

  $effect(() => {
    const url = mr?.webUrl;
    if (url) void loadBgJobs(url);
  });

  // Poll while this MR has a review running in the background (the TAD check polls its own).
  $effect(() => {
    const url = mr?.webUrl;
    if (!url || !bgRunning) return;
    const t = setInterval(() => void loadBgJobs(url), 4000);
    return () => clearInterval(t);
  });

  async function runReviewInBackground() {
    if (!mr || bgRunning || bgBusy) return;
    const d = mr;
    bgBusy = true;
    try {
      const job = await reviews.start({
        kind: 'mr',
        mr: { ref: d.ref, webUrl: d.webUrl, title: d.title, headSha: d.headSha, jiraKeys: d.jiraKeys },
        prompt: buildMrReviewPrompt({ strictness, customInstruction }),
        context: reviewContext(d),
        strictness,
        ai,
      });
      if (mr?.webUrl === d.webUrl) {
        bgJobs = [job, ...bgJobs.filter((j) => j.id !== job.id)];
        bgFor = d.webUrl;
        tab = 'ai';
      }
      toasts.show('Review berjalan di background. Boleh pindah halaman; hasilnya muncul di sini dan di Agent Tasks.', 'ok', 6000);
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


  const items = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list: (MrSummary | Recent)[] = scope === 'recent' ? recent : (lists[scope] ?? []);
    return list.filter((m) => !q || `${m.ref} ${m.title}`.toLowerCase().includes(q));
  });

  const visibleFiles = $derived(
    (mr?.changes ?? []).filter((f) => !fileFilter.trim() || f.newPath.toLowerCase().includes(fileFilter.trim().toLowerCase())),
  );

  $effect(() => {
    void init();
  });

  async function init() {
    status = await gitlab.status().catch((e) => ({ configured: false, tokenPresent: false, error: (e as Error).message }));
    jira
      .status()
      .then((s) => (jiraBase = s.configured ? s.baseUrl : undefined))
      .catch(() => {});
    const handoff = sessionStorage.getItem(OPEN_MR_KEY);
    if (handoff) {
      sessionStorage.removeItem(OPEN_MR_KEY);
      void openByUrl(handoff);
    }
    if (status.configured) await loadList('reviewer');
  }

  async function loadList(s: MrScope, force = false) {
    if (lists[s] && !force) return;
    loadingList = true;
    listError = '';
    try {
      lists = { ...lists, [s]: await gitlab.mrs(s) };
    } catch (e) {
      listError = (e as Error).message;
    } finally {
      loadingList = false;
    }
  }

  function pickScope(s: MrScope | 'recent') {
    scope = s;
    if (s !== 'recent') void loadList(s);
  }

  function remember(d: MrDetail) {
    recent = [{ url: d.webUrl, ref: d.ref, title: d.title }, ...recent.filter((r) => r.url !== d.webUrl)].slice(0, 20);
    writeJson(RECENT_KEY, recent);
  }

  async function load(fetcher: () => Promise<MrDetail>) {
    loadingMr = true;
    try {
      const d = await fetcher();
      mr = d;
      remember(d);
        tab = 'overview';
      fileFilter = '';
      if (aiFor !== d.ref) {
        aiText = '';
        aiFor = null;
      }
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      loadingMr = false;
    }
  }

  function openByUrl(url: string) {
    return load(() => gitlab.mrByUrl(url.trim()));
  }

  function openItem(item: MrSummary | Recent) {
    if ('iid' in item) return load(() => gitlab.mr(item.projectPath, item.iid));
    return openByUrl(item.url);
  }

  function submitPaste(e: SubmitEvent) {
    e.preventDefault();
    if (!pasteUrl.trim()) return;
    void openByUrl(pasteUrl);
    pasteUrl = '';
  }

  // ── AI review ──
  function updateAi(sel: AiSelection) {
    ai = sel;
    writeJson(AI_KEY, sel);
  }

  /** MR metadata + diff as the review context; the MR content is untrusted data for the model. */
  function reviewContext(d: MrDetail): string {
    const head = [
      `MR: ${d.ref} — ${d.title}`,
      `Branch: ${d.sourceBranch} → ${d.targetBranch}`,
      `Author: ${d.author.name}`,
      `Jira: ${d.jiraKeys.join(', ') || '-'}`,
      `Risiko otomatis: ${d.risks.map((r) => r.label).join('; ') || '-'}`,
      `Commit: ${d.commits.map((c) => c.title).slice(0, 30).join(' | ') || '-'}`,
      '',
      'Deskripsi MR:',
      d.description.trim().slice(0, 6_000) || '-',
      '',
    ].join('\n');
    let body = '';
    let skipped = 0;
    for (const f of d.changes) {
      const block = `### ${f.renamedFile ? `${f.oldPath} → ` : ''}${f.newPath} (+${f.additions} −${f.deletions})\n${f.truncated ? '(diff tidak tersedia)\n' : '```diff\n' + f.diff + '\n```\n'}\n`;
      if (body.length + block.length > MAX_AI_DIFF) {
        skipped++;
        continue;
      }
      body += block;
    }
    return `${head}\n${body}${skipped ? `\n(${skipped} file lain tidak disertakan karena batas ukuran.)` : ''}`;
  }

  async function runReview() {
    if (!mr || aiRunning) return;
    const d = mr;
    aiRunning = true;
    aiText = '';
    aiFor = d.ref;
    aiAt = Date.now();
    tab = 'ai';
    aiAbort = new AbortController();
    const prompt = buildMrReviewPrompt({ strictness, customInstruction });
    try {
      const res = await fetch(api('/api/connector/ai/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
        body: JSON.stringify({ prompt, context: reviewContext(d), mode: 'code-review', strictness, ai }),
        signal: aiAbort.signal,
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
          if (data.kind === 'text' && data.text) aiText += (aiText ? '\n' : '') + data.text;
          else if (data.kind === 'done') aiText = data.reply ?? aiText;
          else if (data.kind === 'error') failure = data.error ?? 'AI gagal.';
        }
      }
      if (failure) throw new Error(failure);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        aiText = `⚠️ Review gagal: ${(e as Error).message}`;
        toasts.show((e as Error).message, 'err');
      }
    } finally {
      aiRunning = false;
    }
  }

  function stopReview() {
    aiAbort?.abort();
  }

  function copyReview() {
    void navigator.clipboard.writeText(reviewText);
    toasts.show('Hasil review disalin.', 'ok');
  }

  // ── Formatting ──
  const PIPELINE: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' }> = {
    success: { label: 'Pipeline sukses', tone: 'ok' },
    failed: { label: 'Pipeline gagal', tone: 'err' },
    running: { label: 'Pipeline berjalan', tone: 'warn' },
    pending: { label: 'Pipeline menunggu', tone: 'warn' },
    canceled: { label: 'Pipeline dibatalkan', tone: 'muted' },
    skipped: { label: 'Pipeline dilewati', tone: 'muted' },
    manual: { label: 'Pipeline manual', tone: 'warn' },
  };
  const pipe = (s?: PipelineStatus) => (s ? (PIPELINE[s] ?? { label: `Pipeline ${s}`, tone: 'muted' as const }) : undefined);

  function rel(iso: string): string {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (mins < 60) return `${Math.max(mins, 0)} mnt`;
    if (mins < 1440) return `${Math.round(mins / 60)} jam`;
    return `${Math.round(mins / 1440)} hr`;
  }
</script>

<div class="mr-page">
  {#if status && !status.configured}
    <div class="setup panel">
      <span class="setup-icon"><Icon name="merge" size={26} /></span>
      <h2>Hubungkan GitLab internal</h2>
      <p class="muted">
        {status.tokenPresent ? status.error : 'Simpan Personal Access Token GitLab (scope read_api) di halaman Koneksi. Pastikan VPN aktif.'}
      </p>
      <a class="btn btn-primary" href="#/connections"><Icon name="plug" size={14} /> Buka Koneksi</a>
    </div>
  {:else}
    <aside class="panel inbox">
      <form class="paste" onsubmit={submitPaste}>
        <Icon name="link" size={15} />
        <input type="url" placeholder="Tempel link MR GitLab…" bind:value={pasteUrl} aria-label="Link MR" />
        <button class="btn btn-primary btn-sm" disabled={!pasteUrl.trim() || loadingMr}>Buka</button>
      </form>

      <div class="segments" role="tablist">
        {#each [
          { id: 'all', label: 'Semua MR' },
          { id: 'reviewer', label: 'Perlu review saya' },
          { id: 'assigned', label: 'Ditugaskan' },
          { id: 'created', label: 'Buatan saya' },
          { id: 'recent', label: 'Terakhir dibuka' },
        ] as s (s.id)}
          <button role="tab" aria-selected={scope === s.id} class:active={scope === s.id} onclick={() => pickScope(s.id as MrScope | 'recent')}>
            {s.label}
          </button>
        {/each}
      </div>

      <div class="list-tools">
        <label class="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Cari MR" bind:value={query} />
        </label>
        {#if scope !== 'recent'}
          <button class="icon-btn" title="Muat ulang" onclick={() => loadList(scope as MrScope, true)} disabled={loadingList}><Icon name="refresh" size={15} /></button>
        {/if}
      </div>

      <div class="list">
        {#if loadingList && scope !== 'recent' && !lists[scope as MrScope]}
          <p class="muted empty">Memuat MR…</p>
        {:else if listError && scope !== 'recent'}
          <p class="empty err">{listError}</p>
        {:else}
          {#each items as item ('url' in item ? item.url : item.ref)}
            {@const s = 'iid' in item ? item : undefined}
            <button class="item" class:active={mr?.ref === item.ref} onclick={() => openItem(item)} disabled={loadingMr}>
              <span class="item-ref mono">{item.ref}</span>
              <span class="item-title">{#if s?.draft}<span class="draft">Draft</span>{/if}{item.title}</span>
              {#if s}
                <span class="item-meta">
                  {s.author.name} · {rel(s.updatedAt)}
                  {#if s.hasConflicts}<span class="dot-err">konflik</span>{/if}
                  {#if s.userNotesCount}<span>· {s.userNotesCount} komentar</span>{/if}
                </span>
              {/if}
            </button>
          {:else}
            <p class="muted empty">{scope === 'recent' ? 'Belum ada MR yang dibuka.' : 'Tidak ada MR terbuka.'}</p>
          {/each}
        {/if}
      </div>
    </aside>

    <section class="panel detail">
      {#if loadingMr && !mr}
        <p class="muted center">Memuat MR…</p>
      {:else if !mr}
        <div class="center">
          <span class="setup-icon"><Icon name="merge" size={26} /></span>
          <h3>Pilih MR</h3>
          <p class="muted">Pilih dari daftar atau tempel link MR. Semua akses read-only.</p>
        </div>
      {:else}
        {@const p = pipe(mr.pipeline?.status)}
        <header class="mr-head">
          <div class="mr-title-row">
            <span class="mono ref">{mr.ref}</span>
            <span class="state state-{mr.state}">{mr.draft ? 'Draft' : mr.state}</span>
            <span class="spacer"></span>
            {#if loadingMr}<span class="muted small">Memuat…</span>{/if}
            <a class="btn btn-sm" href={mr.webUrl} target="_blank" rel="noreferrer"><Icon name="external" size={13} /> GitLab</a>
            <button class="btn btn-primary btn-sm" onclick={runReview} disabled={aiRunning} title="Tingkat ketelitian: {activeStrictnessOption.label}">
              <Icon name="sparkles" size={13} /> {aiRunning ? 'Mereview…' : `Review AI (${activeStrictnessOption.badge})`}
            </button>
            <button class="btn btn-sm" onclick={runReviewInBackground} disabled={bgRunning || bgBusy} title="Jalankan review di background (Agent Tasks); boleh pindah halaman">
              <Icon name="bot" size={13} /> {bgRunning ? 'Background berjalan…' : 'Background'}
            </button>
          </div>
          <h2>{mr.title}</h2>
          <div class="meta">
            <span class="mono branch">{mr.sourceBranch}</span>
            <Icon name="chevron" size={12} />
            <span class="mono branch">{mr.targetBranch}</span>
            <span>· oleh {mr.author.name}</span>
            <span>· {mr.totals.files} file <span class="add">+{mr.totals.additions}</span> <span class="del">−{mr.totals.deletions}</span></span>
          </div>
          <div class="chips">
            {#if p}
              <a class="chip chip-{p.tone === 'ok' ? 'ok' : p.tone === 'err' ? 'err' : p.tone === 'warn' ? 'warn' : ''}" href={mr.pipeline?.webUrl} target="_blank" rel="noreferrer">{p.label}</a>
            {/if}
            {#if mr.approvals}
              <span class="chip {mr.approvals.approved ? 'chip-ok' : ''}">
                {mr.approvals.approved ? 'Approved' : 'Belum approved'}{mr.approvals.approvedBy.length ? ` · ${mr.approvals.approvedBy.join(', ')}` : ''}{mr.approvals.left ? ` · butuh ${mr.approvals.left} lagi` : ''}
              </span>
            {/if}
            {#if mr.hasConflicts}<span class="chip chip-err">Ada konflik</span>{/if}
            {#each mr.jiraKeys as key (key)}
              {#if jiraBase}
                <a class="chip chip-accent" href="{jiraBase}/browse/{key}" target="_blank" rel="noreferrer"><Icon name="jira" size={11} /> {key}</a>
              {:else}
                <span class="chip chip-accent"><Icon name="jira" size={11} /> {key}</span>
              {/if}
            {/each}
          </div>
        </header>

        <div class="tabs" role="tablist">
          <button role="tab" class:active={tab === 'overview'} aria-selected={tab === 'overview'} onclick={() => (tab = 'overview')}>Ringkasan</button>
          <button role="tab" class:active={tab === 'files'} aria-selected={tab === 'files'} onclick={() => (tab = 'files')}>File ({mr.totals.files})</button>
          <button role="tab" class:active={tab === 'commits'} aria-selected={tab === 'commits'} onclick={() => (tab = 'commits')}>Commit ({mr.commits.length})</button>
          <button role="tab" class:active={tab === 'tad'} aria-selected={tab === 'tad'} onclick={() => (tab = 'tad')}>Kesesuaian TAD</button>
          <button role="tab" class:active={tab === 'ai'} aria-selected={tab === 'ai'} onclick={() => (tab = 'ai')}>
            Review AI {#if aiRunning || bgRunning}<span class="pulse"></span>{/if}
          </button>
        </div>

        <div class="tab-body">
          {#if tab === 'tad'}
            <TadConformance {mr} {ai} onAiChange={updateAi} />
          {:else if tab === 'overview'}
            <div class="overview">
              <JiraPanel keys={mr.jiraKeys} mrUrl={mr.webUrl} headSha={mr.headSha} verdict={reviewVerdict} {jiraBase} />
              <section>
                <h4>Deteksi risiko</h4>
                {#if mr.risks.length}
                  <ul class="risks">
                    {#each mr.risks as r (r.kind)}
                      <li>
                        <span class="risk-label"><Icon name="alert" size={13} /> {r.label}</span>
                        {#if r.files.length}
                          <span class="risk-files mono">{r.files.slice(0, 4).join(', ')}{r.files.length > 4 ? ` +${r.files.length - 4}` : ''}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="muted">Tidak ada area sensitif yang terdeteksi dari path file.</p>
                {/if}
              </section>
              <section>
                <h4>Reviewer & assignee</h4>
                <p class="muted small">
                  Reviewer: {mr.reviewers.map((u) => u.name).join(', ') || '—'} · Assignee: {mr.assignees.map((u) => u.name).join(', ') || '—'}
                  {#if mr.labels.length} · Label: {mr.labels.join(', ')}{/if}
                </p>
              </section>
              <section>
                <h4>Deskripsi</h4>
                {#if mr.description.trim()}
                  <div class="md">{@html renderPreview(mr.description).html}</div>
                {:else}
                  <p class="muted">Tidak ada deskripsi.</p>
                {/if}
              </section>
            </div>
          {:else if tab === 'files'}
            <div class="files">
              <div class="files-tools">
                <label class="search">
                  <Icon name="search" size={14} />
                  <input type="search" placeholder="Filter path file" bind:value={fileFilter} />
                </label>
                {#if mr.diffTruncated}<span class="muted small">Sebagian diff tidak ditampilkan karena terlalu besar.</span>{/if}
                <span class="spacer"></span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  class:btn-active={mrWrapFiles}
                  onclick={() => (mrWrapFiles = !mrWrapFiles)}
                  title="Bungkus teks baris kode panjang agar tidak terpotong"
                >
                  <Icon name="split" size={13} />
                  <span>{mrWrapFiles ? 'Scroll Mode' : 'Wrap Baris'}</span>
                </button>
              </div>
              {#each visibleFiles as f (f.oldPath + '→' + f.newPath)}
                <DiffFile file={f} open={mr.changes.length <= 15 && f.additions + f.deletions <= 400} wrap={mrWrapFiles} />
              {:else}
                <p class="muted">Tidak ada file yang cocok.</p>
              {/each}
            </div>
          {:else if tab === 'commits'}
            <ul class="commits">
              {#each mr.commits as c (c.id)}
                <li>
                  <span class="mono sha">{c.shortId}</span>
                  <span class="commit-title">{c.title}</span>
                  <span class="muted small">{c.authorName} · {rel(c.createdAt)}</span>
                </li>
              {:else}
                <li class="muted">Tidak ada commit.</li>
              {/each}
            </ul>
          {:else}
            <div class="ai">
              <div class="review-config-card">
                <div class="config-row">
                  <div class="config-label">
                    <Icon name="shield" size={14} />
                    <span>Ketelitian Review:</span>
                  </div>
                  <div class="strictness-pills" role="group" aria-label="Pilih tingkat ketelitian review">
                    {#each REVIEW_STRICTNESS_OPTIONS as opt (opt.id)}
                      <button
                        type="button"
                        class="strictness-pill"
                        class:active={strictness === opt.id}
                        aria-pressed={strictness === opt.id}
                        onclick={() => setStrictness(opt.id)}
                        disabled={aiRunning}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="config-hint muted">
                  💡 {activeStrictnessOption.hint}
                </div>
                <div class="config-instruction-row">
                  <label class="custom-instruction-box">
                    <Icon name="sparkles" size={13} />
                    <input
                      type="text"
                      placeholder="Instruksi tambahan (opsional: misal cek migration DB, backwards compatibility, dll)"
                      bind:value={customInstruction}
                      disabled={aiRunning}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') void runReview();
                      }}
                    />
                  </label>
                </div>
              </div>

              <div class="ai-bar">
                <div class="picker"><AiPicker value={ai} onchange={updateAi} disabled={aiRunning} /></div>
                {#if aiRunning}
                  <button class="btn" onclick={stopReview}><Icon name="x" size={13} /> Hentikan</button>
                {:else}
                  <button class="btn btn-primary" onclick={runReview}><Icon name="sparkles" size={13} /> {reviewText ? 'Review ulang' : 'Mulai review'}</button>
                {/if}
                <button class="btn" onclick={runReviewInBackground} disabled={bgRunning || bgBusy} title="Review dijalankan connector di background dan tercatat di Agent Tasks; boleh pindah halaman">
                  <Icon name="bot" size={13} /> {bgRunning ? 'Berjalan di background…' : 'Jalankan di background'}
                </button>
                {#if reviewText && !aiRunning}<button class="btn" onclick={copyReview}><Icon name="copy" size={13} /> Salin</button>{/if}
              </div>
              <p class="muted small">
                Diff dikirim ke model yang dipilih untuk dianalisis: temuan bug/keamanan, kualitas, dan <strong>task terdeteksi beserta evidence</strong>.
                Hasilnya draft untuk kamu; tidak ada yang dikirim ke GitLab.
              </p>
              {#if bgJob}
                <BackgroundReviewCard job={bgJob} headSha={mr.headSha} busy={bgBusy} oncancel={cancelBackground} />
              {/if}
              {#if reviewText}
                {#if bgShown}<p class="muted small">Hasil review background di atas{bgJob?.ai.model ? ` (${bgJob.ai.model})` : ''}.</p>{/if}
                <div class="md review">{@html renderPreview(reviewText).html}</div>
              {:else if aiRunning}
                <p class="muted">Menganalisis diff… (bisa 1–3 menit untuk MR besar)</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

</div>

<style>
  .mr-page {
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    gap: 16px;
    height: 100%;
    min-height: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .setup {
    grid-column: 1 / -1;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 32px;
  }
  .setup h2, .center h3 {
    margin: 0;
    font-weight: 500;
  }
  .setup p {
    max-width: 520px;
    margin: 0;
  }
  .setup-icon {
    display: grid;
    place-items: center;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    text-align: center;
  }
  .small {
    font-size: 12.5px;
  }
  .spacer {
    flex: 1;
  }

  /* Inbox */
  .inbox {
    padding: 14px 10px 10px;
    gap: 10px;
  }
  .paste, .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 6px 0 12px;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .paste input, .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: 13px;
  }
  .search {
    height: 36px;
    flex: 1;
  }
  .segments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .segments button {
    height: 30px;
    padding: 0 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    font-size: 12.5px;
    cursor: pointer;
  }
  .segments button.active {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--ink-text);
  }
  .list-tools {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-2);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--surface-2);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px;
    border: 0;
    border-radius: 12px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    background: var(--surface-2);
  }
  .item.active {
    background: var(--accent-soft);
  }
  .item-ref {
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-title {
    font-size: 13.5px;
    font-weight: 500;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .draft {
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 11px;
  }
  .item-meta {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-3);
  }
  .dot-err {
    color: var(--err);
  }
  .empty {
    padding: 20px 8px;
    text-align: center;
    font-size: 13px;
  }
  .err {
    color: var(--err);
  }

  /* Detail */
  .mr-head {
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .mr-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ref {
    font-size: 12.5px;
    color: var(--text-3);
  }
  .state {
    padding: 1px 9px;
    border-radius: 999px;
    font-size: 12px;
    background: var(--surface-2);
    text-transform: capitalize;
  }
  .state-opened {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .state-merged {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .mr-head h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 500;
    line-height: 1.35;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-2);
  }
  .meta :global(svg) {
    transform: rotate(-90deg);
  }
  .branch {
    padding: 1px 8px;
    border-radius: 6px;
    background: var(--surface-2);
    font-size: 12px;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--err);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips a {
    text-decoration: none;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    font-weight: 500;
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
  .tab-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 24px;
  }
  .overview {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .overview h4 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 500;
  }
  .risks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .risks li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--warn-soft);
  }
  .risk-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--warn);
    font-weight: 500;
    font-size: 13px;
  }
  .risk-files {
    font-size: 11.5px;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .md {
    font-size: 13.5px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .md :global(pre) {
    overflow-x: auto;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    min-width: 0;
  }
  .btn-active {
    background: var(--accent-soft) !important;
    color: var(--accent) !important;
  }
  .files-tools {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .commits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .commits li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .sha {
    font-size: 12px;
    color: var(--accent);
  }
  .commit-title {
    flex: 1;
    min-width: 0;
  }
  .review-config-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface-2);
  }
  .config-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .config-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  .strictness-pills {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .strictness-pill {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .strictness-pill:hover:not(:disabled) {
    background: var(--surface-3, var(--surface));
    color: var(--text);
  }
  .strictness-pill.active {
    background: var(--ink);
    color: var(--ink-text);
    border-color: var(--ink);
  }
  .strictness-pill:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .config-hint {
    font-size: 11.5px;
    color: var(--text-3);
    line-height: 1.35;
    padding-left: 2px;
  }
  .config-instruction-row {
    margin-top: 2px;
  }
  .custom-instruction-box {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--accent);
  }
  .custom-instruction-box:focus-within {
    border-color: var(--accent-2);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .custom-instruction-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: 13px;
    color: var(--text);
  }
  .ai {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ai-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .picker {
    flex: 0 1 320px;
    min-width: 220px;
  }
  .review {
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--surface-2);
  }

  @media (max-width: 1000px) {
    .mr-page {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .inbox {
      max-height: 40vh;
    }
  }
</style>
