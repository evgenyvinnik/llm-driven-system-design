import { Router } from 'express'
import { MODELS } from '../../shared/catalog.js'

export const modelsRouter = Router()

modelsRouter.get('/', (_req, res) => {
  res.json({
    models: MODELS.map(({ id, label, description, maxOutputTokens }) => ({ id, label, description, maxOutputTokens })),
  })
})
