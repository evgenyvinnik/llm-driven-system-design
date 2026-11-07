/**
 * Datasets, prompts, model configs and scorers. All workspace-scoped.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, userOf, workspaceOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import {
  createModelConfig,
  createPrompt,
  createPromptSchema,
  createPromptVersion,
  createScorer,
  createScorerSchema,
  createScorerVersion,
  getPrompt,
  listModelConfigs,
  listPrompts,
  listScorers,
  modelConfigSchema,
  promptVersionSchema,
  scorerVersionSchema,
} from '../services/catalog.js'
import { createDataset, createDatasetSchema, createVersion, createVersionSchema, diffVersions, getDataset, listDatasets, versionCases } from '../services/datasets.js'

export const catalogRouter = Router()
catalogRouter.use(requireAuth)

const versionParam = z.coerce.number().int().min(1)

catalogRouter.get('/datasets', asyncHandler(async (req, res) => res.json({ datasets: await listDatasets(pool, workspaceOf(req)) })))
catalogRouter.post(
  '/datasets',
  asyncHandler(async (req, res) => res.status(201).json(await createDataset(workspaceOf(req), userOf(req).id, createDatasetSchema.parse(req.body)))),
)
catalogRouter.get('/datasets/:id', asyncHandler(async (req, res) => res.json({ dataset: await getDataset(pool, workspaceOf(req), req.params.id) })))
catalogRouter.get(
  '/datasets/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const cases = await versionCases(pool, workspaceOf(req), req.params.id, versionParam.parse(req.params.version))
    if (cases.length === 0) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dataset version not found' } })
    res.json({ cases })
  }),
)
catalogRouter.post(
  '/datasets/:id/versions',
  asyncHandler(async (req, res) => res.status(201).json(await createVersion(workspaceOf(req), userOf(req).id, req.params.id, createVersionSchema.parse(req.body)))),
)
catalogRouter.get(
  '/datasets/:id/diff',
  asyncHandler(async (req, res) => {
    const from = versionParam.parse(req.query.from)
    const to = versionParam.parse(req.query.to)
    res.json({ from, to, diff: await diffVersions(pool, workspaceOf(req), req.params.id, from, to) })
  }),
)

catalogRouter.get('/prompts', asyncHandler(async (req, res) => res.json({ prompts: await listPrompts(pool, workspaceOf(req)) })))
catalogRouter.post('/prompts', asyncHandler(async (req, res) => res.status(201).json(await createPrompt(workspaceOf(req), userOf(req).id, createPromptSchema.parse(req.body)))))
catalogRouter.get('/prompts/:id', asyncHandler(async (req, res) => res.json({ prompt: await getPrompt(pool, workspaceOf(req), req.params.id) })))
catalogRouter.post(
  '/prompts/:id/versions',
  asyncHandler(async (req, res) => res.status(201).json(await createPromptVersion(workspaceOf(req), userOf(req).id, req.params.id, promptVersionSchema.parse(req.body)))),
)

catalogRouter.get('/model-configs', asyncHandler(async (req, res) => res.json({ modelConfigs: await listModelConfigs(pool, workspaceOf(req)) })))
catalogRouter.post(
  '/model-configs',
  asyncHandler(async (req, res) => res.status(201).json(await createModelConfig(pool, workspaceOf(req), userOf(req).id, modelConfigSchema.parse(req.body)))),
)

catalogRouter.get('/scorers', asyncHandler(async (req, res) => res.json({ scorers: await listScorers(pool, workspaceOf(req)) })))
catalogRouter.post('/scorers', asyncHandler(async (req, res) => res.status(201).json(await createScorer(workspaceOf(req), userOf(req).id, createScorerSchema.parse(req.body)))))
catalogRouter.post(
  '/scorers/:id/versions',
  asyncHandler(async (req, res) => res.status(201).json(await createScorerVersion(workspaceOf(req), userOf(req).id, req.params.id, scorerVersionSchema.parse(req.body)))),
)
