import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import { uploadSignature, getSignatureUrl, getDocumentBuffer } from '../utils/minio.js';
import { setSigningSession } from '../utils/redis.js';
import { authenticateSigner } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';
import { workflowEngine } from '../services/workflowEngine.js';

const router = Router();

// Get signing session info
router.get('/session/:accessToken', async (req, res) => {
  try {
    const { accessToken } = req.params;

    // Get recipient and envelope info
    const result = await query(
      `SELECT r.*, e.name as envelope_name, e.status as envelope_status,
              e.message as envelope_message, e.authentication_level
       FROM recipients r
       JOIN envelopes e ON r.envelope_id = e.id
       WHERE r.access_token = $1`,
      [accessToken]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid signing link' });
    }

    const recipient = result.rows[0];

    // Check envelope status
    if (!['sent', 'delivered'].includes(recipient.envelope_status)) {
      return res.status(400).json({
        error: 'This document is no longer available for signing',
        status: recipient.envelope_status
      });
    }

    // Check recipient status
    if (recipient.status === 'completed') {
      return res.status(400).json({ error: 'You have already signed this document' });
    }

    if (recipient.status === 'declined') {
      return res.status(400).json({ error: 'This signing request was declined' });
    }

    // Get documents for this envelope
    const docsResult = await query(
      'SELECT * FROM documents WHERE envelope_id = $1 ORDER BY created_at ASC',
      [recipient.envelope_id]
    );

    // Get fields assigned to this recipient
    const fieldsResult = await query(
      `SELECT df.*
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       WHERE d.envelope_id = $1 AND df.recipient_id = $2
       ORDER BY df.page_number ASC, df.y ASC`,
      [recipient.envelope_id, recipient.id]
    );

    // Cache signing session in Redis
    await setSigningSession(accessToken, {
      recipientId: recipient.id,
      envelopeId: recipient.envelope_id,
      envelope_status: recipient.envelope_status,
      status: recipient.status
    });

    res.json({
      recipient: {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        status: recipient.status
      },
      envelope: {
        id: recipient.envelope_id,
        name: recipient.envelope_name,
        message: recipient.envelope_message,
        status: recipient.envelope_status
      },
      documents: docsResult.rows,
      fields: fieldsResult.rows,
      authenticationRequired: recipient.authentication_level !== 'email'
    });
  } catch (error) {
    console.error('Get signing session error:', error);
    res.status(500).json({ error: 'Failed to get signing session' });
  }
});

