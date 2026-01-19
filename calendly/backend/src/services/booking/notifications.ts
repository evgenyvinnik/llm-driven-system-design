/**
 * Notification handling for booking-related events.
 *
 * @description Publishes booking notifications to RabbitMQ for async processing
 * and sends direct email notifications. Handles confirmation, reschedule,
 * cancellation, and reminder notifications.
 *
 * @module services/booking/notifications
 */

import { type Booking } from './types.js';
import { emailService } from '../emailService.js';
import { logger } from '../../shared/logger.js';
import { emailNotificationsTotal } from '../../shared/metrics.js';
import { queueService } from '../../shared/queue.js';

/**
 * Publishes a booking confirmation notification to RabbitMQ.
 *
 * @description Queues a notification message for async processing by notification
 * workers. The message contains all details needed to send confirmation emails
 * to both invitee and host.
 *
 * @param {Booking} booking - The newly created booking
 * @param {Object} meetingType - Meeting type details including host info
 * @param {string} meetingType.name - Display name of the meeting type
 * @param {string} meetingType.user_name - Display name of the host
 * @param {string} meetingType.user_email - Email address of the host
 * @param {string} meetingType.id - UUID of the meeting type
 * @returns {Promise<void>} Resolves when message is published
 * @throws {Error} If RabbitMQ connection fails or message cannot be published
 *
 * @example
 * await publishBookingConfirmation(booking, {
 *   name: '30 Minute Meeting',
 *   user_name: 'John Doe',
 *   user_email: 'john@example.com',
 *   id: 'meeting-type-uuid'
 * });
 */
export async function publishBookingConfirmation(
  booking: Booking,
  meetingType: { name: string; user_name: string; user_email: string; id: string }
): Promise<void> {
  try {
    await queueService.publishNotification('booking_confirmed', {
      bookingId: booking.id,
      hostUserId: booking.host_user_id,
      inviteeEmail: booking.invitee_email,
      inviteeName: booking.invitee_name,
      meetingTypeName: meetingType.name,
      meetingTypeId: meetingType.id,
      hostName: meetingType.user_name,
      hostEmail: meetingType.user_email,
      startTime: booking.start_time.toString(),
      endTime: booking.end_time.toString(),
      inviteeTimezone: booking.invitee_timezone,
      notes: booking.notes || undefined,
    });
  } catch (error) {
    logger.error({ error, bookingId: booking.id }, 'Failed to publish booking confirmation');
    throw error;
  }
}

/**
 * Schedules reminder notifications for an upcoming booking.
 *
 * @description Schedules two reminder notifications: one 24 hours before and
 * one 1 hour before the meeting start time. Reminders are only scheduled if
 * the reminder time is in the future. Uses RabbitMQ delayed message feature.
 *
 * @param {Booking} booking - The booking to schedule reminders for
 * @returns {Promise<void>} Resolves when reminders are scheduled
 * @throws {Error} If RabbitMQ connection fails
 *
 * @example
 * // For a booking at 2024-01-15T14:00:00Z
 * await scheduleReminders(booking);
 * // Schedules reminders for:
 * // - 2024-01-14T14:00:00Z (24 hours before)
 * // - 2024-01-15T13:00:00Z (1 hour before)
 */
export async function scheduleReminders(booking: Booking): Promise<void> {
  const startTime = new Date(booking.start_time);
  const now = new Date();

  // Schedule 24-hour reminder
  const reminder24h = new Date(startTime.getTime() - 24 * 60 * 60 * 1000);
  if (reminder24h > now) {
    await queueService.scheduleReminder(booking.id, reminder24h.toISOString(), {
      hoursUntil: 24,
      inviteeEmail: booking.invitee_email,
      inviteeName: booking.invitee_name,
      startTime: booking.start_time.toString(),
      inviteeTimezone: booking.invitee_timezone,
    });
  }

  // Schedule 1-hour reminder
  const reminder1h = new Date(startTime.getTime() - 60 * 60 * 1000);
  if (reminder1h > now) {
    await queueService.scheduleReminder(booking.id, reminder1h.toISOString(), {
      hoursUntil: 1,
      inviteeEmail: booking.invitee_email,
      inviteeName: booking.invitee_name,
      startTime: booking.start_time.toString(),
      inviteeTimezone: booking.invitee_timezone,
    });
  }
}

/**
 * Publishes a reschedule notification to RabbitMQ.
 *
 * @description Queues a notification message for async processing when a booking
 * is rescheduled to a new time. The message includes the new meeting times.
 *
 * @param {Booking} booking - The rescheduled booking with updated times
 * @param {Object} meetingDetails - Meeting type and host details
 * @param {string} meetingDetails.meeting_type_name - Display name of the meeting type
 * @param {string} meetingDetails.meeting_type_id - UUID of the meeting type
 * @param {string} meetingDetails.host_name - Display name of the host
 * @param {string} meetingDetails.host_email - Email address of the host
 * @returns {Promise<void>} Resolves when message is published
 * @throws {Error} If RabbitMQ connection fails or message cannot be published
 */
