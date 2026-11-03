/**
 * Development seed. Resets all chat data, then creates three users and a set
 * of conversations that exercise every client path: branches from an edit and
 * from regenerations, a 300-message thread (pagination and virtualization),
 * a stopped answer and a failed one (partial output kept), code and tables,
 * hostile markup that must render inert, and another user's private chat.
 *
 * Assistant text comes from the mock model's own generator, so seeded answers
 * look exactly like live ones. All names and content are fictitious.
 *
 * Accounts (password "password123"): alice, bob, admin (operator role).
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { estimateTokens, findModel } from '../shared/catalog.js'
import type { ContextMessage } from '../shared/context.js'
import { pool } from '../shared/db.js'
import { planGeneration } from '../model/generator.js'

interface Node {
  id: string
  role: 'user' | 'assistant'
  content: string
  depth: number
  parentId: string | null
  createdAt: Date
}

interface GenOpts {
  model?: string
  kind?: 'message' | 'edit' | 'regenerate'
  outcome?: 'completed' | 'cancelled' | 'failed'
}

class ConversationBuilder {
  readonly id = randomUUID()
  readonly nodes: Node[] = []
  private clock: number
  leafId: string | null = null

  constructor(
    readonly userId: string,
    readonly title: string,
    readonly model: string,
    startedAt: Date,
    private stepMs = 60_000,
  ) {
    this.clock = startedAt.getTime()
  }

  private tick(ms = this.stepMs): Date {
    this.clock += ms
    return new Date(this.clock)
  }

  private path(toId: string | null): ContextMessage[] {
    const out: ContextMessage[] = []
    let cursor = toId ? this.nodes.find((n) => n.id === toId) : undefined
    while (cursor) {
      out.unshift({ role: cursor.role, content: cursor.content })
      cursor = cursor.parentId ? this.nodes.find((n) => n.id === cursor!.parentId) : undefined
    }
    return out
  }

  /** Adds a user message under `parentId` (default: the current leaf) and its answer. Returns the user node. */
  ask(question: string, opts: GenOpts & { parentId?: string | null } = {}): Node {
    const parentId = opts.parentId === undefined ? this.leafId : opts.parentId
    const parent = parentId ? this.nodes.find((n) => n.id === parentId)! : null
    const user: Node = {
      id: randomUUID(),
      role: 'user',
      content: question,
      depth: parent ? parent.depth + 1 : 0,
      parentId,
      createdAt: this.tick(),
    }
    this.nodes.push(user)
    this.answer(user.id, opts)
    return user
  }

  /** Adds an assistant answer under a user message (a regeneration when one already exists). */
  answer(userMessageId: string, opts: GenOpts = {}): Node {
    const user = this.nodes.find((n) => n.id === userMessageId)!
    const model = opts.model ?? this.model
    const spec = findModel(model)!
    const nonce = randomUUID()
    const plan = planGeneration({ model, messages: this.path(user.id), maxTokens: spec.maxOutputTokens, nonce }, spec, {
      failureRate: 0,
      disconnectRate: 0,
    })
    const outcome = opts.outcome ?? 'completed'
    const tokens = outcome === 'completed' ? plan.tokens : plan.tokens.slice(0, Math.floor(plan.tokens.length * 0.35))
    const assistant: Node = {
      id: randomUUID(),
      role: 'assistant',
      content: tokens.join(''),
      depth: user.depth + 1,
      parentId: user.id,
      createdAt: this.tick(4000),
    }
    this.nodes.push(assistant)
    this.leafId = assistant.id
    generations.push({
      id: nonce,
      conversationId: this.id,
      userId: this.userId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      kind: opts.kind ?? 'message',
      model,
      outcome,
      output: assistant.content,
      inputTokens: estimateTokens(this.path(user.id).map((m) => m.content).join('\n')),
      outputTokens: tokens.length,
      finishReason: outcome === 'completed' ? plan.finishReason : outcome === 'cancelled' ? 'cancelled' : null,
      createdAt: assistant.createdAt,
      durationMs: Math.round((tokens.length / spec.tokensPerSecond) * 1000),
      ttftMs: spec.ttftMs,
    })
    return assistant
  }

  /** An edit: a new user message beside `original`, under the same parent, with its own answer. */
  edit(original: Node, question: string, opts: GenOpts = {}): Node {
    return this.ask(question, { ...opts, parentId: original.parentId, kind: 'edit' })
  }

  get updatedAt(): Date {
    return new Date(this.clock)
  }
}

