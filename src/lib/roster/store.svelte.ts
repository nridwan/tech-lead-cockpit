import { roster } from './client';
import type { TeamMember } from './types';

/** The team roster shared by every screen (Projects sidebar, Estimate panel), loaded once. */
class RosterState {
  members = $state<TeamMember[]>([]);
  loaded = $state(false);
  private loading?: Promise<void>;

  /** Loads on first use; `force` reloads (e.g. before opening the roster). */
  load(force = false): Promise<void> {
    if (this.loaded && !force) return Promise.resolve();
    this.loading ??= roster
      .list()
      .then((m) => {
        this.members = m;
        this.loaded = true;
      })
      .catch(() => {})
      .finally(() => (this.loading = undefined));
    return this.loading;
  }
}

export const rosterState = new RosterState();
