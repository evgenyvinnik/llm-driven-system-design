import { describe, expect, it } from 'vitest'
import { extract, htmlToText, kindOf, markdownHeadings, PermanentError, unsupportedReason } from './extract.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('extract', () => {
  it('maps extensions to kinds and rejects unsupported types with a reason', () => {
    expect(kindOf('a.md')).toBe('markdown')
    expect(kindOf('A.HTML')).toBe('html')
    expect(kindOf('notes.txt')).toBe('text')
    expect(kindOf('scan.pdf')).toBeNull()
    expect(unsupportedReason('scan.pdf')).toMatch(/PDF/)
    expect(unsupportedReason('x.docx')).toMatch(/\.docx/)
  })

  it('strips HTML markup, scripts and styles, decodes entities and records headings', () => {
    const html = '<html><head><title>T</title><style>p{}</style></head><body><h1>Budget &amp; Plan</h1><p>Line one &lt;b&gt;.</p><script>alert(1)</script><p>Two&nbsp;words &#169;</p></body></html>'
    const out = htmlToText(html)
    expect(out.text).toBe('Budget & Plan\n\nLine one <b>.\n\nTwo words ©')
    expect(out.headings).toEqual([{ level: 1, text: 'Budget & Plan', charStart: 0 }])
    expect(out.text).not.toMatch(/alert|p\{\}/)
  })

  it('keeps markdown verbatim so offsets index the uploaded file', () => {
    const md = '# Title\n\nBody text.\n\n## Part two\n\nMore.'
    const out = extract(enc(md), 'markdown')
    expect(out.text).toBe(md)
    expect(markdownHeadings(md).map((h) => [h.text, md.slice(h.charStart, h.charStart + 2)])).toEqual([
      ['Title', '# '],
      ['Part two', '##'],
    ])
  })

  it('fails binary or invalid UTF-8 input permanently, with a reason', () => {
    expect(() => extract(new Uint8Array([72, 105, 0, 1, 2]), 'text')).toThrow(PermanentError)
    expect(() => extract(new Uint8Array([72, 105, 0, 1, 2]), 'text')).toThrow(/NUL byte at offset 2/)
    expect(() => extract(new Uint8Array([0xc3, 0x28, 0x41]), 'text')).toThrow(/not valid UTF-8/)
    expect(() => extract(new Uint8Array([]), 'text')).toThrow(/empty/)
    expect(() => extract(enc('<html><script>x</script></html>'), 'html')).toThrow(/No text content/)
  })

  it('normalizes CRLF line endings and drops a BOM', () => {
    expect(extract(enc('\uFEFFa\r\nb'), 'text').text).toBe('a\nb')
  })
})
