import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowOptions } from '@/services/sse-follow'
import type { Generation, Message } from '@/types'

// Capture each stream's callbacks so the test can play events into it.
const streams = new Map<string, FollowOptions>()
vi.mock('@/services/sse-follow', () => ({
  followSse: (opts: FollowOptions) => {
    streams.set(opts.url, opts)
    return () => streams.delete(opts.url)
  },
}))
vi.mock('@/services/api', () => ({
  api: {
    getGeneration: vi.fn(() => new Promise(() => undefined)), // never resolves: keep the streamed copy
    cancelGeneration: vi.fn(),
  },
  isNetworkError: () => false,
}))

import { api } from '@/services/api'
import { useConversations } from './conversations-store'
import { useGenerations } from './generations-store'
import { useUi } from './ui-store'

const frame = () => new Promise((resolve) => setTimeout(resolve, 40))

function generation(id: string, conversationId: string, fields: Partial<Generation> = {}): Generation {
  return {
    id,
    conversationId,
    userMessageId: `${id}-u`,
    assistantMessageId: `${id}-a`,
    kind: 'message',
    model: 'sim-swift',
    status: 'running',
    output: '',
    checkpointEventId: null,
    outputTruncated: false,
    finishReason: null,
    errorCode: null,
    errorMessage: null,
    usage: { inputTokens: null, outputTokens: null, queueMs: null, ttftMs: null, durationMs: null },
    contextMessages: null,
    contextDropped: null,
    cancelRequested: false,
    createdAt: '2026-11-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...fields,
  }
}

function seedThread(conversationId: string, gen: Generation) {
  const assistant: Message = {
    id: gen.assistantMessageId,
    conversationId,
    parentId: gen.userMessageId,
    role: 'assistant',
    content: '',
    depth: 1,
    createdAt: '2026-11-01T00:00:00Z',
    siblingIds: [gen.assistantMessageId],
    generation: gen,
  }
  useConversations.getState().setThread({
    conversation: {
      id: conversationId,
      title: `Chat ${conversationId}`,
      model: 'sim-swift',
      currentLeafId: assistant.id,
      activeGenerationId: gen.id,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    },
    messages: [assistant],
    hasMoreBefore: false,
  })
}

const stream = (id: string) => streams.get(`/api/v1/generations/${id}/events`)!

beforeEach(() => {
  streams.clear()
  useGenerations.getState().reset()
  useConversations.getState().reset()
  useUi.setState({ toasts: [], announcement: { text: '', nonce: 0 } })
})

describe('switching conversations mid-stream', () => {
  it("keeps A streaming into A's entry and never into B's", async () => {
    const a = generation('gen-a', 'conv-a')
    const b = generation('gen-b', 'conv-b')
    seedThread('conv-a', a)
    seedThread('conv-b', b)
    useConversations.getState().setViewing('conv-a')
    useGenerations.getState().follow(a)

    stream('gen-a').onEvent('delta', { text: 'Hello ' }, '1-0')
    // The user switches to B, which has its own answer streaming.
    useConversations.getState().setViewing('conv-b')
    useGenerations.getState().follow(b)
    stream('gen-a').onEvent('delta', { text: 'from A' }, '2-0')
    stream('gen-b').onEvent('delta', { text: 'B only' }, '1-0')
    await frame()

    const { byId } = useGenerations.getState()
    expect(byId['gen-a'].text).toBe('Hello from A')
    expect(byId['gen-b'].text).toBe('B only')
    expect(byId['gen-a'].lastEventId).toBe('2-0')
    // A's stream was not closed by the switch.
    expect(streams.has('/api/v1/generations/gen-a/events')).toBe(true)
  })

  it("lands A's finished answer in A's thread while the user reads B, with a toast", async () => {
    const a = generation('gen-a', 'conv-a')
    seedThread('conv-a', a)
    useConversations.getState().setViewing('conv-b')
    useGenerations.getState().follow(a)

    stream('gen-a').onEvent('delta', { text: 'The final answer.' }, '1-0')
    // No frame has passed: the end must flush the pending delta first.
    stream('gen-a').onEvent(
      'end',
      { status: 'completed', outputTruncated: false, finishReason: 'stop', errorCode: null, errorMessage: null, usage: a.usage, at: 'x' },
      '2-0',
    )

    const threadA = useConversations.getState().threads['conv-a']
    expect(threadA.messages[0].content).toBe('The final answer.')
    expect(threadA.messages[0].generation?.status).toBe('completed')
    expect(useConversations.getState().unread['conv-a']).toBe(true)
    expect(useUi.getState().toasts[0].message).toContain('Chat conv-a')
    expect(api.getGeneration).toHaveBeenCalledWith('gen-a')
  })

  it('announces completion to screen readers when the user is watching', () => {
    const a = generation('gen-a', 'conv-a')
    seedThread('conv-a', a)
    useConversations.getState().setViewing('conv-a')
    useGenerations.getState().follow(a)
    stream('gen-a').onEvent(
      'end',
      { status: 'cancelled', outputTruncated: true, finishReason: 'cancelled', errorCode: null, errorMessage: null, usage: a.usage, at: 'x' },
      '9-0',
    )
    expect(useUi.getState().announcement.text).toBe('Response stopped.')
    expect(useUi.getState().toasts).toHaveLength(0)
  })
})

describe('resume and ordering', () => {
  it('resumes from the PostgreSQL checkpoint instead of replaying from the start', () => {
    useGenerations.getState().follow(generation('gen-a', 'conv-a', { output: 'Checkpointed text', checkpointEventId: '17-3' }))
    expect(stream('gen-a').lastEventId).toBe('17-3')
    expect(useGenerations.getState().byId['gen-a'].text).toBe('Checkpointed text')
  })

  it('does not open a second stream for the same generation', () => {
    const a = generation('gen-a', 'conv-a')
    useGenerations.getState().follow(a)
    const first = stream('gen-a')
    useGenerations.getState().follow(a) // e.g. the device-sync echo of our own request
    expect(stream('gen-a')).toBe(first)
  })

  it('never lets a stale REST copy move a finished generation backwards', async () => {
    const a = generation('gen-a', 'conv-a')
    useGenerations.getState().follow(a)
    stream('gen-a').onEvent(
      'end',
      { status: 'cancelled', outputTruncated: false, finishReason: 'cancelled', errorCode: null, errorMessage: null, usage: a.usage, at: 'x' },
      '3-0',
    )
    // The Stop request's reply arrives late and still says "running".
    vi.mocked(api.cancelGeneration).mockResolvedValue({ generation: { ...a, status: 'running' } })
    await useGenerations.getState().cancel('gen-a')
    useGenerations.getState().follow({ ...a, status: 'running' })
    expect(useGenerations.getState().byId['gen-a'].status).toBe('cancelled')
  })
})
