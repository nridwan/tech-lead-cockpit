<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { estimate } from '../lib/estimate/client';
  import { schedule } from '../lib/estimate/schedule';
  import { projectAvailability } from '../lib/roster/availability';
  import { roster } from '../lib/roster/client';
  import type { TeamMember } from '../lib/roster/types';
  import type { EstimateProject, Holiday } from '../lib/estimate/types';
  import type { Draft } from './drafts.svelte';

  /** Which project the TAD belongs to (Task Board, progress report, estimate and E2E live there), with its target date. */
  let { draft }: { draft: Draft } = $props();

  let project = $state<EstimateProject | null>(null);
  let holidays = $state<Holiday[]>([]);
  let all = $state<EstimateProject[]>([]);
  let members = $state<TeamMember[]>([]);
  let loaded = $state(false);

  $effect(() => {
    const id = draft.id;
    untrack(() => void load(id));
  });

  async function load(id: string) {
    loaded = false;
    try {
      const [list, h, m] = await Promise.all([estimate.projects(), estimate.holidays(), roster.list().catch(() => [] as TeamMember[])]);
      all = list;
      members = m;
      if (draft.id !== id) return;
      project = list.find((p) => p.draftIds.includes(id)) ?? null;
      holidays = h.holidays;
    } catch {
      project = null;
    }
    loaded = true;
  }

  const end = $derived.by(() => {
    if (!project) return undefined;
    try {
      const r = schedule({ ...project, availability: projectAvailability(project, members, all, holidays) }, holidays);
      return r.complete && r.endDate ? r.endDate : undefined;
    } catch {
      return undefined;
    }
  });
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
</script>

{#if loaded}
  {#if project}
    <a class="chip chip-interactive" href="#/projects/{project.id}" title="Task Board, estimasi, E2E test, dan laporan terjadwal ada di menu Proyek">
      <Icon name="list" size={12} /> Proyek: {project.name}{end ? ` · selesai ${fmt(end)}` : ''}
    </a>
  {:else}
    <a class="chip chip-interactive" href="#/projects/new?draft={draft.id}" title="Task Board, estimasi, E2E test, dan laporan terjadwal ada di menu Proyek. Buat proyek dari TAD ini.">
      <Icon name="plus" size={12} /> Task Board &amp; Estimasi di Proyek
    </a>
  {/if}
{/if}

<style>
  .chip-interactive {
    text-decoration: none;
    color: inherit;
    border: 1px solid var(--border);
  }
  .chip-interactive:hover {
    background: var(--surface-hover);
  }
</style>
