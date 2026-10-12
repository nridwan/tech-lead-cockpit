// The team roster: everyone who can be staffed on a project, kept once and reused by every
// estimate. Role, Jira account, git e-mails, capacity and leave live here; projects copy a member
// into their team (Developer.memberId) and read availability from it. Stored by the connector in
// ~/.tech-lead-cockpit/team-roster.json.

import type { EstimateRole } from '../estimate/types';

export interface LeaveRange {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
  note?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: EstimateRole;
  /** Linked Jira user (Cloud accountId, or username on Data Center). */
  jira?: { accountId: string; displayName: string };
  /** Commit author e-mails (lowercase); git and Jira often use different addresses. */
  gitEmails: string[];
  /** Share of a working day this person has for project work, 0.1–1. */
  capacity: number;
  leaves: LeaveRange[];
  /** Inactive members (left the team, long leave) are not recommended. */
  active: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** A commit author seen in the Services repos. */
export interface GitAuthor {
  email: string;
  name: string;
  commits: number;
  repos: string[];
}

/** Commits per author e-mail in the repo that matches one service of the project. */
export interface ServiceActivity {
  service: string;
  /** Repo folder under the Services root; undefined when no folder matched. */
  repo?: string;
  total: number;
  byEmail: Record<string, number>;
}

export interface ActivityResponse {
  days: number;
  services: ServiceActivity[];
  error?: string;
}

/** Where a member's time already goes in other Cockpit projects. */
export interface MemberBusy {
  projectId: string;
  projectName: string;
  allocation: number;
  /** Last day of their work there (YYYY-MM-DD). */
  until: string;
}

export interface MemberRecommendation {
  member: TeamMember;
  /** Earliest day they can start on this project. */
  availableFrom: string;
  /** Working days between the project start and availableFrom. */
  waitDays: number;
  /** Capacity left at the project start after other projects. */
  freeCapacity: number;
  busy: MemberBusy[];
  /** Leave working days inside the project window. */
  leaveDays: number;
  /** Open Jira work outside this project; `until` = when it is done at their capacity. */
  jira?: { days: number; issues: number; until?: string };
  /** Share of recent commits in the repos of this role's tasks (0–1); undefined without git data. */
  familiarity?: { share: number; commits: number; topService?: string; topShare?: number };
  /** Already in this project's team. */
  inProject: boolean;
  reasons: string[];
}
