import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';

const router = Router();

interface DocumentRow {
  id: string;
  envelope_id: string;
  name: string;
  page_count: number;
  s3_key: string;
  status: string;
  file_size: number;
  sender_id?: string;
  envelope_status?: string;
}

interface FieldRow {
  id: string;
  document_id: string;
  recipient_id: string;
  type: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  completed: boolean;
  value?: string;
  signature_id?: string;
  envelope_id?: string;
  sender_id?: string;
  envelope_status?: string;
  recipient_name?: string;
  recipient_email?: string;
}

interface RecipientRow {
  id: string;
  envelope_id: string;
}

interface FieldDimensions {
  width: number;
  height: number;
}

interface BulkField {
  recipientId: string;
  type: string;
  pageNumber: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  required?: boolean;
}

// Add field to document
router.post('/:documentId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { documentId } = req.params;
    const { recipientId, type, pageNumber, x, y, width, height, required = true } = req.body;

    if (!recipientId || !type || pageNumber === undefined || x === undefined || y === undefined) {
      res.status(400).json({
        error: 'recipientId, type, pageNumber, x, and y are required'
      });
      return;
    }

    // Validate field type
    const validTypes = ['signature', 'initial', 'date', 'text', 'checkbox'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: `Invalid field type. Must be one of: ${validTypes.join(', ')}` });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify document and envelope ownership
    const docResult = await query<DocumentRow>(
      `SELECT d.*, e.sender_id, e.status as envelope_status
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [documentId]
    );

    if (docResult.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = docResult.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (document.envelope_status !== 'draft') {
      res.status(400).json({ error: 'Can only add fields to draft envelopes' });
      return;
    }

    // Validate page number
    if (pageNumber < 1 || pageNumber > document.page_count) {
      res.status(400).json({
        error: `Page number must be between 1 and ${document.page_count}`
      });
      return;
    }

    // Verify recipient belongs to this envelope
    const recipientResult = await query<RecipientRow>(
      'SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2',
      [recipientId, document.envelope_id]
    );

    if (recipientResult.rows.length === 0) {
      res.status(400).json({ error: 'Recipient not found in this envelope' });
      return;
    }

    // Default dimensions based on field type
    const defaultDimensions: Record<string, FieldDimensions> = {
      signature: { width: 200, height: 50 },
      initial: { width: 80, height: 40 },
      date: { width: 120, height: 30 },
      text: { width: 200, height: 30 },
      checkbox: { width: 20, height: 20 }
    };

    const fieldId = uuid();
    const fieldWidth = width || defaultDimensions[type].width;
    const fieldHeight = height || defaultDimensions[type].height;

    const result = await query<FieldRow>(
      `INSERT INTO document_fields
        (id, document_id, recipient_id, type, page_number, x, y, width, height, required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [fieldId, documentId, recipientId, type, pageNumber, x, y, fieldWidth, fieldHeight, required]
    );

    const field = result.rows[0];

    // Log audit event
    await auditService.log(document.envelope_id, 'field_added', {
      fieldId,
      fieldType: type,
      documentId,
      recipientId,
      pageNumber,
      userId: req.user.id
    }, req.user.id);

    res.status(201).json({ field });
  } catch (error) {
    console.error('Add field error:', error);
    res.status(500).json({ error: 'Failed to add field' });
  }
});

