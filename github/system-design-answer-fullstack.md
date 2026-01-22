# System Design Interview: GitHub - Code Hosting Platform (Full-Stack Focus)

## Role Focus

> This answer emphasizes **full-stack integration**: shared type definitions with Zod, API contract design, TanStack Query data fetching patterns, optimistic updates for PR workflows, real-time synchronization, and end-to-end feature implementation.

---

## Opening Statement

"Today I'll design a code hosting platform like GitHub with a focus on full-stack integration. The key challenges are maintaining type safety between frontend and backend, designing APIs that support efficient UI patterns, implementing optimistic updates for responsive PR workflows, and synchronizing real-time state across multiple clients."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Repositories**: Browse files, view commits, manage branches
2. **Pull Requests**: Create, review with inline comments, merge
3. **Code Search**: Full-text search with filters
4. **Real-time**: Notifications, PR status updates, typing indicators
5. **Webhooks**: Configurable event delivery to external systems

### Non-Functional Requirements

- **Type Safety**: End-to-end type validation
- **Responsiveness**: Optimistic updates for common actions
- **Consistency**: Real-time sync without conflicts
- **Developer Experience**: Clear API contracts, good error messages

### Full-Stack Integration Goals

| Layer | Goal |
|-------|------|
| Types | Single source of truth with Zod |
| API | RESTful with consistent patterns |
| State | Server state in TanStack Query, UI state in Zustand |
| Real-time | WebSocket for live updates, automatic refetch |

---

## Step 2: Shared Type System (7 minutes)

### Zod Schema Definitions

```typescript
// shared/schemas/repository.ts
import { z } from 'zod'

export const RepositorySchema = z.object({
  id: z.number(),
  ownerId: z.number().nullable(),
  orgId: z.number().nullable(),
  name: z.string().min(1).max(100),
  description: z.string().nullable(),
  isPrivate: z.boolean().default(false),
  defaultBranch: z.string().default('main'),
  language: z.string().nullable(),
  starsCount: z.number().default(0),
  forksCount: z.number().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type Repository = z.infer<typeof RepositorySchema>

export const CreateRepositorySchema = z.object({
  name: z.string()
    .min(1, 'Repository name is required')
    .max(100, 'Repository name must be 100 characters or less')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only alphanumeric, dots, underscores, and hyphens allowed'),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().default(false),
  autoInit: z.boolean().default(true),
  gitignoreTemplate: z.string().optional(),
  licenseTemplate: z.string().optional(),
})

export type CreateRepositoryInput = z.infer<typeof CreateRepositorySchema>

// Tree and file schemas
export const TreeNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number().optional(),
  sha: z.string(),
})

export type TreeNode = z.infer<typeof TreeNodeSchema>

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64']),
  size: z.number(),
  sha: z.string(),
  language: z.string().nullable(),
})

export type FileContent = z.infer<typeof FileContentSchema>
```

### Pull Request Schemas

```typescript
// shared/schemas/pullRequest.ts
import { z } from 'zod'

export const PullRequestStateSchema = z.enum(['open', 'closed', 'merged'])

export const PullRequestSchema = z.object({
  id: z.number(),
  repoId: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: PullRequestStateSchema,
  headBranch: z.string(),
  headSha: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  authorId: z.number(),
  mergedBy: z.number().nullable(),
  mergedAt: z.string().datetime().nullable(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  isDraft: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type PullRequest = z.infer<typeof PullRequestSchema>

export const CreatePullRequestSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  body: z.string().max(65535).optional(),
  headBranch: z.string().min(1, 'Source branch is required'),
  baseBranch: z.string().min(1, 'Target branch is required'),
  isDraft: z.boolean().default(false),
})

export type CreatePullRequestInput = z.infer<typeof CreatePullRequestSchema>

export const MergeStrategySchema = z.enum(['merge', 'squash', 'rebase'])

export const MergePullRequestSchema = z.object({
  strategy: MergeStrategySchema,
  commitTitle: z.string().max(250).optional(),
  commitMessage: z.string().max(65535).optional(),
  deleteSourceBranch: z.boolean().default(false),
})

export type MergePullRequestInput = z.infer<typeof MergePullRequestSchema>

// Review schemas
export const ReviewStateSchema = z.enum(['approved', 'changes_requested', 'commented', 'pending'])

export const ReviewCommentSchema = z.object({
  id: z.number(),
  reviewId: z.number().nullable(),
  prId: z.number(),
  userId: z.number(),
  path: z.string(),
  line: z.number(),
  side: z.enum(['LEFT', 'RIGHT']),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type ReviewComment = z.infer<typeof ReviewCommentSchema>

export const CreateReviewSchema = z.object({
  state: ReviewStateSchema,
  body: z.string().max(65535).optional(),
  comments: z.array(z.object({
    path: z.string(),
    line: z.number(),
    side: z.enum(['LEFT', 'RIGHT']),
    body: z.string().min(1),
  })),
})

export type CreateReviewInput = z.infer<typeof CreateReviewSchema>
```

### API Response Schemas

