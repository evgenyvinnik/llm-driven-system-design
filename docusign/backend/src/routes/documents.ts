import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { query } from '../utils/db.js';
import { uploadDocument, getDocumentUrl, getDocumentBuffer } from '../utils/minio.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';

const router = Router();

interface EnvelopeRow {
  id: string;
  sender_id: string;
  status: string;
}

interface DocumentRow {
  id: string;
  envelope_id: string;
  name: string;
  page_count: number;
  s3_key: string;
  status: string;
  file_size: number;
  created_at: string;
  sender_id?: string;
  envelope_status?: string;
}

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
router.post('/upload/:envelopeId', authenticate, upload.single('document'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId } = req.params;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify envelope ownership and status
    const envelopeResult = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    if (envelopeResult.rows[0].status !== 'draft') {
      res.status(400).json({ error: 'Can only add documents to draft envelopes' });
      return;
    }

    // Process PDF
    let pdfDoc: PDFDocument;
    let pageCount: number;

    try {
      pdfDoc = await PDFDocument.load(req.file.buffer);
      pageCount = pdfDoc.getPageCount();
    } catch (pdfError) {
      res.status(400).json({ error: 'Invalid PDF file' });
      return;
    }

    // Store document in MinIO
    const documentId = uuid();
    const s3Key = `envelopes/${envelopeId}/documents/${documentId}/original.pdf`;

    await uploadDocument(s3Key, req.file.buffer, 'application/pdf');

    // Create document record
    const result = await query<DocumentRow>(
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
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await query<DocumentRow>(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
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
router.get('/:id/download', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await query<DocumentRow>(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
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
router.get('/:id/view', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await query<DocumentRow>(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
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
router.delete('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await query<DocumentRow>(
      `SELECT d.*, e.sender_id, e.status as envelope_status
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = result.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (document.envelope_status !== 'draft') {
      res.status(400).json({ error: 'Can only delete documents from draft envelopes' });
      return;
    }

    await query('DELETE FROM documents WHERE id = $1', [id]);

    res.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Get documents for an envelope
router.get('/envelope/:envelopeId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify envelope ownership
    const envelopeResult = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    const result = await query<DocumentRow>(
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
