/**
 * The mock model's "understanding": intent, people, dates and topic keywords
 * from the request and the conversation so far. It only uses what is in the
 * request it receives (the turn context's date and zone, earlier turns' text),
 * exactly like a real model, which keeps no memory between calls.
 * @module model/nlu
 */
import { addDays } from '../shared/time.js'

export type Intent =
  | 'send_draft'
  | 'rewrite_selection'
  | 'summarize_into_doc'
  | 'draft_reply'
  | 'create_event'
  | 'calendar_query'
  | 'bulk_read'
  | 'summarize_message'
  | 'doc_question'
  | 'mail_question'
  | 'open_item'
  | 'general'

const RULES: [Intent, RegExp][] = [
  ['send_draft', /^(yes[,.!]?\s*)?(please\s+)?(go ahead and\s+)?send(\s+(it|that|the (draft|email|reply)))?\b/i],
  ['rewrite_selection', /\b(rewrite|shorten|tighten|simplify|rephrase|improve|polish)\b.*\b(this|selected|selection|paragraph|it)\b|\bmake (this|it|the selection|the selected)\b/i],
  ['summarize_into_doc', /\b(summar\w*|recap)\b.*\b(thread|emails?|conversation|discussion)\b.*\b(under|below|after|into|in|to)\b.*\b(intro\w*|doc\w*|plan|section|budget)\b|\badd (a )?(short |brief )?summary of\b/i],
  ['draft_reply', /\b(draft|write|compose|reply)\b.*\b(reply|response|email|note|back)\b/i],
  ['create_event', /\b(schedule|book|set up|create|add|put)\b.*\b(meeting|call|event|sync|1:1|one-on-one|catch-?up)\b/i],
  ['calendar_query', /\b(calendar|agenda|meetings?|events?|schedule|free|busy|booked)\b/i],
  ['bulk_read', /\b(every|all( the)?)\s+(emails?|messages?|mail|threads?)\b/i],
  ['summarize_message', /\b(summar\w*|what does|what's in|read me|tl;?dr)\b.*\b(email|message|invoice|note|mail)\b/i],
  ['doc_question', /\b(docs?|documents?|plan|forecast|checklist|retro|onboarding|spec|policy)\b/i],
  ['mail_question', /\b(what did|did \w+ (say|mention|reply)|when did|emails?|mail|thread|wrote|said|say about|sent me|reply from)\b/i],
  ['open_item', /^(open|show me|pull up|take me to)\b/i],
]

export function detectIntent(request: string): Intent {
  for (const [intent, pattern] of RULES) if (pattern.test(request)) return intent
  return 'general'
}

const NOT_NAMES = new Set(
  'I Add Can Could Did Do Does Draft Find For From Give How I If Is It Make Monday Tuesday Wednesday Thursday Friday Saturday Sunday Next Last Open Please Put Q1 Q2 Q3 Q4 Read Reply Rewrite Schedule Send Set Show Summarize Summarise Tell The This Under What When Where Which Who Why Will Write Yes Thanks Hi Hey Go Also Then Any Are Book Create Pull Take Check List Shorten Tighten Simplify Polish Improve Rephrase H1 H2 FY26 SFO LIS AI OK Insights Lisbon January February March April May June July August September October November December Northwind Figtree Flyway Lumen'.split(
    ' ',
  ),
)

/** Capitalized words that look like first names: "Dana's thread", "from Raj". */
export function extractPeople(text: string): string[] {
  const people: string[] = []
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,})(?:'s)?\b/g)) {
    if (!NOT_NAMES.has(match[1]) && !people.includes(match[1])) people.push(match[1])
  }
  return people
}