interface SeedGeneration {
  id: string
  conversationId: string
  userId: string
  userMessageId: string
  assistantMessageId: string
  kind: string
  model: string
  outcome: string
  output: string
  inputTokens: number
  outputTokens: number
  finishReason: string | null
  createdAt: Date
  durationMs: number
  ttftMs: number
}

const generations: SeedGeneration[] = []
const conversations: ConversationBuilder[] = []

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()
const ago = (ms: number) => new Date(now - ms)

async function main() {
  const hash = await bcrypt.hash('password123', 10)
  const users = { alice: randomUUID(), bob: randomUUID(), admin: randomUUID() }

  // Today: a trip plan with an edited question and a regenerated answer (‹ 1/2 › and ‹ 1/3 ›).
  const trip = new ConversationBuilder(users.alice, 'Weekend trip to Lisbon', 'sim-swift', ago(3 * HOUR))
  trip.ask('I have a long weekend in Lisbon in October. What should I plan around?')
  const neighborhoods = trip.ask('Which neighborhoods are best for walking and food?')
  trip.ask('Can you give me a day by day plan with a list of steps?')
  trip.edit(neighborhoods, 'Which neighborhoods are quiet but still close to restaurants and trams?')
  const finalQ = trip.ask('Give me a packing list for rainy weather.')
  trip.answer(finalQ.id, { kind: 'regenerate' })
  trip.answer(finalQ.id, { kind: 'regenerate', model: 'sim-deep' })
  conversations.push(trip)

  // Today: code, so the renderer's code blocks and tables show up.
  const code = new ConversationBuilder(users.alice, 'Debounce helper in TypeScript', 'sim-deep', ago(5 * HOUR))
  code.ask('Write a TypeScript function that keeps the first unique search queries, with a snippet I can paste.')
  code.ask('Compare that approach with a Set versus a Map in a table, including trade-offs.')
  conversations.push(code)

  // Today: hostile markup from the "model", which the client must render inert.
  const unsafe = new ConversationBuilder(users.alice, 'Rendering untrusted HTML safely', 'sim-swift', ago(7 * HOUR))
  unsafe.ask('How should a chat app render model output that might contain HTML or XSS injection?')
  conversations.push(unsafe)

  // Yesterday: an answer the user stopped partway through.
  const bike = new ConversationBuilder(users.alice, 'Bike commute gear checklist', 'sim-swift', ago(DAY + 2 * HOUR))
  bike.ask('I am starting to commute by bike, 8 km each way. What gear do I need?')
  bike.ask('Make it a detailed checklist with steps for winter.', { outcome: 'cancelled' })
  conversations.push(bike)

  // Yesterday: a failed answer with partial output kept.
  const flaky = new ConversationBuilder(users.alice, 'Sourdough starter troubleshooting', 'sim-flaky', ago(DAY + 6 * HOUR))
  flaky.ask('My sourdough starter smells like acetone and is not rising. What is going on?')
  flaky.ask('How often should I feed it if my kitchen is cold?', { outcome: 'failed' })
  conversations.push(flaky)

  // Earlier this week: a long thread for pagination and virtualization (150 exchanges, 300 messages).
  const okr = new ConversationBuilder(users.alice, 'Quarterly OKR planning log', 'sim-swift', ago(4 * DAY), 90_000)
  const areas = ['onboarding', 'activation', 'retention', 'billing', 'support', 'reliability', 'search', 'mobile']
  const asks = [
    'Draft two key results for {a} this week.',
    'What metric would show progress on {a}?',
    'List the risks for the {a} objective.',
    'Summarize where {a} stands and what to do next.',
    'How do we measure {a} without adding new tracking?',
  ]
  for (let i = 0; i < 150; i++) {
    const area = areas[i % areas.length]
    okr.ask(`Week ${Math.floor(i / 5) + 1}, note ${(i % 5) + 1}: ${asks[i % asks.length].replace('{a}', area)}`)
  }
  conversations.push(okr)

  // Older: plain conversations so the sidebar has history.
  const older: [string, string, number][] = [
    ['Explaining compound interest to a teenager', 'How do I explain compound interest to a 14 year old with an example?', 9],
    ['Houseplants for a north-facing room', 'Which houseplants survive in a north-facing room with little light?', 12],
    ['Cover letter tone check', 'Is it okay for a cover letter to sound conversational rather than formal?', 20],
    ['Learning the guitar as an adult', 'What is a realistic practice plan for learning guitar at 35?', 33],
  ]
  for (const [title, question, days] of older) {
    const c = new ConversationBuilder(users.alice, title, 'sim-swift', ago(days * DAY))
    c.ask(question)
    c.ask('Thanks. Can you make that shorter?')
    conversations.push(c)
  }

  // Bob's private conversation: alice must never be able to read it.
  const bobChat = new ConversationBuilder(users.bob, 'Surprise party planning', 'sim-swift', ago(2 * HOUR))
  bobChat.ask('Help me plan a surprise party for Alice next Saturday with a checklist.')
  conversations.push(bobChat)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('TRUNCATE generations, messages, conversations, users CASCADE')
    await client.query(
      `INSERT INTO users (id, username, display_name, password_hash, role) VALUES
         ($1, 'alice', 'Alice Moreno', $4, 'user'),
         ($2, 'bob', 'Bob Okafor', $4, 'user'),
         ($3, 'admin', 'Operator', $4, 'admin')`,
      [users.alice, users.bob, users.admin, hash],
    )
    for (const c of conversations) {
      await client.query(
        `INSERT INTO conversations (id, user_id, title, model, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.id, c.userId, c.title, c.model, c.nodes[0].createdAt, c.updatedAt],
      )
      // Parents before children: nodes are in creation order.
      for (const n of c.nodes) {
        await client.query(
          `INSERT INTO messages (id, conversation_id, parent_id, role, content, depth, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [n.id, c.id, n.parentId, n.role, n.content, n.depth, n.createdAt],
        )
      }
      await client.query('UPDATE conversations SET current_leaf_id = $2 WHERE id = $1', [c.id, c.leafId])
    }
    for (const g of generations) {
      const started = new Date(g.createdAt.getTime() + 40)
      const firstToken = new Date(started.getTime() + g.ttftMs)
      const finished = new Date(firstToken.getTime() + g.durationMs)
      await client.query(
        `INSERT INTO generations (id, conversation_id, user_id, user_message_id, assistant_message_id, kind, model,
                                  status, idempotency_key, request_hash, attempt, output, output_truncated,
                                  finish_reason, error_code, error_message, input_tokens, output_tokens,
                                  context_messages, context_dropped, created_at, enqueued_at, started_at,
                                  first_token_at, finished_at, cancel_requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'seed', 1, $10, $11, $12, $13, $14, $15, $16, NULL, NULL,
                 $17, $17, $18, $19, $20, $21)`,
        [
          g.id,
          g.conversationId,
          g.userId,
          g.userMessageId,
          g.assistantMessageId,
          g.kind,
          g.model,
          g.outcome,
          `seed-${g.id}`,
          g.output,
          g.outcome !== 'completed' && g.output.length > 0,
          g.finishReason,
          g.outcome === 'failed' ? 'MODEL_ERROR' : null,
          g.outcome === 'failed' ? 'The model failed partway through this answer' : null,
          g.inputTokens,
          g.outputTokens,
          g.createdAt,
          started,
          firstToken,
          finished,
          g.outcome === 'cancelled' ? finished : null,
        ],
      )
    }
    await client.query('COMMIT')
    const messageCount = conversations.reduce((sum, c) => sum + c.nodes.length, 0)
    console.log(
      `Seeded 3 users, ${conversations.length} conversations, ${messageCount} messages, ${generations.length} generations`,
    )
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('Seed failed:', err)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

await main()
