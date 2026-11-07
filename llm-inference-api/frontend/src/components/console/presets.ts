/** System prompts for the composer. The long ones are what apps repeat on every call, so they show prefix-cache reuse. */
export const SYSTEM_PRESETS = [
  {
    id: 'support',
    label: 'Support assistant (long, cacheable)',
    text:
      'You are the support assistant for Acme Robotics. Answer from the product manual, cite the section number, and keep answers under 120 words. ' +
      'Manual excerpt: calibrate the arm before each shift; check the torque limits; log every fault code with the time and the operator. '.repeat(30),
  },
  {
    id: 'classifier',
    label: 'Document classifier (long, cacheable)',
    text: 'You classify documents into one of twelve categories and justify the label in one sentence. Category definitions follow. '.repeat(40),
  },
  { id: 'short', label: 'Short system prompt', text: 'You are a concise assistant.' },
  { id: 'none', label: 'No system prompt', text: '' },
]
