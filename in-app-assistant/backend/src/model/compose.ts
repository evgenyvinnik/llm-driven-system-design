/**
 * Deterministic text generation for the mock model: extractive summaries and
 * answers built from tool results, with citations. Plain, but grounded in
 * what the tools returned, which is the property the rest of the system
 * (citation checking, the UI's source chips) needs to exercise.
 * @module model/compose
 */
import { concept, tokenize } from '../retrieval/embed.js'
import { firstName } from './nlu.js'

export function sentences(text: string): string[] {
  // A salutation on its own line ("Hi both," / "Alice,") is not part of the first sentence.
  return text
    .replace(/^\s*(?:(?:hi|hey|hello|dear)\b[^\n]{0,30}|[A-Z][a-z]+(?: [A-Z][a-z]+)?),\s*\n/, '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"$])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && !/^(hi|hello|hey|dear|thanks|thank you|best|cheers|regards|kind regards)\b/i.test(s))
}

/** Prefers sentences with numbers and with words from the query. */
export function bestSentence(text: string, query = ''): string | null {
  const wanted = new Set(tokenize(query).map(concept))
  let best: string | null = null
  let bestScore = -1
  for (const sentence of sentences(text)) {
    const words = tokenize(sentence).map(concept)
    const overlap = words.filter((w) => wanted.has(w)).length
    const numbers = (sentence.match(/[$\d]/g) ?? []).length
    const score = overlap * 4 + Math.min(numbers, 8) + Math.min(sentence.length, 160) / 80
    if (score > bestScore) {
      best = sentence
      bestScore = score
    }
  }
  return best
}

/** "I'll send a revised sheet" by Dana → "Dana will send a revised sheet". */
export function reported(name: string, sentence: string): string {
  const conversions: [RegExp, string][] = [
    [/^I'll\b/, `${name} will`],
    [/^I've\b/, `${name} has`],
    [/^I'm\b/, `${name} is`],
    [/^I'd\b/, `${name} would`],
    [/^I\b/, name],
    [/^We\b/, `${name}'s team`],
  ]
  for (const [pattern, replacement] of conversions) {
    if (pattern.test(sentence)) return sentence.replace(pattern, replacement).replace(/\bmy\b/g, 'their')
  }
  return `${name} said ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
}

export interface MessageLike {
  message_id: string
  from: string
  subject?: string
  body?: string
  snippet?: string
  sent?: string
}

/** One reported sentence per message, oldest first, each cited. */
export function threadSummary(messages: MessageLike[], max = 3): string {
  const picked = messages.length > max ? [messages[0], ...messages.slice(-(max - 1))] : messages
  return picked
    .map((m) => {
      const sentence = bestSentence(m.body ?? m.snippet ?? '')
      return sentence ? `${reported(firstName(m.from), sentence)}` : null
    })
    .filter(Boolean)
    .join(' ')
}

export function citedThreadSummary(messages: MessageLike[], max = 3): string {
  const picked = messages.length > max ? [messages[0], ...messages.slice(-(max - 1))] : messages
  return picked
    .map((m) => {
      const sentence = bestSentence(m.body ?? m.snippet ?? '')
      return sentence ? `${reported(firstName(m.from), sentence)} [${m.message_id}]` : null
    })
    .filter(Boolean)
    .join(' ')
}

/** A grounded answer: the most relevant sentence from each of the top messages, cited. */
export function answerFromMessages(query: string, messages: MessageLike[], max = 2): string {
  const lines: string[] = []
  for (const m of messages.slice(0, max)) {
    const sentence = bestSentence(m.body ?? m.snippet ?? '', query)
    if (sentence) lines.push(`${reported(firstName(m.from), sentence)} [${m.message_id}]`)
  }
  return lines.join(' ')
}

export interface EventLike {
  event_id: string
  title: string
  start: string
  end?: string
  location?: string
  attendees?: string[]
}

/** Internal attendees by first name, outsiders by address; names already in the title are skipped. */
export function eventList(events: EventLike[], orgDomain: string): string {
  return events
    .map((e) => {
      const time = e.start.replace(/^\w{3}, \w{3} \d{1,2}, /, '')
      const where = e.location ? `, ${e.location}` : ''
      const names = (e.attendees ?? [])
        .map((a) => (orgDomain && a.endsWith(`@${orgDomain}`) ? firstName(a.split('@')[0]) : a))
        .filter((n) => !e.title.includes(n))
      const who = names.length ? ` with ${names.join(', ')}` : ''
      return `- **${time}** ${e.title}${who}${where} [${e.event_id}]`
    })
    .join('\n')
}

const FILLER = /\b(really|very|just|basically|actually)\b\s*/gi

/** "Rewrite this to be shorter": drop filler and keep the first clause of long sentences. */
export function tighten(text: string): string {
  const out = sentences(text.endsWith('.') ? text : `${text}.`).map((s) => {
    let t = s.replace(FILLER, '').replace(/\s{2,}/g, ' ').trim()
    if (t.length > 80 && t.includes(',')) t = `${t.slice(0, t.indexOf(',')).trim()}.`
    return t.charAt(0).toUpperCase() + t.slice(1)
  })
  const result = out.join(' ').trim()
  return result.length > 0 && result.length < text.length ? result : text.split(/(?<=[.!?])\s/)[0]
}
