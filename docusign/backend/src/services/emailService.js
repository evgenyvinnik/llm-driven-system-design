import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';

// Simulated email service for development
// In production, this would integrate with SendGrid, SES, etc.

class EmailService {
  constructor() {
    this.baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  // Store email in database (simulated sending)
  async storeEmail(recipientId, envelopeId, type, subject, body) {
    await query(
      `INSERT INTO email_notifications
        (id, recipient_id, envelope_id, type, subject, body, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', NOW())`,
      [uuid(), recipientId, envelopeId, type, subject, body]
    );

    console.log(`[EMAIL] To: ${recipientId} | Subject: ${subject}`);
    console.log(`[EMAIL] Body: ${body.substring(0, 200)}...`);
  }

  // Send signing request to recipient
  async sendSigningRequest(recipient, envelope) {
    const signingUrl = `${this.baseUrl}/sign/${recipient.access_token}`;

    const subject = `Please sign: ${envelope.name}`;
    const body = `
Hello ${recipient.name},

You have been requested to sign "${envelope.name}".

Please click the link below to review and sign the document:
${signingUrl}

${envelope.message ? `Message from sender: ${envelope.message}` : ''}

This link is unique to you and should not be shared.

Thank you,
DocuSign
    `.trim();

    await this.storeEmail(recipient.id, envelope.id, 'signing_request', subject, body);

    return { signingUrl };
  }

  // Send reminder to recipient
  async sendReminder(recipient, envelope) {
    const signingUrl = `${this.baseUrl}/sign/${recipient.access_token}`;

    const subject = `Reminder: Please sign "${envelope.name}"`;
    const body = `
Hello ${recipient.name},

This is a reminder that you have a document waiting for your signature: "${envelope.name}".

Please click the link below to review and sign:
${signingUrl}

Thank you,
DocuSign
    `.trim();

    await this.storeEmail(recipient.id, envelope.id, 'reminder', subject, body);
  }

  // Send completion notification
  async sendCompletionNotification(recipient, envelope) {
    const downloadUrl = `${this.baseUrl}/envelopes/${envelope.id}/download`;

    const subject = `Completed: ${envelope.name}`;
    const body = `
Hello ${recipient.name},

All parties have signed "${envelope.name}".

You can download the completed document and certificate of completion here:
${downloadUrl}

Thank you for using DocuSign.
    `.trim();

    await this.storeEmail(recipient.id, envelope.id, 'completed', subject, body);
  }

  // Send decline notification to sender
  async sendDeclineNotification(recipient, envelope, reason) {
    const subject = `Document Declined: ${envelope.name}`;
    const body = `
Hello ${envelope.sender_name},

${recipient.name} (${recipient.email}) has declined to sign "${envelope.name}".

${reason ? `Reason: ${reason}` : ''}

You can view the envelope status in your DocuSign dashboard.

Thank you,
DocuSign
    `.trim();

    // Send to the sender's email via the envelope's sender_id
    await this.storeEmail(null, envelope.id, 'declined', subject, body);
  }

  // Send void notification
  async sendVoidNotification(recipient, envelope, reason) {
    const subject = `Document Voided: ${envelope.name}`;
    const body = `
Hello ${recipient.name},

The document "${envelope.name}" has been voided and is no longer available for signing.

${reason ? `Reason: ${reason}` : ''}

If you have any questions, please contact the sender.

Thank you,
DocuSign
    `.trim();

    await this.storeEmail(recipient.id, envelope.id, 'voided', subject, body);
  }

  // Get all emails for an envelope (for debugging/admin)
  async getEnvelopeEmails(envelopeId) {
    const result = await query(
      `SELECT en.*, r.email as recipient_email, r.name as recipient_name
       FROM email_notifications en
       LEFT JOIN recipients r ON en.recipient_id = r.id
       WHERE en.envelope_id = $1
       ORDER BY en.created_at DESC`,
      [envelopeId]
    );
    return result.rows;
  }

  // Get recent emails (for admin dashboard)
  async getRecentEmails(limit = 50) {
    const result = await query(
      `SELECT en.*, r.email as recipient_email, r.name as recipient_name,
              e.name as envelope_name
       FROM email_notifications en
       LEFT JOIN recipients r ON en.recipient_id = r.id
       LEFT JOIN envelopes e ON en.envelope_id = e.id
       ORDER BY en.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

export const emailService = new EmailService();
