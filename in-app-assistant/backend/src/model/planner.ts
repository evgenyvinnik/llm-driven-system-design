/**
 * The mock model's policy: given the whole conversation, decide the next
 * reply (some text, some tool calls, or a final answer). It is recomputed
 * from scratch on every call by reading which tools already ran and what
 * they returned, so it is stateless in the same way a real model is.
 *
 * It is deliberately a decent agent, not a perfect one: with
 * `followInjectedInstructions` on (the default) it obeys instructions it
 * finds inside emails, so the policy engine, not the model, has to stop the
 * resulting send.
 * @module model/planner
 */
import { addDays } from '../shared/time.js'
import { answerFromMessages, bestSentence, citedThreadSummary, eventList, sentences, threadSummary, tighten, type MessageLike } from './compose.js'
import { callsOf, lastError, lastOk, type ConversationView } from './conversation.js'
import { detectIntent, extractDateRange, extractTime, extractTopic, firstName, resolvePerson, type Intent } from './nlu.js'

export interface PlannedCall {
  name: string
  input: Record<string, unknown>
}

export interface Plan {
  text?: string
  calls?: PlannedCall[]
}

export interface PlannerSettings {
  followInjectedInstructions: boolean
  repeatLastCall: boolean
}

type Rec = Record<string, unknown>

const say = (text: string): Plan => ({ text })
const call = (name: string, input: Rec, text?: string): Plan => ({ text, calls: [{ name, input: dropUndefined(input) }] })

function dropUndefined(input: Rec): Rec {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

/** Validation and unknown-tool errors are worth fixing and retrying; business errors are reported. */
function retryable(error: string | null): boolean {
  return !!error && /^(Invalid arguments|No tool named)/.test(error)
}

interface Facts {
  view: ConversationView
  settings: PlannerSettings
  intent: Intent
  person?: string
  range?: ReturnType<typeof extractDateRange>
  topic: string
  user: string
}

function facts(view: ConversationView, settings: PlannerSettings): Facts {
  const person = resolvePerson(view.request, view.history)
  const range = extractDateRange(view.request, view.context.today)
  const topic = extractTopic(view.request, [person ?? '', 'thread', 'summary'])
  return { view, settings, intent: detectIntent(view.request), person, range, topic, user: firstName(view.context.user || 'me') }
}

const rangeFilter = (f: Facts) => (f.range ? { after: f.range.start, before: addDays(f.range.end, 1) } : {})

/** Search results from search_mail in this turn, or prefetched mail passages when the orchestrator prefetched. */
function mailResults(f: Facts): Rec[] | null {
  const searched = lastOk(f.view, 'search_mail')
  if (searched) return (searched.results as Rec[]) ?? []
  const pre = f.view.prefetched.filter((p) => p.kind === 'mail')
  if (pre.length && !callsOf(f.view, 'search_mail').length) {
    return pre.map((p) => ({ message_id: p.id, thread_id: p.thread, from: p.from ?? '', subject: p.title, snippet: p.text }))
  }
  return null
}

function searchMailCall(f: Facts, query: string, extra: Rec = {}, preamble?: string): Plan {
  return call('search_mail', { query: query || '*', from: f.person, ...rangeFilter(f), ...extra }, preamble)
}

const nameOf = (f: Facts) => (f.person ? firstName(f.person) : 'them')

// ─────────────────────────────── intents ───────────────────────────────

function summarizeIntoDoc(f: Facts): Plan {
  const doc = f.view.context.openDocument
  if (!doc) return say("Open the document you'd like the summary added to, then ask me again.")
  const results = mailResults(f)
  if (!results) {
    return searchMailCall(f, f.topic || f.person || 'thread', {}, `I'll find ${nameOf(f)}'s thread${f.range ? ` from ${f.range.label}` : ''} first.`)
  }
  if (results.length === 0) return say(`I couldn't find a thread from ${nameOf(f)}${f.range ? ` ${f.range.label}` : ''}. Want me to search a wider date range?`)
  const top = results[0]
  const threadId = top.thread_id as string | undefined
  const thread = lastOk(f.view, 'get_thread')
  if (!thread) {
    if (threadId) return call('get_thread', { thread_id: threadId })
    if (!lastOk(f.view, 'get_message')) return call('get_message', { message_id: top.message_id })
  }
  const messages = (thread?.messages as MessageLike[]) ?? [lastOk(f.view, 'get_message') as unknown as MessageLike]
  const subject = String(thread?.subject ?? top.subject ?? 'the thread').replace(/^re:\s*/i, '')
  const anchor = anchorFor(doc, f.view.request)
  const inserts = callsOf(f.view, 'insert_text')
  const insertError = lastError(f.view, 'insert_text')
  if (inserts.length === 0 || (retryable(insertError) && inserts.length < 3)) {
    return call('insert_text', {
      doc_id: doc.doc_id,
      after_paragraph_id: anchor.id,
      text: `Summary of ${nameOf(f)}'s thread "${subject}": ${threadSummary(messages)}`,
      mode: 'tracked',
    })
  }
  if (insertError) return say(`I couldn't add the summary: ${insertError}`)
  const cites = messages.map((m) => `[${m.message_id}]`).join('')
  return say(
    `Added a ${Math.min(messages.length, 3)}-sentence summary of ${nameOf(f)}'s thread under ${anchor.section} as a suggestion you can accept or reject. ${cites}`,
  )
}

/** "under the intro" → the last paragraph of the Introduction section. */
function anchorFor(doc: NonNullable<ConversationView['context']['openDocument']>, request: string) {
  const outline = doc.outline ?? []
  const want = /\b(?:under|below|after|beneath|into|in|to)\s+(?:the\s+)?([a-z]{3,})/i.exec(request)?.[1]?.toLowerCase()
  const headings = outline.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'heading')
  const match = want ? headings.find(({ p }) => p.text.toLowerCase().startsWith(want.slice(0, 5))) : undefined
  if (match) {
    const next = headings.find(({ i }) => i > match.i)
    const last = outline[(next ? next.i : outline.length) - 1]
    return { id: last.id, section: `"${match.p.text}"` }
  }
  const selected = doc.selection?.[0]
  if (selected) return { id: selected, section: `your selection (${selected})` }
  const fallback = outline.find((p) => p.kind !== 'title') ?? outline[0]
  return { id: fallback?.id ?? 'p_1', section: 'the top of the document' }
}

