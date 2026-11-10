import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { ExperimentProvider } from 'experimentation-sdk/react'
import { client } from './lib/experiments'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({ routeTree, defaultPreload: false })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// With a cached snapshot the page renders immediately; with nothing cached it waits
// at most 300 ms for the first fetch, then renders with the coded defaults.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExperimentProvider client={client} maxWaitMs={300}>
      <RouterProvider router={router} />
    </ExperimentProvider>
  </StrictMode>,
)
