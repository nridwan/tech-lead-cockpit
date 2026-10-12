import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ESTIMATE_ROLES } from '../../src/lib/estimate/types.ts';
import type { LeaveRange, TeamMember } from '../../src/lib/roster/types.ts';
import { DATA_DIR } from '../paths.ts';

/** The team roster, one JSON file (0600) next to the other Cockpit data. */

export const ROSTER_FILE = join(DATA_DIR, 'team-roster.json');
export const MAX_MEMBERS = 200;

export class RosterInputError extends Error {}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const validDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s));

function validLeaves(raw: unknown): LeaveRange[] {
  const out: LeaveRange[] = [];
  for (const l of (Array.isArray(raw) ? raw : []).slice(0, 100)) {
    if (!validDate(l?.start) || !validDate(l?.end)) throw new RosterInputError('Tanggal cuti tidak valid.');
    if (l.end < l.start) throw new RosterInputError('Tanggal akhir cuti sebelum tanggal mulai.');
    const note = String(l.note ?? '').trim().slice(0, 120);
    out.push({ start: l.start, end: l.end, ...(note ? { note } : {}) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function validateMember(raw: Partial<TeamMember>, existing?: TeamMember): TeamMember {
  const name = String(raw.name ?? '').trim().slice(0, 80);
  if (!name) throw new RosterInputError('Nama anggota tim wajib diisi.');
  if (!(ESTIMATE_ROLES as readonly string[]).includes(String(raw.role))) throw new RosterInputError(`Role "${name}" tidak dikenal.`);
  const accountId = String(raw.jira?.accountId ?? '');
  const jira = /^[\w.@:-]{1,128}$/.test(accountId) ? { accountId, displayName: String(raw.jira?.displayName ?? accountId).slice(0, 120) } : undefined;
  const gitEmails = [...new Set((Array.isArray(raw.gitEmails) ? raw.gitEmails : []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL.test(e)))].slice(0, 10);
  const capacity = Number(raw.capacity);
  const note = String(raw.note ?? '').trim().slice(0, 300);
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? (typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : randomUUID()),
    name,
    role: raw.role as TeamMember['role'],
    ...(jira ? { jira } : {}),
    gitEmails,
    capacity: Number.isFinite(capacity) && capacity > 0 ? Math.min(1, Math.max(0.1, Math.round(capacity * 10) / 10)) : 1,
    leaves: validLeaves(raw.leaves),
    active: raw.active !== false,
    ...(note ? { note } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class RosterStore {
  private cache?: TeamMember[];

  constructor(private readonly file = ROSTER_FILE) {}

  async list(): Promise<TeamMember[]> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.cache = (Array.isArray(raw?.members) ? raw.members : []).flatMap((m: Partial<TeamMember>) => {
        try {
          return [validateMember(m, m as TeamMember)];
        } catch {
          return [];
        }
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      this.cache = [];
    }
    return sortMembers(this.cache!);
  }

  /** Adds or updates one member (matched by id). A Jira account belongs to one member only. */
  async save(raw: Partial<TeamMember>): Promise<TeamMember[]> {
    const members = [...(await this.list())];
    const existing = typeof raw.id === 'string' ? members.find((m) => m.id === raw.id) : undefined;
    const member = validateMember(raw, existing);
    if (member.jira && members.some((m) => m.id !== member.id && m.jira?.accountId === member.jira!.accountId)) {
      throw new RosterInputError(`Akun Jira ${member.jira.displayName} sudah dipakai anggota lain.`);
    }
    if (!existing && members.length >= MAX_MEMBERS) throw new RosterInputError(`Daftar tim maksimal ${MAX_MEMBERS} orang.`);
    const next = existing ? members.map((m) => (m.id === member.id ? member : m)) : [...members, member];
    await this.write(next);
    return sortMembers(next);
  }

  async remove(id: string): Promise<TeamMember[]> {
    const next = (await this.list()).filter((m) => m.id !== id);
    await this.write(next);
    return sortMembers(next);
  }

  private async write(members: TeamMember[]) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, members }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    this.cache = members;
  }
}

function sortMembers(members: TeamMember[]): TeamMember[] {
  return [...members].sort((a, b) => Number(b.active) - Number(a.active) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}
