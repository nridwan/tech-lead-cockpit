import { describe, expect, it } from 'vitest';
import { applyFileHunks, fileHunks, hunkNumber, hunkPath, jsonChanges, jsonProblem, locateRoutes, patchFile, routePatterns } from './patch';

// Multi-line route blocks like a gateway config. The source reformats /v1/a, inserts a scope route
// after it, and appends an out-of-scope route at the end (which also adds a comma to /v1/b's "}").
const block = (path: string, last = false) => ['    {', `      "endpoint": "${path}",`, '      "method": "GET"', `    }${last ? '' : ','}`];
const TARGET = ['{', '  "endpoints": [', ...block('/v1/a'), ...block('/v1/b', true), '  ]', '}'].join('\n');
const SOURCE = [
  '{',
  '  "endpoints": [',
  '    {',
  '      "endpoint":   "/v1/a",',
  '      "method":  "GET"',
  '    },',
  ...block('/v1/topup/{id}'),
  ...block('/v1/b'),
  ...block('/v1/kyc/province', true),
  '  ]',
  '}',
].join('\n');

describe('release branch from chosen hunks', () => {
  const fh = fileHunks(TARGET, SOURCE);

  it('splits changes into hunks, ignoring a reformat', () => {
    const p = patchFile('k.json', 'modified', fh);
    // The spaces-only change of /v1/a is not a hunk; the scope route is a hunk of its own.
    expect(p.hunks.map((h) => h.id)).toEqual(['k.json#0', 'k.json#1']);
    expect(p.hunks[0].added.join('\n')).toContain('/v1/topup/{id}');
    expect(p.hunks[0].added.join('\n')).not.toContain('/v1/kyc');
    expect(p.hunks[0].removed).toEqual([]);
    expect(p.hunks[1].added.join('\n')).toContain('/v1/kyc/province');
    expect([hunkPath('a/b.json#12'), hunkNumber('a/b.json#12')]).toEqual(['a/b.json', 12]);
  });

  it("applies only the chosen hunks on the target's text", () => {
    const out = applyFileHunks(fh, new Set([0]));
    expect(out).toBe(['{', '  "endpoints": [', ...block('/v1/a'), ...block('/v1/topup/{id}'), ...block('/v1/b', true), '  ]', '}'].join('\n'));
    expect(jsonProblem('k.json', out)).toBeUndefined();
    expect(JSON.parse(applyFileHunks(fh, new Set([0, 1]))).endpoints).toHaveLength(4);
    expect(applyFileHunks(fh, new Set())).toBe(TARGET);
  });

  it('tells whether a route named in the instruction is in a hunk, already in the target, or nowhere', () => {
    const [p] = routePatterns('endpoint /v1/topup/{id} harus ikut');
    expect(p.re.test('"endpoint": "/v1/topup/{trx_id}",')).toBe(true);
    expect(p.re.test('"endpoint": "/v1/topup/channel/{id}",')).toBe(false);
    expect(locateRoutes('/v1/topup/{id} dan /v1/a dan /v1/zzz/{x}', [{ path: 'k.json', fh }])).toEqual([
      { path: '/v1/topup/{id}', where: 'hunk', file: 'k.json' },
      { path: '/v1/a', where: 'target', file: 'k.json', line: 4 },
      { path: '/v1/zzz/{x}', where: 'none' },
    ]);
  });

  it('summarises what the JSON data gains, formatting ignored', () => {
    expect(jsonChanges(TARGET, applyFileHunks(fh, new Set([0]), 'k.json'))).toEqual(['endpoints + {endpoint: /v1/topup/{id}, method: GET}']);
    expect(jsonChanges('{"a": 1, "b": [1]}', '{"a": 2, "b": [1], "c": "x"}')).toEqual(['a: 1 → 2', 'c + "x"']);
  });

  it('flags a JSON file broken by a partial choice', () => {
    expect(jsonProblem('k.json', '{"a": 1,}')).toMatch(/bukan JSON valid/);
    expect(jsonProblem('a.go', 'func {')).toBeUndefined();
    // JSON.parse accepts a key written twice; a broken merge must not pass.
    expect(jsonProblem('k.json', '{\n  "a": 1,\n  "b": {"a": 2},\n  "a": 3\n}')).toMatch(/key ganda: "a" baris 4/);
    expect(jsonProblem('k.json', '{"a": "x\\"y", "b": [{"a": 1}, {"a": 2}]}')).toBeUndefined();
  });

  it('treats a new or deleted file as one change', () => {
    expect(fileHunks(undefined, 'a\nb').hunks).toHaveLength(1);
    expect(applyFileHunks(fileHunks(undefined, 'a\nb'), new Set([0]))).toBe('a\nb');
    expect(fileHunks('x', undefined).hunks).toHaveLength(1);
  });
});
