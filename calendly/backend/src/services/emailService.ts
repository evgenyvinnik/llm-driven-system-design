import { pool } from '../db/index.js';
import { type Booking } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

/**
 * Simulated email service for sending booking notifications.
 * In production, this would integrate with SendGrid, Mailgun, SES, etc.
 * For this demo, emails are logged to console and stored in the database
 * for tracking and debugging purposes.
 */
export class EmailService {
  /**
   * Sends a booking confirmation email to either the invitee or host.
   * Formats the meeting time in the invitee's timezone for clarity.
   * @param booking - The booking to send confirmation for
   * @param meetingType - Meeting type details including host info
   * @param recipient - Whether to send to 'invitee' or 'host'
   */
  async sendBookingConfirmation(
    booking: Booking,
    meetingType: { name: string; user_name: string; user_email: string },
    recipient: 'invitee' | 'host'
  ): Promise<void> {
    const recipientEmail = recipient === 'invitee' ? booking.invitee_email : meetingType.user_email;
    const recipientName = recipient === 'invitee' ? booking.invitee_name : meetingType.user_name;

    const startTimeInvitee = toZonedTime(new Date(booking.start_time), booking.invitee_timezone);
    const formattedTime = format(startTimeInvitee, 'EEEE, MMMM do, yyyy \'at\' h:mm a');

    const subject = recipient === 'invitee'
      ? `Confirmed: ${meetingType.name} with ${meetingType.user_name}`
      : `New Booking: ${meetingType.name} with ${booking.invitee_name}`;

    const body = recipient === 'invitee'
      ? `
Hi ${recipientName},

Your meeting has been confirmed!

Meeting: ${meetingType.name}
Host: ${meetingType.user_name}
When: ${formattedTime} (${booking.invitee_timezone})

${booking.notes ? `Notes: ${booking.notes}` : ''}

To reschedule or cancel, visit your booking page.

Best regards,
Calendly
      `.trim()
      : `
Hi ${recipientName},

You have a new booking!

Meeting: ${meetingType.name}
Guest: ${booking.invitee_name} (${booking.invitee_email})
When: ${formattedTime} (${booking.invitee_timezone})

${booking.notes ? `Notes: ${booking.notes}` : ''}

Best regards,
Calendly
      `.trim();

    await this.logEmail(booking.id, recipientEmail, 'confirmation', subject, body);
  }

  /**
   * Sends a notification when a booking is rescheduled.
   * Informs the invitee of the new meeting time.
   * @param booking - The rescheduled booking with new time
   */
  async sendRescheduleNotification(booking: Booking): Promise<void> {
    const startTimeInvitee = toZonedTime(new Date(booking.start_time), booking.invitee_timezone);
    const formattedTime = format(startTimeInvitee, 'EEEE, MMMM do, yyyy \'at\' h:mm a');

    const subject = `Meeting Rescheduled`;
    const body = `
Hi ${booking.invitee_name},

Your meeting has been rescheduled.

New Time: ${formattedTime} (${booking.invitee_timezone})

If this doesn't work for you, please contact the host to reschedule.

Best regards,
Calendly
    `.trim();

    await this.logEmail(booking.id, booking.invitee_email, 'reschedule', subject, body);
  }

  /**
   * Sends a notification when a booking is cancelled.
   * Includes the cancellation reason if provided.
   * @param booking - The cancelled booking
   * @param reason - Optional cancellation reason to include in the email
   */
  async sendCancellationNotification(booking: Booking, reason?: string): Promise<void> {
    const startTimeInvitee = toZonedTime(new Date(booking.start_time), booking.invitee_timezone);
    const formattedTime = format(startTimeInvitee, 'EEEE, MMMM do, yyyy \'at\' h:mm a');

    const subject = `Meeting Cancelled`;
    const body = `
Hi ${booking.invitee_name},

Your meeting scheduled for ${formattedTime} has been cancelled.

${reason ? `Reason: ${reason}` : ''}

We apologize for any inconvenience.

Best regards,
Calendly
    `.trim();

    await this.logEmail(booking.id, booking.invitee_email, 'cancellation', subject, body);
  }

  /**
   * Sends a reminder notification before a scheduled meeting.
   * Used by background jobs to remind invitees of upcoming meetings.
   * @param booking - The upcoming booking
   * @param hoursUntil - Number of hours until the meeting starts
   */
  async sendReminder(booking: Booking, hoursUntil: number): Promise<void> {
    const startTimeInvitee = toZonedTime(new Date(booking.start_time), booking.invitee_timezone);
    const formattedTime = format(startTimeInvitee, 'EEEE, MMMM do, yyyy \'at\' h:mm a');

    const subject = `Reminder: Meeting in ${hoursUntil} hour${hoursUntil > 1 ? 's' : ''}`;
    const body = `
Hi ${booking.invitee_name},

This is a reminder that you have a meeting coming up.

When: ${formattedTime} (${booking.invitee_timezone})

See you soon!

Best regards,
Calendly
    `.trim();

    await this.logEmail(booking.id, booking.invitee_email, 'reminder', subject, body);
  }

  /**
   * Logs an email to the database and console.
   * In production, this would send via an email service provider.
   * @param bookingId - The UUID of the related booking
   * @param recipientEmail - The email address to send to
   * @param notificationType - Type of notification (confirmation, reminder, etc.)
   * @param subject - Email subject line
   * @param body - Email body content
   */
  private async logEmail(
    bookingId: string,
    recipientEmail: string,
    notificationType: string,
    subject: string,
    body: string
  ): Promise<void> {
    const id = uuidv4();

    await pool.query(
      `INSERT INTO email_notifications
       (id, booking_id, recipient_email, notification_type, subject, body, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent')`,
      [id, bookingId, recipientEmail, notificationType, subject, body]
    );

    // Log to console for debugging
    console.log('='.repeat(60));
    console.log(`EMAIL NOTIFICATION (${notificationType.toUpperCase()})`);
    console.log('='.repeat(60));
    console.log(`To: ${recipientEmail}`);
    console.log(`Subject: ${subject}`);
    console.log('-'.repeat(60));
    console.log(body);
    console.log('='.repeat(60));
  }

  /**
   * Retrieves all email notifications for a specific booking.
   * Useful for debugging email delivery issues.
   * @param bookingId - The UUID of the booking
   * @returns Array of email notifications sorted by sent time (newest first)
   */
  async getEmailsForBooking(bookingId: string): Promise<Array<{
    id: string;
    recipient_email: string;
    notification_type: string;
    subject: string;
    body: string;
    sent_at: Date;
    status: string;
  }>> {
    const result = await pool.query(
      `SELECT * FROM email_notifications
       WHERE booking_id = $1
       ORDER BY sent_at DESC`,
      [bookingId]
    );

    return result.rows;
  }

  /**
   * Retrieves all email notifications in the system.
   * Admin-only operation for monitoring email activity.
   * @param limit - Maximum number of emails to return (default 100)
   * @returns Array of email notifications sorted by sent time (newest first)
   */
  async getAllEmails(limit: number = 100): Promise<Array<{
    id: string;
    booking_id: string;
    recipient_email: string;
    notification_type: string;
    subject: string;
    sent_at: Date;
    status: string;
  }>> {
    const result = await pool.query(
      `SELECT id, booking_id, recipient_email, notification_type, subject, sent_at, status
       FROM email_notifications
       ORDER BY sent_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }
}

/** Singleton instance of EmailService for application-wide use */
export const emailService = new EmailService();
