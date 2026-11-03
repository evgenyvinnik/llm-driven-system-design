import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const render = (text: string, final = true) => renderToStaticMarkup(createElement(Markdown, { text, final, citations: [] }))

describe('Markdown', () => {
  it('never turns model output into HTML', () => {
    const html = render('<img src=x onerror=alert(1)> **bold** <script>alert(1)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('does not render markdown links as anchors', () => {
    expect(render('[click me](https://evil.example)')).not.toContain('<a')
  })

  it('shows an unverified citation as struck-through text, not a link', () => {
    const html = render('Fact [m_fake1].')
    expect(html).toContain('line-through')
    expect(html).not.toContain('<a')
  })

  it('renders bullet lists', () => {
    expect(render('- one\n- two')).toContain('<ul')
  })
})