```typescript
// shared/schemas/api.ts
import { z } from 'zod'

// Pagination wrapper
export function paginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  })
}

// Error response
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.array(z.string())).optional(),
  }),
})

export type ApiError = z.infer<typeof ApiErrorSchema>

// Success wrapper for mutations
export function successSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
  })
}
```

---

## Step 3: Backend API Implementation (10 minutes)

### Express Route with Validation Middleware

```typescript
// backend/src/shared/validation.ts
import { Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body)
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request body validation failed',
            details: formatZodErrors(error),
          },
        })
      } else {
        next(error)
      }
    }
  }
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = schema.parse(req.query) as any
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Query parameter validation failed',
            details: formatZodErrors(error),
          },
        })
      } else {
        next(error)
      }
    }
  }
}

function formatZodErrors(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {}

  for (const issue of error.issues) {
    const path = issue.path.join('.')
    if (!details[path]) {
      details[path] = []
    }
    details[path].push(issue.message)
  }

  return details
}
```

### Pull Request Routes

```typescript
// backend/src/api/routes/pullRequests.ts
import { Router } from 'express'
import {
  CreatePullRequestSchema,
  MergePullRequestSchema,
  CreateReviewSchema,
  PullRequestSchema,
  paginatedSchema,
} from '@shared/schemas'
import { validateBody, validateQuery } from '../shared/validation.js'
import { requireAuth } from '../shared/auth.js'
import { pool } from '../shared/db.js'
import { gitService } from '../shared/git.js'
import { emitWebhook } from '../shared/webhooks.js'

const router = Router()

// List pull requests
const ListPRsQuerySchema = z.object({
  state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(30),
})

router.get(
  '/:owner/:repo/pulls',
  validateQuery(ListPRsQuerySchema),
  async (req, res) => {
    const { owner, repo } = req.params
    const { state, page, limit } = req.query

    const offset = (page - 1) * limit

    // Get repository
    const repoResult = await pool.query(
      `SELECT r.id FROM repositories r
       JOIN users u ON r.owner_id = u.id
       WHERE u.username = $1 AND r.name = $2`,
      [owner, repo]
    )

    if (repoResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Repository not found' } })
    }

    const repoId = repoResult.rows[0].id

    // Build query based on state filter
    let stateFilter = ''
    if (state !== 'all') {
      stateFilter = `AND state = '${state}'`
    }

    const [prsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM pull_requests
         WHERE repo_id = $1 ${stateFilter}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [repoId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM pull_requests WHERE repo_id = $1 ${stateFilter}`,
        [repoId]
      ),
    ])

    const total = parseInt(countResult.rows[0].count, 10)

    res.json({
      items: prsResult.rows.map(row => PullRequestSchema.parse(snakeToCamel(row))),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  }
)

