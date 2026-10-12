import { describe, expect, it } from 'vitest';
import { extractPageId } from './confluence-prd';
import { trackedHunk } from '../html-diff';
import { buildHunks, lineDiff } from '../diff';

describe('extractPageId', () => {
  it('reads Cloud links, viewpage links and bare ids', () => {
    expect(extractPageId('https://acme.atlassian.net/wiki/spaces/ACME/pages/1250951173/PRD+-+Acme+Wallet')).toBe('1250951173');
    expect(extractPageId('https://wiki.x/pages/viewpage.action?pageId=42')).toBe('42');
    expect(extractPageId(' 687603717 ')).toBe('687603717');
    expect(extractPageId('https://example.com/no-id')).toBeNull();
  });

  it('reads unpublished drafts and editor links', () => {
    expect(extractPageId('https://acme.atlassian.net/wiki/pages/resumedraft.action?draftId=1411973122&draftShareId=e76dd2c4-f308-420c-8d7a-4726f80a4354')).toBe('1411973122');
    expect(extractPageId('https://acme.atlassian.net/wiki/spaces/ACME/pages/edit-v2/1411973122?draftShareId=abc')).toBe('1411973122');
    expect(extractPageId('https://acme.atlassian.net/wiki/spaces/ACME/pages/edit-v2/1411973122')).toBe('1411973122');
    expect(extractPageId('https://wiki.x/pages/edit/77')).toBe('77');
    expect(extractPageId('https://acme.atlassian.net/wiki/spaces/ACME/pages/1250951173')).toBe('1250951173');
    // A space or title made of digits is not a page id.
    expect(extractPageId('https://acme.atlassian.net/wiki/spaces/ACME/pages/resumedraft.action')).toBeNull();
  });
});

describe('trackedHunk', () => {
  it('shows a PRD change word by word within its whole block', () => {
    const before = ['# PRD', '', '- Limit transfer 5 juta', '- Fee 2500', '', 'Akhir'];
    const after = ['# PRD', '', '- Limit transfer 10 juta', '- Fee 2500', '', 'Akhir'];
    const diff = lineDiff(before, after);
    const [h] = buildHunks(diff);
    const { html } = trackedHunk(diff, h, (md) => md.split('\n').map((l) => `<p>${l}</p>`).join(''));
    expect(html).toContain('<del class="tc-del">5</del><ins class="tc-add">10</ins>');
    expect(html).toContain('Fee 2500'); // the rest of the list is shown as context
  });
});