// Get fields for document
router.get('/document/:documentId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { documentId } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify document ownership
    const docResult = await query<DocumentRow>(
      `SELECT d.*, e.sender_id
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [documentId]
    );

    if (docResult.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    if (docResult.rows[0].sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = await query<FieldRow>(
      `SELECT df.*, r.name as recipient_name, r.email as recipient_email
       FROM document_fields df
       JOIN recipients r ON df.recipient_id = r.id
       WHERE df.document_id = $1
       ORDER BY df.page_number ASC, df.y ASC`,
      [documentId]
    );

    res.json({ fields: result.rows });
  } catch (error) {
    console.error('Get fields error:', error);
    res.status(500).json({ error: 'Failed to get fields' });
  }
});

// Update field
router.put('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { recipientId, type, pageNumber, x, y, width, height, required } = req.body;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify field and envelope ownership
    const fieldResult = await query<FieldRow>(
      `SELECT df.*, d.envelope_id, e.sender_id, e.status as envelope_status
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE df.id = $1`,
      [id]
    );

    if (fieldResult.rows.length === 0) {
      res.status(404).json({ error: 'Field not found' });
      return;
    }

    const field = fieldResult.rows[0];

    if (field.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (field.envelope_status !== 'draft') {
      res.status(400).json({ error: 'Can only edit fields in draft envelopes' });
      return;
    }

    // If changing recipient, verify they belong to this envelope
    if (recipientId) {
      const recipientResult = await query<{ id: string }>(
        'SELECT id FROM recipients WHERE id = $1 AND envelope_id = $2',
        [recipientId, field.envelope_id]
      );

      if (recipientResult.rows.length === 0) {
        res.status(400).json({ error: 'Recipient not found in this envelope' });
        return;
      }
    }

    const result = await query<FieldRow>(
      `UPDATE document_fields
       SET recipient_id = COALESCE($2, recipient_id),
           type = COALESCE($3, type),
           page_number = COALESCE($4, page_number),
           x = COALESCE($5, x),
           y = COALESCE($6, y),
           width = COALESCE($7, width),
           height = COALESCE($8, height),
           required = COALESCE($9, required)
       WHERE id = $1
       RETURNING *`,
      [id, recipientId, type, pageNumber, x, y, width, height, required]
    );

    res.json({ field: result.rows[0] });
  } catch (error) {
    console.error('Update field error:', error);
    res.status(500).json({ error: 'Failed to update field' });
  }
});

// Delete field
router.delete('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify field and envelope ownership
    const fieldResult = await query<FieldRow>(
      `SELECT df.*, d.envelope_id, e.sender_id, e.status as envelope_status
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE df.id = $1`,
      [id]
    );

    if (fieldResult.rows.length === 0) {
      res.status(404).json({ error: 'Field not found' });
      return;
    }

    const field = fieldResult.rows[0];

    if (field.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (field.envelope_status !== 'draft') {
      res.status(400).json({ error: 'Can only delete fields from draft envelopes' });
      return;
    }

    await query('DELETE FROM document_fields WHERE id = $1', [id]);

    res.json({ message: 'Field deleted' });
  } catch (error) {
    console.error('Delete field error:', error);
    res.status(500).json({ error: 'Failed to delete field' });
  }
});

// Bulk add fields
router.post('/bulk/:documentId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { documentId } = req.params;
    const { fields } = req.body as { fields: BulkField[] };

    if (!Array.isArray(fields) || fields.length === 0) {
      res.status(400).json({ error: 'Fields array is required' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify document ownership
    const docResult = await query<DocumentRow>(
      `SELECT d.*, e.sender_id, e.status as envelope_status
       FROM documents d
       JOIN envelopes e ON d.envelope_id = e.id
       WHERE d.id = $1`,
      [documentId]
    );

    if (docResult.rows.length === 0) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const document = docResult.rows[0];

    if (document.sender_id !== req.user.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (document.envelope_status !== 'draft') {
      res.status(400).json({ error: 'Can only add fields to draft envelopes' });
      return;
    }

    const createdFields: FieldRow[] = [];

    for (const field of fields) {
      const fieldId = uuid();
      const result = await query<FieldRow>(
        `INSERT INTO document_fields
          (id, document_id, recipient_id, type, page_number, x, y, width, height, required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [fieldId, documentId, field.recipientId, field.type, field.pageNumber,
         field.x, field.y, field.width || 200, field.height || 50, field.required !== false]
      );
      createdFields.push(result.rows[0]);
    }

    res.status(201).json({ fields: createdFields });
  } catch (error) {
    console.error('Bulk add fields error:', error);
    res.status(500).json({ error: 'Failed to add fields' });
  }
});

export default router;