// Create pull request
router.post(
  '/:owner/:repo/pulls',
  requireAuth,
  validateBody(CreatePullRequestSchema),
  async (req, res) => {
    const { owner, repo } = req.params
    const { title, body, headBranch, baseBranch, isDraft } = req.body
    const authorId = req.user!.id

    // Get repository
    const repoResult = await pool.query(
      `SELECT r.* FROM repositories r
       JOIN users u ON r.owner_id = u.id
       WHERE u.username = $1 AND r.name = $2`,
      [owner, repo]
    )

    if (repoResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Repository not found' } })
    }

    const repository = repoResult.rows[0]

    // Validate branches exist
    const [headRef, baseRef] = await Promise.all([
      gitService.getRef(owner, repo, headBranch),
      gitService.getRef(owner, repo, baseBranch),
    ])

    if (!headRef) {
      return res.status(400).json({
        error: { code: 'INVALID_BRANCH', message: `Branch '${headBranch}' not found` }
      })
    }

    if (!baseRef) {
      return res.status(400).json({
        error: { code: 'INVALID_BRANCH', message: `Branch '${baseBranch}' not found` }
      })
    }

    // Get diff stats
    const diffStats = await gitService.diffStats(owner, repo, baseRef.sha, headRef.sha)

    // Get next PR number
    const numberResult = await pool.query(
      `SELECT COALESCE(MAX(number), 0) + 1 as next_number
       FROM pull_requests WHERE repo_id = $1`,
      [repository.id]
    )
    const prNumber = numberResult.rows[0].next_number

    // Create PR
    const prResult = await pool.query(
      `INSERT INTO pull_requests
       (repo_id, number, title, body, head_branch, head_sha, base_branch, base_sha,
        author_id, additions, deletions, changed_files, is_draft)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        repository.id, prNumber, title, body,
        headBranch, headRef.sha, baseBranch, baseRef.sha,
        authorId, diffStats.additions, diffStats.deletions,
        diffStats.filesChanged, isDraft
      ]
    )

    const pr = PullRequestSchema.parse(snakeToCamel(prResult.rows[0]))

    // Emit webhook
    await emitWebhook(repository.id, 'pull_request.opened', { pullRequest: pr })

    res.status(201).json({ success: true, data: pr })
  }
)

// Get single pull request with diff
router.get(
  '/:owner/:repo/pulls/:number',
  async (req, res) => {
    const { owner, repo, number } = req.params

    const result = await pool.query(
      `SELECT pr.*, r.owner_id, r.name as repo_name
       FROM pull_requests pr
       JOIN repositories r ON pr.repo_id = r.id
       JOIN users u ON r.owner_id = u.id
       WHERE u.username = $1 AND r.name = $2 AND pr.number = $3`,
      [owner, repo, parseInt(number, 10)]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pull request not found' } })
    }

    const pr = PullRequestSchema.parse(snakeToCamel(result.rows[0]))

    // Get diff files
    const diff = await gitService.diff(owner, repo, pr.baseSha, pr.headSha)

    // Get reviews
    const reviews = await pool.query(
      `SELECT * FROM reviews WHERE pr_id = $1 ORDER BY created_at DESC`,
      [pr.id]
    )

    // Get review comments
    const comments = await pool.query(
      `SELECT * FROM review_comments WHERE pr_id = $1 ORDER BY created_at ASC`,
      [pr.id]
    )

    res.json({
      pullRequest: pr,
      diff,
      reviews: reviews.rows.map(r => snakeToCamel(r)),
      comments: comments.rows.map(c => ReviewCommentSchema.parse(snakeToCamel(c))),
    })
  }
)

// Merge pull request
router.post(
  '/:owner/:repo/pulls/:number/merge',
  requireAuth,
  validateBody(MergePullRequestSchema),
  async (req, res) => {
    const { owner, repo, number } = req.params
    const { strategy, commitTitle, commitMessage, deleteSourceBranch } = req.body
    const userId = req.user!.id

    // Get PR
    const prResult = await pool.query(
      `SELECT pr.*, r.id as repo_id
       FROM pull_requests pr
       JOIN repositories r ON pr.repo_id = r.id
       JOIN users u ON r.owner_id = u.id
       WHERE u.username = $1 AND r.name = $2 AND pr.number = $3`,
      [owner, repo, parseInt(number, 10)]
    )

    if (prResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pull request not found' } })
    }

    const pr = prResult.rows[0]

    if (pr.state !== 'open') {
      return res.status(400).json({
        error: { code: 'INVALID_STATE', message: 'Pull request is not open' }
      })
    }

    // Check if mergeable
    const mergeCheck = await gitService.checkMergeable(owner, repo, pr.base_sha, pr.head_sha)
    if (!mergeCheck.mergeable) {
      return res.status(409).json({
        error: {
          code: 'MERGE_CONFLICT',
          message: 'Pull request has conflicts that must be resolved',
          details: { conflicts: mergeCheck.conflicts }
        }
      })
    }

    // Perform merge based on strategy
    let mergeResult
    const message = commitTitle || `Merge pull request #${pr.number} from ${pr.head_branch}`

    switch (strategy) {
      case 'merge':
        mergeResult = await gitService.merge(owner, repo, pr.head_sha, pr.base_branch, message)
        break
      case 'squash':
        const commits = await gitService.log(owner, repo, pr.base_sha, pr.head_sha)
        const squashMessage = commitMessage || commits.map(c => `* ${c.message}`).join('\n')
        mergeResult = await gitService.squash(owner, repo, pr.head_sha, pr.base_branch, message, squashMessage)
        break
      case 'rebase':
        mergeResult = await gitService.rebase(owner, repo, pr.head_branch, pr.base_branch)
        break
    }

    // Update PR state
    await pool.query(
      `UPDATE pull_requests
       SET state = 'merged', merged_by = $1, merged_at = NOW()
       WHERE id = $2`,
      [userId, pr.id]
    )

    // Delete source branch if requested
    if (deleteSourceBranch) {
      await gitService.deleteBranch(owner, repo, pr.head_branch)
    }

    // Emit webhook
    await emitWebhook(pr.repo_id, 'pull_request.merged', {
      pullRequest: { ...snakeToCamel(pr), state: 'merged', mergedBy: userId },
      mergeCommitSha: mergeResult.sha,
    })

    res.json({
      success: true,
      data: {
        sha: mergeResult.sha,
        merged: true,
      }
    })
  }
)

// Submit review
router.post(
  '/:owner/:repo/pulls/:number/reviews',
  requireAuth,
  validateBody(CreateReviewSchema),
  async (req, res) => {
    const { owner, repo, number } = req.params
    const { state, body, comments } = req.body
    const reviewerId = req.user!.id

    // Get PR
    const prResult = await pool.query(
      `SELECT pr.* FROM pull_requests pr
       JOIN repositories r ON pr.repo_id = r.id
       JOIN users u ON r.owner_id = u.id
       WHERE u.username = $1 AND r.name = $2 AND pr.number = $3`,
      [owner, repo, parseInt(number, 10)]
    )

    if (prResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pull request not found' } })
    }

    const pr = prResult.rows[0]

    // Create review and comments in transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Create review
      const reviewResult = await client.query(
        `INSERT INTO reviews (pr_id, reviewer_id, state, body, commit_sha)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [pr.id, reviewerId, state, body, pr.head_sha]
      )
      const review = reviewResult.rows[0]

      // Create review comments
      const createdComments = []
      for (const comment of comments) {
        const commentResult = await client.query(
          `INSERT INTO review_comments (review_id, pr_id, user_id, path, line, side, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [review.id, pr.id, reviewerId, comment.path, comment.line, comment.side, comment.body]
        )
        createdComments.push(commentResult.rows[0])
      }

      await client.query('COMMIT')

      res.status(201).json({
        success: true,
        data: {
          review: snakeToCamel(review),
          comments: createdComments.map(c => ReviewCommentSchema.parse(snakeToCamel(c))),
        }
      })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
)

export default router
```

---

## Step 4: Frontend API Layer (8 minutes)

### TanStack Query Hooks

```typescript
// frontend/src/api/hooks/usePullRequests.ts
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../client'
import {
  PullRequest,
  CreatePullRequestInput,
  MergePullRequestInput,
  CreateReviewInput,
  paginatedSchema,
  PullRequestSchema,
} from '@shared/schemas'

// Query keys factory
export const prKeys = {
  all: (owner: string, repo: string) => ['pullRequests', owner, repo] as const,
  list: (owner: string, repo: string, filters: { state?: string }) =>
    [...prKeys.all(owner, repo), 'list', filters] as const,
  detail: (owner: string, repo: string, number: number) =>
    [...prKeys.all(owner, repo), 'detail', number] as const,
  diff: (owner: string, repo: string, number: number) =>
    [...prKeys.detail(owner, repo, number), 'diff'] as const,
}

// List pull requests with pagination
export function usePullRequests(
  owner: string,
  repo: string,
  options: { state?: 'open' | 'closed' | 'merged' | 'all' } = {}
) {
  return useInfiniteQuery({
    queryKey: prKeys.list(owner, repo, options),
    queryFn: async ({ pageParam = 1 }) => {
      const response = await api.get(`/repos/${owner}/${repo}/pulls`, {
        params: { ...options, page: pageParam, limit: 30 },
      })
      return paginatedSchema(PullRequestSchema).parse(response.data)
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
  })
}

// Get single PR with diff
export function usePullRequest(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: prKeys.detail(owner, repo, number),
    queryFn: async () => {
      const response = await api.get(`/repos/${owner}/${repo}/pulls/${number}`)
      return response.data
    },
  })
}

// Create pull request
export function useCreatePullRequest(owner: string, repo: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreatePullRequestInput) => {
      const response = await api.post(`/repos/${owner}/${repo}/pulls`, input)
      return response.data.data as PullRequest
    },
    onSuccess: (newPR) => {
      // Add to list cache
      queryClient.setQueryData(
        prKeys.list(owner, repo, { state: 'open' }),
        (old: any) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((page: any, i: number) =>
              i === 0
                ? { ...page, items: [newPR, ...page.items] }
                : page
            ),
          }
        }
      )
    },
  })
}

