-- Seed data for development/testing
-- Notification System Sample Data

-- Insert default templates
INSERT INTO notification_templates (id, name, description, channels, variables) VALUES
  ('welcome', 'Welcome Email', 'Sent when a new user signs up',
   '{"email": {"subject": "Welcome to Notifications!", "body": "Hi {{name}}, welcome to our notification system!"}, "push": {"title": "Welcome!", "body": "Thanks for joining us, {{name}}!"}}',
   ARRAY['name']),
  ('password_reset', 'Password Reset', 'Password reset notification',
   '{"email": {"subject": "Reset Your Password", "body": "Hi {{name}}, click here to reset your password: {{resetLink}}"}}',
   ARRAY['name', 'resetLink']),
  ('order_update', 'Order Update', 'Order status notification',
   '{"email": {"subject": "Order #{{orderId}} Update", "body": "Your order status has been updated to: {{status}}"}, "push": {"title": "Order Update", "body": "Order #{{orderId}} is now {{status}}"}, "sms": {"body": "Your order #{{orderId}} is now {{status}}"}}',
   ARRAY['orderId', 'status']),
  ('marketing', 'Marketing Campaign', 'Promotional notification',
   '{"email": {"subject": "{{subject}}", "body": "{{content}}"}, "push": {"title": "{{title}}", "body": "{{message}}"}}',
   ARRAY['subject', 'content', 'title', 'message'])
ON CONFLICT (id) DO NOTHING;

