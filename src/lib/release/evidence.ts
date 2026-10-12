import type { MrFileChange } from '../gitlab/types';
import type { CodeEvidence, CodeHit } from './types';

/**
 * Is a ticket's work in the code? Read from the diff itself, not from commit messages: the
 * endpoint of the ticket's TAD Detail Task, or the words of the ticket name, in the added lines
 * and file paths. No AI: the same diff gives the same answer, and every match names its file.
 *
 * - strong: the TAD endpoint is in the added code, or one identifier / path holds every word of
 *   the ticket name (`GetDetailCashinChannel`, `get_detail_cashin_channel`, `/cashin/channel/detail`).
 * - weak: one changed file holds every word, spread over several identifiers. Worth a look.
 */

export interface TicketProbe {
  key: string;
  summary: string;
  /** Endpoints from the ticket's TAD Detail Task, e.g. /v1/cashin/channel/detail. */
  endpoints?: string[];
}

/** Words that say what kind of work it is, not what it is about. */
const STOP = new Set([
  'develop', 'developing', 'development', 'enhance', 'enhancement', 'implement', 'implementasi', 'implementation', 'membuat', 'buat', 'bikin',
  'integrasi', 'integration', 'integrate', 'handle', 'handling', 'fix', 'fixing', 'bugfix', 'penyesuaian', 'adjust', 'adjustment', 'menambahkan',
  'tambahkan', 'tambah', 'add', 'adding', 'mengubah', 'update', 'updating', 'new', 'baru', 'data', 'pada', 'untuk', 'dan', 'atau', 'di', 'ke',
  'dari', 'yang', 'dengan', 'agar', 'saat', 'ketika', 'the', 'and', 'for', 'with', 'from', 'into', 'api', 'apis', 'ui', 'ux', 'be', 'fe', 'halaman',
  'page', 'screen', 'register', 'endpoint', 'feature', 'fitur', 'task', 'bug', 'issue', 'flow', 'proses', 'process', 'logic', 'via', 'per',
]);
/** Words that may or may not be in the code's names; never required. */
const HINT = new Set(['get', 'post', 'put', 'model', 'models', 'scheduler', 'worker', 'job', 'cron', 'response', 'request', 'mobile', 'service', 'handler', 'controller', 'table', 'tabel', 'module']);
/** Indonesian ticket words and the English the code usually uses. */
const SYNONYMS: Record<string, string[]> = {
  kode: ['code'], konfirmasi: ['confirm'], transaksi: ['transaction', 'trx'], riwayat: ['history'], daftar: ['list'], pembayaran: ['payment'],
  bayar: ['pay'], ubah: ['update', 'edit'], hapus: ['delete', 'remove'], nomor: ['number', 'no'], pengguna: ['user'], kirim: ['send'], cek: ['check'],
  kadaluarsa: ['expired', 'expire'], kedaluwarsa: ['expired', 'expire'], pengaturan: ['setting', 'config'], konfigurasi: ['config'], laporan: ['report'],
  notifikasi: ['notification', 'notif'], saldo: ['balance'], akun: ['account'], tarik: ['withdraw'], setor: ['deposit'], detil: ['detail'], status: ['status'],
  expired: ['expire'], channel: ['channel'], cashin: ['cashin', 'cash_in'], cashout: ['cashout', 'cash_out'], topup: ['topup', 'top_up'],
};

const join = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const TEST_PATH = /(^|\/)(test|tests|__tests__|testdata|fixtures?|mocks?)\/|[._-](test|spec)\.[a-z]+$/i;

/** The ticket name without its [TAG]s: "[BACKEND][SVC][CODE] - Develop API X" → "Develop API X". */
export function ticketName(summary: string): string {
  return summary.replace(/^(\s*\[[^\]]*\])+\s*-?\s*/, '').trim();
}

/** Each required word with the spellings that count for it. */
export function ticketTerms(summary: string): string[][] {
  const words = ticketName(summary).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  const out: string[][] = [];
  for (const w of new Set(words)) {
    if (STOP.has(w) || HINT.has(w)) continue;
    out.push([...new Set([w, ...(SYNONYMS[w] ?? [])].map(join))]);
  }
  return out;
}

/** Hint words of a ticket name (request, mobile, get…): never required, but they back up a near match. */
function ticketHints(summary: string): string[] {
  return [...new Set(ticketName(summary).toLowerCase().split(/[^a-z0-9]+/).filter((w) => HINT.has(w)))];
}

/** The required words of a ticket as one comparable string: "cashin channel detail". */
const signature = (summary: string) =>
  ticketTerms(summary)
    .map((t) => t[0])
    .sort()
    .join(' ');

/**
 * One feature has a ticket per service: the gateway's "Register API Request Kode Cashin" and the
 * backend's "Develop API Request Kode Cashin". A ticket without TAD endpoints takes those of the
 * tickets with exactly the same words (at least two), so the gateway route is found too.
 */
