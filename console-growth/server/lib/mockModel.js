// A stand-in for the model. It returns deterministic text built from the prompt, so the same
// input always gives the same output and the same token counts. No network calls.
import crypto from 'node:crypto';

const OPENINGS = [
  'Here is a concise answer.',
  'Good question. Let me break it down.',
  'Short version first, then the details.',
  'There are a few parts to this.',
];

const BODY = [
  'Start with the smallest version that works end to end, then measure before optimizing.',
  'Keep the interface narrow: one function in, one result out, and errors that say what to do next.',
  'Cache what is expensive to compute and cheap to invalidate; recompute everything else.',
  'Write the edge cases down first. Empty input, very large input and retries are where bugs hide.',
  'Prefer explicit configuration over clever defaults, and log the values you actually used.',
  'If two systems must agree, make one of them the source of truth and derive the other.',
  'Batch small requests together when latency allows it; the per-request overhead dominates otherwise.',
  'Test the failure path as carefully as the happy path, including timeouts and partial results.',
];

export function estimateTokens(text) {
  return Math.max(1, Math.ceil((text ?? '').length / 4));
}

export function generateCompletion({ system = '', prompt, maxTokens = 512 }) {
  const digest = crypto.createHash('sha256').update(`${system}\n${prompt}`).digest();
  const topic = prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
  const sentences = [OPENINGS[digest[0] % OPENINGS.length], `You asked about: "${topic}".`];
  const bodyCount = 3 + (digest[1] % 4);
  for (let i = 0; i < bodyCount; i += 1) sentences.push(BODY[digest[2 + i] % BODY.length]);

  let output = sentences.join(' ');
  const maxChars = maxTokens * 4;
  if (output.length > maxChars) output = `${output.slice(0, maxChars).trimEnd()}…`;

  return {
    output,
    inputTokens: estimateTokens(system) + estimateTokens(prompt),
    outputTokens: estimateTokens(output),
    stopReason: output.endsWith('…') ? 'max_tokens' : 'end_turn',
  };
}