// Merge pull request with optimistic update
export function useMergePullRequest(owner: string, repo: string, number: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: MergePullRequestInput) => {
      const response = await api.post(
        `/repos/${owner}/${repo}/pulls/${number}/merge`,
        input
      )
      return response.data.data
    },
    onMutate: async (input) => {
      // Cancel in-flight queries
      await queryClient.cancelQueries({ queryKey: prKeys.detail(owner, repo, number) })

      // Snapshot previous value
      const previousPR = queryClient.getQueryData(prKeys.detail(owner, repo, number))

      // Optimistically update to merged state
      queryClient.setQueryData(
        prKeys.detail(owner, repo, number),
        (old: any) => ({
          ...old,
          pullRequest: {
            ...old.pullRequest,
            state: 'merged',
            mergedAt: new Date().toISOString(),
          },
        })
      )

      return { previousPR }
    },
    onError: (err, input, context) => {
      // Rollback on error
      if (context?.previousPR) {
        queryClient.setQueryData(
          prKeys.detail(owner, repo, number),
          context.previousPR
        )
      }
    },
    onSettled: () => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: prKeys.detail(owner, repo, number) })
      queryClient.invalidateQueries({ queryKey: prKeys.list(owner, repo, { state: 'open' }) })
    },
  })
}

// Submit review
export function useSubmitReview(owner: string, repo: string, number: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateReviewInput) => {
      const response = await api.post(
        `/repos/${owner}/${repo}/pulls/${number}/reviews`,
        input
      )
      return response.data.data
    },
    onSuccess: (newReview) => {
      // Add review to PR detail cache
      queryClient.setQueryData(
        prKeys.detail(owner, repo, number),
        (old: any) => ({
          ...old,
          reviews: [newReview.review, ...old.reviews],
          comments: [...old.comments, ...newReview.comments],
        })
      )
    },
  })
}
```

### Repository and File Hooks

```typescript
// frontend/src/api/hooks/useRepository.ts
import { useQuery } from '@tanstack/react-query'
import { api } from '../client'
import { Repository, RepositorySchema, TreeNode, FileContent } from '@shared/schemas'