export function withSharedEndpoints<T extends TicketProbe>(tickets: T[]): T[] {
  const pool = new Map<string, Set<string>>();
  for (const t of tickets) {
    const sig = signature(t.summary);
    if (!t.endpoints?.length || sig.split(' ').length < 2) continue;
    const set = pool.get(sig) ?? new Set<string>();
    for (const e of t.endpoints) set.add(e);
    pool.set(sig, set);
  }
  return tickets.map((t) => {
    if (t.endpoints?.length) return t;
    const shared = pool.get(signature(t.summary));
    return shared ? { ...t, endpoints: [...shared] } : t;
  });
}

/** /v1/cashin/channel/detail → the path and its shorter tails (a router group may hold the prefix). */
export function endpointVariants(endpoint: string): string[] {
  const path = endpoint.replace(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+/i, '').replace(/^https?:\/\/[^/]+/i, '').split(/[?#\s]/)[0];
  const segs = path.split('/').filter(Boolean);
  // Stop at the first path parameter ({id}, :id): what follows is written differently per router.
  const at = segs.findIndex((s) => /[{}:<>]/.test(s));
  const fixed = (at < 0 ? segs : segs.slice(0, at)).map((s) => s.toLowerCase());
  const out: string[] = [];
  for (let i = 0; fixed.length - i >= 2; i++) out.push(`/${fixed.slice(i).join('/')}`);
  return out;
}

const addedLines = (diff: string) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
const CHUNK = /[A-Za-z_][A-Za-z0-9_\-./]{2,119}/g;

export interface FileText {
  path: string;
  chunks: string[];
  lower: string;
}

function fileText(c: MrFileChange): FileText {
  const lines = addedLines(c.diff);
  const chunks = [c.newPath, ...lines.flatMap((l) => l.match(CHUNK) ?? [])];
  return { path: c.newPath, chunks, lower: lines.join('\n').toLowerCase() };
}

const has = (text: string, term: string[]) => term.some((t) => text.includes(t));

/** Where the ticket shows in these changes, strongest first; undefined when it does not. */
export function findEvidence(probe: TicketProbe, files: FileText[]): Omit<CodeEvidence, 'ref'> | undefined {
  const terms = ticketTerms(probe.summary);
  const hints = ticketHints(probe.summary);
  const variants = (probe.endpoints ?? []).flatMap(endpointVariants);
  const strong: CodeHit[] = [];
  const weak: CodeHit[] = [];
  const byEndpoint: CodeHit[] = [];
  for (const f of files) {
    const v = variants.find((x) => f.lower.includes(x));
    if (v) {
      byEndpoint.push({ path: f.path, match: v });
      continue;
    }
    // One word is not enough to tell tickets apart.
    if (terms.length < 2) continue;
    const id = f.chunks.find((ch) => {
      const j = join(ch);
      return terms.every((t) => has(j, t));
    });
    if (id) strong.push({ path: f.path, match: id });
    else {
      const joined = f.chunks.map(join);
      if (terms.every((t) => joined.some((j) => has(j, t)))) weak.push({ path: f.path, match: terms.map((t) => t[0]).join(' + ') });
      else if (terms.length >= 3 && hints.length) {
        // All words but one in one name, backed by a hint word: /mobile/cashin/channel/{id} for
        // "Get Detail Cashin Channel Mobile". Close, but a human should confirm.
        const near = f.chunks.find((ch) => {
          const j = join(ch);
          return terms.filter((t) => has(j, t)).length === terms.length - 1 && hints.some((h) => j.includes(h));
        });
        if (near) weak.push({ path: f.path, match: near });
      }
    }
  }
  // Code before tests: a test alone is not the feature.
  const order = (hits: CodeHit[]) => [...hits.filter((h) => !TEST_PATH.test(h.path)), ...hits.filter((h) => TEST_PATH.test(h.path))];
  // The TAD endpoint is the most telling match: list it first.
  strong.unshift(...byEndpoint);
  const real = strong.filter((h) => !TEST_PATH.test(h.path));
  if (real.length) return { strength: 'strong', hits: order(strong).slice(0, 5) };
  const hits = order([...strong, ...weak]);
  return hits.length ? { strength: 'weak', hits: hits.slice(0, 5) } : undefined;
}

/** Ready-to-search text of a diff, built once per source and reused for every ticket. */
export function indexChanges(changes: MrFileChange[]): FileText[] {
  return changes.filter((c) => !c.deletedFile).map(fileText);
}

const dir = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * Changed files no ticket accounts for: candidates for work outside the scope. A file next to a
 * ticket's match whose path has one of the ticket's words (cashin/dto.go beside cashin/router.go)
 * is part of that feature.
 */
export function unattributedFiles(changes: MrFileChange[], found: { summary: string; evidence: Pick<CodeEvidence, 'hits'> }[]): string[] {
  const used = new Set(found.flatMap((f) => f.evidence.hits.map((h) => h.path)));
  const near = found.map((f) => ({ dirs: new Set(f.evidence.hits.map((h) => dir(h.path))), terms: ticketTerms(f.summary) }));
  return changes
    .filter((c) => !c.deletedFile && !used.has(c.newPath))
    .filter((c) => !near.some((n) => n.dirs.has(dir(c.newPath)) && n.terms.some((t) => has(join(c.newPath), t))))
    .map((c) => c.newPath);
}
