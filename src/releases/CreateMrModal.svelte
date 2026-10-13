<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { AiJobWatch, loadReleaseAi, saveReleaseAi } from '../lib/release/ai-job.svelte';
  import { safetyOk } from '../lib/release/safety';
  import Modal from '../components/Modal.svelte';
  import DiffFile from '../mr/DiffFile.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { openExternal } from '../lib/open-external';
  import { releaseBranchCommands, type BranchPick } from '../lib/release/branch';
  import { releases } from '../lib/release/client';
  import type { AiPick, MrPlan, Release, ReleaseAiJob, ReleaseService } from '../lib/release/types';

  /**
   * New release MR for one service: compares the source branch with the target first (commits,
   * files, env/migrations/queries, tickets), then creates it through the GitLab API (token with
   * scope api, confirmed) or opens GitLab's own form filled in.
   */
  let { release, service, onclose, oncreated, onchanged }: { release: Release; service: ReleaseService; onclose: () => void; oncreated: (r: Release) => void; onchanged?: (r: Release) => void } = $props();
  const oncreatedBranch = (r: Release) => onchanged?.(r);

  let open = $state(true);
  // The release's source branch is only the starting value; the field is edited here.
  let source = $state(untrack(() => service.sourceBranch ?? release.sourceBranch ?? 'staging'));
  // Release branch (when the source also holds work outside the release).
  // Layout: a summary with the next step, three tabs, and the MR title + create button at the bottom.
  let tab = $state<'check' | 'changes' | 'branch'>('check');
  /** How the release branch is made: whole commits (cherry-pick) or chosen changes (hunks). */
  let method = $state<'commit' | 'hunk'>('commit');
  let branchName = $state('');
  let picks = $state<BranchPick[]>([]);
  let branching = $state(false);
  let branchResult = $state<{ picked: number; failed?: { sha: string; title?: string; error: string } } | null>(null);
  const chosen = $derived(picks.filter((p) => p.include));
  let plan = $state<MrPlan | null>(null);
  let loading = $state(false);
  let error = $state('');
  let title = $state('');
  let creating = $state(false);
  let changeFilter = $state('');
  const shownChanges = $derived((plan?.changes ?? []).filter((c) => !changeFilter.trim() || c.newPath.toLowerCase().includes(changeFilter.trim().toLowerCase())));

  // AI pick of the release-branch commits: reads each commit's diff against the scope.
  let ai = $state(loadReleaseAi());
  let aiPicks = $state<Record<string, AiPick>>({});
  let pickInstruction = $state('');
  const aiPick = new AiJobWatch(
    () => release.id,
    'picks',
    () => service.id,
    (job) => {
      if (job.status === 'done') {
        applyPicks(job);
        toasts.show('AI selesai memilih commit. Periksa alasannya sebelum membuat branch.', 'ok', 5000);
      } else if (job.status === 'error') toasts.show(`AI gagal memilih commit: ${job.error}`, 'err', 6000);
    },
  );

  // AI read of what the source branch brings: tickets, changes without a ticket (endpoints
  // registered without a task, too), server needs. Starts by itself when the plan loads.
  const aiMr = new AiJobWatch(
    () => release.id,
    'mr',
    () => service.id,
    (job) => {
      if (job.status === 'error') toasts.show(`Cek AI MR gagal: ${job.error}`, 'err', 6000);
    },
  );
  const aiMrDone = $derived(aiMr.job?.status === 'done' && aiMr.job.sourceBranch === plan?.sourceBranch ? aiMr.job : null);
  const verdictOf = (key: string) => aiMrDone?.verdicts?.find((v) => v.key === key);

  async function startAiMr() {
    if (!plan) return;
    saveReleaseAi(ai);
    await aiMr.start(ai, { sourceBranch: plan.sourceBranch });
    if (aiMr.error) toasts.show(aiMr.error, 'err');
  }

  function applyPicks(job: ReleaseAiJob) {
    const by = new Map((job.picks ?? []).map((p) => [p.sha, p]));
    picks = picks.map((p) => (by.has(p.sha) ? { ...p, include: by.get(p.sha)!.include } : p));
    aiPicks = Object.fromEntries(by);
  }

  async function startAiPick() {
    saveReleaseAi(ai);
    await aiPick.start(ai, { sourceBranch: plan?.sourceBranch ?? source.trim(), instruction: pickInstruction.trim() || undefined });
    if (aiPick.error) toasts.show(aiPick.error, 'err');
  }

  onMount(() => {
    void load();
    return () => {
      aiPick.stop();
      aiMr.stop();
      aiPatch.stop();
      aiSafety.stop();
      aiFlag.stop();
    };
  });
  $effect(() => {
    if (!open) onclose();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      plan = await releases.mrPlan(release.id, service.id, source.trim());
      title = plan.title;
      branchName = plan.releaseBranch.branch;
      picks = plan.releaseBranch.commits.map((c) => ({ ...c }));
      // A dirty source: suggest the release branch right away.
      tab = 'check';
      // The last AI pick for this branch still applies to the same commits.
      aiPicks = {};
      await aiPick.load();
      if (aiPick.job?.status === 'done' && aiPick.job.sourceBranch === plan.sourceBranch) {
        applyPicks(aiPick.job);
      }
      await aiSafety.load();
      await aiFlag.load();
      patchSel = {};
      await aiPatch.load();
      if (aiPatch.job?.status === 'done' && aiPatch.job.sourceBranch === plan.sourceBranch) {
        applyPatch(aiPatch.job);
        method = 'hunk';
      }
      // The AI read of this branch: reuse the last one, else start it.
      await aiMr.load();
      if (!(aiMr.job?.status === 'done' && aiMr.job.sourceBranch === plan.sourceBranch) && !aiMr.running && plan.files) void startAiMr();
    } catch (e) {
      error = (e as Error).message;
      plan = null;
    } finally {
      loading = false;
    }
  }

  // Safety of a release branch (made by cherry-pick or chosen hunks): runs after it is made.
  const aiSafety = new AiJobWatch(
    () => release.id,
    'safety',
    () => service.id,
    (job) => {
      if (job.status === 'done' && job.safety) toasts.show(safetyOk(job.safety) ? `Branch ${job.safety.branch} lolos cek keamanan.` : `Branch ${job.safety.branch} belum lolos cek keamanan. Periksa kartu Keamanan.`, safetyOk(job.safety) ? 'ok' : 'info', 6000);
      else if (job.status === 'error') toasts.show(`Cek keamanan gagal: ${job.error}`, 'err', 6000);
    },
  );
  /** The source is a release branch, not the release's usual source (staging…). */
  const onReleaseBranch = $derived(Boolean(plan) && plan!.sourceBranch !== (release.sourceBranch || 'staging'));
  const safety = $derived(aiSafety.job?.status === 'done' && aiSafety.job.safety?.branch === plan?.sourceBranch ? aiSafety.job.safety : null);

  async function startSafety() {
    if (!plan) return;
    saveReleaseAi(ai);
    await aiSafety.start(ai, { sourceBranch: plan.sourceBranch });
    if (aiSafety.error) toasts.show(aiSafety.error, 'err');
  }

  async function create() {
    if (!plan) return;
    // A release branch that has not passed its safety check needs a second look.
    if (onReleaseBranch && (!safety || !safetyOk(safety))) {
      const go = await confirmDialog({
        title: 'Branch rilis belum lolos cek keamanan',
        message: !safety ? `Cek keamanan ${plan.sourceBranch} belum dijalankan.` : `${safety.subset.length} perubahan bukan dari ${safety.from}, ${safety.files.length} masalah file, ketergantungan: ${safety.deps?.verdict ?? '-'}, pipeline: ${safety.pipeline?.status ?? 'belum ada'}. Tetap buat MR?`,
        confirmText: 'Tetap lanjut',
        danger: true,
      });
      if (!go) return;
    }
    const ok = await confirmDialog({
      title: 'Buat MR di GitLab?',
      message: `MR ${plan.sourceBranch} → ${plan.targetBranch} akan dibuat di ${plan.projectPath} atas nama token GitLab kamu (${plan.commits.length} commit, ${plan.files} file).`,
      confirmText: 'Buat MR',
    });
    if (!ok) return;
    creating = true;
    try {
      const r = await releases.createMr(release.id, service.id, { sourceBranch: plan.sourceBranch, title });
      toasts.show(r.created ? `MR ${r.ref} dibuat.` : `MR ${r.ref} sudah ada, ditautkan ke rilis.`, 'ok', 4000);
      oncreated(r.release);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      creating = false;
    }
  }

  async function copyCommands() {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(releaseBranchCommands({ base: plan.targetBranch, branch: branchName.trim() }, chosen));
      toasts.show('Perintah git disalin. Setelah branch di-push, isi branch sumber dengan nama branch itu lalu Bandingkan.', 'ok', 5000);
    } catch {
      toasts.show('Tidak bisa menyalin ke clipboard.', 'err');
    }
  }

  async function makeBranch() {
    if (!plan || !chosen.length || !branchName.trim()) return;
    const ok = await confirmDialog({
      title: 'Buat branch rilis di GitLab?',
      message: `Branch ${branchName.trim()} dibuat dari ${plan.targetBranch} di ${plan.projectPath}, lalu ${chosen.length} commit di-cherry-pick berurutan. Kalau ada konflik, proses berhenti di commit itu.`,
      confirmText: 'Buat branch',
    });
    if (!ok) return;
    branching = true;
    branchResult = null;
    try {
      const r = await releases.createReleaseBranch(release.id, service.id, branchName.trim(), chosen.map((p) => ({ sha: p.sha, title: p.title })), plan.sourceBranch);
      branchResult = { picked: r.picked.length, failed: r.failed };
      oncreatedBranch(r.release);
      if (r.failed) {
        toasts.show(`Berhenti di ${r.failed.sha.slice(0, 8)}: ${r.failed.error}`, 'err', 8000);
      } else {
        toasts.show(`Branch ${r.branch} siap dengan ${r.picked.length} commit.`, 'ok', 4000);
        source = r.branch;
        await load();
        tab = 'branch';
        void startSafety();
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      branching = false;
    }
  }

  // Release branch from chosen hunks (for mixed commits): the AI picks, the user reviews.
  let patchSel = $state<Record<string, boolean>>({});
  let patching = $state(false);
  let patchPreview = $state<{ files: { path: string; status: string; diff: string; problem?: string; changes?: string[] }[] } | null>(null);
  let previewing = $state(false);

  async function previewPatch() {
    if (!plan || !patchChosen.length) return;
    previewing = true;
    try {
      patchPreview = await releases.previewPatch(release.id, service.id, { sourceBranch: plan.sourceBranch, hunks: patchChosen });
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      previewing = false;
    }
  }
  const aiPatch = new AiJobWatch(
    () => release.id,
    'patch',
    () => service.id,
    (job) => {
      if (job.status === 'done') {
        applyPatch(job);
        toasts.show('AI selesai memilih perubahan. Periksa sebelum membuat branch.', 'ok', 5000);
      } else if (job.status === 'error') toasts.show(`AI gagal memilih perubahan: ${job.error}`, 'err', 6000);
    },
  );
  const patchDone = $derived(aiPatch.job?.status === 'done' && aiPatch.job.sourceBranch === plan?.sourceBranch ? aiPatch.job : null);
  const patchChosen = $derived(Object.entries(patchSel).filter(([, v]) => v).map(([k]) => k));

  function applyPatch(job: ReleaseAiJob) {
    patchPreview = null;
    patchSel = Object.fromEntries((job.patch?.files ?? []).flatMap((f) => f.hunks.map((h) => [h.id, h.include])));
  }

  async function startAiPatch() {
    saveReleaseAi(ai);
    await aiPatch.start(ai, { sourceBranch: plan?.sourceBranch ?? source.trim(), instruction: pickInstruction.trim() || undefined });
    if (aiPatch.error) toasts.show(aiPatch.error, 'err');
  }

  async function makePatchBranch(force = false) {
    if (!plan || !patchChosen.length || !branchName.trim()) return;
    if (!force) {
      const ok = await confirmDialog({
        title: 'Buat branch rilis dari perubahan pilihan?',
        message: `Branch ${branchName.trim()} dibuat dari ${plan.targetBranch} di ${plan.projectPath} dengan ${patchChosen.length} perubahan pilihan dari ${plan.sourceBranch}, dalam satu commit.`,
        confirmText: 'Buat branch',
      });
      if (!ok) return;
    }
    patching = true;
    try {
      const r = await releases.createPatchBranch(release.id, service.id, { branch: branchName.trim(), sourceBranch: plan.sourceBranch, hunks: patchChosen, force });
      oncreatedBranch(r.release);
      toasts.show(`Branch ${r.branch} siap: ${r.files.length} file, commit ${r.commit.slice(0, 8)}.`, 'ok', 5000);
      source = r.branch;
      await load();
      tab = 'branch';
      void startSafety();
    } catch (e) {
      const msg = (e as Error).message;
      if (!force && /bukan JSON valid/.test(msg)) {
        const again = await confirmDialog({ title: 'Hasilnya bukan JSON valid', message: `${msg}`, confirmText: 'Tetap buat', danger: true });
        if (again) return void (await makePatchBranch(true));
      } else error = msg;
    } finally {
      patching = false;
    }
  }

  async function openForm() {
    if (!plan?.formUrl) return;
    await openExternal(plan.formUrl);
    toasts.show('Form MR dibuka di GitLab. Setelah dibuat, klik "Cari service & MR" atau tempel link MR-nya.', 'info', 6000);
  }

  const f = $derived(plan?.findings);

  // Feature flag for a feature outside the release (on the source): AI writes it, the user reviews,
  // then a branch + MR into the source branch (confirmed). The MR is reviewed and merged in GitLab.
  let flagWhat = $state('');
  let flagPaths = $state<string[]>([]);
  let flagBusy = $state<'' | 'mr' | 'status'>('');
  const aiFlag = new AiJobWatch(
    () => release.id,
    'flag',
    () => service.id,
    (job) => {
      if (job.status === 'done') toasts.show(job.flag?.files.length ? `Feature flag ${job.flag.name} siap ditinjau.` : 'AI tidak membuat perubahan; lihat catatannya.', 'info', 5000);
      else if (job.status === 'error') toasts.show(`Menyusun feature flag gagal: ${job.error}`, 'err', 6000);
    },
  );
  const flagDone = $derived(aiFlag.job?.status === 'done' ? aiFlag.job : null);

  function flagThis(u: { path: string; reason: string }) {
    flagPaths = [...new Set([...flagPaths, u.path])];
    flagWhat = flagWhat.trim() ? `${flagWhat.trim()}\n${u.path}: ${u.reason}` : `${u.path}: ${u.reason}`;
    queueMicrotask(() => document.getElementById('flag-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function startFlag() {
    saveReleaseAi(ai);
    await aiFlag.start(ai, { instruction: flagWhat.trim(), paths: flagPaths });
    if (aiFlag.error) toasts.show(aiFlag.error, 'err');
  }

  async function makeFlagMr() {
    const f = flagDone?.flag;
    if (!f) return;
    const ok = await confirmDialog({ title: `Buat branch & MR feature flag ke ${f.base}?`, message: `Branch dari ${f.base} berisi ${f.files.length} file yang diubah AI (flag ${f.name}, default mati), lalu MR ke ${f.base} dibuat atas nama token GitLab kamu.`, confirmText: 'Buat branch & MR' });
    if (!ok) return;
    flagBusy = 'mr';
    try {
      const r = await releases.createFlagMr(release.id, service.id);
      toasts.show(`${r.created ? 'MR' : 'MR yang ada'} ${r.ref} ke ${f.base} siap direview di GitLab.`, 'ok', 6000);
      await aiFlag.load();
    } catch (e) {
      toasts.show((e as Error).message, 'err', 8000);
    } finally {
      flagBusy = '';
    }
  }

  /** Reads the flag MR from GitLab: review, approvals, pipeline, merged (merging happens in GitLab). */
  async function flagStatus() {
    flagBusy = 'status';
    try {
      const st = await releases.flagStatus(release.id, service.id);
      toasts.show(st.merged ? `${st.ref} sudah di-merge. Klik Bandingkan, lalu cek ulang dengan AI.` : `${st.ref}: ${st.state ?? 'terbuka'}, ${st.approvals ?? 0}${st.approvalsRequired ? `/${st.approvalsRequired}` : ''} approval${st.pipeline ? `, pipeline ${st.pipeline}` : ''}.`, 'info', 6000);
      await aiFlag.load();
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      flagBusy = '';
    }
  }

  /** What the summary shows: ticket results (AI first), changes without a ticket, risks. */
  const ticketsIn = $derived(plan ? plan.tickets.filter((t) => (verdictOf(t.key) ? verdictOf(t.key)!.verdict === 'ada' : t.inSource)).length : 0);
  const ticketsMissing = $derived(plan ? plan.tickets.filter((t) => (verdictOf(t.key) ? verdictOf(t.key)!.verdict === 'tidak' : !t.inSource && !t.unsure)) : []);
  const loose = $derived(aiMrDone?.unrelated?.filter((u) => !u.flag) ?? []);
  const flagged = $derived(aiMrDone?.unrelated?.filter((u) => u.flag) ?? []);
  const risks = $derived(aiMrDone?.risks ?? []);
  /** The source brings work outside the release: a release branch is the way out. */
  const dirty = $derived(Boolean(plan) && !onReleaseBranch && (plan!.outOfScope.length > 0 || loose.length > 0));

  /** One sentence on what to do now, and the button for it. */
  const next = $derived.by((): { text: string; action?: { label: string; run: () => void } ; ok?: boolean } => {
    if (!plan) return { text: '' };
    if (!plan.commits.length && !plan.existing) return { text: `${plan.sourceBranch} tidak membawa perubahan baru ke ${plan.targetBranch}.` };
    if (aiMr.running) return { text: 'AI sedang membaca diff. Hasil pemeriksaan muncul di tab Pemeriksaan.' };
    if (onReleaseBranch) {
      if (aiSafety.running) return { text: 'Cek keamanan branch rilis sedang berjalan.' };
      if (!safety) return { text: `Sumbernya branch rilis ${plan.sourceBranch}: jalankan cek keamanan dulu.`, action: { label: 'Cek keamanan', run: () => ((tab = 'branch'), void startSafety()) } };
      if (!safetyOk(safety)) return { text: 'Branch rilis belum lolos cek keamanan: selesaikan yang bertanda ✗ / ≈.', action: { label: 'Lihat cek keamanan', run: () => (tab = 'branch') } };
    }
    if (dirty) return { text: `${plan.sourceBranch} membawa perubahan di luar scope (${plan.outOfScope.length + loose.length}). Siapkan branch rilis yang hanya berisi scope, atau bungkus fiturnya dengan feature flag (tombol Flag-kan di tab Pemeriksaan).`, action: { label: 'Siapkan branch rilis', run: () => (tab = 'branch') } };
    if (ticketsMissing.length) return { text: `${ticketsMissing.length} tiket belum terlihat di kode (${ticketsMissing.map((t) => t.key).join(', ')}). Pastikan memang tidak ikut rilis ini, lalu buat MR.` };
    return { text: `Siap: buat MR ${plan.sourceBranch} → ${plan.targetBranch}.`, ok: true };
  });
</script>

<Modal bind:open title="Buat MR ke {release.targetBranch}" subtitle="{service.name} · {service.gitlabPath}" width={860}>
  <div class="wrap">
    <div class="row">
      <label class="inline small">Branch sumber <input class="input mono src" bind:value={source} onkeydown={(e) => e.key === 'Enter' && load()} /></label>
      <span class="small">→ <span class="mono">{release.targetBranch}</span></span>
      <button class="btn btn-sm" onclick={load} disabled={loading || !source.trim()}><Icon name="refresh" size={12} /> {loading ? 'Membandingkan…' : 'Bandingkan'}</button>
    </div>

    {#if error}<p class="err small">{error}</p>{/if}

    {#if plan}
      {#if plan.existing}
        <div class="note"><Icon name="alert" size={13} /> Sudah ada MR terbuka untuk branch ini: <a href={plan.existing.webUrl} target="_blank" rel="noreferrer">{plan.existing.ref}</a>. "Buat MR" akan menautkannya ke rilis, bukan membuat MR kedua.</div>
      {/if}

      <section class="summary" class:ok={next.ok}>
        <div class="chips-row small">
          <span class="chip" class:good={plan.tickets.length > 0 && ticketsIn === plan.tickets.length} class:badc={ticketsMissing.length > 0}>Tiket {ticketsIn}/{plan.tickets.length} ada{aiMrDone ? ' (AI)' : aiMr.running ? ' · AI membaca…' : ''}</span>
          <span class="chip" class:badc={plan.outOfScope.length + loose.length > 0}>{plan.outOfScope.length + loose.length} di luar scope</span>
          {#if flagged.length}<span class="chip">{flagged.length} di balik flag</span>{/if}
          {#if risks.length}<span class="chip badc">{risks.length} risiko</span>{/if}
          <span class="chip">{plan.commits.length} commit · {plan.files} file</span>
          {#if onReleaseBranch}<span class="chip" class:good={safety && safetyOk(safety)} class:badc={safety && !safetyOk(safety)}>Keamanan: {aiSafety.running ? 'dicek…' : safety ? (safetyOk(safety) ? 'lolos' : 'belum') : 'belum dicek'}</span>{/if}
        </div>
        <div class="next">
          <span><strong>Langkah berikutnya:</strong> {next.text}</span>
          {#if next.action}<button class="btn btn-sm btn-primary" onclick={next.action.run}>{next.action.label}</button>{/if}
        </div>
      </section>

      <div class="tabbar" role="tablist">
        <button role="tab" class:active={tab === 'check'} onclick={() => (tab = 'check')}>Pemeriksaan{ticketsMissing.length + risks.length + loose.length ? ` (${ticketsMissing.length + risks.length + loose.length})` : ''}</button>
        <button role="tab" class:active={tab === 'changes'} onclick={() => (tab = 'changes')}>Perubahan ({plan.files} file)</button>
        <button role="tab" class:active={tab === 'branch'} onclick={() => (tab = 'branch')}>Branch rilis{onReleaseBranch ? ' ✓' : dirty ? ' ⚠' : ''}</button>
      </div>

      {#if tab === 'check'}
        {#if plan.warnings.length}
          <details class="warn"><summary class="small">{plan.warnings.length} catatan dari perbandingan</summary>{#each plan.warnings as w (w)}<p><Icon name="alert" size={12} /> {w}</p>{/each}</details>
        {/if}
        <section>
          {#if plan.tickets.length}
            <h4>Tiket {service.name} <span class="muted small">· dicek dari isi diff {plan.sourceBranch}</span></h4>
            <div class="row small">
              {#if aiMr.running}
                <span class="ai-status"><Icon name="sparkles" size={12} /> {aiMr.job?.progress ?? 'AI membaca diff…'}</span>
              {:else if aiMrDone}
                <span class="muted">Dicek AI ({aiMrDone.model})</span>
                <button class="link-btn" onclick={startAiMr}>Cek ulang</button>
              {:else}
                <button class="link-btn" onclick={startAiMr}><Icon name="sparkles" size={12} /> Cek dengan AI</button>
              {/if}
            </div>
            <ul class="small tickets">
              {#each plan.tickets as t (t.key)}
                {@const v = verdictOf(t.key)}
                <li class:missing={v ? v.verdict === 'tidak' : !t.inSource && !t.unsure} class:unsure={v ? v.verdict === 'sebagian' : t.unsure}>
                  <span class="mono">{t.key}</span> {t.summary}
                  <span class="muted">· {t.status} · {v ? `AI: ${v.verdict}` : t.inSource ? 'ada di kode' : t.unsure ? 'cocok samar, cek manual' : 'tidak terlihat di kode'}</span>
                  {#if v?.reason}<div class="muted evidence"><Icon name="sparkles" size={11} /> {v.reason}</div>{/if}
                  {#if t.code}<div class="muted evidence">{t.code.strength === 'strong' ? '✓' : '≈'} {#each t.code.hits.slice(0, 3) as h, i (i)}<span class="mono">{h.path}</span> ({h.match}) {/each}</div>{:else if t.byKey}<div class="muted evidence">key ada di commit</div>{/if}
                </li>
              {/each}
            </ul>
            {#if loose.length}
              <h4 class="w">Perubahan tanpa tiket (AI) — {loose.length}</h4>
              <ul class="small tickets">{#each loose as u, i (i)}<li class="missing"><span class="mono">{u.path}</span> — {u.reason} <button class="link-btn small" onclick={() => flagThis(u)} title="Bungkus perubahan ini dengan feature flag (default mati) di {plan.sourceBranch}">Flag-kan</button></li>{/each}</ul>
            {/if}
            {#if flagged.length}
              <h4>Di balik feature flag (aman ikut selama flag mati) — {flagged.length}</h4>
              <ul class="small tickets">{#each flagged as u, i (i)}<li><span class="mono">{u.path}</span> · flag <span class="mono">{u.flag}</span> — {u.reason}</li>{/each}</ul>
            {/if}
            {#if aiMrDone?.risks?.length}
              <h4 class="bad">Risiko / temuan review (AI) — {aiMrDone.risks.length}</h4>
              <ul class="small tickets">{#each aiMrDone.risks as r, i (i)}<li>{#if r.path}<span class="mono">{r.path}</span> — {/if}{r.reason}</li>{/each}</ul>
            {/if}
            {#if aiMrDone?.needs?.length}
              <h4>Perlu di server (AI)</h4>
              <ul class="small tickets">{#each aiMrDone.needs as n, i (i)}<li>{n.when === 'post' ? 'Setelah deploy: ' : ''}{n.kind === 'env' ? `env ${n.label}` : n.label}{#if n.kind === 'sql' && n.detail}<pre class="sqlbox">{n.detail}</pre>{/if}</li>{/each}</ul>
            {/if}
            {#if !aiMrDone && plan.unattributed?.length}
              <details class="small"><summary>{plan.unattributed.length} file tidak terkait tiket {service.name} mana pun (cek apakah ikut terbawa)</summary><ul class="mono">{#each plan.unattributed as f (f)}<li>{f}</li>{/each}</ul></details>
            {/if}
          {/if}
          {#if plan.outOfScope.length}
            <h4 class="bad">Di luar scope, akan ikut terbawa ({plan.outOfScope.length})</h4>
            <ul class="small tickets">
              {#each plan.outOfScope as o (o.key)}<li class="missing"><span class="mono">{o.key}</span> {o.summary ?? 'tidak termuat dari Jira'}{o.commits[0] ? ` · ${o.commits[0]}` : ''}</li>{/each}
            </ul>
          {/if}
          <section class="flag" id="flag-panel">
            <h4>Feature flag</h4>
            <p class="muted small">Fitur di branch sumber yang bukan bagian rilis bisa dibungkus feature flag (default mati) lewat MR ke branch sumbernya. MR-nya direview dan di-merge di GitLab; setelah itu fiturnya boleh ikut naik tanpa aktif.</p>
            <textarea class="input pick-ins" rows="2" bind:value={flagWhat} placeholder="Fitur yang mau di-flag, mis. scheduler laporan pajak di core/scheduler/tax_transaction_scheduler.go"></textarea>
            {#if flagPaths.length}<div class="small">File: {#each flagPaths as p (p)}<span class="tag mono">{p} <button class="link-btn" onclick={() => (flagPaths = flagPaths.filter((x) => x !== p))} aria-label="Hapus {p}">✕</button></span> {/each}</div>{/if}
            <div class="row">
              <AiPicker value={ai} onchange={(v) => (ai = v)} disabled={aiFlag.running} />
              {#if aiFlag.running}
                <span class="small ai-status"><Icon name="sparkles" size={12} /> {aiFlag.job?.progress ?? 'AI menyusun…'}</span>
                <button class="btn btn-sm" onclick={() => aiFlag.cancel()}><Icon name="x" size={12} /> Batalkan</button>
              {:else}
                <button class="btn btn-sm btn-primary" onclick={startFlag} disabled={!flagWhat.trim()}><Icon name="sparkles" size={12} /> Susun feature flag dengan AI</button>
              {/if}
            </div>
            {#if flagDone?.flag}
              {@const fl = flagDone.flag}
              <div class="pfile">
                <div class="small"><strong>Flag <span class="mono">{fl.name}</span></strong> (default mati) di <span class="mono">{fl.base}</span>{fl.summary ? ` — ${fl.summary}` : ''}</div>
                {#if flagDone.notes?.length}<ul class="small ai-notes">{#each flagDone.notes as n, i (i)}<li>{n}</li>{/each}</ul>{/if}
                {#if fl.problems.length}<ul class="small err-text">{#each fl.problems as pr, i (i)}<li>{pr}</li>{/each}</ul>{/if}
                {#each fl.files as ff (ff.path)}
                  <details><summary class="small"><span class="mono">{ff.path}</span> · {ff.status === 'create' ? 'file baru' : 'diubah'}</summary><pre class="sqlbox">{ff.preview || '(tidak ada perubahan)'}</pre></details>
                {/each}
                <div class="row">
                  {#if fl.mr}
                    <span class="small">
                      MR <a href={fl.mr.webUrl} target="_blank" rel="noreferrer">{fl.mr.ref}</a> ({fl.mr.branch} → {fl.base}):
                      {#if fl.mr.merged}<strong>sudah di-merge</strong> — klik Bandingkan, lalu cek ulang dengan AI.
                      {:else}menunggu review dan merge di GitLab{fl.mr.checkedAt ? ` · ${fl.mr.approvals ?? 0}${fl.mr.approvalsRequired ? `/${fl.mr.approvalsRequired}` : ''} approval${fl.mr.pipeline ? ` · pipeline ${fl.mr.pipeline}` : ''}` : ''}{/if}
                    </span>
                    {#if !fl.mr.merged}<button class="btn btn-sm" onclick={flagStatus} disabled={!!flagBusy}><Icon name="refresh" size={12} /> {flagBusy === 'status' ? 'Mengecek…' : 'Cek status'}</button>{/if}
                  {:else if fl.files.length}
                    <button class="btn btn-sm btn-primary" onclick={makeFlagMr} disabled={!!flagBusy || plan.canCreate === false}><Icon name="merge" size={12} /> {flagBusy === 'mr' ? 'Membuat…' : `Buat branch & MR ke ${fl.base}`}</button>
                  {/if}
                </div>
              </div>
            {/if}
          </section>
          <h4>Temuan pola (env, migrasi, query)</h4>
          {#if f}
            <ul class="small findings">
              {#if f.envAdded.length}<li><strong>Env baru:</strong> <span class="mono">{f.envAdded.join(', ')}</span></li>{/if}
              {#if f.envReadInCode.length}<li><strong>Env dibaca di kode:</strong> <span class="mono">{f.envReadInCode.join(', ')}</span></li>{/if}
              {#if f.migrations.length}<li><strong>Migrasi:</strong> <span class="mono">{f.migrations.join(', ')}</span></li>{/if}
              {#if f.sqlOutside.length}<li class="w"><strong>Query manual:</strong> <span class="mono">{f.sqlOutside.join(', ')}</span></li>{/if}
              {#if f.modelWithoutMigration.length}<li class="w"><strong>Model berubah tanpa migrasi:</strong> <span class="mono">{f.modelWithoutMigration.join(', ')}</span></li>{/if}
              {#if f.commitsWithoutKey.length}<li class="w"><strong>{f.commitsWithoutKey.length} commit tanpa Jira key</strong></li>{/if}
              {#if !f.envAdded.length && !f.envReadInCode.length && !f.migrations.length && !f.sqlOutside.length}<li class="muted">Tidak membawa env, migrasi, atau query.</li>{/if}
            </ul>
          {/if}
        </section>
      {:else if tab === 'changes'}
        <section class="changes">
          {#if plan.commits.length}
            <h4>Commit</h4>
            <ul class="small commits">
              {#each plan.commits.slice(0, 30) as c (c.shortId)}<li><span class="mono">{c.shortId}</span> {c.title}</li>{/each}
              {#if plan.commits.length > 30}<li class="muted">… {plan.commits.length - 30} commit lain</li>{/if}
            </ul>
          {/if}
          <h4>File ({plan.files}, {plan.changes.reduce((n, c) => n + c.additions, 0)}+ / {plan.changes.reduce((n, c) => n + c.deletions, 0)}−)</h4>
          <div class="row">
            <input class="input" bind:value={changeFilter} placeholder="Saring file, mis. migrations atau .env" />
            <span class="muted small">{shownChanges.length} file{plan.truncated ? ' · perbandingan dari GitLab terpotong' : ''}</span>
          </div>
          <div class="diffs">
            {#each shownChanges as c (c.newPath)}
              <DiffFile file={c} open={false} />
            {:else}
              <p class="muted small">Tidak ada file yang cocok.</p>
            {/each}
          </div>
        </section>
      {:else}
        <section class="branch">
          {#if onReleaseBranch}
            <section class="safety" class:ok={safety && safetyOk(safety)}>
              <div class="row">
                <strong>Keamanan branch rilis {plan.sourceBranch}</strong>
                {#if aiSafety.running}
                  <span class="small ai-status"><Icon name="sparkles" size={12} /> {aiSafety.job?.progress ?? 'Mengecek…'}</span>
                {:else}
                  <button class="btn btn-sm" onclick={startSafety}><Icon name="check" size={12} /> {safety ? 'Cek ulang' : 'Cek keamanan'}</button>
                {/if}
              </div>
              {#if safety}
                <ul class="small layers">
                  <li class:bad={safety.subset.length}>
                    {safety.subset.length ? '✗' : '✓'} <strong>Isi dari {safety.from}:</strong> {safety.subset.length ? `${safety.subset.length} perubahan tidak ada di ${safety.from} (belum pernah dites)` : `semua perubahan berasal dari ${safety.from}`}
                    {#if safety.subset.length}<ul>{#each safety.subset.slice(0, 10) as x, i (i)}<li><span class="mono">{x.path}{x.line ? `:${x.line}` : ''}</span> {x.text ? `— ${x.text}` : ''} <span class="muted">({x.reason})</span></li>{/each}</ul>{/if}
                  </li>
                  <li class:bad={safety.files.length}>
                    {safety.files.length ? '✗' : '✓'} <strong>File:</strong> {safety.files.length ? `${safety.files.length} masalah` : 'tidak ada penanda konflik, JSON valid'}
                    {#if safety.files.length}<ul>{#each safety.files as x, i (i)}<li><span class="mono">{x.path}{x.line ? `:${x.line}` : ''}</span> — {x.reason}</li>{/each}</ul>{/if}
                  </li>
                  <li class:bad={safety.deps?.verdict === 'putus'} class:warn={safety.deps?.verdict === 'perlu dicek'}>
                    {safety.deps?.verdict === 'aman' ? '✓' : safety.deps?.verdict === 'putus' ? '✗' : '≈'} <strong>Ketergantungan (AI):</strong> {safety.deps?.verdict ?? '-'}{safety.deps?.summary ? ` — ${safety.deps.summary}` : ''}
                    {#if safety.deps?.issues.length}<ul>{#each safety.deps.issues as x, i (i)}<li>{#if x.path}<span class="mono">{x.path}</span> — {/if}{x.reason}</li>{/each}</ul>{/if}
                  </li>
                  <li class:bad={safety.pipeline?.status && safety.pipeline.status !== 'success'} class:warn={!safety.pipeline?.status}>
                    {safety.pipeline?.status === 'success' ? '✓' : safety.pipeline?.status ? '✗' : '≈'} <strong>Pipeline:</strong>
                    {#if safety.pipeline?.status}<a href={safety.pipeline.url} target="_blank" rel="noreferrer">{safety.pipeline.status}</a>{:else}{safety.pipeline?.note}{/if}
                  </li>
                </ul>
                {#if safety.skipped.length}<p class="muted small">Tidak dibandingkan (biner/lock/terlalu besar): {safety.skipped.slice(0, 6).join(', ')}{safety.skipped.length > 6 ? ', …' : ''}</p>{/if}
                <p class="small"><strong>{safetyOk(safety) ? 'Aman untuk dibuat MR ke ' + plan.targetBranch + '.' : 'Belum aman: selesaikan yang bertanda ✗ / ≈ dulu.'}</strong></p>
              {:else if !aiSafety.running}
                <p class="muted small">Cek: semua perubahan berasal dari branch sumbernya, file valid, ketergantungan tidak putus (AI), dan pipeline branch ini lulus.</p>
              {/if}
            </section>
          {/if}
          {#if !onReleaseBranch}
            <p class="small">Buat branch rilis dari <span class="mono">{plan.targetBranch}</span> yang hanya berisi scope, bila <span class="mono">{plan.sourceBranch}</span> juga membawa perubahan lain. Setelah dibuat, branch itu jadi sumber MR dan dicek keamanannya.</p>
          {/if}
          <div class="method small" role="radiogroup">
            <label><input type="radio" bind:group={method} value="commit" /> <strong>Per commit</strong> (cherry-pick): bila fitur rapi per commit/merge</label>
            <label><input type="radio" bind:group={method} value="hunk" /> <strong>Per perubahan</strong> (hunk): bila commit campuran, atau perlu sebagian isi commit</label>
          </div>
          <textarea class="input pick-ins" rows="2" bind:value={pickInstruction} placeholder="Instruksi untuk AI (opsional), mis. perubahan CI/Dockerfile tanpa task tetap ikut; commit refactor logger jangan ikut"></textarea>
          <div class="row">
            <label class="inline small">Nama branch rilis <input class="input mono bname" bind:value={branchName} /></label>
            <AiPicker value={ai} onchange={(v) => (ai = v)} disabled={aiPick.running || aiPatch.running} />
          </div>
          {#if method === 'commit'}
          <div class="row">
            {#if aiPick.running}
              <span class="small ai-status"><Icon name="sparkles" size={12} /> {aiPick.job?.progress ?? 'AI berjalan…'}</span>
              <button class="btn btn-sm" onclick={() => aiPick.cancel()}><Icon name="x" size={12} /> Batalkan</button>
            {:else}
              <button class="btn btn-sm btn-primary" onclick={startAiPick} disabled={!picks.length}><Icon name="sparkles" size={12} /> Pilih dengan AI</button>
              {#if aiPick.job?.status === 'done' && aiPick.job.sourceBranch === plan.sourceBranch}<span class="muted small">Pilihan AI ({aiPick.job.model}){aiPick.job.instruction ? ` · instruksi: ${aiPick.job.instruction}` : ''}</span>{/if}
            {/if}
          </div>
          {#if aiPick.job?.status === 'done' && aiPick.job.sourceBranch === plan.sourceBranch && aiPick.job.notes?.length}
            <ul class="small ai-notes">{#each aiPick.job.notes as n, i (i)}<li>{n}</li>{/each}</ul>
          {/if}
          <ul class="picks">
            {#each picks as p (p.sha)}
              <li class:off={!p.include}>
                <label>
                  <input type="checkbox" bind:checked={p.include} />
                  <span class="mono">{p.shortId}</span>
                  {#if p.merge}<span class="tag">merge</span>{/if}
                  <span class="ptitle">{p.title}</span>
                  {#if p.reason === 'out-of-scope'}<span class="tag bad-tag">di luar scope: {p.outsideKeys.join(', ')}</span>
                  {:else if p.reason === 'mixed'}<span class="tag bad-tag">campur: {p.outsideKeys.join(', ')} di luar scope</span>
                  {:else if p.reason === 'no-key'}<span class="tag warn-tag">tanpa Jira key</span>
                  {:else}<span class="tag ok-tag">{p.keys.join(', ')}</span>{/if}
                </label>
                {#if aiPicks[p.sha]}<div class="ai-reason small" class:no={!aiPicks[p.sha].include}><Icon name="sparkles" size={11} /> {aiPicks[p.sha].include ? 'Masuk' : 'Tidak masuk'}{aiPicks[p.sha].keys.length ? ` (${aiPicks[p.sha].keys.join(', ')})` : ''}: {aiPicks[p.sha].reason}</div>{/if}
              </li>
            {:else}
              <li class="muted small">Tidak ada commit untuk dipilih.</li>
            {/each}
          </ul>
          {#if branchResult?.failed}
            <p class="err small">Berhenti di <span class="mono">{branchResult.failed.sha.slice(0, 8)}</span> {branchResult.failed.title ?? ''}: {branchResult.failed.error}. {branchResult.picked} commit sebelumnya sudah masuk ke branch {branchName}. Selesaikan konfliknya secara lokal (git cherry-pick), push, lalu Bandingkan dengan branch itu.</p>
          {/if}
          <p class="small">{chosen.length} dari {picks.length} commit dipilih</p>
          <div class="row">
            <button class="btn btn-sm" onclick={copyCommands} disabled={!chosen.length}><Icon name="copy" size={12} /> Salin perintah git</button>
            <button class="btn btn-sm btn-primary" onclick={makeBranch} disabled={branching || !chosen.length || !branchName.trim() || plan.canCreate === false}><Icon name="merge" size={12} /> {branching ? 'Membuat…' : 'Buat branch & cherry-pick di GitLab'}</button>
          </div>
          {:else}
          <div class="patch">
            <div class="row">
              {#if aiPatch.running}
                <span class="small ai-status"><Icon name="sparkles" size={12} /> {aiPatch.job?.progress ?? 'AI berjalan…'}</span>
                <button class="btn btn-sm" onclick={() => aiPatch.cancel()}><Icon name="x" size={12} /> Batalkan</button>
              {:else}
                <button class="btn btn-sm btn-primary" onclick={startAiPatch}><Icon name="sparkles" size={12} /> Susun perubahan dengan AI</button>
              {/if}
            </div>
            {#if patchDone}
              {#if patchDone.notes?.length}<ul class="small ai-notes">{#each patchDone.notes as n, i (i)}<li>{n}</li>{/each}</ul>{/if}
              {#each patchDone.patch?.files ?? [] as f, fi (fi)}
                <div class="pfile">
                  <div class="small"><span class="mono">{f.path}</span> <span class="tag">{f.status === 'new' ? 'file baru' : f.status === 'deleted' ? 'dihapus' : `${f.hunks.length} hunk`}</span></div>
                  {#each f.hunks as h (h.id)}
                    <div class="phunk" class:off={!patchSel[h.id]}>
                      <label class="small"><input type="checkbox" bind:checked={patchSel[h.id]} onchange={() => (patchPreview = null)} /> baris {h.at}: +{h.added.length} / −{h.removed.length}{h.reason ? ` · ${h.reason}` : ''}</label>
                      <details><summary class="small muted">lihat</summary><pre class="sqlbox">{[...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`)].join('\n')}{h.more ? `\n… (${h.more} baris lagi)` : ''}</pre></details>
                    </div>
                  {/each}
                </div>
              {/each}
              {#if patchPreview}
                <div class="pfile">
                  <strong class="small">Hasil di {plan.targetBranch} (belum ditulis)</strong>
                  {#each patchPreview.files as pf, pi (pi)}
                    <div class="small"><span class="mono">{pf.path}</span> · {pf.status === 'create' ? 'file baru' : pf.status === 'delete' ? 'dihapus' : 'diubah'}</div>
                    {#if pf.problem}<div class="small err-text">{pf.problem}</div>{/if}
                    {#if pf.changes?.length}<ul class="small">{#each pf.changes as c, i (i)}<li class="mono">{c}</li>{/each}</ul>{/if}
                    <details><summary class="small muted">diff terhadap {plan.targetBranch}</summary><pre class="sqlbox">{pf.diff || '(tidak ada perubahan)'}</pre></details>
                  {/each}
                </div>
              {/if}
              <div class="row">
                <span class="small">{patchChosen.length} perubahan dipilih</span>
                <button class="btn btn-sm" onclick={previewPatch} disabled={previewing || !patchChosen.length}>{previewing ? 'Menyusun…' : 'Lihat hasil'}</button>
                <button class="btn btn-sm btn-primary" onclick={() => makePatchBranch()} disabled={patching || !patchChosen.length || !branchName.trim() || plan.canCreate === false}><Icon name="merge" size={12} /> {patching ? 'Membuat…' : 'Buat branch dari perubahan pilihan'}</button>
              </div>
            {/if}
          </div>
          {/if}
        </section>
      {/if}

      <div class="actions">
        <label class="field grow"><span class="small">Judul MR</span><input class="input" bind:value={title} /></label>
        <span class="muted small token-note">
          {#if plan.canCreate === false}Token GitLab tidak punya scope <code>api</code>: pakai "Buka form di GitLab", atau buat token baru dengan scope api lalu simpan di Koneksi.{:else if plan.canCreate === undefined}Scope token tidak bisa dicek; kalau GitLab menolak, pakai "Buka form di GitLab".{/if}
        </span>
        <button class="btn btn-sm" onclick={openForm} disabled={!plan.formUrl}><Icon name="external" size={12} /> Buka form di GitLab</button>
        <button class="btn btn-primary btn-sm" onclick={create} disabled={creating || !title.trim() || plan.canCreate === false || !plan.sourceExists || !plan.targetExists || (!plan.commits.length && !plan.existing)}>
          <Icon name="merge" size={12} /> {creating ? 'Membuat…' : plan.existing ? 'Tautkan MR yang ada' : 'Buat MR'}
        </button>
      </div>
    {:else if loading}
      <p class="muted small">Membandingkan {source} dengan {release.targetBranch} di GitLab…</p>
    {/if}
  </div>
</Modal>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row,
  /* The MR title and the create button stay in view while the tabs scroll. */
  .actions {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    position: sticky;
    bottom: 0;
    z-index: 2;
    padding: 10px 0 2px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .src {
    width: 180px;
  }
  .grow {
    flex: 1;
    min-width: 200px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
  }
  ul {
    margin: 0;
    padding-left: 16px;
  }
  .commits,
  .tickets {
    max-height: 180px;
    overflow: auto;
  }
  .findings .w,
  .tickets .unsure {
    color: var(--warn);
  }
  .evidence {
    overflow-wrap: anywhere;
  }
  .tickets .missing {
    color: var(--warn, #b45309);
  }
  .bad {
    color: var(--err);
  }
  .changes {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .changes .row > :global(.input) {
    flex: 1;
    width: auto;
  }
  .diffs {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 55vh;
    overflow: auto;
  }
  /* A file card clips its content (overflow: hidden): in a height-capped flex column it would
     shrink to fit and cut the diff instead of letting the list scroll. */
  .diffs > :global(*) {
    flex-shrink: 0;
  }
  .branch {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .link-btn {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font: inherit;
    font-size: 13px;
    text-align: left;
  }
  .bname {
    width: 240px;
  }
  .picks {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 220px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .picks li label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .ai-status {
    color: var(--accent);
  }
  .sqlbox {
    margin: 4px 0;
    padding: 6px 8px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    font-size: 12px;
  }
  .patch {
    border-top: 1px dashed var(--border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .flag {
    border-top: 1px dashed var(--border);
    padding-top: 8px;
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .summary {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .summary.ok {
    border-color: var(--ok, #15803d);
  }
  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .chip.good {
    color: var(--ok, #15803d);
    border-color: var(--ok, #15803d);
  }
  .chip.badc {
    color: var(--err);
    border-color: var(--err);
  }
  .next {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
  }
  .tabbar {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
  }
  .tabbar button {
    border: none;
    background: none;
    padding: 6px 12px;
    font: inherit;
    font-size: 13px;
    color: var(--text-2, inherit);
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .tabbar button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .method {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .token-note {
    flex-basis: 100%;
    order: 9;
  }
  .safety {
    border: 1px solid var(--warn, #b45309);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .safety.ok {
    border-color: var(--ok, #15803d);
  }
  .layers {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .layers li.bad {
    color: var(--err);
  }
  .layers li.warn {
    color: var(--warn);
  }
  .layers ul {
    padding-left: 18px;
    color: var(--text-2, inherit);
  }
  .pfile {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    background: var(--surface);
  }
  .phunk {
    padding: 2px 0 2px 8px;
  }
  .phunk.off {
    opacity: 0.6;
  }
  .pick-ins {
    width: 100%;
  }
  .ai-notes {
    margin: 0;
    color: var(--warn);
  }
  .ai-reason {
    padding: 0 8px 6px 30px;
    color: var(--ok, var(--accent));
  }
  .ai-reason.no {
    color: var(--warn);
  }
  .picks li.off {
    opacity: 0.65;
  }
  .ptitle {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--surface-hover);
    white-space: nowrap;
  }
  .ok-tag {
    background: var(--ok-soft);
  }
  .warn-tag {
    background: var(--warn-soft);
  }
  .bad-tag {
    background: var(--err-soft);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .field > span {
    font-weight: 600;
  }
  .note,
  .warn {
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .warn p {
    margin: 0;
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
    }
</style>
