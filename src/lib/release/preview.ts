import DOMPurify from 'dompurify';
import { tanggal } from './deployment';

/**
 * Confluence storage (what Cockpit publishes) as plain HTML for the in-app preview: status
 * lozenges, task checkboxes, code blocks, info panels, mentions, emoticons and dates, so the
 * preview shows the page that will be published, styled like the TAD preview.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

export function storageToPreviewHtml(xhtml: string, people: Map<string, string> = new Map()): string {
  let h = xhtml;
  // Code macros (CDATA may be split to escape "]]>").
  h = h.replace(/<ac:structured-macro\b[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_, inner: string) => {
    const lang = inner.match(/<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>/)?.[1];
    const body = [...inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join('');
    return `<div class="code-block"><pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(body)}</code></pre></div>`;
  });
  h = h.replace(/<ac:structured-macro\b[^>]*ac:name="status"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_, inner: string) => {
    const title = inner.match(/<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>/)?.[1] ?? '';
    const colour = (inner.match(/<ac:parameter ac:name="colour">([^<]*)<\/ac:parameter>/)?.[1] ?? 'grey').toLowerCase();
    return `<span class="lozenge lz-${esc(colour)}">${title}</span>`;
  });
  h = h.replace(/<ac:structured-macro\b[^>]*ac:name="(info|note|tip|warning|panel)"[^>]*>[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>\s*<\/ac:structured-macro>/g, (_, kind: string, body: string) => `<div class="panel panel-${kind}">${body}</div>`);
  h = h.replace(/<ac:structured-macro\b[^>]*ac:name="page-signatures"[^>]*?(?:\/>|>[\s\S]*?<\/ac:structured-macro>)/g, '<div class="panel panel-note">✍️ Tanda tangan dokumen (page signatures) diisi di Confluence.</div>');
  // Tasks.
  h = h.replace(/<ac:task-list\b[^>]*>/g, '<ul class="tasks">').replace(/<\/ac:task-list>/g, '</ul>');
  h = h.replace(/<ac:task>([\s\S]*?)<\/ac:task>/g, (_, inner: string) => {
    const done = /<ac:task-status>\s*complete\s*</.test(inner);
    const body = inner.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/)?.[1] ?? '';
    return `<li class="task${done ? ' done' : ''}"><span class="box">${done ? '☑' : '☐'}</span> ${body}</li>`;
  });
  // Mentions, emoticons, dates.
  h = h.replace(/<ac:link>\s*(<ri:user\b[^>]*\/?>)\s*<\/ac:link>/g, (_, tag: string) => {
    const name = attr(tag, 'data-display-name') ?? people.get(attr(tag, 'ri:account-id') ?? '') ?? 'pengguna';
    return `<span class="mention">@${esc(name)}</span>`;
  });
  // Atlassian-only emoji have a ":name:" fallback instead of a character.
  const SHORT: Record<string, string> = { note: '📝', info: 'ℹ️', warning: '⚠️', tick: '✅', cross: '❌' };
  h = h.replace(/<ac:emoticon\b[^>]*?\/>/g, (tag) => {
    const f = attr(tag, 'ac:emoji-fallback') ?? '';
    return /^:[\w-]+:$/.test(f) ? (SHORT[f.slice(1, -1)] ?? '') : f;
  });
  h = h.replace(/<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})"[^>]*\/>/g, (_, d: string) => `<span class="date">${tanggal(d)}</span>`);
  // Header colours as inline background.
  h = h.replace(/data-highlight-colour="([^"]+)"/g, (_, c: string) => `style="background:${(c.match(/#[0-9a-f]{3,8}/i)?.[0] ?? c).replace(/["<>]/g, '')}"`);
  // Whatever Confluence-only markup is left.
  h = h.replace(/<\/?(ac|ri):[^>]*>/g, '');
  return DOMPurify.sanitize(h, { ADD_ATTR: ['style'] });
}
