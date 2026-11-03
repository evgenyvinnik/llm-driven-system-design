import type { App } from '@/types'

/** Suggestion chips double as a menu of what the assistant can do in this app. */
export const SUGGESTIONS: Record<App, string[]> = {
  mail: [
    'What did Dana say about the budget?',
    'Summarize the latest email from Northwind',
    "Draft a reply to Dana's budget email saying the $48,000 total works for us",
    'Find every email about the offsite and summarize each one',
    'Did anything change with my travel plans?',
  ],
  docs: [
    "Add a short summary of Dana's thread from last week under the intro",
    'Rewrite the selected paragraph to be more concise',
    "What's the travel budget in the FY26 forecast?",
    'Add a note to the FY26 forecast that offsite spend is $48,000',
  ],
  calendar: ["What's on my calendar tomorrow?", 'Schedule a 30 minute call with Raj tomorrow at 3pm about the offsite', "What's on my calendar this week?"],
}

export function SuggestionChips({ app, onPick }: { app: App; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {SUGGESTIONS[app].map((s) => (
        <button key={s} type="button" onClick={() => onPick(s)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[13px] text-slate-700 hover:border-accent-300 hover:bg-accent-50">
          {s}
        </button>
      ))}
    </div>
  )
}
