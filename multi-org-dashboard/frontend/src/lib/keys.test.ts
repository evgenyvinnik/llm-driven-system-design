import { describe, expect, it } from 'vitest'
import { keys } from './keys'

describe('query keys', () => {
  it('all start with the org, so two orgs never share an entry', () => {
    for (const [name, build] of Object.entries(keys)) {
      const key = (build as (...args: unknown[]) => readonly unknown[])('org_lumen', {}, 'x')
      expect(key.slice(0, 2), name).toEqual(['org', 'org_lumen'])
    }
  })
})
