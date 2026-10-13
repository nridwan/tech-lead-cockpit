import { describe, expect, it } from 'vitest';
import { applyFlagEdits, flagBranchName, flagPrompt, parseFlagReply, textHash } from './flag';

const MAIN = ['func main() {', '\tc := cron.New()', '\tc.AddFunc(cfg.Tax, scheduler.TaxReport)', '\tc.Start()', '}'].join('\n');

describe('feature flag', () => {
  it('asks for an off-by-default flag in the repo style, with exact find/replace edits', () => {
    const p = flagPrompt({ repo: 'g/worker', base: 'staging', target: 'master', what: 'scheduler pajak', files: [{ path: 'main.go', content: MAIN }], diff: '+x', conventions: 'FDS_ENABLE=false' });
    expect(p).toContain('Default MATI');
    expect(p).toContain('FDS_ENABLE=false');
    expect(p).toContain('### main.go');
  });

  it('applies edits only when their text is found exactly once', () => {
    const plan = parseFlagReply(
      JSON.stringify({
        flags: [{ flag: 'TAX_SCHEDULER_ENABLE', summary: 'scheduler pajak' }, { flag: 'FDS_WINDOW_ENABLE', summary: 'laporan FDS per jendela' }, { flag: '' }],
        edits: [
          { path: 'main.go', find: '\tc.AddFunc(cfg.Tax, scheduler.TaxReport)', replace: '\tif os.Getenv("TAX_SCHEDULER_ENABLE") == "true" {\n\t\tc.AddFunc(cfg.Tax, scheduler.TaxReport)\n\t}' },
          { path: '.env.example', find: 'A=1', replace: 'A=1\nTAX_SCHEDULER_ENABLE=false' },
          { path: 'main.go', find: 'tidak ada', replace: 'x' },
          { path: '../etc/passwd', find: '', replace: 'x' },
          { path: 'docs/flag.md', find: '', replace: '# Flag' },
        ],
      }),
    )!;
    // One flag per feature; all of them in one change.
    expect(plan.flags).toEqual([{ name: 'TAX_SCHEDULER_ENABLE', summary: 'scheduler pajak' }, { name: 'FDS_WINDOW_ENABLE', summary: 'laporan FDS per jendela' }]);
    expect(parseFlagReply(JSON.stringify({ flag: 'OLD_ENABLE', summary: 'x', edits: [] }))!.flags).toEqual([{ name: 'OLD_ENABLE', summary: 'x' }]);
    expect(plan.edits.map((e) => e.path)).toEqual(['main.go', '.env.example', 'main.go', 'docs/flag.md']);
    const r = applyFlagEdits(plan.edits, new Map([['main.go', MAIN], ['.env.example', 'A=1']]));
    expect(r.files.map((f) => [f.path, f.status])).toEqual([
      ['main.go', 'update'],
      ['.env.example', 'update'],
      ['docs/flag.md', 'create'],
    ]);
    expect(r.files[0].content).toContain('if os.Getenv("TAX_SCHEDULER_ENABLE") == "true" {');
    expect(r.files[0].preview).toContain('+\tif os.Getenv("TAX_SCHEDULER_ENABLE") == "true" {');
    expect(r.files[0].baseHash).toBe(textHash(MAIN));
    expect(r.problems).toEqual(['main.go: potongan yang diganti tidak ditemukan; edit dilewati.']);
  });

  it('refuses an ambiguous edit and a broken JSON result', () => {
    const r = applyFlagEdits([{ path: 'a.go', find: 'x', replace: 'y' }, { path: 'c.json', find: '"a": 1', replace: '"a": 1,' }], new Map([['a.go', 'x x'], ['c.json', '{"a": 1}']]));
    expect(r.problems).toEqual(['a.go: potongan yang diganti muncul lebih dari sekali; edit dilewati.', expect.stringMatching(/c\.json bukan JSON valid/)]);
  });

  it('names the branch after the flag', () => {
    expect(flagBranchName('TAX_SCHEDULER_ENABLE')).toBe('feature-flag/tax-scheduler-enable');
    expect(flagBranchName('***')).toBe('feature-flag/baru');
    expect(flagBranchName(['TAX_ENABLE', 'FDS_ENABLE', 'KYC_ENABLE'])).toBe('feature-flag/tax-enable-dan-2-lainnya');
    expect(textHash('a')).not.toBe(textHash('b'));
    expect(textHash(undefined)).toBe('none');
  });
});
