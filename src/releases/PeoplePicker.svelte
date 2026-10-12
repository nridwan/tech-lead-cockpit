<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { connector } from '../lib/confluence/client';
  import type { DeployPerson } from '../lib/release/types';

  /** People for a deployment page field: Confluence accounts (mentions) or plain names. */
  let { people = $bindable([]), single = false, label = 'orang' }: { people: DeployPerson[]; single?: boolean; label?: string } = $props();

  let q = $state('');
  let results = $state<{ accountId: string; displayName: string; email?: string }[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function search(v: string) {
    q = v;
    clearTimeout(timer);
    if (v.trim().length < 2) return void (results = []);
    timer = setTimeout(async () => {
      results = await connector.searchUsers(v.trim()).catch(() => []);
    }, 300);
  }

  function add(p: DeployPerson) {
    if (people.some((x) => (p.accountId ? x.accountId === p.accountId : x.name === p.name))) return;
    people = single ? [p] : [...people, p];
    q = '';
    results = [];
  }
</script>

<div class="picker">
  {#each people as p, i (`${p.accountId ?? p.name}-${i}`)}
    <span class="chip" title={p.accountId ? 'Mention Confluence' : 'Nama (bukan mention)'}>{p.accountId ? '@' : ''}{p.name}<button class="x" onclick={() => (people = people.filter((_, j) => j !== i))} aria-label="Hapus {p.name}"><Icon name="x" size={10} /></button></span>
  {/each}
  {#if !single || !people.length}
    <span class="search">
      <input class="input" value={q} oninput={(e) => search(e.currentTarget.value)} placeholder="Cari {label} di Confluence" onkeydown={(e) => e.key === 'Enter' && q.trim() && !results.length && add({ name: q.trim() })} />
      {#if results.length}
        <span class="results">
          {#each results as u (u.accountId)}<button onclick={() => add({ accountId: u.accountId, name: u.displayName })}>{u.displayName}{u.email ? ` · ${u.email}` : ''}</button>{/each}
        </span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
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
  .search {
    position: relative;
    flex: 1 1 160px;
  }
  .search :global(.input) {
    width: 100%;
    padding: 3px 8px;
    font-size: 12px;
  }
  .results {
    position: absolute;
    z-index: 5;
    top: 100%;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .results button {
    border: none;
    background: none;
    padding: 6px 8px;
    text-align: left;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
  }
  .results button:hover {
    background: var(--surface-hover);
  }
</style>
