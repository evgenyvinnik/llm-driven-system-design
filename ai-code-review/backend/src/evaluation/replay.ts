/**
 * Offline replay: each labeled pull request goes through the same prompt builder,
 * tool allowlist, parser, scanner, gate and decide that a live run uses, against
 * the mock reviewer in-process. Two answers come out of one replay: what the
 * flawed proposal would have done (the model's word) and what the corrected
 * design does (model + gate).
 *
 * Over-limit diffs are a special case. The corrected design never sends them;
 * the proposal truncates them alphabetically, so that is what its column replays.
 * @module evaluation/replay
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../shared/audit.js'
import { toGateFacts } from '../shared/facts.js'
import { decide, type ModelSignal } from '../shared/gate/decide.js'
import { evaluateGate, withinSizeLimits } from '../shared/gate/rules.js'
import type { GatePolicy } from '../shared/gate/types.js'
import type { HostFile, PullSnapshot } from '../shared/host-types.js'
import { parseModelOutput } from '../shared/model-output.js'
import { ModelCallError, type ModelCaller } from '../shared/model-types.js'
import { DEFAULT_POLICY } from '../shared/repos.js'
import { scanForInjection } from '../shared/scanner.js'
import { BASE_TREE } from '../githost/fixtures.js'
import { MAX_FILES_LISTED, toHostFile } from '../githost/store.js'
import { createInProcessCaller } from '../model/in-process.js'
import { defaultSettings } from '../model/settings.js'
import { runConversation } from '../worker/conversation.js'
import { scanInputs } from '../worker/pipeline.js'
import { buildPrompt } from '../worker/prompt.js'
import type { CaseResult, CorpusCase } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
export const CORPUS_PATH = join(here, 'corpus.json')

export function loadCorpus(): CorpusCase[] {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusCase[]
}

export const corpusHash = (corpus: CorpusCase[]) => sha256(JSON.stringify(corpus))

/** The proposal's truncation: first files alphabetically, the rest unread. */
const PROPOSAL_FILE_LIMIT = 100
const MAX_TOOL_ROUNDS = 3
const MAX_TOOL_CALLS = 8
const REPLAY_NONCE = 'c0ffee00c0ffee00'

export function caseToSnapshot(c: CorpusCase): { snapshot: PullSnapshot; tree: Record<string, string> } {
  const headSha = sha256(c.id).slice(0, 40)
  const files: HostFile[] = c.files.map(toHostFile).sort((a, b) => a.filename.localeCompare(b.filename))
  const tree = { ...BASE_TREE, ...(c.repoFiles ?? {}) }
  for (const change of c.files) {
    if (change.content !== undefined) tree[change.path] = change.content
    else if (change.add) tree[change.path] = `${tree[change.path] ?? ''}\n${change.add.join('\n')}`
  }
  const now = '2026-01-01T00:00:00.000Z'
  const snapshot: PullSnapshot = {
    pull: {
      number: 1,
      title: c.title,
      body: c.body,
      user: { login: c.author },
      state: 'open',
      head: { sha: headSha, ref: `corpus/${c.id}` },
      base: { ref: 'main' },
      head_seq: 1,
      changed_files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      created_at: now,
      updated_at: now,
    },
    files: files.slice(0, MAX_FILES_LISTED),
    filesTruncated: files.length > MAX_FILES_LISTED,
    commits: [{ sha: headSha, author: c.commitAuthor ?? c.author, message: c.title, seq: 1 }],
    comments: (c.comments ?? []).map((x, i) => ({ id: i + 1, user: { login: x.user }, body: x.body, created_at: now })),
    reviews: [],
    checks: c.ci === 'none' ? [] : DEFAULT_POLICY.requiredChecks.map((name) => ({ name, status: 'completed' as const, conclusion: c.ci as 'success' | 'failure', head_sha: headSha })),
  }
  return { snapshot, tree }
}