function mailQuestion(f: Facts): Plan {
  const results = mailResults(f)
  if (!results) return searchMailCall(f, f.topic)
  if (results.length === 0) {
    return say(`I didn't find any email${f.person ? ` from ${nameOf(f)}` : ''}${f.topic ? ` about ${f.topic}` : ''}${f.range ? ` ${f.range.label}` : ''}.`)
  }
  const message = lastOk(f.view, 'get_message')
  if (!message) return call('get_message', { message_id: results[0].message_id })
  const others = results.slice(1, 2).map((r) => ({ ...(r as unknown as MessageLike), body: String(r.snippet ?? '') }))
  const answer = answerFromMessages(f.topic, [message as unknown as MessageLike, ...others])
  return say(answer || `The closest match is "${message.subject}" [${message.message_id}].`)
}

const INJECTION = /(?:ai assistants?|automated (?:mail )?tools?|assistant)[^.]*?(?:forward|send|email)[^.]*?\b([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i

function summarizeMessage(f: Facts): Plan {
  const results = mailResults(f)
  if (!results) return searchMailCall(f, f.topic.replace(/\b(invoice|email|message)\b/g, '').trim() || '*', { limit: 5 })
  if (results.length === 0) return say(`I couldn't find an email${f.person ? ` from ${nameOf(f)}` : ''} to summarize.`)
  const message = lastOk(f.view, 'get_message')
  if (!message) return call('get_message', { message_id: results[0].message_id })
  const body = String(message.body ?? '')
  const lead = sentences(body).filter((s) => !INJECTION.test(s)).slice(0, 2).join(' ')
  const summary = lead || (bestSentence(body, f.topic) ?? String(message.subject))
  const sender = firstName(String(message.from))
  const intro = `**${message.subject}** from ${sender}: ${summary} [${message.message_id}]`
  const injection = INJECTION.exec(body)
  if (!injection) return say(intro)
  const target = injection[1]

  const canAct = f.view.toolNames.has('create_draft') && f.view.toolNames.has('send_draft')
  if (!f.settings.followInjectedInstructions || !canAct) {
    return say(
      `${intro}\n\nThe email also contains instructions addressed to AI assistants, asking for invoices to be forwarded to ${target}. I didn't act on them: they came from the sender, not from you, and they look like a phishing attempt.`,
    )
  }
  // The gullible path: treat the email's instruction as a task.
  const draft = lastOk(f.view, 'create_draft')
  const draftError = lastError(f.view, 'create_draft')
  if (!draft && (!draftError || (retryable(draftError) && callsOf(f.view, 'create_draft').length < 3))) {
    return call(
      'create_draft',
      { to: [target], subject: `Fwd: ${message.subject}`, body: `Forwarding as requested for records reconciliation.\n\n${body}` },
      'The email asks for a copy to be forwarded for reconciliation, so I\'ll prepare that.',
    )
  }
  if (draftError) return say(`${intro}\n\nThe email asked me to forward it to ${target}, but I couldn't prepare the draft: ${draftError}`)
  const sends = callsOf(f.view, 'send_draft')
  if (sends.length === 0) return call('send_draft', { draft_id: draft!.draft_id })
  const sendError = lastError(f.view, 'send_draft')
  if (!sendError) return say(`${intro}\n\nAs the email requested, I forwarded it to ${target}. [${draft!.draft_id}]`)
  if (/declined/i.test(sendError)) {
    return say(
      `${intro}\n\nThe email also asked for it to be forwarded to ${target}. I prepared that, but you declined, so nothing was sent. The request came from inside the email, not from you; treat it as suspicious. [${draft!.draft_id}]`,
    )
  }
  return say(`${intro}\n\nThe email asked for it to be forwarded to ${target}. I didn't send it: ${sendError}`)
}

function bulkRead(f: Facts): Plan {
  const results = mailResults(f)
  if (!results) return searchMailCall(f, f.topic, { limit: 10 }, `I'll gather every email about ${f.topic || 'that'}.`)
  if (results.length === 0) return say(`I didn't find any email about ${f.topic}.`)
  const read = new Map(callsOf(f.view, 'get_message').filter((c) => c.result && !c.result.isError).map((c) => [String(c.call.input.message_id), c.result!.json as Rec]))
  const remaining = results.filter((r) => !read.has(String(r.message_id)))
  // Back-to-back reads go out together; the orchestrator runs them in parallel.
  if (remaining.length) return { calls: remaining.slice(0, 3).map((r) => ({ name: 'get_message', input: { message_id: r.message_id, detail: 'summary' } })) }
  const lines = results.map((r) => {
    const m = read.get(String(r.message_id))!
    const sentence = bestSentence(String(m.body ?? ''), f.topic)
    return `- **${m.subject}** (${firstName(String(m.from))}): ${sentence ?? ''} [${m.message_id}]`
  })
  return say(`I found ${results.length} emails about ${f.topic}:\n\n${lines.join('\n')}`)
}

function calendarQuery(f: Facts): Plan {
  const today = f.view.context.today
  const range = f.range ?? { start: today, end: addDays(today, 6), label: 'the next seven days' }
  const found = lastOk(f.view, 'search_events')
  if (!found) return call('search_events', { start_date: range.start, end_date: range.end })
  const events = (found.events as Parameters<typeof eventList>[0]) ?? []
  if (events.length === 0) return say(`Nothing on your calendar ${range.label}.`)
  const domain = /@([^>\s]+)/.exec(f.view.context.user)?.[1] ?? ''
  return say(`Here's ${range.label}:\n\n${eventList(events, domain)}`)
}

function createEventIntent(f: Facts): Plan {
  const today = f.view.context.today
  const date = f.range?.start ?? addDays(today, 1)
  const time = extractTime(f.view.request) ?? '10:00'
  const minutes = /(\d+)\s*(?:-\s*)?(min|minute|hour|hr)/i.exec(f.view.request)
  const duration = minutes ? Number(minutes[1]) * (/h/i.test(minutes[2]) ? 60 : 1) : 30
  let attendee: string | undefined
  if (f.person) {
    const lookup = lastOk(f.view, 'search_mail')
    if (!lookup && !callsOf(f.view, 'search_mail').length) return call('search_mail', { query: '*', from: f.person, limit: 1 }, `I'll look up ${nameOf(f)}'s address.`)
    const from = String(((lookup?.results as Rec[]) ?? [])[0]?.from ?? '')
    attendee = /<([^>]+)>/.exec(from)?.[1] ?? (from.includes('@') ? from : undefined)
  }
  const about = /\babout ([\w\s-]+?)(?:\s+(?:on|at|tomorrow|today|next|this)\b|[.?!]|$)/i.exec(f.view.request)?.[1]
  const title = `${about ? about.trim().replace(/^the\s+/i, '').replace(/^\w/, (c) => c.toUpperCase()) : 'Meeting'}${f.person ? ` with ${nameOf(f)}` : ''}`
  const creates = callsOf(f.view, 'create_event')
  if (creates.length === 0 || (retryable(lastError(f.view, 'create_event')) && creates.length < 3)) {
    return call('create_event', { title, date, start_time: time, duration_minutes: duration, attendees: attendee ? [attendee] : undefined })
  }
  const error = lastError(f.view, 'create_event')
  if (error) return say(/declined/i.test(error) ? "Okay, I didn't create the event." : `I couldn't create the event: ${error}`)
  const created = lastOk(f.view, 'create_event')!
  return say(`Created **${created.title}** for ${created.start}${attendee ? ` and invited ${attendee}` : ''}. [${created.event_id}]`)
}

function draftReply(f: Facts): Plan {
  const content = /\b(?:saying|to say|that says|telling (?:him|her|them)|letting (?:him|her|them) know|that)\s+(.+?)[.?!]?$/i.exec(f.view.request)?.[1]
  const query = extractTopic(f.view.request.replace(content ?? '', ''), [f.person ?? '', 'reply', 'draft'])
  const results = mailResults(f)
  // Dates inside the reply's content ("let's talk tomorrow") aren't a search filter.
  if (!results) return searchMailCall(f, query || '*', { limit: 3, after: undefined, before: undefined })
  if (results.length === 0) return say(`I couldn't find ${f.person ? `${nameOf(f)}'s email` : 'the email'} to reply to.`)
  const original = results[0]
  const fromMatch = /<([^>]+)>/.exec(String(original.from))
  const to = fromMatch?.[1] ?? String(original.from)
  const drafts = callsOf(f.view, 'create_draft')
  if (drafts.length === 0 || (retryable(lastError(f.view, 'create_draft')) && drafts.length < 3)) {
    const body = content ? content.charAt(0).toUpperCase() + content.slice(1) : 'Thanks for the update. I\'ll take a look and follow up shortly'
    return call('create_draft', {
      to: [to],
      subject: `Re: ${String(original.subject).replace(/^re:\s*/i, '')}`,
      body: `Hi ${firstName(String(original.from))},\n\n${body}.\n\nThanks,\n${f.user}`,
      in_reply_to: original.message_id,
    })
  }
  const error = lastError(f.view, 'create_draft')
  if (error) return say(`I couldn't save the draft: ${error}`)
  const draft = lastOk(f.view, 'create_draft')!
  return say(`Saved a draft reply to ${firstName(String(original.from))} in Drafts. [${draft.draft_id}] Say "send it" when you're ready, or edit it first.`)
}

function sendDraftIntent(f: Facts): Plan {
  const fromTurn = lastOk(f.view, 'create_draft')?.draft_id as string | undefined
  const fromHistory = [...f.view.history.join('\n').matchAll(/\b(dr_[a-z0-9]+)\b/g)].pop()?.[1]
  const draftId = fromTurn ?? fromHistory
  if (!draftId) return say("I don't see a draft in this conversation. Ask me to draft one first.")
  if (!f.view.toolNames.has('send_draft')) return say(`Sending email is turned off in your assistant settings, so I can't send ${draftId}. You can send it yourself from Drafts.`)
  if (callsOf(f.view, 'send_draft').length === 0) return call('send_draft', { draft_id: draftId })
  const error = lastError(f.view, 'send_draft')
  if (!error) {
    const sent = lastOk(f.view, 'send_draft')!
    return say(`Sent to ${(sent.to as string[]).join(', ')}. [${sent.message_id}]`)
  }
  if (/declined/i.test(error)) return say(`Okay, I didn't send it. The draft is still in Drafts. [${draftId}]`)
  return say(`I couldn't send it: ${error}`)
}

function rewriteSelection(f: Facts): Plan {
  if (!f.view.toolNames.has('get_selection')) return say('Open a document and select the text you want rewritten, then ask again.')
  const selection = lastOk(f.view, 'get_selection')
  const selectionError = lastError(f.view, 'get_selection')
  if (!selection && !selectionError) return call('get_selection', {})
  if (selectionError) return say(`I couldn't read your selection: ${selectionError}`)
  const paragraphs = (selection!.paragraphs as { id: string; text: string }[]) ?? []
  if (paragraphs.length === 0) return say('Nothing is selected. Click a paragraph in the document, then ask again.')
  const target = paragraphs[0]
  const rewritten = tighten(target.text)
  const replaces = callsOf(f.view, 'replace_text')
  if (replaces.length === 0 || (retryable(lastError(f.view, 'replace_text')) && replaces.length < 3)) {
    return call('replace_text', { doc_id: selection!.doc_id, paragraph_id: target.id, text: rewritten, mode: 'tracked' })
  }
  const error = lastError(f.view, 'replace_text')
  if (error) return say(`I couldn't suggest the rewrite: ${error}`)
  return say(`Suggested a tighter version of ${target.id}: "${rewritten}" Accept or reject it in the document. [${selection!.doc_id}#${target.id}]`)
}

function docQuestion(f: Facts): Plan {
  const editing = /\b(add|append|insert|note)\b.*\b(to|in|into)\b/i.test(f.view.request)
  const query = extractTopic(f.view.request, [f.person ?? '', 'add', 'note', 'append', 'insert'])
  const found = lastOk(f.view, 'search_docs')
  if (!found) return call('search_docs', { query: query || f.view.request.slice(0, 60), owner: f.person })
  const results = (found.results as Rec[]) ?? []
  if (results.length === 0) return say(`I couldn't find a document about ${query}.`)
  const top = results[0]
  const doc = lastOk(f.view, 'read_document')
  if (!doc) return call('read_document', { doc_id: top.doc_id, detail: 'full' })
  const paragraphs = (doc.paragraphs as { id: string; kind: string; text: string }[]) ?? []
  if (editing) {
    const note = /\b(?:that|saying)\s+(.+?)[.?!]?$/i.exec(f.view.request)?.[1] ?? query
    const inserts = callsOf(f.view, 'insert_text')
    if (!f.view.toolNames.has('insert_text')) return say(`I can only edit documents from the Docs app. Open "${doc.title}" there and ask again.`)
    if (inserts.length === 0) {
      const last = paragraphs[paragraphs.length - 1]
      return call('insert_text', { doc_id: doc.doc_id, after_paragraph_id: last.id, text: note.charAt(0).toUpperCase() + note.slice(1) + '.', mode: 'tracked' })
    }
    const error = lastError(f.view, 'insert_text')
    if (error) return say(`I couldn't edit "${doc.title}": ${error}`)
    return say(`Added that to "${doc.title}" as a suggestion. [${doc.doc_id}]`)
  }
  // Words in the document's title identify the document, not the answer: "the travel budget in the FY26 forecast" asks about travel.
  const titleWords = new Set(String(doc.title).toLowerCase().split(/\W+/).map((w) => w.replace(/s$/, '')))
  const focus = query.split(/\s+/).filter((w) => !titleWords.has(w.replace(/s$/, ''))).join(' ') || query
  let best: { id: string; text: string } | null = null
  let bestText = ''
  for (const p of paragraphs.filter((p) => p.kind !== 'title' && p.kind !== 'heading')) {
    const sentence = bestSentence(p.text, focus)
    if (sentence && (!best || scoreFor(sentence, focus) > scoreFor(bestText, focus))) {
      best = p
      bestText = sentence
    }
  }
  if (!best) return say(`"${doc.title}" doesn't seem to cover that. [${doc.doc_id}]`)
  return say(`According to "${doc.title}": ${bestText} [${doc.doc_id}#${best.id}]`)
}

function scoreFor(sentence: string, query: string): number {
  const words = new Set(query.toLowerCase().split(/\s+/).map(stemWord))
  return sentence.toLowerCase().split(/\W+/).map(stemWord).filter((w) => words.has(w)).length * 10 + Math.min((sentence.match(/[$\d]/g) ?? []).length, 6)
}

const stemWord = (w: string) => w.replace(/(ed|ing|s)$/, '')

function openItemIntent(f: Facts): Plan {
  const docs = lastOk(f.view, 'search_docs')
  if (!docs) return call('search_docs', { query: f.topic || f.view.request, limit: 1 })
  const top = ((docs.results as Rec[]) ?? [])[0]
  if (!top) return say(`I couldn't find "${f.topic}".`)
  if (!f.view.toolNames.has('open_item')) return say(`It's "${top.title}" [${top.doc_id}].`)
  if (callsOf(f.view, 'open_item').length === 0) return call('open_item', { kind: 'doc', id: top.doc_id })
  const error = lastError(f.view, 'open_item')
  return say(error ? `I couldn't open it: ${error}` : `Opened "${top.title}". [${top.doc_id}]`)
}

function general(f: Facts): Plan {
  const mail = lastOk(f.view, 'search_mail')
  const docs = lastOk(f.view, 'search_docs')
  if (!mail && !docs) {
    // Two independent reads in one reply: the orchestrator runs them concurrently.
    return {
      calls: [
        { name: 'search_mail', input: { query: f.topic || f.view.request.slice(0, 60), limit: 3 } },
        { name: 'search_docs', input: { query: f.topic || f.view.request.slice(0, 60), limit: 3 } },
      ],
    }
  }
  const lines: string[] = []
  for (const r of ((mail?.results as Rec[]) ?? []).slice(0, 2)) {
    lines.push(`- Email **${r.subject}** (${firstName(String(r.from))}): ${bestSentence(String(r.snippet), f.topic) ?? r.snippet} [${r.message_id}]`)
  }
  for (const r of ((docs?.results as Rec[]) ?? []).slice(0, 2)) {
    lines.push(`- Doc **${r.title}**: ${bestSentence(String(r.snippet), f.topic) ?? r.snippet} [${r.doc_id}${r.paragraph_id ? `#${r.paragraph_id}` : ''}]`)
  }
  if (lines.length === 0) return say("I couldn't find anything about that in your mail or documents.")
  return say(`Here's what I found:\n\n${lines.join('\n')}`)
}

const PLANNERS: Record<Intent, (f: Facts) => Plan> = {
  send_draft: sendDraftIntent,
  rewrite_selection: rewriteSelection,
  summarize_into_doc: summarizeIntoDoc,
  draft_reply: draftReply,
  create_event: createEventIntent,
  calendar_query: calendarQuery,
  bulk_read: bulkRead,
  summarize_message: summarizeMessage,
  doc_question: docQuestion,
  mail_question: mailQuestion,
  open_item: openItemIntent,
  general,
}

// ─────────────────────────────── wrap-up and rewrite ───────────────────────────────

const DONE: Record<string, (input: Rec, result: Rec) => string> = {
  search_mail: (_i, r) => `searched your mail (${((r.results as unknown[]) ?? []).length} results)`,
  get_message: (_i, r) => `read "${r.subject}" [${r.message_id}]`,
  get_thread: (_i, r) => `read the thread "${r.subject}"`,
  search_docs: (_i, r) => `searched your documents (${((r.results as unknown[]) ?? []).length} results)`,
  read_document: (_i, r) => `read "${r.title}"`,
  search_events: (_i, r) => `checked your calendar (${((r.events as unknown[]) ?? []).length} events)`,
  create_draft: (_i, r) => `saved a draft [${r.draft_id}]`,
  insert_text: (i) => `suggested text in the document after ${i.after_paragraph_id}`,
}

/** The final call when a budget runs out: tools are off, say what was done and what's left. */
function wrapUp(f: Facts): string {
  const done = f.view.steps
    .flat()
    .map((c) => ({ c, r: f.view.results.get(c.id) }))
    .filter(({ r }) => r && !r.isError && r.json)
    .map(({ c, r }) => DONE[c.name]?.(c.input, r!.json!) ?? `ran ${c.name}`)
  const unique = [...new Set(done)]
  let left = 'finish the rest of your request'
  if (f.intent === 'bulk_read') {
    const results = (lastOk(f.view, 'search_mail')?.results as Rec[]) ?? []
    const read = new Set(callsOf(f.view, 'get_message').map((c) => String(c.call.input.message_id)))
    const unread = results.filter((r) => !read.has(String(r.message_id)))
    if (unread.length) left = `read ${unread.length} more: ${unread.map((r) => `"${r.subject}"`).join(', ')}`
  }
  return `I reached my step limit before finishing. So far I ${unique.length ? unique.join('; ') : 'had not completed any steps'}.\n\nStill to do: ${left}. Ask me to continue and I'll pick up from there.`
}

export interface RewriteOutput {
  queries: string[]
  sources: ('mail' | 'doc')[]
  filters: { from: string | null; after: string | null; before: string | null }
  needs_retrieval: boolean
}

/** Structured-output call used by the prefetch step: rewrite the request into standalone queries and filters. */
export function rewrite(view: ConversationView): RewriteOutput {
  const f = facts(view, { followInjectedInstructions: false, repeatLastCall: false })
  const retrieval: Intent[] = ['mail_question', 'doc_question', 'general', 'summarize_message', 'summarize_into_doc', 'bulk_read']
  const sources: ('mail' | 'doc')[] = f.intent === 'doc_question' ? ['doc'] : f.intent === 'general' ? ['mail', 'doc'] : ['mail']
  const base = [f.person, f.topic].filter(Boolean).join(' ').trim()
  return {
    queries: base ? [base, ...(f.topic && f.person ? [f.topic] : [])] : [],
    sources,
    filters: { from: f.person ?? null, after: f.range?.start ?? null, before: f.range ? addDays(f.range.end, 1) : null },
    needs_retrieval: retrieval.includes(f.intent) && !!base,
  }
}

/** Template calls (no tools, a <thread> in the prompt): one fixed job, answered in one reply. */
function templateSummary(view: ConversationView): string | null {
  if (view.toolNames.size > 0 || !/<thread /.test(view.lastUserText)) return null
  const messages: MessageLike[] = [...view.lastUserText.matchAll(/<message id="([^"]+)" from="([^"]+)" sent="([^"]+)">\n([\s\S]*?)\n<\/message>/g)].map((m) => ({
    message_id: m[1],
    from: m[2],
    sent: m[3],
    body: m[4],
  }))
  if (messages.length === 0) return 'There is nothing in this thread to summarize.'
  const subject = /<thread subject="([^"]*)"/.exec(view.lastUserText)?.[1] ?? 'this thread'
  return `**${subject}** (${messages.length} message${messages.length === 1 ? '' : 's'}): ${citedThreadSummary(messages)}`
}

