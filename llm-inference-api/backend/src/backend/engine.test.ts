import { describe, expect, it } from 'vitest'
import { Engine, Refusal, type EngineEvent, type EngineItem, type EngineSettings, type GroupSink } from './engine.js'
import { fullText } from './text.js'

const base: EngineSettings = {
  model: 'mock-large',
  version: 'v1',
  slots: 2,
  ttftMs: 100,
  prefillMsPerToken: 1,
  tokensPerSecond: 100,
  admitOverheadMs: 40,
  cacheEntries: 4,
  batching: 'continuous',
  restartMs: 1000,
  crashAfterTokens: 3,
  slowExtraMs: 5000,
}

function item(id: string, over: Partial<EngineItem> = {}): EngineItem {
  return { id, prefixKey: 'p1', prefixTokens: 200, inputTokens: 250, maxTokens: 100, seed: id, outputTokens: 5, ...over }
}

function sink() {
  const events: EngineEvent[] = []
  const state = { ended: false, destroyed: false }
  const s: GroupSink = {
    write: (evs) => events.push(...evs),
    end: () => (state.ended = true),
    destroy: () => (state.destroyed = true),
  }
  return { s, events, state }
}

/** Runs steps every 10 ms of fake time until `until` returns true or 1000 steps pass. */
function run(engine: Engine, start: number, until: () => boolean): number {
  let now = start
  for (let i = 0; i < 1000 && !until(); i++) {
    now += 10
    engine.step(now)
  }
  return now
}

describe('mock engine admission and slots', () => {
  it('admits up to the free slots and rejects the rest with no_slot', () => {
    const e = new Engine({ ...base })
    const r = e.admit('g1', [item('a'), item('b'), item('c')], sink().s, 0)
    expect(r.admitted).toEqual(['a', 'b'])
    expect(r.rejected).toEqual([{ id: 'c', reason: 'no_slot' }])
    expect(e.freeSlots()).toBe(0)
  })

  it('emits first token after prefill, then one token per step, then done', () => {
    const e = new Engine({ ...base, prefillMsPerToken: 0 })
    const g = sink()
    e.admit('g1', [item('a')], g.s, 0)
    e.step(50)
    expect(g.events).toHaveLength(0) // still prefilling (ttft 100)
    run(e, 50, () => g.state.ended)
    const types = g.events.map((x) => x.t)
    expect(types[0]).toBe('first')
    expect(types.filter((t) => t === 'tok')).toHaveLength(4)
    expect(types.at(-1)).toBe('done')
    const text = g.events.filter((x) => x.t === 'first' || x.t === 'tok').map((x) => (x as { text: string }).text).join('')
    expect(text).toBe(fullText('a', 5))
  })

  it('reports max_tokens when output is cut by max_tokens', () => {
    const e = new Engine({ ...base })
    const g = sink()
    e.admit('g1', [item('a', { maxTokens: 3, outputTokens: 50 })], g.s, 0)
    run(e, 0, () => g.state.ended)
    expect(g.events.at(-1)).toMatchObject({ t: 'done', outputTokens: 3, stopReason: 'max_tokens' })
  })

  it('counts an admission stall once per admitted group', () => {
    const e = new Engine({ ...base, slots: 8 })
    e.admit('g1', [item('a'), item('b'), item('c')], sink().s, 0)
    expect(e.nextPeriod()).toBe(10 + 40)
    expect(e.nextPeriod()).toBe(10)
    e.admit('g2', [item('d')], sink().s, 0)
    e.admit('g3', [item('e')], sink().s, 0)
    expect(e.nextPeriod()).toBe(10 + 80)
  })
})

describe('prefix cache', () => {
  it('a repeated prefix skips its prefill cost', () => {
    const e = new Engine({ ...base, slots: 4 })
    const g1 = sink()
    e.admit('g1', [item('a')], g1.s, 0)
    const g2 = sink()
    e.admit('g2', [item('b')], g2.s, 0)
    run(e, 0, () => g1.state.ended && g2.state.ended)
    const first = (g: ReturnType<typeof sink>) => g.events.find((x) => x.t === 'first') as Extract<EngineEvent, { t: 'first' }>
    expect(first(g1).cachedTokens).toBe(0)
    expect(first(g2).cachedTokens).toBe(200)
    expect(e.hitRate()).toBe(0.5)
  })

  it('evicts the least recently used prefix', () => {
    const e = new Engine({ ...base, slots: 10, cacheEntries: 2 })
    for (const k of ['k1', 'k2', 'k3']) e.admit(k, [item(k, { prefixKey: k })], sink().s, 0)
    const g = sink()
    e.admit('again', [item('x', { prefixKey: 'k1' })], g.s, 0)
    run(e, 0, () => g.events.some((x) => x.t === 'first'))
    expect((g.events[0] as { cachedTokens: number }).cachedTokens).toBe(0)
  })
})

