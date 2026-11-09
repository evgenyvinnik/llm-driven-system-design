/**
 * Parses and validates `.ci/workflow.yml`. Validation is strict because the
 * alternative is worse: an unknown field silently ignored means a typo like
 * `idempotnet: false` turns off the one protection on a deploy step. Unknown
 * fields, unknown `needs` and dependency cycles all reject the workflow, and the
 * errors are recorded on the run.
 * @module workflow/parser
 */
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { ParsedJob, ParsedStep, ParsedUpload, ParsedWorkflow, ParseResult, TriggerFilter, WorkflowError } from './types.js'

export const MAX_WORKFLOW_BYTES = 64 * 1024
const MAX_JOBS = 64
const MAX_STEPS = 32
const DEFAULT_STEP_TIMEOUT_SECONDS = 60
const MAX_STEP_TIMEOUT_SECONDS = 600
const DEFAULT_RETENTION_DAYS = 7

const stringList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]))
const envMap = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid variable name'), z.union([z.string(), z.number(), z.boolean()]).transform(String))

const stepSchema = z
  .object({
    name: z.string().min(1).max(120),
    run: z.string().min(1).max(16_000),
    idempotent: z.boolean().default(true),
    'timeout-seconds': z.number().int().positive().max(MAX_STEP_TIMEOUT_SECONDS).default(DEFAULT_STEP_TIMEOUT_SECONDS),
    env: envMap.default({}),
  })
  .strict()

const uploadSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'may contain only letters, digits, dots, dashes and underscores'),
    path: z.string().min(1).max(300),
    'retention-days': z.number().int().positive().max(365).default(DEFAULT_RETENTION_DAYS),
  })
  .strict()

const jobSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    needs: z.union([z.string().min(1), z.array(z.string().min(1))]).transform((v) => (Array.isArray(v) ? v : [v])).optional(),
    'runs-on': stringList,
    environment: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
    secrets: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be UPPER_SNAKE_CASE')).max(32).optional(),
    env: envMap.optional(),
    strategy: z.object({ matrix: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(z.union([z.string(), z.number()])).min(1).max(16)) }).strict().optional(),
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
    upload: z.array(uploadSchema).max(16).optional(),
  })
  .strict()

const triggerSchema = z.object({ branches: z.array(z.string().min(1)).min(1).optional() }).strict().nullable()
const onSchema = z.union([
  z.enum(['push', 'pull_request']).transform((e) => ({ [e]: null })),
  z.array(z.enum(['push', 'pull_request'])).min(1).transform((list) => Object.fromEntries(list.map((e) => [e, null]))),
  z.object({ push: triggerSchema.optional(), pull_request: triggerSchema.optional() }).strict(),
])

const workflowSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    on: onSchema,
    jobs: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'job ids may contain only letters, digits, dashes and underscores'), z.unknown()),
  })
  .strict()

function fromZod(prefix: string, err: z.ZodError): WorkflowError[] {
  return err.issues.flatMap((issue): WorkflowError[] => {
    const path = [prefix, ...issue.path].filter((p) => p !== '').join('.')
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((k) => ({ code: 'UNKNOWN_FIELD', path: path ? `${path}.${k}` : k, message: `Unknown field "${k}"${path ? ` in ${path}` : ''}` }))
    }
    return [{ code: 'INVALID_FIELD', path, message: `${path || 'workflow'}: ${issue.message}` }]
  })
}

function expandMatrix(matrix: Record<string, (string | number)[]>): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}]
  for (const [axis, values] of Object.entries(matrix)) {
    combos = combos.flatMap((combo) => values.map((v) => ({ ...combo, [axis]: String(v) })))
  }
  return combos
}

function normalizeStep(step: z.output<typeof stepSchema>): ParsedStep {
  return { name: step.name, run: step.run, idempotent: step.idempotent, timeoutSeconds: step['timeout-seconds'], env: step.env }
}

function normalizeUpload(upload: z.output<typeof uploadSchema>): ParsedUpload {
  return { name: upload.name, path: upload.path, retentionDays: upload['retention-days'] }
}

/** A cycle as a readable path, or null. Depth-first with the classic three colours. */
export function findCycle(jobs: Pick<ParsedJob, 'key' | 'needs'>[]): string[] | null {
  const needsOf = new Map(jobs.map((j) => [j.key, j.needs]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null
    if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key]
    state.set(key, 'visiting')
    stack.push(key)
    for (const dep of needsOf.get(key) ?? []) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(key, 'done')
    return null
  }
  for (const job of jobs) {
    const cycle = visit(job.key)
    if (cycle) return cycle
  }
  return null
}

