import { Router } from 'express'
import multer from 'multer'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { principal, requireMember } from '../../shared/auth.js'
import { documentChunks, documentDetail, documentText, listDeleted, listDocuments } from '../services/documents.js'
import { changeSharing, deleteDocument, retryDocument, sharingSchema } from '../services/lifecycle.js'
import { publishJobs } from '../services/publish.js'
import { upload } from '../services/uploads.js'

export const documentsRouter = Router()
documentsRouter.use(requireMember)

const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.upload.maxBytes, files: 1 } }).single('file')

function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (raw.length > 200) throw new HttpError(422, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be at most 200 characters')
  return raw
}

const uploadHandler = (forVersion: boolean) =>
  asyncHandler(async (req, res) => {
    await new Promise<void>((resolve, reject) =>
      fileUpload(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
          reject(new HttpError(413, 'FILE_TOO_LARGE', `Files are limited to ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB`))
        else if (err) reject(err)
        else resolve()
      }),
    )
    if (!req.file) throw new HttpError(422, 'FILE_REQUIRED', 'Attach a file in the "file" field')
    const { orgId, userId } = principal(req)
    // multer decodes the multipart filename as latin1; restore UTF-8.
    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
    const result = await upload({
      orgId,
      userId,
      filename,
      bytes: req.file.buffer,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      idempotencyKey: idempotencyKey(req.get('idempotency-key')),
      documentId: forVersion ? req.params.id : undefined,
    })
    await publishJobs(result.jobIds)
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true')
    res.status(result.status).json(result.body)
  })

documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    res.json({ documents: await listDocuments(orgId, userId) })
  }),
)

documentsRouter.get(
  '/deleted',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    res.json({ documents: await listDeleted(orgId, userId) })
  }),
)

documentsRouter.post('/', uploadHandler(false))
documentsRouter.post('/:id/versions', uploadHandler(true))

documentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    res.json(await documentDetail(orgId, userId, req.params.id))
  }),
)

documentsRouter.get(
  '/:id/text',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    const version = typeof req.query.version === 'string' && req.query.version ? req.query.version : undefined
    res.json(await documentText(orgId, userId, req.params.id, version))
  }),
)

documentsRouter.get(
  '/:id/chunks',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    const version = typeof req.query.version === 'string' && req.query.version ? req.query.version : undefined
    res.json({ chunks: await documentChunks(orgId, userId, req.params.id, version) })
  }),
)

documentsRouter.patch(
  '/:id/sharing',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    res.json(await changeSharing(orgId, userId, req.params.id, sharingSchema.parse(req.body)))
  }),
)

documentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    const { jobIds, ...deleted } = await deleteDocument(orgId, userId, req.params.id)
    await publishJobs(jobIds)
    res.status(202).json({ deleted })
  }),
)

documentsRouter.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = principal(req)
    const { jobIds, document } = await retryDocument(orgId, userId, req.params.id)
    await publishJobs(jobIds)
    res.json({ document })
  }),
)
