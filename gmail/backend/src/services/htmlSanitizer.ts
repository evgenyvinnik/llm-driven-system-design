import sanitizeHtml from 'sanitize-html';

/**
 * Email bodies are written by other people and rendered as HTML in the
 * recipient's session: the textbook stored-XSS vector for a mail client. The
 * previous code stored `bodyHtml` verbatim and the reader injected it. This
 * keeps ordinary formatting (paragraphs, emphasis, lists, quotes, tables,
 * links, images) and removes scripts, event handlers, forms, iframes, styles
 * that could overlay the UI, and any non-http(s)/mailto URL.
 *
 * Remote images are kept, so a sender can still learn when a message is opened
 * (a tracking pixel); a production client proxies or blocks them by default.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
