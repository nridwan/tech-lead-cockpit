/** A request read from a pasted cURL command (as copied from DevTools, Postman or a log). */
export interface ParsedCurl {
  method: string;
  url: string;
  /** Path of the URL, without the query string. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
}

/** Splits a shell command into words: quotes, escapes and line continuations. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const text = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '$' && text[i + 1] === "'") {
      // $'…' (bash ANSI-C quoting, e.g. from Chrome): treat as single quotes.
      quote = "'";
      has = true;
      i++;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json']);
const WITH_VALUE = new Set(['-u', '--user', '-o', '--output', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '--connect-timeout', '-m', '--max-time', '--cacert', '--cert', '-x', '--proxy']);

export function parseCurl(cmd: string): ParsedCurl | null {
  const w = words(cmd.trim());
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) return null;
  let method = '';
  let url = '';
  let body: string | undefined;
  let json = false;
  const headers: Record<string, string> = {};
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const at = h.indexOf(':');
      if (at > 0) headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    } else if (DATA.has(a)) {
      const d = next();
      body = body === undefined ? d : `${body}&${d}`;
      if (a === '--json') json = true;
    } else if (a === '--url') url = next();
    else if (WITH_VALUE.has(a)) next();
    else if (!a.startsWith('-') && !url) url = a;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (json && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    url: `${u.origin}${u.pathname}`,
    path: decodeURI(u.pathname),
    query: Object.fromEntries(u.searchParams.entries()),
    headers,
    body,
  };
}