/** "from northwind", "from billing@..." for senders that aren't first names. */
export function extractSender(text: string): string | undefined {
  const match = /\bfrom\s+([A-Za-z][\w.@-]+)/i.exec(text)
  if (!match) return undefined
  const word = match[1].replace(/'s$/, '')
  if (/^(last|this|next|the|my|our|yesterday|today|tomorrow|a|an)$/i.test(word)) return undefined
  return word.toLowerCase()
}

const PRONOUN = /\b(she|he|they|her|him|them|his|their)\b/i

/**
 * The person a request is about. A pronoun resolves to the most recently
 * mentioned person in earlier turns, which is how "what did she say about
 * the budget?" becomes a search for Dana.
 */
export function resolvePerson(request: string, history: string[]): string | undefined {
  const sender = extractSender(request)
  const named = extractPeople(request)
  if (named.length) return named[0].toLowerCase()
  if (sender) return sender
  if (PRONOUN.test(request)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const people = extractPeople(history[i])
      if (people.length) return people[people.length - 1].toLowerCase()
    }
  }
  return undefined
}

export interface DateRange {
  start: string
  end: string
  label: string
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function weekdayIndex(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay()
}

/** Resolves relative date phrases against the turn context's "today". */
export function extractDateRange(text: string, today: string): DateRange | undefined {
  const t = text.toLowerCase()
  const dow = weekdayIndex(today)
  const mondayThisWeek = addDays(today, -((dow + 6) % 7))
  if (/\blast week\b/.test(t)) return { start: addDays(mondayThisWeek, -7), end: addDays(mondayThisWeek, -1), label: 'last week' }
  if (/\bthis week\b/.test(t)) return { start: mondayThisWeek, end: addDays(mondayThisWeek, 6), label: 'this week' }
  if (/\bnext week\b/.test(t)) return { start: addDays(mondayThisWeek, 7), end: addDays(mondayThisWeek, 13), label: 'next week' }
  if (/\byesterday\b/.test(t)) return { start: addDays(today, -1), end: addDays(today, -1), label: 'yesterday' }
  if (/\btomorrow\b/.test(t)) return { start: addDays(today, 1), end: addDays(today, 1), label: 'tomorrow' }
  if (/\btoday\b|\bthis (morning|afternoon)\b/.test(t)) return { start: today, end: today, label: 'today' }
  const lastDays = /\b(last|past) (\d{1,2}) days\b/.exec(t)
  if (lastDays) return { start: addDays(today, -Number(lastDays[2])), end: today, label: `the last ${lastDays[2]} days` }
  for (const [i, name] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b(on |this |next )?${name}\\b`).test(t)) {
      const ahead = (i - dow + 7) % 7 || 7
      const date = addDays(today, ahead)
      return { start: date, end: date, label: name[0].toUpperCase() + name.slice(1) }
    }
  }
  return undefined
}

/** "at 3pm", "at 14:30", "3:30 pm" → "15:00". */
export function extractTime(text: string): string | undefined {
  const match = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i.exec(text)
  if (!match) return undefined
  if (match[4]) return `${match[4].padStart(2, '0')}:${match[5]}`
  let hour = Number(match[1]) % 12
  if (match[3].toLowerCase() === 'pm') hour += 12
  return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`
}

const TOPIC_STOP = new Set(
  `a an the my our your me i to of in on at for from about with and or but is are was were be been it its this that these those
   what did does do say said tell show find search look up any anything something email emails mail mails message messages thread threads
   reply replies draft write compose send please can could would you summarize summarise summary recap short brief quick add under below
   after into intro introduction doc document latest last newest recent week today tomorrow yesterday she he they her him them his their
   all every each new read open pull who when where why how there here have has had get got been going will just know also then next
   whats what's mention mentioned regarding re fyi each one ones every them it`.split(/\s+/),
)

/** Content words left after removing intent words, people and dates. */
export function extractTopic(text: string, exclude: string[] = []): string {
  const skip = new Set(exclude.map((e) => e.toLowerCase()))
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$@.\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, '').replace(/'s$/, ''))
    .filter((w) => w.length > 1 && !TOPIC_STOP.has(w) && !skip.has(w) && !WEEKDAYS.includes(w))
    .join(' ')
}

export function firstName(person: string): string {
  const name = person.replace(/<.*>/, '').trim().split(/\s+/)[0] ?? person
  return name.charAt(0).toUpperCase() + name.slice(1)
}
