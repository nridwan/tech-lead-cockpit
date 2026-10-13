import { DEFAULT_AI_SELECTION, isAiSelection, type AiSelection } from '../ai/types';
import { appSettings } from '../settings/store.svelte';
import { releases } from './client';
import type { ReleaseAiJob } from './types';

const AI_KEY = 'tlc.ai.release';
const POLL_MS = 2500;

/** The default AI from the setup wizard, else the app default. */
function configured(): AiSelection {
  const ai = appSettings.value.ai;
  return appSettings.loaded && ai?.defaultProvider ? { provider: ai.defaultProvider, model: ai.defaultModel } : DEFAULT_AI_SELECTION;
}

/** The AI chosen for release checks (remembered per viewer), else the configured default. */
export function loadReleaseAi(): AiSelection {
  try {
    const v = JSON.parse(localStorage.getItem(AI_KEY) ?? 'null');
    return isAiSelection(v) ? v : configured();
  } catch {
    return configured();
  }
}

export function saveReleaseAi(ai: AiSelection) {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(ai));
  } catch {
    /* ignore */
  }
}

/**
 * Follows one background AI job of a release: loads the last one, starts a new one, polls while
 * it runs, and calls `onDone` once when a job it watched finishes.
 */
export class AiJobWatch {
  job = $state<ReleaseAiJob | null>(null);
  error = $state('');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;

  constructor(
    private readonly releaseId: () => string | undefined,
    readonly kind: ReleaseAiJob['kind'],
    private readonly serviceId: () => string | undefined = () => undefined,
    private readonly onDone: (job: ReleaseAiJob) => void = () => {},
  ) {}

  get running() {
    return this.job?.status === 'running';
  }

  async load() {
    const id = this.releaseId();
    if (!id) return;
    try {
      this.job = await releases.aiJob(id, this.kind, this.serviceId());
      if (this.running) this.poll();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async start(ai: AiSelection, opts: { sourceBranch?: string; instruction?: string; paths?: string[] } = {}) {
    const id = this.releaseId();
    if (!id) return;
    this.error = '';
    try {
      this.job = await releases.aiStart(id, this.kind, ai, { serviceId: this.serviceId(), ...opts });
      this.poll();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Throws the last result away (local only). */
  async discard() {
    const id = this.releaseId();
    if (!id) return;
    this.stop();
    try {
      await releases.aiDiscard(id, this.kind, this.serviceId());
      this.job = null;
      this.error = '';
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async cancel() {
    const id = this.releaseId();
    if (id) this.job = await releases.aiCancel(id, this.kind, this.serviceId()).catch(() => this.job);
  }

  private poll() {
    this.watching = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const id = this.releaseId();
      if (!id) return;
      try {
        this.job = await releases.aiJob(id, this.kind, this.serviceId());
      } catch {
        /* keep polling */
      }
      if (this.running) this.poll();
      else if (this.watching && this.job) {
        this.watching = false;
        this.onDone(this.job);
      }
    }, POLL_MS);
  }

  stop() {
    clearTimeout(this.timer);
    this.watching = false;
  }
}
