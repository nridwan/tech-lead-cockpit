import { describe, expect, it } from 'vitest';
import type { MrFileChange } from '../gitlab/types';
import { compactDiff, diffText, fileDelta, focusTerms, parseDocumentReply, parseJsonReply, parsePicksReply, parseTicketsReply, picksPrompt, ticketsPrompt } from './ai';

const change = (path: string, diff: string): MrFileChange => ({ oldPath: path, newPath: path, newFile: false, renamedFile: false, deletedFile: false, diff, additions: 1, deletions: 0 });

describe('release AI prompts and answers', () => {
  it('fits diffs in a budget and lists the rest by name', () => {
    const { text, omitted } = diffText([change('a.go', '+a'.repeat(10)), change('b.go', '+b'.repeat(50)), change('c.bin', '')], 40);
    expect(text).toContain('### a.go');
    expect(text).toContain('- b.go');
    expect(text).toContain('- c.bin (diff tidak tersedia)');
    expect(omitted).toBe(2);
  });

  it('compacts a reformat down to what is really new', () => {
    const diff = ['@@ -1,4 +1,8 @@', ' {', '-  "a": [1, 2],', '+  "a": [', '+    1, 2', '+  ],', '+  "endpoint": "/v1/topup/{id}",', '   "b": 1', '-  "x": 1', '+  "x":   1'].join('\n');
    // "a": [1, 2] became three lines: not equal line by line, so those stay; "x" only changed spaces.
    const c = compactDiff(diff);
    expect(c).toContain('+  "endpoint": "/v1/topup/{id}",');
    expect(c).not.toContain('"x"');
    expect(c).not.toContain('"b": 1');
  });

  it('computes added and removed lines from two file versions, ignoring formatting', () => {
    const before = ['{', '  "endpoints": [', '    {"endpoint": "/v1/a"},', '  ]', '}'].join('\n');
    const after = ['{', '  "endpoints": [', '    { "endpoint": "/v1/a" },', '    {"endpoint": "/v1/topup/{id}"}', '  ]', '}'].join('\n');
    const d = fileDelta(before, after);
    expect(d).toContain('@@ baru baris 4 @@\n+    {"endpoint": "/v1/topup/{id}"}');
    expect(fileDelta('a\n b', 'a\nb')).toBe('');
  });

  it('puts hunks naming a focus path first when a big file is compacted', () => {
    expect(focusTerms(['ambil /v1/topup/mobile/{id} juga', 'GET /v1/x/y/:id'])).toEqual(['/v1/topup/mobile/', '/v1/x/y/']);
    const big = ['@@ -1 +1 @@', ...Array.from({ length: 400 }, (_, i) => `+"route_${i}": "/v1/other/${i}"`), '@@ -900 +900 @@', '+"endpoint": "/v1/topup/mobile/{id}"'].join('\n');
    const text = diffText([{ oldPath: 'k.json', newPath: 'k.json', newFile: false, renamedFile: false, deletedFile: false, diff: big, additions: 401, deletions: 0 }], 5_000, '', ['/v1/topup/mobile/']).text;
    expect(text).toContain('/v1/topup/mobile/{id}');
    expect(text).toContain('dipadatkan');
  });

  it('asks for every ticket and every deploy need', () => {
    const p = ticketsPrompt({ service: 'core-topup', target: 'master', refs: ['g/core-topup@staging'], tickets: [{ key: 'MU-1', summary: 'Develop API X', detail: 'Endpoint: /v1/x' }], commits: ['feat x'], diff: '### a.go\n+x' });
    expect(p).toContain('- MU-1: Develop API X');
    expect(p).toContain('Endpoint: /v1/x');
    expect(p).toMatch(/CREATE\/ALTER\/DROP TABLE/);
    expect(p).toContain('"needs"');
  });

  it('reads the JSON object out of a chatty or fenced reply', () => {
    expect(parseJsonReply('Berikut hasilnya:\n```json\n{"a": "x } y", "b": [1]}\n```')).toEqual({ a: 'x } y', b: [1] });
    expect(parseJsonReply('ok {"a":1} lalu {"b":2}')).toEqual({ a: 1 });
    expect(parseJsonReply('tidak ada')).toBeNull();
  });

  it('keeps only asked tickets, changed files and valid needs', () => {
    const reply = JSON.stringify({
      tickets: [
        { key: 'mu-1', verdict: 'ada', files: ['a.go', 'tidak/ada.go'], reason: 'handler X' },
        { key: 'MU-9', verdict: 'ada', files: [], reason: 'bukan tiket rilis' },
        { key: 'MU-2', verdict: 'mungkin', files: [], reason: '' },
      ],
      unrelated: [{ path: 'b.go', reason: 'fitur lain' }, { path: 'x.go', reason: 'tidak berubah' }],
      needs: [
        { kind: 'env', when: 'pre', label: 'Tambah env `TOPUP_LIMIT`', detail: 'batas topup', files: ['a.go'] },
        { kind: 'sql', when: 'pre', label: 'Buat tabel topup_codes', detail: 'CREATE TABLE topup_codes (id bigint);', files: [] },
        { kind: 'other', when: 'post', label: 'Smoke test /v1/topup', files: [] },
        { kind: 'cuaca', label: 'x' },
      ],
    });
    const r = parseTicketsReply(reply, ['MU-1', 'MU-2'], ['a.go', 'b.go'])!;
    expect([...r.tickets]).toEqual([['MU-1', { verdict: 'ada', files: ['a.go'], reason: 'handler X' }]]);
    expect(r.unrelated).toEqual([{ path: 'b.go', reason: 'fitur lain' }]);
    expect(r.needs).toEqual([
      { kind: 'env', when: 'pre', label: 'TOPUP_LIMIT', detail: 'batas topup', files: ['a.go'] },
      { kind: 'sql', when: 'pre', label: 'Buat tabel topup_codes', detail: 'CREATE TABLE topup_codes (id bigint);', files: [] },
      { kind: 'other', when: 'post', label: 'Smoke test /v1/topup', files: [] },
    ]);
    expect(parseTicketsReply('maaf', ['MU-1'], [])).toBeNull();
  });

  it('maps picks to known commits (short shas too) in commit order', () => {
    const shas = ['aaaaaaaa11', 'bbbbbbbb22', 'cccccccc33'];
    const r = parsePicksReply(JSON.stringify({ picks: [{ sha: 'cccccccc', include: true, keys: ['mu-2'], reason: 'fitur' }, { sha: 'aaaaaaaa11', include: false, reason: 'promo' }, { sha: 'deadbeef', include: true }], notes: ['MU-3 tidak ada'] }), shas)!;
    expect(r.picks).toEqual([
      { sha: 'aaaaaaaa11', include: false, keys: [], reason: 'promo' },
      { sha: 'cccccccc33', include: true, keys: ['MU-2'], reason: 'fitur' },
    ]);
    expect(r.notes).toEqual(['MU-3 tidak ada']);
  });

  it('takes the instruction and judges commits without a key from their diff', () => {
    const p = picksPrompt({ repo: 'g/gw', source: 'staging', target: 'master', tickets: [], commits: [{ sha: 'a'.repeat(40), shortId: 'aaaaaaaa', title: 'update', merge: false, diff: '+x' }], instruction: 'perubahan CI tetap ikut' });
    expect(p).toContain('Instruksi Tech Lead');
    expect(p).toContain('perubahan CI tetap ikut');
    expect(p).toMatch(/tidak punya Jira key/);
  });

  it("proposes document fixes only for the release's services", () => {
    const r = parseDocumentReply(JSON.stringify({ services: [{ name: 'CORE-TOPUP', envBlock: 'A=1\nB=', preDeploy: ['Jalankan query'], queries: [{ label: 'Buat tabel x', sql: 'CREATE TABLE x (id int);' }, { label: '' }] }, { name: 'lain', envBlock: 'X=1' }, { name: 'core-ledger' }], summary: ['B ditambah'] }), [
      { id: 's1', name: 'core-topup' },
      { id: 's2', name: 'core-ledger' },
    ])!;
    expect(r.fixes).toEqual([{ serviceId: 's1', name: 'core-topup', envBlock: 'A=1\nB=', preDeploy: ['Jalankan query'], queries: [{ label: 'Buat tabel x', sql: 'CREATE TABLE x (id int);' }] }]);
    expect(r.summary).toEqual(['B ditambah']);
  });
});
