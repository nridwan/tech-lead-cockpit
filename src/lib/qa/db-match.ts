/**
 * Matches service names to database names on a server, e.g. core-promo-ultimate ↔ promo_db or
 * core_promo, core-user-auth-v2 ↔ user_auth_v2. Words that every service shares (core, ultimate,
 * service, app, db) are ignored; each database is used once, best matches first.
 */

const NOISE = new Set(['core', 'ultimate', 'service', 'services', 'svc', 'app', 'api', 'db', 'database', 'ms', 'backend', 'be']);

function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));
}

/** 0…1: share of the words both names have (1 = same words). */
export function matchScore(service: string, database: string): number {
  const a = words(service);
  const b = words(database);
  if (!a.length || !b.length) return 0;
  const common = a.filter((w) => b.includes(w)).length;
  return common / Math.max(a.length, b.length);
}

export function matchDatabases(services: string[], databases: string[], minScore = 0.5): Record<string, string> {
  const pairs: { s: string; d: string; score: number }[] = [];
  for (const s of services) for (const d of databases) {
    const score = matchScore(s, d);
    if (score >= minScore) pairs.push({ s, d, score });
  }
  pairs.sort((x, y) => y.score - x.score || x.d.length - y.d.length);
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const p of pairs) {
    if (out[p.s] || used.has(p.d)) continue;
    out[p.s] = p.d;
    used.add(p.d);
  }
  return out;
}