-- Insert sample admin user (password: admin123)
INSERT INTO users (id, email, name, email_verified, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin@example.com', 'Admin User', true, 'admin')
ON CONFLICT (id) DO NOTHING;

-- Insert sample regular users
INSERT INTO users (id, email, phone, name, email_verified, phone_verified, role) VALUES
  ('00000000-0000-0000-0000-000000000002', 'john@example.com', '+1234567890', 'John Doe', true, true, 'user'),
  ('00000000-0000-0000-0000-000000000003', 'jane@example.com', '+1987654321', 'Jane Smith', true, false, 'user'),
  ('00000000-0000-0000-0000-000000000004', 'bob@example.com', NULL, 'Bob Wilson', true, false, 'user')
ON CONFLICT (id) DO NOTHING;

-- Insert default preferences for sample users
INSERT INTO notification_preferences (user_id, channels) VALUES
  ('00000000-0000-0000-0000-000000000002', '{"push": {"enabled": true}, "email": {"enabled": true}, "sms": {"enabled": true}}'),
  ('00000000-0000-0000-0000-000000000003', '{"push": {"enabled": true}, "email": {"enabled": true}, "sms": {"enabled": false}}'),
  ('00000000-0000-0000-0000-000000000004', '{"push": {"enabled": false}, "email": {"enabled": true}, "sms": {"enabled": false}}')
ON CONFLICT (user_id) DO NOTHING;

-- Insert sample device tokens
INSERT INTO device_tokens (user_id, platform, token) VALUES
  ('00000000-0000-0000-0000-000000000002', 'ios', 'sample_apns_token_1'),
  ('00000000-0000-0000-0000-000000000002', 'android', 'sample_fcm_token_1'),
  ('00000000-0000-0000-0000-000000000003', 'web', 'sample_web_push_token_1')
ON CONFLICT (token) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Notification history
--
-- Without these the dashboard and Notifications page render "No notifications
-- found" on a fresh stack: notifications are only ever created by API calls, so
-- nothing exists until someone sends one. These rows cover the full lifecycle
-- the UI has filters for — delivered, failed (retried and dead-lettered),
-- pending, scheduled, cancelled — across all three channels and all four
-- priorities, so the routing model is visible rather than merely described.
-- ---------------------------------------------------------------------------
INSERT INTO notifications (id, user_id, template_id, content, channels, priority, status, created_at, delivered_at, scheduled_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'password_reset',
   '{"title": "Reset your password", "body": "Use the link below within 15 minutes to choose a new password."}',
   ARRAY['email'], 'critical', 'delivered', NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '5 minutes', NULL),

  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "New sign-in from an unrecognized device", "body": "Chrome on macOS, San Francisco. If this was not you, reset your password."}',
   ARRAY['push','email'], 'high', 'delivered', NOW() - INTERVAL '42 minutes', NOW() - INTERVAL '41 minutes', NULL),

  ('a0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'order_shipped',
   '{"title": "Your order has shipped", "body": "Tracking number 1Z999AA10123456784. Expected Thursday."}',
   ARRAY['push','sms'], 'normal', 'delivered', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', NULL),

  -- Retried twice, then succeeded on the third attempt — the happy path of the
  -- exponential-backoff retry logic.
  ('a0000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "Weekly digest", "body": "12 new items in the topics you follow."}',
   ARRAY['email'], 'low', 'delivered', NOW() - INTERVAL '9 hours', NOW() - INTERVAL '8 hours 41 minutes', NULL),

  -- Exhausted its retry budget and was dead-lettered.
  ('a0000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "Payment method expiring", "body": "The card ending 4242 expires next month."}',
   ARRAY['sms'], 'normal', 'failed', NOW() - INTERVAL '5 hours', NULL, NULL),

  ('a0000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "Build #4821 failed", "body": "integration-tests failed on main. 3 of 412 assertions."}',
   ARRAY['push'], 'high', 'pending', NOW() - INTERVAL '2 minutes', NULL, NULL),

  ('a0000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "Scheduled maintenance tonight", "body": "The API will be read-only from 02:00 to 02:30 UTC."}',
   ARRAY['email','push'], 'normal', 'scheduled', NOW() - INTERVAL '20 minutes', NULL, NOW() + INTERVAL '6 hours'),

  ('a0000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', NULL,
   '{"title": "Spring promotion", "body": "Campaign cancelled before send."}',
   ARRAY['email'], 'low', 'cancelled', NOW() - INTERVAL '2 days', NULL, NULL),

  -- Other users, so the admin views are not single-user.
  ('a0000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000002', 'order_shipped',
   '{"title": "Your order has shipped", "body": "Arriving Friday."}',
   ARRAY['sms'], 'normal', 'delivered', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NULL),

  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000003', NULL,
   '{"title": "Someone mentioned you", "body": "Jane was mentioned in #general."}',
   ARRAY['push'], 'normal', 'failed', NOW() - INTERVAL '7 hours', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Per-channel delivery outcomes. A notification fans out to one row per channel,
-- which is what makes partial delivery representable: the push landed, the SMS
-- provider rejected the number, and the notification as a whole is neither
-- cleanly delivered nor cleanly failed.
INSERT INTO delivery_status (notification_id, channel, status, details, attempts, next_retry_at, updated_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'email', 'delivered', '{"provider": "simulated-email", "latency_ms": 412}', 1, NULL, NOW() - INTERVAL '5 minutes'),
  ('a0000000-0000-4000-8000-000000000002', 'push',  'delivered', '{"provider": "simulated-push", "latency_ms": 88}', 1, NULL, NOW() - INTERVAL '41 minutes'),
  ('a0000000-0000-4000-8000-000000000002', 'email', 'delivered', '{"provider": "simulated-email", "latency_ms": 502}', 1, NULL, NOW() - INTERVAL '41 minutes'),
  ('a0000000-0000-4000-8000-000000000003', 'push',  'delivered', '{"provider": "simulated-push", "latency_ms": 95}', 1, NULL, NOW() - INTERVAL '3 hours'),
  ('a0000000-0000-4000-8000-000000000003', 'sms',   'failed',    '{"error": "invalid_destination", "provider": "simulated-sms"}', 3, NULL, NOW() - INTERVAL '3 hours'),
  ('a0000000-0000-4000-8000-000000000004', 'email', 'delivered', '{"provider": "simulated-email", "latency_ms": 1180, "note": "succeeded on attempt 3"}', 3, NULL, NOW() - INTERVAL '8 hours 41 minutes'),
  ('a0000000-0000-4000-8000-000000000005', 'sms',   'failed',    '{"error": "provider_timeout", "dead_lettered": true}', 3, NULL, NOW() - INTERVAL '4 hours'),
  ('a0000000-0000-4000-8000-000000000006', 'push',  'pending',   '{}', 1, NOW() + INTERVAL '30 seconds', NOW() - INTERVAL '2 minutes'),
  ('a0000000-0000-4000-8000-000000000009', 'sms',   'delivered', '{"provider": "simulated-sms", "latency_ms": 640}', 1, NULL, NOW() - INTERVAL '1 day'),
  ('a0000000-0000-4000-8000-00000000000a', 'push',  'failed',    '{"error": "unregistered_token", "dead_lettered": true}', 3, NULL, NOW() - INTERVAL '6 hours')
ON CONFLICT (notification_id, channel) DO NOTHING;
