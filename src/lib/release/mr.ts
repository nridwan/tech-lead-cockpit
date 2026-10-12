import type { Release, ReleaseService } from './types';

/** Title and GitLab form link for a new release MR of one service (release MRs carry no description). */

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

/** GitLab's new-MR form for a project, filled in (no description: release MRs carry none). */
export function newMrFormUrl(gitlabBaseUrl: string, projectPath: string, source: string, target: string, title: string): string {
  const base = gitlabBaseUrl.replace(/\/+$/, '');
  const q = new URLSearchParams({ 'merge_request[source_branch]': source, 'merge_request[target_branch]': target, 'merge_request[title]': title });
  return `${base}/${projectPath}/-/merge_requests/new?${q}`;
}
