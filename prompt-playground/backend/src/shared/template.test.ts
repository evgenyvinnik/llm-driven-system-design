import { describe, expect, it } from 'vitest'
import { contentHash, extractVariables, renderTemplate, requestHash } from './template.js'

describe('extractVariables', () => {
  it('returns unique names in order of first appearance across texts', () => {
    expect(extractVariables('Hi {{name}}, {{ topic }}', 'About {{topic}} and {{name}} {{extra_1}}')).toEqual([
      'name',
      'topic',
      'extra_1',
    ])
  })

  it('ignores malformed placeholders', () => {
    expect(extractVariables('{{1bad}} {{ok}} {single} {{with space}}')).toEqual(['ok'])
  })
})

describe('renderTemplate', () => {
  it('substitutes values and reports missing ones without blanking them', () => {
    const result = renderTemplate('Dear {{name}}, re: {{topic}}', { name: 'Ada' })
    expect(result.text).toBe('Dear Ada, re: {{topic}}')
    expect(result.missing).toEqual(['topic'])
  })

  it('treats an empty string as a provided value', () => {
    expect(renderTemplate('[{{x}}]', { x: '' })).toEqual({ text: '[]', missing: [] })
  })

  it('does not resolve prototype properties as variables', () => {
    expect(renderTemplate('{{constructor}}', {}).missing).toEqual(['constructor'])
  })
})

describe('hashing', () => {
  it('content hash distinguishes system text from template text', () => {
    expect(contentHash('ab', 'c')).not.toBe(contentHash('a', 'bc'))
  })

  it('request hash ignores key order and undefined fields', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1, e: undefined }))
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }))
  })
})
