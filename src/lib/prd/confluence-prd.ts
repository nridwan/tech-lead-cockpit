import { connector } from '../confluence/client';
import { storageToMarkdown } from '../confluence/storage-to-markdown';

/** Where a draft's PRD lives in Confluence, and which version Cockpit last read. */
export interface PrdSource {
  pageId: string;
  title: string;
  url?: string;
  spaceKey?: string;
  version: number;
  /** ISO time of the last read of the page content. */
  syncedAt: string;
  /** Newest version seen by the update check, when it is ahead of `version`. */
  latestVersion?: number;
  checkedAt?: string;
}

/**
 * Page id from a Confluence link or a bare id. Covers published pages (`/pages/123/...`,
 * `viewpage.action?pageId=123`), the editor (`/pages/edit-v2/123`, `/pages/edit/123`) and
 * unpublished drafts, whose link is `resumedraft.action?draftId=123&draftShareId=…`.
 */
export function extractPageId(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{1,20}$/.test(t)) return t;
  return (
    t.match(/\/pages\/(?:edit(?:-v2|-embed)?\/)?(\d{1,20})(?:[/?#]|$)/)?.[1] ??
    t.match(/[?&](?:pageId|draftId|contentId)=(\d{1,20})/)?.[1] ??
    null
  );
}

/** Reads the PRD page and converts it to the Markdown the TAD generator works from. */
export async function fetchPrd(pageId: string): Promise<{ markdown: string; source: PrdSource }> {
  const page = await connector.page({ id: pageId });
  if (!page.storage) throw new Error('Halaman Confluence tidak berisi konten.');
  const now = new Date().toISOString();
  return {
    markdown: storageToMarkdown(page.storage, page.title).markdown,
    source: { pageId: page.id, title: page.title, url: page.url, spaceKey: page.spaceKey, version: page.version, syncedAt: now, checkedAt: now },
  };
}
