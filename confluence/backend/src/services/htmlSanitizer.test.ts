import { describe, it, expect } from 'vitest';
import { sanitizePageHtml } from './htmlSanitizer.js';

describe('sanitizePageHtml', () => {
  it('removes scripts, event handlers, and javascript: links', () => {
    const dirty =
      '<p>Hi<script>steal()</script></p><img src="x.png" onerror="steal()"><a href="javascript:steal()">x</a><iframe src="https://evil"></iframe>';
    const clean = sanitizePageHtml(dirty);
    expect(clean).not.toMatch(/script|onerror|javascript:|iframe/i);
    expect(clean).toContain('<p>Hi</p>');
    expect(clean).toContain('<img src="x.png" />');
  });

  it('keeps editor formatting and the macro inline styles', () => {
    const macro =
      '<div class="macro-note" style="background:#EAE6FF;border-left:4px solid #6554C0;padding:12px 16px;border-radius:4px"><strong style="color:#6554C0;">Note</strong></div>';
    const clean = sanitizePageHtml(`<h2>Setup</h2><ol><li>Clone</li></ol>${macro}`);
    expect(clean).toContain('<h2>Setup</h2><ol><li>Clone</li></ol>');
    expect(clean).toContain('class="macro-note"');
    expect(clean).toContain('border-left:4px solid #6554C0');
    expect(clean).toContain('color:#6554C0');
  });

  it('drops style properties outside the allow-list', () => {
    const clean = sanitizePageHtml('<p style="position:fixed;top:0;color:red">x</p>');
    expect(clean).toBe('<p style="color:red">x</p>');
  });
});
