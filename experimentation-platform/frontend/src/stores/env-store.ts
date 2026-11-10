import { create } from 'zustand'

const KEY = 'console:environment'

function initial(): string {
  try {
    return localStorage.getItem(KEY) || 'prod'
  } catch {
    return 'prod'
  }
}

interface EnvState {
  env: string
  setEnv: (env: string) => void
}

/** The environment every page shows (prod by default); remembered per browser. */
export const useEnvStore = create<EnvState>((set) => ({
  env: initial(),
  setEnv(env) {
    try {
      localStorage.setItem(KEY, env)
    } catch {
      // ignore
    }
    set({ env })
  },
}))