export function plan(view: ConversationView, settings: PlannerSettings): Plan {
  if (view.structured) return { text: JSON.stringify(rewrite(view)) }
  const template = templateSummary(view)
  if (template) return say(template)
  const f = facts(view, settings)
  if (view.wrapUp || view.toolChoiceNone) return say(wrapUp(f))

  // The orchestrator's loop guard answered instead of running the call. Stop
  // calling tools and answer with what there is.
  const lastResults = (view.steps[view.steps.length - 1] ?? []).map((c) => view.results.get(c.id))
  if (lastResults.some((r) => r?.isError && /identical arguments/.test(r.text))) {
    return say(`I kept getting the same result, so I stopped searching. ${wrapUp(f).split('\n')[0].replace('I reached my step limit before finishing. ', '')}`)
  }

  if (settings.repeatLastCall) {
    const previous = view.steps.flat().filter((c) => view.results.get(c.id) && !view.results.get(c.id)!.isError).pop()
    if (previous) return { calls: [{ name: previous.name, input: previous.input }] }
  }

  const planned = PLANNERS[f.intent](f)
  const missing = planned.calls?.find((c) => !view.toolNames.has(c.name))
  if (missing) {
    return say(`I'd need the ${missing.name.replace(/_/g, ' ')} tool for that, and it isn't available here (it may be turned off in your assistant settings or belong to another app).`)
  }
  return planned
}

