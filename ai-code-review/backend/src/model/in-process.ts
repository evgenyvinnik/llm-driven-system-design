/**
 * The same reviewer without the network, for the seed and the offline evaluation.
 * Latency is computed from the settings rather than slept, so a materialized run
 * carries believable usage numbers and a replay of 60 cases takes milliseconds.
 * @module model/in-process
 */
import { ModelCallError, type ModelCaller, type ToolCall } from '../shared/model-types.js'
import { assess } from './assess.js'
import { chaoticText, defaultSettings, nextChaos, type MockSettings } from './settings.js'

export function createInProcessCaller(settings: MockSettings = defaultSettings()): ModelCaller {
  return async (request) => {
    const chaos = nextChaos(settings)
    if (chaos === 'overloaded' || settings.failureRate >= 1) throw new ModelCallError('overloaded', 'Model overloaded (529)')
    if (chaos === 'rate_limited') throw new ModelCallError('rate_limited', 'Rate limited (429)')
    if (chaos === 'timeout') throw new ModelCallError('timeout', `No response within the deadline`)
    if (chaos === 'disconnect') throw new ModelCallError('disconnect', 'The stream broke before the message finished')
    const response = assess(request, { followInjections: settings.followInjections })
    const override = chaos ? chaoticText(chaos) : null
    const toolCalls: ToolCall[] = []
    let text = ''
    for (const block of response.blocks) {
      if (block.type === 'text') text += block.text
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input })
    }
    if (override) {
      text = override
      toolCalls.length = 0
    }
    return {
      model: request.model,
      text,
      toolCalls,
      stopReason: override ? 'end_turn' : response.stopReason,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ttftMs: settings.ttftMs,
      generationMs: Math.round((response.outputTokens / settings.tokensPerSecond) * 1000),
    }
  }
}