export async function publishRescheduleNotification(
  booking: Booking,
  meetingDetails: {
    meeting_type_name: string;
    meeting_type_id: string;
    host_name: string;
    host_email: string;
  }
): Promise<void> {
  await queueService.publishNotification('booking_rescheduled', {
    bookingId: booking.id,
    hostUserId: booking.host_user_id,
    inviteeEmail: booking.invitee_email,
    inviteeName: booking.invitee_name,
    meetingTypeName: meetingDetails.meeting_type_name,
    meetingTypeId: meetingDetails.meeting_type_id,
    hostName: meetingDetails.host_name,
    hostEmail: meetingDetails.host_email,
    startTime: booking.start_time.toString(),
    endTime: booking.end_time.toString(),
    inviteeTimezone: booking.invitee_timezone,
  });
}

/**
 * Publishes a cancellation notification to RabbitMQ.
 *
 * @description Queues a notification message for async processing when a booking
 * is cancelled. The message includes an optional cancellation reason.
 *
 * @param {Booking} booking - The cancelled booking
 * @param {Object} meetingDetails - Meeting type and host details
 * @param {string} meetingDetails.meeting_type_name - Display name of the meeting type
 * @param {string} meetingDetails.meeting_type_id - UUID of the meeting type
 * @param {string} meetingDetails.host_name - Display name of the host
 * @param {string} meetingDetails.host_email - Email address of the host
 * @param {string} [reason] - Optional cancellation reason provided by the user
 * @returns {Promise<void>} Resolves when message is published
 * @throws {Error} If RabbitMQ connection fails or message cannot be published
 */
export async function publishCancellationNotification(
  booking: Booking,
  meetingDetails: {
    meeting_type_name: string;
    meeting_type_id: string;
    host_name: string;
    host_email: string;
  },
  reason?: string
): Promise<void> {
  await queueService.publishNotification('booking_cancelled', {
    bookingId: booking.id,
    hostUserId: booking.host_user_id,
    inviteeEmail: booking.invitee_email,
    inviteeName: booking.invitee_name,
    meetingTypeName: meetingDetails.meeting_type_name,
    meetingTypeId: meetingDetails.meeting_type_id,
    hostName: meetingDetails.host_name,
    hostEmail: meetingDetails.host_email,
    startTime: booking.start_time.toString(),
    endTime: booking.end_time.toString(),
    inviteeTimezone: booking.invitee_timezone,
    cancellationReason: reason,
  });
}

/**
 * Sends confirmation emails to both invitee and host.
 *
 * @description Called asynchronously after booking creation. Sends separate
 * confirmation emails to the invitee and host with meeting details.
 * Increments success metrics for each email sent.
 *
 * @param {Booking} booking - The newly created booking
 * @param {Object} meetingType - Meeting type details for email content
 * @param {string} meetingType.name - Display name of the meeting type
 * @param {string} meetingType.user_name - Display name of the host
 * @param {string} meetingType.user_email - Email address of the host
 * @returns {Promise<void>} Resolves when both emails are sent
 * @throws {Error} If email service fails to send either email
 *
 * @example
 * await sendConfirmationEmails(booking, {
 *   name: 'Quick Chat',
 *   user_name: 'Jane Smith',
 *   user_email: 'jane@example.com'
 * });
 */
export async function sendConfirmationEmails(
  booking: Booking,
  meetingType: { name: string; user_name: string; user_email: string }
): Promise<void> {
  // Send to invitee
  await emailService.sendBookingConfirmation(booking, meetingType, 'invitee');
  emailNotificationsTotal.inc({ type: 'confirmation', status: 'success' });

  // Send to host
  await emailService.sendBookingConfirmation(booking, meetingType, 'host');
  emailNotificationsTotal.inc({ type: 'confirmation', status: 'success' });
}

/**
 * Sends a reschedule notification email to the invitee.
 *
 * @description Called after a booking is successfully rescheduled. Notifies
 * the invitee of the new meeting time via the email service.
 *
 * @param {Booking} booking - The rescheduled booking with updated times
 * @returns {Promise<void>} Resolves when email is sent
 * @throws {Error} If email service fails to send the email
 */
export async function sendRescheduleEmail(booking: Booking): Promise<void> {
  await emailService.sendRescheduleNotification(booking);
}

/**
 * Sends a cancellation notification email to the invitee.
 *
 * @description Called after a booking is cancelled. Notifies the invitee
 * of the cancellation with an optional reason via the email service.
 *
 * @param {Booking} booking - The cancelled booking
 * @param {string} [reason] - Optional cancellation reason to include in the email
 * @returns {Promise<void>} Resolves when email is sent
 * @throws {Error} If email service fails to send the email
 */
export async function sendCancellationEmail(
  booking: Booking,
  reason?: string
): Promise<void> {
  await emailService.sendCancellationNotification(booking, reason);
}