async function askModel(caller: ModelCaller, snapshot: PullSnapshot, tree: Record<string, string>, modelVersion: string) {
  const built = buildPrompt(snapshot, modelVersion, REPLAY_NONCE)
  const convo = await runConversation({
    caller,
    request: built.request,
    maxRounds: MAX_TOOL_ROUNDS,
    tools: {
      maxCalls: MAX_TOOL_CALLS,
      readFile: async (path) => tree[path] ?? null,
      changedFiles: () => snapshot.files.map((f) => ({ path: f.filename, previousPath: f.previous_filename, status: f.status })),
    },
  })
  return convo
}

export async function replayCase(c: CorpusCase, modelVersion: string, caller: ModelCaller, policy: GatePolicy = DEFAULT_POLICY): Promise<CaseResult> {
  const { snapshot, tree } = caseToSnapshot(c)
  const facts = toGateFacts(snapshot, snapshot.pull.head.sha, 'main')
  const gate = evaluateGate(facts, policy)
  const overLimit = withinSizeLimits(facts, policy).status !== 'pass'

  let signal: ModelSignal
  let modelVerdict = 'none'
  let modelConfidence: number | null = null
  let denied = 0
  let scannerHit = false

  const read = async (snap: PullSnapshot) => {
    try {
      const convo = await askModel(caller, snap, tree, modelVersion)
      const parsed = parseModelOutput(convo.text)
      denied = convo.tools.filter((t) => !t.allowed).length
      scannerHit = scanForInjection(scanInputs(snap, convo.tools)).length > 0
      if (!parsed.ok) return { kind: 'failure', code: 'model_malformed', detail: parsed.error } as ModelSignal
      modelVerdict = parsed.output.verdict
      modelConfidence = parsed.output.confidence
      return { kind: 'assessment', verdict: parsed.output.verdict, risk: parsed.output.risk, confidence: parsed.output.confidence } as ModelSignal
    } catch (err) {
      if (err instanceof ModelCallError) return { kind: 'failure', code: 'model_unavailable', detail: err.message } as ModelSignal
      throw err
    }
  }

  if (overLimit) {
    // The proposal's column: alphabetically truncated, so the tail goes unread.
    const truncated = { ...snapshot, files: snapshot.files.slice(0, PROPOSAL_FILE_LIMIT), pull: { ...snapshot.pull, changed_files: Math.min(PROPOSAL_FILE_LIMIT, snapshot.files.length) } }
    await read(truncated)
    signal = { kind: 'failure', code: 'model_not_called', detail: 'Over the size limit, so not sent to the model' }
  } else {
    signal = await read(snapshot)
  }

  const narrow = decide({ mode: 'narrow_auto', killSwitch: false, gate, model: signal, signals: { injection: scannerHit, toolDenied: denied > 0 }, minConfidence: 0.8, ciDeadlineExceeded: true })
  return {
    caseId: c.id,
    title: c.title,
    class: c.labels.class,
    dangerous: c.labels.dangerous,
    injection: c.labels.injection,
    humanDecision: c.labels.humanDecision,
    inScope: c.labels.inScope,
    modelVerdict,
    modelConfidence,
    modelOnly: modelVerdict === 'approve' ? 'approved' : 'escalated',
    gated: narrow.outcome === 'auto_approved' ? 'approved' : 'escalated',
    observeWould: narrow.would === 'approve' ? 'approve' : 'escalate',
    reasonCode: narrow.reasonCode,
    reason: narrow.reason,
    failedRules: gate.failed,
    toolsDenied: denied,
    scannerHit,
  }
}

export async function replayCorpus(corpus: CorpusCase[], modelVersion: string, caller?: ModelCaller): Promise<CaseResult[]> {
  const call = caller ?? createInProcessCaller({ ...defaultSettings(), failureRate: 0 })
  const out: CaseResult[] = []
  for (const c of corpus) out.push(await replayCase(c, modelVersion, call))
  return out
}
