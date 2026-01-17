import { XMLParser } from 'fast-xml-parser';

export interface RSSItem {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  author?: string;
  category?: string | string[];
  guid?: string;
  content?: string;
  'content:encoded'?: string;
  'dc:creator'?: string;
}

export interface RSSFeed {
  title: string;
  link: string;
  description?: string;
  items: RSSItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * Parse RSS/Atom feed XML content
 */
export function parseRSS(xml: string): RSSFeed {
  const parsed = parser.parse(xml);

  // Handle RSS 2.0
  if (parsed.rss?.channel) {
    const channel = parsed.rss.channel;
    return {
      title: channel.title || '',
      link: channel.link || '',
      description: channel.description || '',
      items: normalizeItems(channel.item),
    };
  }

  // Handle Atom
  if (parsed.feed) {
    const feed = parsed.feed;
    return {
      title: feed.title || '',
      link: extractAtomLink(feed.link),
      description: feed.subtitle || '',
      items: normalizeAtomEntries(feed.entry),
    };
  }

  // Handle RDF (RSS 1.0)
  if (parsed['rdf:RDF']) {
    const rdf = parsed['rdf:RDF'];
    const channel = rdf.channel;
    return {
      title: channel?.title || '',
      link: channel?.link || '',
      description: channel?.description || '',
      items: normalizeItems(rdf.item),
    };
  }

  throw new Error('Unknown feed format');
}

function normalizeItems(items: unknown): RSSItem[] {
  if (!items) return [];
  const itemArray = Array.isArray(items) ? items : [items];

  return itemArray.map((item: Record<string, unknown>) => ({
    title: String(item.title || ''),
    link: String(item.link || item.guid || ''),
    description: String(item.description || ''),
    pubDate: item.pubDate as string | undefined,
    author: String(item.author || item['dc:creator'] || ''),
    category: item.category as string | string[] | undefined,
    guid: String(item.guid || item.link || ''),
    content: String(item['content:encoded'] || item.content || ''),
  }));
}

function normalizeAtomEntries(entries: unknown): RSSItem[] {
  if (!entries) return [];
  const entryArray = Array.isArray(entries) ? entries : [entries];

  return entryArray.map((entry: Record<string, unknown>) => ({
    title: extractText(entry.title),
    link: extractAtomLink(entry.link),
    description: extractText(entry.summary),
    pubDate: String(entry.published || entry.updated || ''),
    author: extractAtomAuthor(entry.author),
    category: extractAtomCategories(entry.category),
    guid: String(entry.id || ''),
    content: extractText(entry.content),
  }));
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return String(obj['#text'] || obj['$t'] || '');
  }
  return String(value);
}

function extractAtomLink(link: unknown): string {
  if (!link) return '';
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    const alternate = link.find((l: Record<string, unknown>) => l['@_rel'] === 'alternate' || !l['@_rel']);
    return alternate ? String(alternate['@_href'] || '') : '';
  }
  if (typeof link === 'object' && link !== null) {
    return String((link as Record<string, unknown>)['@_href'] || '');
  }
  return '';
}

function extractAtomAuthor(author: unknown): string {
  if (!author) return '';
  if (typeof author === 'string') return author;
  if (typeof author === 'object' && author !== null) {
    const obj = author as Record<string, unknown>;
    return String(obj.name || '');
  }
  return '';
}

function extractAtomCategories(category: unknown): string[] {
  if (!category) return [];
  const cats = Array.isArray(category) ? category : [category];
  return cats.map((c: Record<string, unknown>) => String(c['@_term'] || c['@_label'] || c || ''));
}

/**
 * Clean HTML from text content
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a summary from text content
 */
export function extractSummary(text: string, maxLength = 300): string {
  const cleaned = stripHtml(text);
  if (cleaned.length <= maxLength) return cleaned;

  // Try to break at sentence boundary
  const truncated = cleaned.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclaim = truncated.lastIndexOf('!');

  const lastSentence = Math.max(lastPeriod, lastQuestion, lastExclaim);
  if (lastSentence > maxLength * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }

  return truncated + '...';
}
