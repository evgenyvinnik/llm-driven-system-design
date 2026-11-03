import { describe, it, expect, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), getClient: vi.fn(), default: {} }));
vi.mock('./redis.js', () => ({
  invalidateMailboxes: vi.fn(),
  mailboxGeneration: vi.fn().mockResolvedValue('0'),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./metrics.js', () => ({ emailsSentTotal: { inc: vi.fn() } }));

import { resolveRecipientRoles } from './messageService.js';
import { sanitizeEmailHtml } from './htmlSanitizer.js';
import { visibleMessageSql } from './threadService.js';

describe('resolveRecipientRoles', () => {
  it('normalizes case and whitespace and removes duplicates', () => {
    const roles = resolveRecipientRoles({ to: ['Bob@Gmail.local', ' bob@gmail.local '], cc: [], bcc: [] });
    expect([...roles]).toEqual([['bob@gmail.local', 'to']]);
  });

  it('keeps the most visible role when an address is listed twice', () => {
    const roles = resolveRecipientRoles({
      to: ['bob@gmail.local'],
      cc: ['bob@gmail.local', 'charlie@gmail.local'],
      bcc: ['charlie@gmail.local', 'alice@gmail.local'],
    });
    expect(Object.fromEntries(roles)).toEqual({
      'bob@gmail.local': 'to',
      'charlie@gmail.local': 'cc',
      'alice@gmail.local': 'bcc',
    });
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips scripts, handlers, forms, iframes and javascript: links', () => {
    const clean = sanitizeEmailHtml(
      '<p onclick="x()">Hi</p><script>steal()</script><img src="https://x/y.png" onerror="steal()">' +
        '<a href="javascript:steal()">click</a><form action="https://evil"><input name="pw"></form><iframe src="https://evil"></iframe>'
    );
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|<form|<input|iframe/i);
    expect(clean).toContain('<p>Hi</p>');
    expect(clean).toContain('<img src="https://x/y.png" />');
  });

  it('opens links in a new tab without handing over the opener', () => {
    expect(sanitizeEmailHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
    );
  });
});

describe('visibleMessageSql', () => {
  it('grants visibility to the sender or a recipient of that message, nothing broader', () => {
    const sql = visibleMessageSql('m').replace(/\s+/g, ' ');
    expect(sql).toContain('m.sender_id = $1');
    expect(sql).toContain('vis.message_id = m.id AND vis.user_id = $1');
    expect(sql).not.toMatch(/thread_user_state|thread_labels/);
  });
});
