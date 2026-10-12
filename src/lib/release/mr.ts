import type { MrCheck, MrPlan, Release, ReleaseAiJob, ReleaseService } from './types';

/** Title, description and GitLab form link for a new release MR of one service. */

/** The team's release MR title, e.g. "[MASTER] - Cashin Toko". */
export const DEFAULT_MR_TITLE = '[{TARGET}] - {RELEASE}';

export function mrTitle(release: Release, service: ReleaseService): string {
  const values: Record<string, string> = {
    TARGET: release.targetBranch.toUpperCase(),
    RELEASE: release.name,
    VERSION: release.version,
    SERVICE: service.name,
    CODENAME: release.codenames[0] ?? '',
  };
  return (release.mrTitleTemplate?.trim() || DEFAULT_MR_TITLE)
    .replace(/\{(TARGET|RELEASE|VERSION|SERVICE|CODENAME)\}/gi, (_, k: string) => values[k.toUpperCase()] ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–·|]\s*$/, '')
    .trim()
    .slice(0, 250);
}

export function mrDescription(
  release: Release,
  service: ReleaseService,
  data: { commits: { shortId: string; title: string }[]; findings: Partial<Pick<MrCheck, 'envAdded' | 'envReadInCode' | 'migrations' | 'sqlOutside'>>; tickets: MrPlan['tickets'] },
): string {
  const lines = [`Rilis **${release.name}${release.version ? ` ${release.version}` : ''}**${release.date ? ` (${release.date})` : ''} untuk **${service.name}**.`, ''];
  if (data.tickets.length) {
    lines.push('### Tiket', '');
    for (const t of data.tickets) lines.push(`- ${t.key} ${t.summary} (${t.status})${t.inSource ? '' : t.unsure ? ' ⚠️ perlu dicek, cocok samar di kode' : ' ⚠️ belum terlihat di kode'}`);
    lines.push('');
  }
  const f = data.findings;
  const todo = [
    ...(f.envAdded ?? []).map((e) => `- Env baru \`${e}\` sudah diset di server`),
    ...(f.envReadInCode ?? []).map((e) => `- Env \`${e}\` (dibaca di kode) ada di server`),
    ...(f.migrations ?? []).map((m) => `- Migrasi \`${m}\` dijalankan`),
    ...(f.sqlOutside ?? []).map((q) => `- Query manual \`${q}\` dijalankan`),
  ];
  if (todo.length) lines.push('### Perlu di server', '', ...todo, '');
  if (data.commits.length) {
    lines.push(`### Commit (${data.commits.length})`, '');
    for (const c of data.commits.slice(0, 50)) lines.push(`- ${c.shortId} ${c.title}`);
    if (data.commits.length > 50) lines.push(`- … ${data.commits.length - 50} commit lain`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** GitLab's new-MR form for a project, filled in; the description is cut to keep the URL short. */
export function newMrFormUrl(gitlabBaseUrl: string, projectPath: string, source: string, target: string, title: string, description: string): string {
  const base = gitlabBaseUrl.replace(/\/+$/, '');
  const desc = description.length > 2_000 ? `${description.slice(0, 2_000)}\n\n…` : description;
  const q = new URLSearchParams({ 'merge_request[source_branch]': source, 'merge_request[target_branch]': target, 'merge_request[title]': title, 'merge_request[description]': desc });
  return `${base}/${projectPath}/-/merge_requests/new?${q}`;
}

/** The AI's findings for a release MR description: tickets, changes without a ticket, server needs. */
export function aiMrSection(job: Pick<ReleaseAiJob, 'verdicts' | 'unrelated' | 'needs' | 'risks' | 'model'>): string {
  const lines: string[] = [];
  if (job.verdicts?.length) {
    lines.push('### Cek AI: tiket di kode', '');
    for (const v of job.verdicts) lines.push(`- ${v.key}: **${v.verdict}**${v.reason ? ` — ${v.reason}` : ''}`);
    lines.push('');
  }
  if (job.unrelated?.length) {
    lines.push('### Cek AI: perubahan tanpa tiket', '');
    for (const u of job.unrelated) lines.push(`- \`${u.path}\` — ${u.reason}`);
    lines.push('');
  }
  if (job.risks?.length) {
    lines.push('### Cek AI: risiko / temuan review', '');
    for (const r of job.risks) lines.push(`- ${r.path ? `\`${r.path}\` — ` : ''}${r.reason}`);
    lines.push('');
  }
  if (job.needs?.length) {
    lines.push('### Cek AI: perlu di server', '');
    for (const n of job.needs) {
      const what = n.kind === 'env' ? `Env \`${n.label}\` diset` : n.kind === 'migration' ? `Migrasi \`${n.label}\` dijalankan` : n.kind === 'sql' ? `Query: ${n.label}` : n.label;
      lines.push(`- ${n.when === 'post' ? '(setelah deploy) ' : ''}${what}`);
      if (n.kind === 'sql' && n.detail) lines.push('', '```sql', n.detail, '```', '');
    }
    lines.push('');
  }
  return lines.length ? `${lines.join('\n').trimEnd()}\n\n_Dicek dengan ${job.model}._` : '';
}
