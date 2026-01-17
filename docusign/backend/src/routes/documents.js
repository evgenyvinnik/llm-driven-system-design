import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { query } from '../utils/db.js';
import { uploadDocument, getDocumentUrl, getDocumentBuffer } from '../utils/minio.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Upload document to envelope
router.post('/upload/:envelopeId', authenticate, upload.single('document'), async (req, res) => {
  try {
    const { envelopeId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Verify envelope ownership and status
    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    if (envelopeResult.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Can only add documents to draft envelopes' });
    }

    // Process PDF
    let pdfDoc;
    let pageCount;

    try {
      pdfDoc = await PDFDocument.load(req.file.buffer);
      pageCount = pdfDoc.getPageCount();
    } catch (pdfError) {
      return res.status(400).json({ error: 'Invalid PDF file' });
    }

    // Store document in MinIO
    const documentId = uuid();
    const s3Key = `envelopes/${envelopeId}/documents/${documentId}/original.pdf`;

    await uploadDocument(s3Key, req.file.buffer, 'application/pdf');

    // Create document record
    const result = await query(
      `INSERT INTO documents (id, envelope_id, name, page_count, s3_key, status, file_size)
       VALUES ($1, $2, $3, $4, $5, 'ready', $6)
       RETURNING *`,
      [documentId, envelopeId, req.file.originalname, pageCount, s3Key, req.file.size]
    );

    const document = result.rows[0];

    // Log audit event
    await auditService.log(envelopeId, 'document_added', {
      documentId,
      documentName: req.file.originalname,
      pageCount,
      fileSize: req.file.size,
      userId: req.user.id
    }, req.user.id);

    res.status(201).json({ document });
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// Get document info
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get presigned URL for document
    const documentUrl = await getDocumentUrl(document.s3_key);

    res.json({ document, documentUrl });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// Get document file (download)
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const buffer = await getDocumentBuffer(document.s3_key);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${document.name}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Download document error:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// Get document for viewing (inline)
router.get('/:id/view', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const buffer = await getDocumentBuffer(document.s3_key);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.name}"`);
    res.send(buffer);
  } catch (error) {
    console.error('View document error:', error);
    res.status(500).json({ error: 'Failed to view document' });
  }
});

// Delete document
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT d.*, e.sender_id, e.status as envelope_status
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (document.envelope_status !== 'draft') {
      return res.status(400).json({ error: 'Can only delete documents from draft envelopes' });
    }

    await query('DELETE FROM documents WHERE id = $1', [id]);

    res.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Get documents for an envelope
router.get('/envelope/:envelopeId', authenticate, async (req, res) => {
  try {
    const { envelopeId } = req.params;

    // Verify envelope ownership
    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    const result = await query(
      'SELECT * FROM documents WHERE envelope_id = $1 ORDER BY created_at ASC',
      [envelopeId]
    );

    res.json({ documents: result.rows });
  } catch (error) {
    console.error('Get envelope documents error:', error);
    res.status(500).json({ error: 'Failed to get documents' });
  }
});

export default router;
