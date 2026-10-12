import { DEFAULT_FAILOVER, DEFAULT_ROLES, deploymentTitle, serviceCommit, serviceEnvBlock, tanggal } from './deployment';
import { RELEASE_STATUS_LABELS, type Release, type ReleaseReport } from './types';

/**
 * The release document as Markdown, laid out like the deployment page Cockpit publishes
 * (deployment.ts): for the Dokumen tab preview and for copying.
 */

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const box = (done?: boolean) => (done ? '[x]' : '[ ]');

export function releaseMarkdown(r: Release, report?: ReleaseReport | null): string {
  const d = r.deploy ?? { roles: [], changeLog: [], testEvidence: [] };
  const checks = report?.mrs ?? [];
  const lines: string[] = [`# ${deploymentTitle(r)}`, ''];

  lines.push('| | |', '| --- | --- |');
  lines.push(`| Target Release | ${cell(`${tanggal(r.date)} ${d.targetTime ?? ''}`.trim() || '-')} |`);
  lines.push(`| Actual Release | ${cell(d.actual ?? 'TBA')} |`);
  lines.push(`| Deployment Status | ${cell(d.statusTitle ?? RELEASE_STATUS_LABELS[r.status])} |`);
  lines.push(`| Deployment Impact | ${cell(d.impact ?? '-')} |`);
  for (const role of d.roles.length ? d.roles : DEFAULT_ROLES.map((label) => ({ label, people: [] }))) lines.push(`| ${cell(role.label)} | ${cell(role.people.map((p) => (p.accountId ? `@${p.name}` : p.name)).join(', ') || '-')} |`);
  lines.push(`| Deployment Room | ${cell(d.room ?? '-')} |`);
  lines.push(`| Issue/Request Link (if any) | ${cell(d.issueLink ?? '-')} |`, '');

  lines.push('## 🎯 Change Log', '', '| No. | Details | Notes |', '| --- | --- | --- |');
  (d.changeLog.length ? d.changeLog : [{ details: '-', notes: '' }]).forEach((c, i) => lines.push(`| ${i + 1} | ${cell(c.details)} | ${cell(c.notes ?? '')} |`));
  lines.push('');

  const services = [...r.services].sort((a, b) => a.order - b.order);
  lines.push('## 📝 Deployment List', '', '> **Urutan deploy:**', ...services.map((s, i) => `> ${i + 1}. ${s.name}`), '');
  for (const s of services) {
    lines.push(`### \`${s.name}\``, '');
    lines.push('**Pre-deploy**', '');
    let any = false;
    const env = serviceEnvBlock(r, s);
    if (env) {
      any = true;
      lines.push(`- ${box(env.done)} Update .env`, '', '```', env.text, '```', '');
    }
    for (const m of r.items.filter((i) => i.kind === 'migration' && i.service === s.name)) {
      any = true;
      lines.push(`- ${box(m.done)} Jalankan migrasi \`${m.label}\``);
    }
    for (const q of r.items.filter((i) => i.kind === 'sql' && i.service === s.name)) {
      any = true;
      lines.push(`- ${box(q.done)} ${q.detail ? q.label : `Jalankan query \`${q.label}\``}`);
      if (q.detail) lines.push('', '```sql', q.detail, '```', '');
    }
    for (const p of s.preDeploy ?? []) {
      any = true;
      lines.push(`- [ ] ${p}`);
    }
    if (!any) lines.push('- [ ] N/A');
    lines.push('', `**Commit id**: \`${serviceCommit(s, checks) ?? 'TBA'}\``, '');
    lines.push('**Post-deploy**', '', ...((s.postDeploy ?? []).length ? s.postDeploy!.map((p) => `- [ ] ${p}`) : ['- [ ] N/A']), '');
    const rollback = r.steps.filter((x) => x.kind === 'rollback' && x.service === s.name).map((x) => x.text);
    lines.push(`**Failover Strategy**: ${s.failover ?? (rollback.join('; ') || DEFAULT_FAILOVER)}`, '');
    lines.push(`**Updated by**: ${s.updatedBy ? `@${s.updatedBy.name}` : '-'}`, '');
  }

  const keys = [...new Set([...(report?.tickets.map((t) => t.key) ?? []), ...r.jiraKeys])];
  lines.push('## 🚀 Release List', '', d.releaseList?.jql ? `JQL: \`${d.releaseList.jql}\`` : keys.length ? `JQL: \`key in (${keys.join(', ')})\`` : '-', '');
  lines.push('## Document Control', '', '_Tanda tangan (page signatures) di Confluence._', '');
  lines.push('## Post Deployment Test', '', '**Evidence link:**', ...d.testEvidence.map((e) => `- [${e.title}](${e.url})`), '');
  lines.push('## 💣 Post Deployment issues', '', '| | Date | Issues | Rootcause | Solution | Status | Datetime |', '| --- | --- | --- | --- | --- | --- | --- |', ...[1, 2, 3, 4].map((n) => `| ${n} | | | | | | |`), '');
  return lines.join('\n');
}