export function parseWorkflow(source: string): ParseResult {
  if (Buffer.byteLength(source, 'utf8') > MAX_WORKFLOW_BYTES) {
    return { ok: false, errors: [{ code: 'TOO_LARGE', path: '', message: `Workflow file is larger than ${MAX_WORKFLOW_BYTES} bytes` }] }
  }
  const doc = parseDocument(source)
  if (doc.errors.length > 0) {
    return { ok: false, errors: doc.errors.map((e) => ({ code: 'YAML_SYNTAX' as const, path: '', message: `YAML syntax error: ${e.message}` })) }
  }
  let json: unknown
  try {
    // toJS enforces the alias limit, so a YAML alias bomb lands here and not in the heap.
    json = doc.toJS({ maxAliasCount: 50 })
  } catch (err) {
    return { ok: false, errors: [{ code: 'YAML_SYNTAX', path: '', message: `YAML error: ${(err as Error).message}` }] }
  }
  const top = workflowSchema.safeParse(json)
  if (!top.success) return { ok: false, errors: fromZod('', top.error) }

  const errors: WorkflowError[] = []
  const rawJobs = Object.entries(top.data.jobs)
  if (rawJobs.length === 0) errors.push({ code: 'INVALID_FIELD', path: 'jobs', message: 'A workflow needs at least one job' })
  if (rawJobs.length > MAX_JOBS) errors.push({ code: 'TOO_LARGE', path: 'jobs', message: `A workflow may have at most ${MAX_JOBS} jobs` })

  // A `needs` on a matrix job means every leg of it, so legs are expanded first.
  const jobs: ParsedJob[] = []
  const legsOf = new Map<string, string[]>()
  for (const [id, raw] of rawJobs) {
    const parsed = jobSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(...fromZod(`jobs.${id}`, parsed.error))
      continue
    }
    const job = parsed.data
    const combos = job.strategy ? expandMatrix(job.strategy.matrix) : [null]
    const legs: string[] = []
    for (const combo of combos) {
      const suffix = combo ? Object.entries(combo).map(([k, v]) => `${k}-${v}`).join('-') : ''
      const key = suffix ? `${id}-${suffix.replace(/[^A-Za-z0-9_-]/g, '_')}` : id
      const display = job.name ?? id
      legs.push(key)
      jobs.push({
        key,
        name: combo ? `${display} (${Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(', ')})` : display,
        needs: job.needs ?? [],
        runsOn: job['runs-on'],
        environment: job.environment ?? null,
        secrets: job.secrets ?? [],
        env: { ...(job.env ?? {}), ...Object.fromEntries(Object.entries(combo ?? {}).map(([k, v]) => [`MATRIX_${k.toUpperCase()}`, v])) },
        steps: job.steps.map(normalizeStep),
        uploads: (job.upload ?? []).map(normalizeUpload),
        matrix: combo,
      })
    }
    legsOf.set(id, legs)
  }
  if (jobs.length > MAX_JOBS) errors.push({ code: 'TOO_LARGE', path: 'jobs', message: `The matrix expands to more than ${MAX_JOBS} jobs` })
  if (errors.length > 0) return { ok: false, errors }

  for (const job of jobs) {
    const expanded: string[] = []
    for (const need of job.needs) {
      const legs = legsOf.get(need)
      if (!legs) errors.push({ code: 'UNKNOWN_NEEDS', path: `jobs.${job.key}.needs`, message: `Job "${job.key}" needs "${need}", which is not defined in this workflow` })
      else expanded.push(...legs)
    }
    job.needs = [...new Set(expanded)]
  }
  if (errors.length > 0) return { ok: false, errors }

  const cycle = findCycle(jobs)
  if (cycle) return { ok: false, errors: [{ code: 'DEPENDENCY_CYCLE', path: 'jobs', message: `Dependency cycle: ${cycle.join(' -> ')}` }] }

  const on: ParsedWorkflow['on'] = {}
  for (const [event, filter] of Object.entries(top.data.on) as ['push' | 'pull_request', { branches?: string[] } | null | undefined][]) {
    if (filter !== undefined) on[event] = { branches: filter?.branches ?? null } satisfies TriggerFilter
  }
  return { ok: true, workflow: { name: top.data.name ?? 'workflow', on, jobs } }
}

/** `*` matches within a path segment and `**` matches across them, as branch filters usually do. */
export function branchMatches(branch: string, pattern: string): boolean {
  const regex = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${regex}$`).test(branch)
}

export function matchesTrigger(workflow: Pick<ParsedWorkflow, 'on'>, eventType: string, branch: string): boolean {
  const filter = workflow.on[eventType as 'push' | 'pull_request']
  if (!filter) return false
  return filter.branches === null || filter.branches.some((p) => branchMatches(branch, p))
}
