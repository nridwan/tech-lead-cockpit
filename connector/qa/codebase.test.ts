// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import { QaManager } from './manager.ts';

const REPLY = '{"flows":[{"name":"Health","steps":[{"name":"health","service":"core-promo-ultimate","request":{"method":"GET","path":"/health"}}]}]}';

describe('generation against the codebase', () => {
  let dir = '';
  let services = '';
  const calls: { prompt: string; readOnlyDirs?: string[] }[] = [];
  let touched: string[] = [];
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async () => null,
      writeSecret: async () => true,
      deleteSecret: async () => true,
      resolveServicesRoot: async () => services,
      watchRepos: async () => async () => touched,
      runAi: (_ai, prompt, opts) => (calls.push({ prompt, readOnlyDirs: opts.readOnlyDirs }), { done: Promise.resolve({ reply: REPLY }), cancel: () => {} }),
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-code-'));
    services = join(dir, 'Services');
    await mkdir(join(services, 'core-promo-ultimate'), { recursive: true });
    await mkdir(join(services, 'core-tcico'), { recursive: true });
    calls.length = 0;
    touched = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const generate = async (m: QaManager, ai: AiSelection, useCodebase?: boolean) => {
    const job = await m.generate({ projectId: 'proj', projectName: 'P', ai, tasks: [{ title: 'Reserve', service: 'CORE-PROMO-ULTIMATE', spec: 'POST /reserve' }], categories: ['happy-path'], useCodebase });
    for (let i = 0; i < 200 && m.getJob(job.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
    return m.getJob(job.id)!;
  };

  it('lets a CLI agent read the codebase (read-only) and names the tasks\' service folders', async () => {
    await generate(manager(), { provider: 'claude', model: '' });
    expect(calls[0].readOnlyDirs).toEqual([services]);
    expect(calls[0].prompt).toContain('## Codebase (HANYA BACA)');
    expect(calls[0].prompt).toContain('Folder service task yang dipilih: core-promo-ultimate.');
    expect(calls[0].prompt).toContain('Health check / ping');
  });

  it('skips the codebase for API providers or when switched off', async () => {
    await generate(manager(), { provider: 'inferhub', model: '' });
    await generate(manager(), { provider: 'claude', model: '' }, false);
    for (const c of calls) {
      expect(c.readOnlyDirs).toEqual([]);
      expect(c.prompt).not.toContain('## Codebase');
    }
  });

  it('warns in the notes when a repo changed during generation', async () => {
    touched = ['core-promo-ultimate'];
    const job = await generate(manager(), { provider: 'claude', model: '' });
    expect(job.suite?.notes).toContain('PERINGATAN: working tree berubah selama generate di core-promo-ultimate');
  });
});