describe('continuous vs static batching', () => {
  it('continuous frees a slot as soon as a short sequence finishes', () => {
    const e = new Engine({ ...base, prefillMsPerToken: 0 })
    const g = sink()
    e.admit('g1', [item('short', { outputTokens: 2 }), item('long', { outputTokens: 50 })], g.s, 0)
    run(e, 0, () => g.events.some((x) => x.t === 'done' && x.id === 'short'))
    expect(e.freeSlots()).toBe(1)
  })

  it('static holds every slot until the longest member finishes', () => {
    const e = new Engine({ ...base, prefillMsPerToken: 0, batching: 'static' })
    const g = sink()
    e.admit('g1', [item('short', { outputTokens: 2 }), item('long', { outputTokens: 50 })], g.s, 0)
    run(e, 0, () => g.events.some((x) => x.t === 'done' && x.id === 'short'))
    expect(e.freeSlots()).toBe(0)
    expect(e.admit('g2', [item('c')], sink().s, 0).rejected).toHaveLength(1)
    run(e, 0, () => g.state.ended)
    expect(e.freeSlots()).toBe(2)
  })
})

describe('cancel, drain, upgrade, chaos', () => {
  it('cancel frees the slot and reports tokens emitted so far', () => {
    const e = new Engine({ ...base, prefillMsPerToken: 0 })
    const g = sink()
    e.admit('g1', [item('a', { outputTokens: 50 })], g.s, 0)
    run(e, 0, () => g.events.length >= 3)
    expect(e.cancel(['a'])).toEqual(['a'])
    expect(g.events.at(-1)).toMatchObject({ t: 'cancelled', id: 'a', outputTokens: 3 })
    expect(g.state.ended).toBe(true)
    expect(e.freeSlots()).toBe(2)
  })

  it('draining refuses new groups but finishes in-flight work', () => {
    const e = new Engine({ ...base })
    const g = sink()
    e.admit('g1', [item('a')], g.s, 0)
    e.setDraining(true)
    expect(() => e.admit('g2', [item('b')], sink().s, 0)).toThrow(Refusal)
    run(e, 0, () => g.state.ended)
    expect(g.events.at(-1)?.t).toBe('done')
  })

  it('upgrade waits for in-flight work, then switches version with a cold cache', () => {
    const e = new Engine({ ...base })
    const g = sink()
    e.admit('g1', [item('a')], g.s, 0)
    e.upgrade('v2')
    expect(e.state).toBe('draining')
    expect(e.settings.version).toBe('v1')
    run(e, 0, () => g.state.ended)
    expect(e.state).toBe('ok')
    expect(e.settings.version).toBe('v2')
    expect(e.snapshot().cache.entries).toBe(0)
  })

  it('armed chaos fires exactly the armed number of times', () => {
    const e = new Engine({ ...base, slots: 8 })
    e.chaos.overload = 2
    expect(() => e.admit('g1', [item('a')], sink().s, 0)).toThrow(/overloaded/)
    expect(() => e.admit('g2', [item('a')], sink().s, 0)).toThrow(/overloaded/)
    expect(e.admit('g3', [item('a')], sink().s, 0).admitted).toEqual(['a'])
  })

  it('a mid-stream crash drops every open stream and restarts', () => {
    const e = new Engine({ ...base, slots: 4, prefillMsPerToken: 0 })
    e.chaos.crash_mid_stream = 1
    const g1 = sink()
    e.admit('g1', [item('a', { outputTokens: 50 })], g1.s, 0)
    const g2 = sink()
    e.admit('g2', [item('b', { outputTokens: 50 })], g2.s, 0)
    run(e, 0, () => g1.state.destroyed)
    expect(g1.events.filter((x) => x.id === 'a')).toHaveLength(3)
    expect(g2.state.destroyed).toBe(true)
    expect(e.state).toBe('restarting')
    expect(() => e.admit('g3', [item('c')], sink().s, 0)).toThrow(/restarting/)
    e.stop()
  })

  it('slow chaos delays only the armed sequence', () => {
    const e = new Engine({ ...base, slots: 4, prefillMsPerToken: 0 })
    e.chaos.slow = 1
    const g = sink()
    e.admit('g1', [item('slow'), item('fast')], g.s, 0)
    run(e, 0, () => g.events.some((x) => x.t === 'done' && x.id === 'fast'))
    expect(g.events.some((x) => x.id === 'slow')).toBe(false)
  })
})
