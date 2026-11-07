import { describe, expect, it } from 'vitest'
import { grade } from './grader.js'

const reference = '403 Forbidden: the server understood the request but refuses to authorize it.'
const concise = '403 Forbidden: the server understood the request but refuses to authorize it.'
const padded =
  'HTTP 403 Forbidden is a standard response status code. It means the server understood the request but refuses to authorize it. You usually see it when a signed-in user lacks permission. When debugging, check the request headers, the server logs and any proxy in between before retrying.'
const wrong = '403 Unauthorized: authentication is required or has failed.'

const judge = (output: string, strictness: 'lenient' | 'strict') => grade({ rubric: 'r', strictness, passGrade: 4, input: '', output, reference })

describe('mock judge', () => {
  it('passes a correct answer and fails a confused one', () => {
    expect(judge(concise, 'lenient')).toMatchObject({ grade: 5, passed: true })
    expect(judge(wrong, 'lenient').passed).toBe(false)
  })

  it('the strict rubric penalizes padding that the lenient one accepts', () => {
    expect(judge(padded, 'lenient').passed).toBe(true)
    const strict = judge(padded, 'strict')
    expect(strict.grade).toBe(3)
    expect(strict.passed).toBe(false)
    expect(strict.rationale).toContain('penalized as padded')
  })

  it('is deterministic and confident far from the boundary', () => {
    expect(judge(concise, 'strict')).toEqual(judge(concise, 'strict'))
    expect(judge(concise, 'lenient').confidence).toBeGreaterThan(0.9)
    const partial = grade({ rubric: 'r', strictness: 'lenient', passGrade: 4, input: '', output: '403 Forbidden: the server refuses it.', reference })
    expect(partial.confidence).toBeLessThan(0.5)
  })
})
