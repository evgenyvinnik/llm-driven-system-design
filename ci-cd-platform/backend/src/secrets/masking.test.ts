import { describe, expect, it } from 'vitest'
import { MASK, maskVariants, StreamMasker } from './masking.js'

const SECRET = 'hunter2-prod-token'

function run(values: string[], chunks: string[]): string[] {
  const masker = new StreamMasker(values)
  return [...chunks.flatMap((c) => masker.feed(c)), ...masker.flush()]
}

describe('StreamMasker', () => {
  it('masks a value inside one chunk', () => {
    expect(run([SECRET], [`token=${SECRET} ok\n`])).toEqual([`token=${MASK} ok`])
  })

  it('masks a value split across two chunks', () => {
    const lines = run([SECRET], ['token=hunter2-', 'prod-token done\n'])
    expect(lines).toEqual([`token=${MASK} done`])
    expect(lines.join()).not.toContain('hunter2')
  })

  it('masks a value split across every possible boundary', () => {
    for (let cut = 1; cut < SECRET.length; cut++) {
      const lines = run([SECRET], [`a ${SECRET.slice(0, cut)}`, `${SECRET.slice(cut)} b\n`])
      expect(lines).toEqual([`a ${MASK} b`])
    }
  })

  it('masks a value delivered a character at a time', () => {
    const lines = run([SECRET], [...`x${SECRET}y\n`])
    expect(lines).toEqual([`x${MASK}y`])
  })

  it('holds a partial line back and never exposes it until the line completes', () => {
    const masker = new StreamMasker([SECRET])
    expect(masker.feed('token=hunter2-')).toEqual([])
    expect(masker.partial).toBe('token=hunter2-')
    expect(masker.feed('prod-token\n')).toEqual([`token=${MASK}`])
    expect(masker.partial).toBe('')
  })

  it('resumes from a persisted partial, as another API instance would', () => {
    const first = new StreamMasker([SECRET])
    first.feed('token=hunter2-')
    const second = new StreamMasker([SECRET], first.partial)
    expect(second.feed('prod-token!\n')).toEqual([`token=${MASK}!`])
  })

  it('flushes a final line without a newline, masked', () => {
    expect(run([SECRET], [`end ${SECRET}`])).toEqual([`end ${MASK}`])
  })

  it('masks several values, longest first, so a prefix never leaves a tail behind', () => {
    expect(run(['abcd', 'abcdefgh'], ['abcdefgh abcd\n'])).toEqual([`${MASK} ${MASK}`])
  })

  it('masks common encodings', () => {
    const b64 = Buffer.from(SECRET).toString('base64')
    expect(run([SECRET], [`auth ${b64}\n`])).toEqual([`auth ${MASK}`])
    expect(run(['p@ss word'], [`url=${encodeURIComponent('p@ss word')}\n`])).toEqual([`url=${MASK}`])
  })

  it('masks each line of a multi-line value', () => {
    expect(run(['line-one\nline-two'], ['line-one\n', 'x line-two y\n'])).toEqual([MASK, `x ${MASK} y`])
  })

  it('leaves values too short to mask alone, rather than shredding the log', () => {
    expect(maskVariants(['abc'])).toEqual([])
    expect(run(['abc'], ['abcabc\n'])).toEqual(['abcabc'])
  })

  it('passes everything through when there is nothing to mask', () => {
    expect(run([], ['a\nb\n', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('normalizes CRLF', () => {
    expect(run([], ['a\r\nb\r\n'])).toEqual(['a', 'b'])
  })

  it('never lets a value through a very long line with no newline, whatever the cut', () => {
    const filler = 'x'.repeat(100)
    for (let offset = 0; offset < 40; offset++) {
      const masker = new StreamMasker([SECRET], '', 64)
      const text = `${'y'.repeat(offset)}${filler}${SECRET}${filler}`
      const out: string[] = []
      for (let i = 0; i < text.length; i += 17) out.push(...masker.feed(text.slice(i, i + 17)))
      out.push(...masker.flush())
      const joined = out.join('')
      expect(joined).not.toContain('hunter2')
      expect(joined).toContain(MASK)
      expect(joined.length).toBe(text.length - SECRET.length + MASK.length)
    }
  })
})