export const repoKeys = {
  all: ['repositories'] as const,
  detail: (owner: string, repo: string) => ['repository', owner, repo] as const,
  tree: (owner: string, repo: string, ref: string, path: string) =>
    [...repoKeys.detail(owner, repo), 'tree', ref, path] as const,
  file: (owner: string, repo: string, ref: string, path: string) =>
    [...repoKeys.detail(owner, repo), 'file', ref, path] as const,
  branches: (owner: string, repo: string) =>
    [...repoKeys.detail(owner, repo), 'branches'] as const,
}

export function useRepository(owner: string, repo: string) {
  return useQuery({
    queryKey: repoKeys.detail(owner, repo),
    queryFn: async () => {
      const response = await api.get(`/repos/${owner}/${repo}`)
      return RepositorySchema.parse(response.data)
    },
  })
}

export function useTree(owner: string, repo: string, ref: string, path: string = '') {
  return useQuery({
    queryKey: repoKeys.tree(owner, repo, ref, path),
    queryFn: async () => {
      const response = await api.get(
        `/repos/${owner}/${repo}/tree/${ref}`,
        { params: { path } }
      )
      return response.data as TreeNode[]
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - tree doesn't change often
  })
}

export function useFileContent(owner: string, repo: string, ref: string, path: string) {
  return useQuery({
    queryKey: repoKeys.file(owner, repo, ref, path),
    queryFn: async () => {
      const response = await api.get(
        `/repos/${owner}/${repo}/contents/${ref}/${encodeURIComponent(path)}`
      )
      return response.data as FileContent
    },
    staleTime: 60 * 60 * 1000, // 1 hour - file content by SHA is immutable
  })
}

export function useBranches(owner: string, repo: string) {
  return useQuery({
    queryKey: repoKeys.branches(owner, repo),
    queryFn: async () => {
      const response = await api.get(`/repos/${owner}/${repo}/branches`)
      return response.data as Array<{ name: string; sha: string; isDefault: boolean }>
    },
    staleTime: 60 * 1000, // 1 minute
  })
}
```

---

## Step 5: Real-Time Synchronization (8 minutes)

### WebSocket Integration

```typescript
// frontend/src/api/websocket.ts
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useCallback } from 'react'

type WSMessage =
  | { type: 'pr.updated'; payload: { owner: string; repo: string; number: number } }
  | { type: 'pr.merged'; payload: { owner: string; repo: string; number: number } }
  | { type: 'review.submitted'; payload: { owner: string; repo: string; number: number; reviewId: number } }
  | { type: 'comment.added'; payload: { owner: string; repo: string; number: number; commentId: number } }
  | { type: 'ci.status'; payload: { owner: string; repo: string; sha: string; status: string } }

export function useWebSocketSync() {
  const queryClient = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>()

  const connect = useCallback(() => {
    const ws = new WebSocket(`${WS_URL}/sync`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected')
    }

    ws.onmessage = (event) => {
      const message: WSMessage = JSON.parse(event.data)
      handleMessage(message, queryClient)
    }

    ws.onclose = () => {
      // Reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectTimeoutRef.current = setTimeout(connect, delay)
      reconnectAttempts++
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      ws.close()
    }
  }, [queryClient])

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
      clearTimeout(reconnectTimeoutRef.current)
    }
  }, [connect])

  // Subscribe to specific resources
  const subscribe = useCallback((resource: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'subscribe', resource }))
  }, [])

  const unsubscribe = useCallback((resource: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'unsubscribe', resource }))
  }, [])

  return { subscribe, unsubscribe }
}

function handleMessage(message: WSMessage, queryClient: QueryClient) {
  switch (message.type) {
    case 'pr.updated':
    case 'pr.merged': {
      const { owner, repo, number } = message.payload
      // Invalidate PR detail cache
      queryClient.invalidateQueries({
        queryKey: ['pullRequests', owner, repo, 'detail', number],
      })
      // Also invalidate list
      queryClient.invalidateQueries({
        queryKey: ['pullRequests', owner, repo, 'list'],
      })
      break
    }

    case 'review.submitted':
    case 'comment.added': {
      const { owner, repo, number } = message.payload
      queryClient.invalidateQueries({
        queryKey: ['pullRequests', owner, repo, 'detail', number],
      })
      break
    }

    case 'ci.status': {
      const { owner, repo, sha } = message.payload
      // Find and update any PRs with this SHA
      queryClient.invalidateQueries({
        queryKey: ['pullRequests', owner, repo],
        predicate: (query) => {
          const data = query.state.data as any
          return data?.pullRequest?.headSha === sha
        },
      })
      break
    }
  }
}
```

### PR Detail Page with Real-Time Updates

```tsx
// frontend/src/routes/$owner/$repo/pull/$number.tsx
import { useParams } from '@tanstack/react-router'
import { usePullRequest, useMergePullRequest, useSubmitReview } from '@/api/hooks/usePullRequests'
import { useWebSocketSync } from '@/api/websocket'
import { useEffect } from 'react'

