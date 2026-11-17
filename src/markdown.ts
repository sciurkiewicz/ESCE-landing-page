import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style'],
  });
}
