import sanitizeHtml from 'sanitize-html';

/**
 * Page HTML comes straight from a contentEditable editor and is rendered with
 * dangerouslySetInnerHTML for every reader, including space admins. Without
 * cleaning, any member could store `<img onerror=...>` or a `javascript:` link
 * and run script in everyone else's session. This keeps the formatting the
 * editor and macros produce (headings, lists, tables, code, links, images, and
 * the inline styles the info/note/warning macros use) and drops scripts, event
 * handlers, iframes, and non-http(s) URLs.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span', 'blockquote',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark', 'small',
    'ul', 'ol', 'li', 'pre', 'code', 'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'nav',
  ],
  allowedAttributes: {
    '*': ['class', 'style', 'id'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
      background: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
      'border-left': [/^[\w\s#.-]+$/],
      'border-radius': [/^[\d.]+(px|em|rem|%)$/],
      padding: [/^[\d.\spxemr%]+$/],
      margin: [/^[\d.\spxemr%auto]+$/],
      'margin-top': [/^[\d.]+(px|em|rem|%)$/],
      'text-align': [/^(left|right|center|justify)$/],
      'font-weight': [/^(bold|normal|\d{3})$/],
    },
  },
  transformTags: {
    // Links that open a new tab must not hand the opener to the target page.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

export function sanitizePageHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