export function PullRequestPage() {
  const { owner, repo, number } = useParams({ from: '/$owner/$repo/pull/$number' })
  const prNumber = parseInt(number, 10)

  const { data, isLoading, error } = usePullRequest(owner, repo, prNumber)
  const mergeMutation = useMergePullRequest(owner, repo, prNumber)
  const reviewMutation = useSubmitReview(owner, repo, prNumber)

  // Subscribe to real-time updates for this PR
  const { subscribe, unsubscribe } = useWebSocketSync()

  useEffect(() => {
    const resource = `${owner}/${repo}/pull/${prNumber}`
    subscribe(resource)
    return () => unsubscribe(resource)
  }, [owner, repo, prNumber, subscribe, unsubscribe])

  if (isLoading) return <LoadingSkeleton />
  if (error) return <ErrorMessage error={error} />

  const { pullRequest, diff, reviews, comments } = data

  return (
    <div className="max-w-6xl mx-auto p-6">
      {/* PR Header */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold">
          {pullRequest.title}
          <span className="text-gray-500 font-normal"> #{pullRequest.number}</span>
        </h1>
        <PRStatusBadge state={pullRequest.state} />
        <p className="text-sm text-gray-600 mt-2">
          {pullRequest.authorId} wants to merge {pullRequest.changedFiles} files
          from <code>{pullRequest.headBranch}</code> into <code>{pullRequest.baseBranch}</code>
        </p>
      </header>

      {/* Tabs */}
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="conversation">
            Conversation ({comments.length})
          </TabsTrigger>
          <TabsTrigger value="commits">
            Commits ({pullRequest.changedFiles})
          </TabsTrigger>
          <TabsTrigger value="files">
            Files Changed ({diff.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation">
          <ConversationView
            pullRequest={pullRequest}
            comments={comments}
            reviews={reviews}
          />
        </TabsContent>

        <TabsContent value="files">
          <DiffViewer files={diff} comments={comments} />
        </TabsContent>
      </Tabs>

      {/* Merge Panel */}
      {pullRequest.state === 'open' && (
        <MergePanel
          pullRequest={pullRequest}
          onMerge={(strategy) => mergeMutation.mutate({ strategy })}
          isMerging={mergeMutation.isPending}
        />
      )}

      {/* Review Form */}
      <ReviewForm
        prId={pullRequest.id}
        onSubmit={(review) => reviewMutation.mutate(review)}
        isSubmitting={reviewMutation.isPending}
      />
    </div>
  )
}
```

### Optimistic Review Comment Workflow

```tsx
// frontend/src/components/ReviewForm.tsx
import { useState, useCallback } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CreateReviewSchema, CreateReviewInput, ReviewStateSchema } from '@shared/schemas'

interface PendingComment {
  id: string // temporary client ID
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export function ReviewForm({ prId, onSubmit, isSubmitting }: ReviewFormProps) {
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([])

  const { register, handleSubmit, formState: { errors } } = useForm<CreateReviewInput>({
    resolver: zodResolver(CreateReviewSchema),
  })

  // Add pending comment (from inline comment forms)
  const addPendingComment = useCallback((comment: Omit<PendingComment, 'id'>) => {
    setPendingComments(prev => [
      ...prev,
      { ...comment, id: crypto.randomUUID() }
    ])
  }, [])

  // Remove pending comment
  const removePendingComment = useCallback((id: string) => {
    setPendingComments(prev => prev.filter(c => c.id !== id))
  }, [])

  // Submit review with all pending comments
  const handleFormSubmit = handleSubmit((data) => {
    onSubmit({
      ...data,
      comments: pendingComments.map(({ id, ...comment }) => comment),
    })
  })

  return (
    <form onSubmit={handleFormSubmit} className="border rounded-lg p-4 mt-6">
      <h3 className="font-semibold mb-4">Submit Review</h3>

      {/* Pending comments summary */}
      {pendingComments.length > 0 && (
        <div className="mb-4 p-3 bg-gray-50 rounded">
          <p className="text-sm font-medium">
            {pendingComments.length} pending comment(s)
          </p>
          <ul className="text-sm text-gray-600 mt-1">
            {pendingComments.map(c => (
              <li key={c.id} className="flex justify-between items-center">
                <span>{c.path}:{c.line}</span>
                <button
                  type="button"
                  onClick={() => removePendingComment(c.id)}
                  className="text-red-500 hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Review body */}
      <textarea
        {...register('body')}
        placeholder="Leave a comment..."
        className="w-full border rounded p-3 mb-4"
        rows={4}
      />

      {/* Review actions */}
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            type="submit"
            onClick={() => register('state').onChange({ target: { value: 'commented' } })}
            className="px-4 py-2 border rounded hover:bg-gray-50"
            disabled={isSubmitting}
          >
            Comment
          </button>
          <button
            type="submit"
            onClick={() => register('state').onChange({ target: { value: 'approved' } })}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
            disabled={isSubmitting}
          >
            Approve
          </button>
          <button
            type="submit"
            onClick={() => register('state').onChange({ target: { value: 'changes_requested' } })}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            disabled={isSubmitting}
          >
            Request Changes
          </button>
        </div>

        {isSubmitting && <LoadingSpinner />}
      </div>
    </form>
  )
}
```

---

## Step 6: Code Search Integration (7 minutes)

### Search API with Elasticsearch

```typescript
// backend/src/api/routes/search.ts
import { Router } from 'express'
import { z } from 'zod'
import { esClient } from '../shared/elasticsearch.js'
import { validateQuery } from '../shared/validation.js'

const router = Router()

const SearchQuerySchema = z.object({
  q: z.string().min(1),
  language: z.string().optional(),
  repo: z.string().optional(),
  path: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

router.get(
  '/search/code',
  validateQuery(SearchQuerySchema),
  async (req, res) => {
    const { q, language, repo, path, page, limit } = req.query
    const from = (page - 1) * limit

    // Build Elasticsearch query
    const must: any[] = [{ match: { content: q } }]
    const filter: any[] = []

    if (language) {
      filter.push({ term: { language } })
    }

    if (repo) {
      filter.push({ term: { 'repo.fullName': repo } })
    }

    if (path) {
      filter.push({ wildcard: { path: `*${path}*` } })
    }

    const result = await esClient.search({
      index: 'code',
      body: {
        query: {
          bool: { must, filter },
        },
        highlight: {
          fields: {
            content: {
              fragment_size: 150,
              number_of_fragments: 5,
              pre_tags: ['<mark>'],
              post_tags: ['</mark>'],
            },
          },
        },
        from,
        size: limit,
      },
    })

    const hits = result.hits.hits.map((hit: any) => ({
      repoId: hit._source.repoId,
      repoFullName: hit._source.repo.fullName,
      path: hit._source.path,
      language: hit._source.language,
      highlights: parseHighlights(hit.highlight?.content || []),
    }))

    res.json({
      items: hits,
      pagination: {
        page,
        limit,
        total: result.hits.total.value,
        totalPages: Math.ceil(result.hits.total.value / limit),
      },
    })
  }
)

function parseHighlights(fragments: string[]): Array<{
  lineNumber: number
  content: string
  matchRanges: Array<{ start: number; end: number }>
}> {
  return fragments.map((fragment, index) => {
    // Parse <mark> tags into ranges
    const ranges: Array<{ start: number; end: number }> = []
    let content = ''
    let currentIndex = 0
    let inMark = false
    let markStart = 0

    for (let i = 0; i < fragment.length; i++) {
      if (fragment.slice(i, i + 6) === '<mark>') {
        markStart = currentIndex
        inMark = true
        i += 5 // Skip past <mark>
      } else if (fragment.slice(i, i + 7) === '</mark>') {
        ranges.push({ start: markStart, end: currentIndex })
        inMark = false
        i += 6 // Skip past </mark>
      } else {
        content += fragment[i]
        currentIndex++
      }
    }

    return {
      lineNumber: index + 1, // Approximate
      content,
      matchRanges: ranges,
    }
  })
}

export default router
```

### Frontend Search Hook and Component

```typescript
// frontend/src/api/hooks/useSearch.ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../client'
import { useDebounce } from '@/hooks/useDebounce'

interface SearchFilters {
  language?: string
  repo?: string
  path?: string
}

export function useCodeSearch(query: string, filters: SearchFilters) {
  const debouncedQuery = useDebounce(query, 300)

  return useInfiniteQuery({
    queryKey: ['search', 'code', debouncedQuery, filters],
    queryFn: async ({ pageParam = 1 }) => {
      const response = await api.get('/search/code', {
        params: {
          q: debouncedQuery,
          ...filters,
          page: pageParam,
          limit: 20,
        },
      })
      return response.data
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    enabled: debouncedQuery.length >= 3,
  })
}
```

```tsx
// frontend/src/routes/search.tsx
import { useSearchParams } from '@tanstack/react-router'
import { useCodeSearch } from '@/api/hooks/useSearch'

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') || ''
  const language = searchParams.get('language') || undefined
  const repo = searchParams.get('repo') || undefined

  const {
    data,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useCodeSearch(query, { language, repo })

  const results = data?.pages.flatMap(page => page.items) ?? []

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Search header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-2">
          Search results for "{query}"
        </h1>
        <p className="text-gray-600">
          {data?.pages[0]?.pagination.total.toLocaleString()} results
        </p>

        {/* Filters */}
        <div className="flex gap-4 mt-4">
          <LanguageFilter
            value={language}
            onChange={(lang) => setSearchParams({ ...searchParams, language: lang })}
          />
          <RepoFilter
            value={repo}
            onChange={(r) => setSearchParams({ ...searchParams, repo: r })}
          />
        </div>
      </div>

      {/* Results */}
      <div className="divide-y">
        {results.map((result) => (
          <SearchResultCard key={`${result.repoId}:${result.path}`} result={result} />
        ))}
      </div>

      {/* Load more */}
      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full py-3 text-center text-blue-600 hover:bg-gray-50"
        >
          {isFetchingNextPage ? 'Loading...' : 'Load more results'}
        </button>
      )}
    </div>
  )
}
```

---

## Step 7: Error Handling and Loading States (5 minutes)

### Centralized Error Boundary

```tsx
// frontend/src/components/ErrorBoundary.tsx
import { useRouteError, isRouteErrorResponse } from '@tanstack/react-router'

export function RouteErrorBoundary() {
  const error = useRouteError()

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return <NotFoundPage />
    }
    if (error.status === 403) {
      return <ForbiddenPage />
    }
  }

  return <GenericErrorPage error={error} />
}

function GenericErrorPage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred'

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-red-600 mb-4">Something went wrong</h1>
        <p className="text-gray-600 mb-6">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Reload page
        </button>
      </div>
    </div>
  )
}
```

### API Error Handler

```typescript
// frontend/src/api/client.ts
import axios, { AxiosError } from 'axios'
import { ApiError } from '@shared/schemas'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
})

// Request interceptor for auth
api.interceptors.request.use((config) => {
  const sessionId = localStorage.getItem('sessionId')
  if (sessionId) {
    config.headers['X-Session-Id'] = sessionId
  }
  return config
})

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiError>) => {
    if (error.response?.status === 401) {
      // Redirect to login
      window.location.href = '/login'
      return Promise.reject(error)
    }

    // Enhance error with API error details
    if (error.response?.data?.error) {
      const apiError = error.response.data.error
      const enhancedError = new Error(apiError.message) as Error & {
        code: string
        details: Record<string, string[]>
      }
      enhancedError.code = apiError.code
      enhancedError.details = apiError.details || {}
      return Promise.reject(enhancedError)
    }

    return Promise.reject(error)
  }
)
```

### Loading Skeletons

```tsx
// frontend/src/components/skeletons/PRDetailSkeleton.tsx
export function PRDetailSkeleton() {
  return (
    <div className="max-w-6xl mx-auto p-6 animate-pulse">
      {/* Header skeleton */}
      <div className="mb-6">
        <div className="h-8 bg-gray-200 rounded w-3/4 mb-2" />
        <div className="h-4 bg-gray-200 rounded w-1/2" />
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-4 mb-6">
        <div className="h-10 bg-gray-200 rounded w-32" />
        <div className="h-10 bg-gray-200 rounded w-24" />
        <div className="h-10 bg-gray-200 rounded w-28" />
      </div>

      {/* Diff skeleton */}
      <div className="space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="border rounded">
            <div className="h-12 bg-gray-100 border-b" />
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, j) => (
                <div key={j} className="h-4 bg-gray-100 rounded" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## Step 8: Key Design Decisions and Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Type sharing | Zod schemas | TypeScript interfaces | Runtime validation + types |
| Data fetching | TanStack Query | SWR, Redux Toolkit Query | Infinite queries, optimistic updates |
| Real-time | WebSocket + invalidation | SSE, polling | Bi-directional, efficient |
| Forms | React Hook Form + Zod | Formik, uncontrolled | Type-safe validation |
| API client | Axios | Fetch | Interceptors, timeout config |

### Full-Stack Type Safety Chain

```
Zod Schema (shared/)
       │
       ├──► Frontend Types (z.infer)
       │         │
       │         └──► Form Validation (zodResolver)
       │         └──► API Response Parsing
       │
       └──► Backend Validation (validateBody/validateQuery)
                 │
                 └──► Runtime Validation Errors
                 └──► Type-Safe Request Handlers
```

### Cache Invalidation Strategy

| Event | Invalidated Queries |
|-------|-------------------|
| PR created | `prKeys.list` |
| PR merged | `prKeys.detail`, `prKeys.list` |
| Review submitted | `prKeys.detail` |
| Push event (WS) | `repoKeys.tree`, `repoKeys.file` |
| CI status (WS) | PRs with matching SHA |

---

## Closing Summary

I've designed a full-stack code hosting platform with four core integration patterns:

1. **Shared Type System**: Zod schemas providing single source of truth for types and validation, used by both frontend forms and backend route handlers

2. **API Layer**: RESTful endpoints with consistent validation middleware, TanStack Query hooks with proper cache key factories, and optimistic updates for merge operations

3. **Real-Time Sync**: WebSocket connection subscribing to specific resources, automatic query invalidation on server events, and reconnection with exponential backoff

4. **Error Handling**: Centralized error boundary with route-aware handling, Axios interceptors for auth and error enhancement, and typed API errors with validation details

**Key full-stack trade-offs:**
- Zod over pure TypeScript (runtime validation overhead vs. safety)
- Query invalidation over WebSocket data push (simpler sync vs. bandwidth)
- Optimistic updates selectively (merge operations vs. all mutations)

**Future enhancements:**
- GraphQL for complex nested queries (PR with reviews, comments, CI status)
- Offline-first with service workers and IndexedDB caching
- Collaborative editing with Yjs or operational transforms
- End-to-end testing with Playwright covering full user flows
