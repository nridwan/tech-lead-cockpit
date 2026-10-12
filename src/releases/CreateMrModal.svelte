<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { AiJobWatch, loadReleaseAi, saveReleaseAi } from '../lib/release/ai-job.svelte';
  import Modal from '../components/Modal.svelte';
  import DiffFile from '../mr/DiffFile.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { openExternal } from '../lib/open-external';
  import { releaseBranchCommands, type BranchPick } from '../lib/release/branch';
  import { releases } from '../lib/release/client';
  import { aiMrSection } from '../lib/release/mr';
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
  let showBranch = $state(false);
  let branchName = $state('');
  let picks = $state<BranchPick[]>([]);
  let branching = $state(false);
  let branchResult = $state<{ picked: number; failed?: { sha: string; title?: string; error: string } } | null>(null);
  const chosen = $derived(picks.filter((p) => p.include));
  let plan = $state<MrPlan | null>(null);
  let loading = $state(false);
  let error = $state('');
  let title = $state('');
  let description = $state('');
  let creating = $state(false);
  let showChanges = $state(false);
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
  let baseDescription = '';
  const aiMr = new AiJobWatch(
    () => release.id,
    'mr',
    () => service.id,
    (job) => {
      if (job.status === 'done') applyAiMr(job);
      else if (job.status === 'error') toasts.show(`Cek AI MR gagal: ${job.error}`, 'err', 6000);
    },
  );
  const aiMrDone = $derived(aiMr.job?.status === 'done' && aiMr.job.sourceBranch === plan?.sourceBranch ? aiMr.job : null);
  const verdictOf = (key: string) => aiMrDone?.verdicts?.find((v) => v.key === key);

  /** Adds the AI's findings to the description, unless the user already edited it. */
  function applyAiMr(job: ReleaseAiJob) {
    if (!plan || job.sourceBranch !== plan.sourceBranch) return;
    const extra = aiMrSection(job);
    if (extra && description === baseDescription) {
      description = `${baseDescription}\n\n${extra}`;
      baseDescription = description;
    }
  }

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
      description = plan.description;
      baseDescription = description;
      branchName = plan.releaseBranch.branch;
      picks = plan.releaseBranch.commits.map((c) => ({ ...c }));
      // A dirty source: suggest the release branch right away.
      showBranch = plan.outOfScope.length > 0 || plan.releaseBranch.commits.some((c) => c.reason === 'out-of-scope' || c.reason === 'mixed');
      // The last AI pick for this branch still applies to the same commits.
      aiPicks = {};
      await aiPick.load();
      if (aiPick.job?.status === 'done' && aiPick.job.sourceBranch === plan.sourceBranch) {
        applyPicks(aiPick.job);
        showBranch = true;
      }
      patchSel = {};
      await aiPatch.load();
      if (aiPatch.job?.status === 'done' && aiPatch.job.sourceBranch === plan.sourceBranch) {
        applyPatch(aiPatch.job);
        showBranch = true;
      }
      // The AI read of this branch: reuse the last one, else start it.
      await aiMr.load();
      if (aiMr.job?.status === 'done' && aiMr.job.sourceBranch === plan.sourceBranch) applyAiMr(aiMr.job);
      else if (!aiMr.running && plan.files) void startAiMr();
    } catch (e) {
      error = (e as Error).message;
      plan = null;
    } finally {
      loading = false;
    }
  }

  async function create() {
    if (!plan) return;
    const ok = await confirmDialog({
      title: 'Buat MR di GitLab?',
      message: `MR ${plan.sourceBranch} → ${plan.targetBranch} akan dibuat di ${plan.projectPath} atas nama token GitLab kamu (${plan.commits.length} commit, ${plan.files} file).`,
      confirmText: 'Buat MR',
    });
    if (!ok) return;
    creating = true;
    try {
      const r = await releases.createMr(release.id, service.id, { sourceBranch: plan.sourceBranch, title, description });
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
      const r = await releases.createReleaseBranch(release.id, service.id, branchName.trim(), chosen.map((p) => ({ sha: p.sha, title: p.title })));
      branchResult = { picked: r.picked.length, failed: r.failed };
      oncreatedBranch(r.release);
      if (r.failed) {
        toasts.show(`Berhenti di ${r.failed.sha.slice(0, 8)}: ${r.failed.error}`, 'err', 8000);
      } else {
        toasts.show(`Branch ${r.branch} siap dengan ${r.picked.length} commit.`, 'ok', 4000);
        source = r.branch;
        showBranch = false;
        await load();
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
      showBranch = false;
      await load();
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
      {#if plan.warnings.length}
        <div class="warn">{#each plan.warnings as w (w)}<p><Icon name="alert" size={12} /> {w}</p>{/each}</div>
      {/if}

      <section class="branch">
        <button class="link-btn" onclick={() => (showBranch = !showBranch)}>{showBranch ? '▾' : '▸'} {plan.sourceBranch} juga berisi perubahan di luar rilis? Buat branch rilis dari {plan.targetBranch}</button>
        {#if showBranch}
          <p class="muted small">Commit jalur utama {plan.sourceBranch} (lama ke baru). Merge commit dihitung bersama isi branch fiturnya, jadi satu pilihan membawa satu fitur utuh. Klik <strong>Pilih dengan AI</strong>: AI membaca diff tiap commit dan memilih yang benar-benar milik scope, dengan alasannya.</p>
          <textarea class="input pick-ins" rows="2" bind:value={pickInstruction} placeholder="Instruksi untuk AI (opsional), mis. perubahan CI/Dockerfile tanpa task tetap ikut; commit refactor logger jangan ikut"></textarea>
          <div class="row">
            <AiPicker value={ai} onchange={(v) => (ai = v)} disabled={aiPick.running} />
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
          <div class="row">
            <label class="inline small">Nama branch <input class="input mono bname" bind:value={branchName} /></label>
            <span class="small">{chosen.length} dari {picks.length} commit dipilih</span>
          </div>
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
          <div class="patch">
            <h4>Ambil perubahan tertentu saja (per hunk)</h4>
            <p class="muted small">Untuk commit campuran, atau perubahan tanpa tiket yang diminta instruksi: AI memilih hunk perubahan {plan.targetBranch} → {plan.sourceBranch} yang masuk scope + instruksi di atas. Branch rilis dibuat dari {plan.targetBranch} dengan hanya perubahan itu, dalam satu commit.</p>
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
              {#each patchDone.patch?.files ?? [] as f (f.path)}
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
                  {#each patchPreview.files as pf (pf.path)}
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
          <div class="row">
            <button class="btn btn-sm" onclick={copyCommands} disabled={!chosen.length}><Icon name="copy" size={12} /> Salin perintah git</button>
            <button class="btn btn-sm btn-primary" onclick={makeBranch} disabled={branching || !chosen.length || !branchName.trim() || plan.canCreate === false}><Icon name="merge" size={12} /> {branching ? 'Membuat…' : 'Buat branch & cherry-pick di GitLab'}</button>
          </div>
        {/if}
      </section>

      <div class="grid">
        <section>
          <h4>Perbandingan</h4>
          <p class="small">{plan.commits.length} commit · {plan.files} file{plan.truncated ? ' (sebagian, perbandingan terpotong)' : ''}</p>
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
          {#if plan.outOfScope.length}
            <h4 class="bad">Di luar scope, akan ikut terbawa ({plan.outOfScope.length})</h4>
            <ul class="small tickets">
              {#each plan.outOfScope as o (o.key)}<li class="missing"><span class="mono">{o.key}</span> {o.summary ?? 'tidak termuat dari Jira'}{o.commits[0] ? ` · ${o.commits[0]}` : ''}</li>{/each}
            </ul>
          {/if}
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
                  {#if t.code}<div class="muted evidence">{t.code.strength === 'strong' ? '✓' : '≈'} {#each t.code.hits.slice(0, 3) as h (h.path)}<span class="mono">{h.path}</span> ({h.match}) {/each}</div>{:else if t.byKey}<div class="muted evidence">key ada di commit</div>{/if}
                </li>
              {/each}
            </ul>
            {#if aiMrDone?.unrelated?.length}
              <h4 class="w">Perubahan tanpa tiket (AI) — {aiMrDone.unrelated.length}</h4>
              <ul class="small tickets">{#each aiMrDone.unrelated as u (u.path)}<li class="missing"><span class="mono">{u.path}</span> — {u.reason}</li>{/each}</ul>
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
          {#if plan.commits.length}
            <h4>Commit</h4>
            <ul class="small commits">
              {#each plan.commits.slice(0, 30) as c (c.shortId)}<li><span class="mono">{c.shortId}</span> {c.title}</li>{/each}
              {#if plan.commits.length > 30}<li class="muted">… {plan.commits.length - 30} commit lain</li>{/if}
            </ul>
          {/if}
        </section>
        <section>
          <label class="field"><span>Judul MR</span><input class="input" bind:value={title} /></label>
          <label class="field"><span>Deskripsi</span><textarea class="input mono desc" rows="16" bind:value={description}></textarea></label>
        </section>
      </div>

      <section class="changes">
        <button class="link-btn" onclick={() => (showChanges = !showChanges)}>{showChanges ? '▾' : '▸'} Review perubahan ({plan.files} file, {plan.changes.reduce((n, c) => n + c.additions, 0)}+ / {plan.changes.reduce((n, c) => n + c.deletions, 0)}−) yang akan masuk ke {plan.targetBranch}</button>
        {#if showChanges}
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
        {/if}
      </section>

      <div class="actions">
        <span class="muted small grow">
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
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
  .grid {
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 16px;
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
  .patch h4 {
    margin: 0;
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
  .desc {
    font-size: 12px;
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
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
