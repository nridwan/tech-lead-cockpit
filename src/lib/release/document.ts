import { bringsSummary } from './share';
import { RELEASE_STATUS_LABELS, type Release, type ReleaseReport } from './types';

/** The release document as Markdown (for Confluence and copying): what, where, in which order, and how to roll back. */

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function releaseMarkdown(r: Release, report?: ReleaseReport | null): string {
  const checks = report?.mrs ?? [];
  const lines: string[] = [`# Rilis ${r.name}${r.version ? ` ${r.version}` : ''}`, ''];
  lines.push('| Item | Detail |', '| --- | --- |');
  lines.push(`| Versi | ${cell(r.version || '-')} |`);
  lines.push(`| Tanggal rilis | ${r.date ?? '-'} |`);
  lines.push(`| Status | ${RELEASE_STATUS_LABELS[r.status]} |`);
  lines.push(`| Branch target | ${cell(r.targetBranch)} |`);
  if (r.codenames.length) lines.push(`| Codename | ${cell(r.codenames.join(', '))} |`);
  lines.push('');

  lines.push('## Service & MR', '', '| Urutan | Service | MR | PIC | Membawa |', '| --- | --- | --- | --- | --- |');
  for (const s of [...r.services].sort((a, b) => a.order - b.order)) {
    const mrs = s.mrs.map((m) => `[${m.ref}](${m.webUrl})`).join(', ') || 'belum ada';
    const brings = s.mrs.map((m) => bringsSummary(checks.find((c) => c.ref === m.ref))).filter(Boolean).join('; ');
    lines.push(`| ${s.order} | ${cell(s.name)} | ${cell(mrs)} | ${cell(s.pic ?? '-')} | ${cell(brings || '-')} |`);
  }
  lines.push('');

  if (report?.tickets.length) {
    lines.push('## Tiket', '', '| Tiket | Judul | Status | Di MR |', '| --- | --- | --- | --- |');
    for (const t of report.tickets) lines.push(`| ${t.key} | ${cell(t.summary)} | ${cell(t.status)} | ${t.inMrs.length ? cell(t.inMrs.join(', ')) : 'belum'} |`);
    lines.push('');
  }

  const group = (kind: 'env' | 'migration' | 'sql', title: string) => {
    const items = r.items.filter((i) => i.kind === kind);
    if (!items.length) return;
    lines.push(`## ${title}`, '');
    for (const i of items) {
      lines.push(`- [${i.done ? 'x' : ' '}] ${i.service ? `**${i.service}**: ` : ''}\`${i.label}\``);
      if (i.detail && i.detail !== i.label) lines.push('', '```sql', i.detail, '```', '');
    }
    lines.push('');
  };
  group('env', 'Environment variable baru');
  group('migration', 'Migrasi database');
  group('sql', 'Query manual');

  for (const [kind, title] of [
    ['deploy', 'Langkah deploy'],
    ['rollback', 'Rollback'],
  ] as const) {
    const steps = r.steps.filter((s) => s.kind === kind);
    if (!steps.length) continue;
    lines.push(`## ${title}`, '');
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s.service ? `**${s.service}**: ` : ''}${s.text}${s.done ? ' ✅' : ''}`));
    lines.push('');
  }
  if (r.notes) lines.push('## Catatan', '', r.notes, '');
  return lines.join('\n');
}
