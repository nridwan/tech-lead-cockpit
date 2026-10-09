import { describe, expect, it } from 'vitest';
import { parseCurl } from './curl';

describe('parseCurl', () => {
  it('reads method, url, query, headers and a JSON body (multi-line, quotes)', () => {
    const c = parseCurl(`curl -X POST 'https://api.dev.test/core/v1/promos/reserve?dry=1' \\
      -H 'Content-Type: application/json' -H "Authorization: Bearer abc" \\
      --data-raw '{"promoId":"P1","note":"it\\'s ok"}'`);
    expect(c).toMatchObject({ method: 'POST', url: 'https://api.dev.test/core/v1/promos/reserve', path: '/core/v1/promos/reserve', query: { dry: '1' } });
    expect(c?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer abc' });
    expect(c?.body).toContain('"promoId":"P1"');
  });

  it('defaults to GET without a body and POST with one; --json sets the content type', () => {
    expect(parseCurl('curl https://h.test/x')?.method).toBe('GET');
    expect(parseCurl("curl https://h.test/x -d 'a=1'")?.method).toBe('POST');
    expect(parseCurl(`curl --json '{"a":1}' https://h.test/x`)).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
  });

  it('rejects text that is not a cURL with an http(s) URL', () => {
    expect(parseCurl('wget https://h.test')).toBeNull();
    expect(parseCurl('curl -X GET')).toBeNull();
  });
});
