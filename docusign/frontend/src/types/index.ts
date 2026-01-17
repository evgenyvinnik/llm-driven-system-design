export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface Envelope {
  id: string;
  sender_id: string;
  name: string;
  status: EnvelopeStatus;
  authentication_level: 'email' | 'sms' | 'knowledge' | 'id_verification';
  message?: string;
  expiration_date?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  document_count?: number;
  recipient_count?: number;
  completed_count?: number;
  sender_name?: string;
  sender_email?: string;
}

export type EnvelopeStatus =
  | 'draft'
  | 'sent'
  | 'delivered'
  | 'signed'
  | 'completed'
  | 'declined'
  | 'voided';

export interface Document {
  id: string;
  envelope_id: string;
  name: string;
  page_count: number;
  s3_key: string;
  status: 'processing' | 'ready' | 'error';
  file_size: number;
  created_at: string;
}

export interface Recipient {
  id: string;
  envelope_id: string;
  name: string;
  email: string;
  role: 'signer' | 'cc' | 'in_person';
  routing_order: number;
  status: 'pending' | 'sent' | 'delivered' | 'completed' | 'declined';
  access_token?: string;
  phone?: string;
  ip_address?: string;
  completed_at?: string;
  created_at: string;
  field_count?: number;
  completed_field_count?: number;
}

export interface DocumentField {
  id: string;
  document_id: string;
  recipient_id: string;
  type: FieldType;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  completed: boolean;
  value?: string;
  signature_id?: string;
  recipient_name?: string;
  recipient_email?: string;
}

export type FieldType = 'signature' | 'initial' | 'date' | 'text' | 'checkbox';

export interface Signature {
  id: string;
  recipient_id: string;
  field_id: string;
  s3_key: string;
  type: 'draw' | 'typed' | 'upload';
  created_at: string;
}

export interface AuditEvent {
  id: string;
  envelope_id: string;
  event_type: string;
  data: Record<string, unknown>;
  timestamp: string;
  actor: string;
  hash: string;
  details?: string;
}

export interface EmailNotification {
  id: string;
  recipient_id: string;
  envelope_id: string;
  type: string;
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at?: string;
  created_at: string;
  recipient_email?: string;
  recipient_name?: string;
  envelope_name?: string;
}

export interface SigningSession {
  recipient: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
  };
  envelope: {
    id: string;
    name: string;
    message?: string;
    status: string;
  };
  documents: Document[];
  fields: DocumentField[];
  authenticationRequired: boolean;
}

export interface Certificate {
  envelopeId: string;
  envelopeName: string;
  documentName: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  chainVerified: boolean;
  signers: {
    name: string;
    email: string;
    signedAt: string;
    ipAddress?: string;
  }[];
  events: {
    id: string;
    time: string;
    action: string;
    actor: string;
    details: string;
    hash: string;
  }[];
  eventCount: number;
}

export interface AdminStats {
  envelopes: {
    total: string;
    draft: string;
    pending: string;
    completed: string;
    declined: string;
    voided: string;
    last_24h: string;
    last_7d: string;
  };
  users: {
    total: string;
    admins: string;
    new_24h: string;
  };
  signatures: {
    total: string;
    drawn: string;
    typed: string;
    last_24h: string;
  };
  documents: {
    total: string;
    total_size: string;
    avg_pages: string;
  };
}
