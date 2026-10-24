/**
 * Request schemas. The library assumes well-formed input (levels.md says tests
 * only pass valid paths); the API is where untrusted input gets checked.
 * @module api/validation
 */
import { z } from 'zod'
import { isValidPath } from '../store/backend.js'

export const filePath = z.string().refine(isValidPath, {
  message: 'Path must start with /, have no empty, "." or ".." segments, and be at most 1024 characters',
})

export const dirPath = z.union([z.literal('/'), filePath])

export const size = z.number().int().min(0).max(1e15)

export const userId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'User ids are 1-32 lowercase letters, digits, "-" or "_"')

export const addFileBody = z.object({ path: filePath, size, owner: userId.nullable().default(null) })
export const updateFileBody = z.object({ size })
export const addUserBody = z.object({ id: userId, capacity: size })
export const mergeBody = z.object({ sourceId: userId })

export const listQuery = z.object({ path: dirPath.default('/') })
export const pathQuery = z.object({ path: filePath })
export const largestQuery = z.object({
  prefix: z.string().startsWith('/').max(1024).default('/'),
  n: z.coerce.number().int().min(1).max(100).default(10),
})
