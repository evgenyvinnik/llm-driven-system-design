// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExperimentClient } from '../client/client.js'
import { fakeServer, snapshot } from '../client/test-helpers.js'
import { Experiment, Exposure, ExperimentProvider, useVariant } from './index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snap = snapshot(3, {
  checkout_cta: { salt: 'cta' },
  rewards_teaser: { salt: 'rw', variants: [{ key: 'control', name: 'No banner' }, { key: 'treatment', name: 'Banner' }] },
})

let root: Root
let container: HTMLDivElement
let client: ExperimentClient
let server: ReturnType<typeof fakeServer>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  server = fakeServer(snap)
  client = new ExperimentClient({ apiUrl: 'http://sdk.test/sdk/v1', clientKey: 'cli_test', fetch: server.fetch, stream: false, bootstrap: snap, flushIntervalMs: 60_000, context: { stableId: 'visitor-1', anonymousId: 'visitor-1' } })
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await client.close()
})

async function sentEvents() {
  await client.flush()
  return server.calls.filter((c) => c.url.endsWith('/events')).flatMap((c) => (c.body as { events: { type: string; flagKey: string; variant: string }[] }).events)
}

function RewardsTab() {
  const v = useVariant('rewards_teaser')
  return (
    <Exposure evaluation={v}>
      <p>rewards {v.variant}</p>
    </Exposure>
  )
}

function App({ showRewards }: { showRewards: boolean }) {
  return (
    <ExperimentProvider client={client}>
      <Experiment flag="checkout_cta" variants={{ control: <button>Add to cart</button>, treatment: <button>Buy now</button> }} />
      {showRewards ? <RewardsTab /> : null}
    </ExperimentProvider>
  )
}

describe('React bindings', () => {
  it('renders the assigned variant and logs exposure for what rendered, not for an unopened tab', async () => {
    await act(async () => root.render(<App showRewards={false} />))
    const expected = client.peek('checkout_cta').variant === 'treatment' ? 'Buy now' : 'Add to cart'
    expect(container.textContent).toContain(expected)
    // The app also evaluates everything at session start (assignment, not exposure).
    client.evaluateAll()
    const events = await sentEvents()
    expect(events.filter((e) => e.type === 'exposure').map((e) => e.flagKey)).toEqual(['checkout_cta'])
    expect(events.filter((e) => e.type === 'assignment').map((e) => e.flagKey).sort()).toEqual(['checkout_cta', 'rewards_teaser'])
  })

  it('logs the tab exposure once it is actually opened, once', async () => {
    await act(async () => root.render(<App showRewards={false} />))
    await act(async () => root.render(<App showRewards />))
    await act(async () => root.render(<App showRewards={false} />))
    await act(async () => root.render(<App showRewards />))
    const exposures = (await sentEvents()).filter((e) => e.type === 'exposure')
    expect(exposures.map((e) => e.flagKey).sort()).toEqual(['checkout_cta', 'rewards_teaser'])
  })

  it('with whenVisible, waits for the element to intersect the viewport', async () => {
    let fire: ((visible: boolean) => void) | null = null
    class FakeObserver {
      constructor(cb: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) {
        fire = (visible) => cb([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }])
      }
      observe() {}
      disconnect() {}
    }
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver
    function Below() {
      const v = useVariant('checkout_cta')
      return (
        <Exposure evaluation={v} whenVisible>
          <span>below the fold</span>
        </Exposure>
      )
    }
    await act(async () =>
      root.render(
        <ExperimentProvider client={client}>
          <Below />
        </ExperimentProvider>,
      ),
    )
    expect((await sentEvents()).filter((e) => e.type === 'exposure')).toHaveLength(0)
    act(() => fire!(true))
    expect((await sentEvents()).filter((e) => e.type === 'exposure')).toHaveLength(1)
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  })

  it('re-renders with the default when a kill switch snapshot arrives', async () => {
    await act(async () => root.render(<App showRewards={false} />))
    const killed = snapshot(4, { checkout_cta: { salt: 'cta', status: 'stopped', version: 2 }, rewards_teaser: { salt: 'rw' } })
    await act(async () => {
      client.apply(killed, null)
    })
    expect(container.textContent).toContain('Add to cart')
  })
})
