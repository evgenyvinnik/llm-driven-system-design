/**
 * The mock judge's grading. Pure and deterministic (a judge runs at
 * temperature 0): the same (rubric config, output, reference) always gets the
 * same grade, so re-scoring with an unchanged judge config reproduces scores.
 *
 * Grade 1-5 from recall of the reference's content words in the output. The
 * strict rubric also docks two grades for padding (output much longer than the
 * reference). Confidence is low when recall sits near the pass threshold:
 * those are the cases a human should look at.
 * @module judge/grader
 */

export interface JudgeRequest {
  rubric: string
  strictness: 'lenient' | 'strict'
  passGrade: number
  input: string
  output: string
  reference: string
}

export interface JudgeVerdict {
  grade: number
  score: number
  passed: boolean
  confidence: number
  rationale: string
}

const STOP = new Set('a an and are as at be but by for from has have if in into is it its of on or so than that the their then there this to was were when which with'.split(' '))

export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).filter((w) => !STOP.has(w))
}

export function grade(req: JudgeRequest): JudgeVerdict {
  const ref = [...new Set(contentWords(req.reference))]
  const outWords = contentWords(req.output)
  const out = new Set(outWords)
  const covered = ref.filter((w) => out.has(w))
  const recall = ref.length > 0 ? covered.length / ref.length : 0
  let g = 1 + Math.round(recall * 4)
  const totalOut = (req.output.match(/\S+/g) ?? []).length
  const totalRef = Math.max(1, (req.reference.match(/\S+/g) ?? []).length)
  const padded = totalOut > 2.5 * totalRef && totalOut > 8
  if (req.strictness === 'strict' && padded) g = Math.max(1, g - 2)
  const passed = g >= req.passGrade
  // Distance from the recall that sits exactly on the pass boundary.
  const boundary = (req.passGrade - 1.5) / 4
  const distance = Math.abs(recall - boundary) + (req.strictness === 'strict' && padded ? -0.15 : 0)
  const confidence = Math.round(Math.min(0.99, Math.max(0.05, distance / 0.3)) * 100) / 100
  const missing = ref.filter((w) => !out.has(w)).slice(0, 4)
  const parts = [`covers ${covered.length}/${ref.length} key terms`]
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
  if (padded) parts.push(`${req.strictness === 'strict' ? 'penalized as padded' : 'padded'} (${totalOut} words vs ${totalRef})`)
  return { grade: g, score: (g - 1) / 4, passed, confidence, rationale: `Grade ${g}/5: ${parts.join('; ')}.` }
}
