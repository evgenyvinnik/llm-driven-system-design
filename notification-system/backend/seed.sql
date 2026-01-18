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
