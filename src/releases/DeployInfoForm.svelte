<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { DEFAULT_ROLES } from '../lib/release/deployment';
  import { RELEASE_STATUS_LABELS, type DeployInfo, type Release } from '../lib/release/types';
  import PeoplePicker from './PeoplePicker.svelte';

  /** The release info of the deployment page (top table, Change Log, Release List, evidence). */
  let { release }: { release: Release } = $props();

  const STATUS = ['', 'DRAFT', 'DOCUMENT APPROVAL', 'READY TO DEPLOY', 'ON PROGRESS', 'DONE', 'ROLLBACK'];
  const COLOUR: Record<string, string> = { DRAFT: 'Grey', 'DOCUMENT APPROVAL': 'Blue', 'READY TO DEPLOY': 'Yellow', 'ON PROGRESS': 'Purple', DONE: 'Green', ROLLBACK: 'Red' };

  // Every edit goes to release.deploy, created with the default roles the first time.
  $effect.pre(() => {
    if (!release.deploy) release.deploy = { roles: DEFAULT_ROLES.map((label) => ({ label, people: [] })), changeLog: [], testEvidence: [] };
  });
  const d = $derived(release.deploy as DeployInfo);

  let newRole = $state('');
</script>

{#if release.deploy}
<section class="form">
  <h4><Icon name="doc" size={14} /> Info dokumen Deployment</h4>
  <div class="grid">
    <label class="field"><span>Jam rilis</span><input class="input" bind:value={d.targetTime} placeholder="mis. 06:00" /></label>
    <label class="field"><span>Actual Release</span><input class="input" bind:value={d.actual} placeholder="TBA" /></label>
    <label class="field">
      <span>Deployment Status</span>
      <select class="input" value={d.statusTitle ?? ''} onchange={(e) => { d.statusTitle = e.currentTarget.value || undefined; d.statusColour = COLOUR[e.currentTarget.value]; }}>
        {#each STATUS as s (s)}<option value={s}>{s || `ikuti status rilis (${RELEASE_STATUS_LABELS[release.status]})`}</option>{/each}
      </select>
    </label>
    <label class="field"><span>Deployment Impact</span><input class="input" bind:value={d.impact} placeholder="-" /></label>
    <label class="field"><span>Deployment Room</span><input class="input" bind:value={d.room} /></label>
    <label class="field"><span>Issue/Request Link</span><input class="input" bind:value={d.issueLink} placeholder="https://…" /></label>
  </div>

  <div class="roles">
    {#each d.roles as role, i (role.label + i)}
      <div class="role">
        <span class="rlabel">{role.label}</span>
        <PeoplePicker bind:people={role.people} label={role.label} />
        <button class="icon-btn" onclick={() => (d.roles = d.roles.filter((_, j) => j !== i))} aria-label="Hapus peran {role.label}"><Icon name="x" size={11} /></button>
      </div>
    {/each}
    <div class="role">
      <input class="input rinput" bind:value={newRole} placeholder="Peran lain" onkeydown={(e) => { if (e.key === 'Enter' && newRole.trim()) { d.roles = [...d.roles, { label: newRole.trim(), people: [] }]; newRole = ''; } }} />
    </div>
  </div>

  <h5>Change Log</h5>
  {#each d.changeLog as c, i (i)}
    <div class="row">
      <span class="no">{i + 1}</span>
      <input class="input" bind:value={c.details} placeholder="Details (fitur/perubahan)" />
      <input class="input" bind:value={c.notes} placeholder="Notes" />
      <button class="icon-btn" onclick={() => (d.changeLog = d.changeLog.filter((_, j) => j !== i))} aria-label="Hapus baris"><Icon name="x" size={11} /></button>
    </div>
  {/each}
  <button class="btn btn-sm" onclick={() => (d.changeLog = [...d.changeLog, { details: '', notes: '' }])}><Icon name="plus" size={12} /> Baris Change Log</button>

  <div class="grid two">
    <label class="field">
      <span>Release List (JQL)</span>
      <input class="input mono" value={d.releaseList?.jql ?? ''} oninput={(e) => (d.releaseList = { ...d.releaseList, jql: e.currentTarget.value || undefined })} placeholder="kosong = key in (tiket rilis)" />
    </label>
    <div class="field">
      <span>Bukti Post Deployment Test</span>
      {#each d.testEvidence as ev, i (i)}
        <div class="row"><input class="input" bind:value={ev.title} placeholder="Judul" /><input class="input" bind:value={ev.url} placeholder="https://…" /><button class="icon-btn" onclick={() => (d.testEvidence = d.testEvidence.filter((_, j) => j !== i))} aria-label="Hapus"><Icon name="x" size={11} /></button></div>
      {/each}
      <button class="btn btn-sm" onclick={() => (d.testEvidence = [...d.testEvidence, { title: '', url: '' }])}><Icon name="plus" size={12} /> Link bukti</button>
    </div>
  </div>
</section>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  h4,
  h5 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  h5 {
    margin-top: 6px;
    font-size: 12.5px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .grid.two {
    grid-template-columns: 1fr 1fr;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
  }
  .field > span {
    font-weight: 600;
  }
  .roles {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .role,
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .row > :global(.input) {
    flex: 1;
    width: auto;
  }
  .rlabel {
    flex: 0 0 150px;
    font-size: 12px;
    font-weight: 600;
  }
  .rinput {
    width: 150px;
  }
  .no {
    flex: 0 0 20px;
    font-size: 12px;
    text-align: center;
  }
  .icon-btn {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 2px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  @media (max-width: 760px) {
    .grid,
    .grid.two {
      grid-template-columns: 1fr;
    }
  }
</style>
