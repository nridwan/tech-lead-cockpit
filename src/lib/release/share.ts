import type { MrCheck, Release, ReleaseMrRef } from './types';

/**
 * The "please review" message for a Teams group: one line per MR with its service, link, author,
 * pipeline, approvals and what it brings to the server. Built here from data, so every value is
 * escaped and only a few safe tags (p, b, a, ul, li, br) reach Teams.
 */

export interface ShareOptions {
  mrRefs: string[];
  /** Review deadline, free text (e.g. "Kamis 16.00"). */
  deadline?: string;
  /** Names shown in bold under the list. */
  reviewers?: string[];
  note?: string;
  /** "Kirim pengingat": only MRs still waiting, other heading. */
  reminder?: boolean;
}

export interface ShareLine {
  service: string;
  mr: ReleaseMrRef;
  check?: MrCheck;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u: string) => (/^https?:\/\/[^\s"'<>]+$/.test(u) ? u : '');
const fmtDate = (d?: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

export function shareLines(release: Release, checks: MrCheck[], refs: string[]): ShareLine[] {
  const want = new Set(refs);
  return release.services
    .slice()
    .sort((a, b) => a.order - b.order)
    .flatMap((s) => s.mrs.filter((m) => want.has(m.ref)).map((mr) => ({ service: s.name, mr, check: checks.find((c) => c.ref === mr.ref) })));
}

/** "2 env baru, 1 migrasi, 1 query manual" for one MR. */
export function bringsSummary(c?: MrCheck): string {
  if (!c) return '';
  const parts = [
    c.envAdded.length ? `${c.envAdded.length} env baru` : '',
    c.migrations.length ? `${c.migrations.length} migrasi` : '',
    c.sqlOutside.length ? `${c.sqlOutside.length} query manual` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function lineParts(l: ShareLine, minApprovals: number) {
  const c = l.check;
  const title = c?.title ?? l.mr.title ?? '';
  const meta = [
    c?.author,
    c?.state === 'merged' ? 'sudah merge' : c?.draft ? 'draft' : '',
    c?.pipeline ? `pipeline ${c.pipeline}` : '',
    c && c.state === 'opened' ? `${c.approvals.count}/${minApprovals} approval` : '',
    bringsSummary(c),
  ].filter(Boolean);
  return { title, meta };
}

export function shareHeading(release: Release, opts: ShareOptions): string {
  return `${opts.reminder ? 'Pengingat review' : 'Mohon review'} MR rilis: ${release.name}${release.version ? ` ${release.version}` : ''}`;
}

export function shareMessageText(release: Release, checks: MrCheck[], opts: ShareOptions): string {
  const lines = shareLines(release, checks, opts.mrRefs);
  const out = [shareHeading(release, opts), `Target ${release.targetBranch}${release.date ? ` · rilis ${fmtDate(release.date)}` : ''}${opts.deadline ? ` · review sebelum ${opts.deadline}` : ''}`, ''];
  for (const l of lines) {
    const { title, meta } = lineParts(l, release.minApprovals);
    out.push(`• ${l.service}: ${l.mr.webUrl}${title ? ` (${title})` : ''}${meta.length ? ` · ${meta.join(' · ')}` : ''}`);
  }
  if (opts.reviewers?.length) out.push('', `Reviewer: ${opts.reviewers.join(', ')}`);
  if (opts.note?.trim()) out.push('', opts.note.trim());
  return out.join('\n');
}

export function shareMessageHtml(release: Release, checks: MrCheck[], opts: ShareOptions): string {
  const lines = shareLines(release, checks, opts.mrRefs);
  const sub = [`Target <b>${esc(release.targetBranch)}</b>`, release.date ? `rilis ${esc(fmtDate(release.date))}` : '', opts.deadline ? `review sebelum <b>${esc(opts.deadline)}</b>` : ''].filter(Boolean).join(' · ');
  const items = lines.map((l) => {
    const { title, meta } = lineParts(l, release.minApprovals);
    const url = safeUrl(l.mr.webUrl);
    const link = url ? `<a href="${esc(url)}">${esc(l.mr.ref)}</a>` : esc(l.mr.ref);
    return `<li><b>${esc(l.service)}</b>: ${link}${title ? ` ${esc(title)}` : ''}${meta.length ? ` · ${esc(meta.join(' · '))}` : ''}</li>`;
  });
  const parts = [`<p><b>${esc(shareHeading(release, opts))}</b><br/>${sub}</p>`, `<ul>${items.join('')}</ul>`];
  if (opts.reviewers?.length) parts.push(`<p>Reviewer: ${opts.reviewers.map((r) => `<b>${esc(r)}</b>`).join(', ')}</p>`);
  if (opts.note?.trim()) parts.push(`<p>${esc(opts.note.trim()).replace(/\n/g, '<br/>')}</p>`);
  return parts.join('');
}