// Get document for signing (public, requires access token)
router.get('/document/:accessToken/:documentId', async (req, res) => {
  try {
    const { accessToken, documentId } = req.params;

    // Verify access token belongs to a recipient in this envelope
    const recipientResult = await query(
      `SELECT r.*, e.status as envelope_status
       FROM recipients r
       JOIN envelopes e ON r.envelope_id = e.id
       WHERE r.access_token = $1`,
      [accessToken]
    );

    if (recipientResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid signing link' });
    }

    const recipient = recipientResult.rows[0];

    // Verify document belongs to this envelope
    const docResult = await query(
      'SELECT * FROM documents WHERE id = $1 AND envelope_id = $2',
      [documentId, recipient.envelope_id]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = docResult.rows[0];

    // Log document view
    await auditService.log(recipient.envelope_id, 'signing_started', {
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      documentId,
      documentName: document.name,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    }, recipient.id);

    // Get document from MinIO
    const buffer = await getDocumentBuffer(document.s3_key);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.name}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Get signing document error:', error);
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// Capture signature
router.post('/sign/:accessToken', authenticateSigner, async (req, res) => {
  try {
    const { fieldId, signatureData, type = 'draw' } = req.body;

    if (!fieldId || !signatureData) {
      return res.status(400).json({ error: 'fieldId and signatureData are required' });
    }

    const recipient = req.signer;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Verify field belongs to this recipient
    const fieldResult = await query(
      `SELECT df.*, d.envelope_id
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       WHERE df.id = $1`,
      [fieldId]
    );

    if (fieldResult.rows.length === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }

    const field = fieldResult.rows[0];

    if (field.recipient_id !== recipient.id) {
      return res.status(403).json({ error: 'This field is not assigned to you' });
    }

    if (field.completed) {
      return res.status(400).json({ error: 'This field has already been completed' });
    }

    // Process signature image
    let signatureBuffer;
    if (signatureData.startsWith('data:image')) {
      // Base64 encoded image
      const base64Data = signatureData.split(',')[1];
      signatureBuffer = Buffer.from(base64Data, 'base64');
    } else {
      signatureBuffer = Buffer.from(signatureData, 'base64');
    }

    // Store signature in MinIO
    const signatureId = uuid();
    const s3Key = `signatures/${signatureId}.png`;
    await uploadSignature(s3Key, signatureBuffer, 'image/png');

    // Create signature record
    await query(
      `INSERT INTO signatures (id, recipient_id, field_id, s3_key, type, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [signatureId, recipient.id, fieldId, s3Key, type, ipAddress, userAgent]
    );

    // Update field as completed
    await query(
      `UPDATE document_fields
       SET completed = true, signature_id = $2
       WHERE id = $1`,
      [fieldId, signatureId]
    );

    // Log audit event
    await auditService.log(field.envelope_id, 'signature_captured', {
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      fieldId,
      signatureId,
      type,
      ipAddress,
      userAgent,
      timestamp: new Date().toISOString()
    }, recipient.id);

    // Check if recipient has completed all required fields
    const isComplete = await workflowEngine.checkRecipientCompletion(recipient.id);

    res.json({
      signatureId,
      fieldId,
      completed: true,
      recipientComplete: isComplete
    });
  } catch (error) {
    console.error('Capture signature error:', error);
    res.status(500).json({ error: 'Failed to capture signature' });
  }
});

// Complete field (for non-signature fields like date, text, checkbox)
router.post('/complete-field/:accessToken', authenticateSigner, async (req, res) => {
  try {
    const { fieldId, value } = req.body;

    if (!fieldId) {
      return res.status(400).json({ error: 'fieldId is required' });
    }

    const recipient = req.signer;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Verify field belongs to this recipient
    const fieldResult = await query(
      `SELECT df.*, d.envelope_id
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       WHERE df.id = $1`,
      [fieldId]
    );

    if (fieldResult.rows.length === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }

    const field = fieldResult.rows[0];

    if (field.recipient_id !== recipient.id) {
      return res.status(403).json({ error: 'This field is not assigned to you' });
    }

    if (field.completed) {
      return res.status(400).json({ error: 'This field has already been completed' });
    }

    // For signature/initial fields, redirect to sign endpoint
    if (['signature', 'initial'].includes(field.type)) {
      return res.status(400).json({
        error: 'Use the /sign endpoint for signature and initial fields'
      });
    }

    // Set value based on field type
    let fieldValue = value;
    if (field.type === 'date') {
      fieldValue = value || new Date().toISOString().split('T')[0];
    } else if (field.type === 'checkbox') {
      fieldValue = value === true || value === 'true' ? 'checked' : 'unchecked';
    }

    // Update field
    await query(
      `UPDATE document_fields
       SET completed = true, value = $2
       WHERE id = $1`,
      [fieldId, fieldValue]
    );

    // Log audit event
    await auditService.log(field.envelope_id, 'field_completed', {
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      fieldId,
      fieldType: field.type,
      ipAddress,
      userAgent,
      timestamp: new Date().toISOString()
    }, recipient.id);

    // Check if recipient has completed all required fields
    const isComplete = await workflowEngine.checkRecipientCompletion(recipient.id);

    res.json({
      fieldId,
      value: fieldValue,
      completed: true,
      recipientComplete: isComplete
    });
  } catch (error) {
    console.error('Complete field error:', error);
    res.status(500).json({ error: 'Failed to complete field' });
  }
});

// Finish signing (mark recipient as complete)
router.post('/finish/:accessToken', authenticateSigner, async (req, res) => {
  try {
    const recipient = req.signer;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Check all required fields are complete
    const incompleteResult = await query(
      `SELECT df.* FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       WHERE d.envelope_id = $1 AND df.recipient_id = $2 AND df.required = true AND df.completed = false`,
      [recipient.envelope_id, recipient.id]
    );

    if (incompleteResult.rows.length > 0) {
      return res.status(400).json({
        error: 'Please complete all required fields before finishing',
        incompleteFields: incompleteResult.rows.map(f => ({
          id: f.id,
          type: f.type,
          pageNumber: f.page_number
        }))
      });
    }

    // Mark recipient as complete
    await workflowEngine.completeRecipient(recipient.id, ipAddress, userAgent);

    res.json({
      message: 'Signing completed successfully',
      recipientId: recipient.id
    });
  } catch (error) {
    console.error('Finish signing error:', error);
    res.status(500).json({ error: 'Failed to complete signing' });
  }
});

// Decline to sign
router.post('/decline/:accessToken', authenticateSigner, async (req, res) => {
  try {
    const { reason } = req.body;
    const recipient = req.signer;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    await workflowEngine.declineEnvelope(recipient.id, reason, ipAddress, userAgent);

    res.json({
      message: 'Document declined',
      recipientId: recipient.id
    });
  } catch (error) {
    console.error('Decline signing error:', error);
    res.status(500).json({ error: 'Failed to decline' });
  }
});

// Get signature image
router.get('/signature-image/:signatureId/:accessToken', authenticateSigner, async (req, res) => {
  try {
    const { signatureId } = req.params;

    const result = await query(
      'SELECT * FROM signatures WHERE id = $1 AND recipient_id = $2',
      [signatureId, req.signer.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Signature not found' });
    }

    const signatureUrl = await getSignatureUrl(result.rows[0].s3_key);

    res.json({ url: signatureUrl });
  } catch (error) {
    console.error('Get signature image error:', error);
    res.status(500).json({ error: 'Failed to get signature image' });
  }
});

export default router;
