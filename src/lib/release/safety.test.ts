import { describe, expect, it } from 'vitest';
import { fileProblems, notFromSource, safetyOk, type SafetyResult } from './safety';

const TARGET = ['func A() {}', 'func B() {}'].join('\n');
const SOURCE = ['func A() {}', 'func B() {}', 'func Topup() {}', 'func Kyc() {}'].join('\n');

describe('release branch safety', () => {
  it('accepts a release branch made only of changes from the source', () => {
    const release = ['func A() {}', 'func B() {}', 'func Topup() {}'].join('\n');
    expect(notFromSource('a.go', TARGET, release, SOURCE)).toEqual([]);
    // Formatting and a trailing comma do not count as new code.
    expect(notFromSource('a.go', TARGET, ['func A()  {}', 'func B() {},', 'func Topup() {}'].join('\n'), SOURCE)).toEqual([]);
  });

  it('flags code the source does not have (a hand-made conflict fix) and removals the source keeps', () => {
    const release = ['func A() {}', 'func Topup() { fixed() }'].join('\n');
    expect(notFromSource('a.go', TARGET, release, SOURCE)).toEqual([
      { path: 'a.go', line: 2, text: 'func Topup() { fixed() }', reason: 'baris ini tidak ada di branch sumber (belum pernah dites di sana)' },
      { path: 'a.go', text: 'func B() {}', reason: 'baris ini dihapus di branch rilis tapi masih ada di branch sumber' },
    ]);
  });

  it('flags a file the release changes but the source does not', () => {
    expect(notFromSource('b.go', 'x', 'x\ny', 'x')).toHaveLength(1);
  });

  it('finds conflict markers and broken JSON', () => {
    expect(fileProblems('a.go', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feat')).toHaveLength(3);
    expect(fileProblems('k.json', '{"a": 1,}')[0].reason).toMatch(/bukan JSON valid/);
    expect(fileProblems('k.json', '{"a": 1}')).toEqual([]);
  });

  it('is safe only when every layer is green', () => {
    const r: SafetyResult = { branch: 'release/x', from: 'staging', subset: [], files: [], deps: { verdict: 'aman', issues: [] }, pipeline: { status: 'success' }, skipped: [] };
    expect(safetyOk(r)).toBe(true);
    expect(safetyOk({ ...r, pipeline: { note: 'Belum ada pipeline' } })).toBe(false);
    expect(safetyOk({ ...r, deps: { verdict: 'perlu dicek', issues: [] } })).toBe(false);
    expect(safetyOk({ ...r, subset: [{ path: 'a', reason: 'x' }] })).toBe(false);
  });
});
