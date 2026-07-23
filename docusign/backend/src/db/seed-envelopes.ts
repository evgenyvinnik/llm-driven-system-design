/**
 * Seeds demonstrable envelopes so the dashboard, envelope list, and — most
 * importantly — the signing ceremony show real content instead of an empty
 * state. A plain SQL seed can't do this: a signable envelope needs a real PDF
 * living in MinIO (the signing page streams it by s3_key) plus recipients that
 * carry access tokens and signature fields at page coordinates. So this seeder
 * generates the PDFs with pdf-lib, uploads them, and writes the full envelope
 * graph the way the app itself would. Also seeds the demo user accounts, so this
 * is the single seeder the harness runs (`npm run db:seed`).
 *
 * Run with: npm run db:seed
 */
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pool } from '../utils/db.js';
import { uploadDocument, initializeMinio } from '../utils/minio.js';
import { auditService } from '../services/auditService.js';

/** Demo accounts. All share the repo-standard password `password123`. */
const USERS = [
  { email: 'admin@docusign.local', name: 'Admin User', role: 'admin' },
  { email: 'alice@example.com', name: 'Alice Johnson', role: 'user' },
  { email: 'bob@example.com', name: 'Bob Smith', role: 'user' },
  { email: 'carol@example.com', name: 'Carol Williams', role: 'user' },
];

async function seedUsers(): Promise<void> {
  const hash = await bcrypt.hash('password123', 10);
  for (const u of USERS) {
    await pool.query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, u.name, hash, u.role]
    );
  }
  console.log(`  ${USERS.length} users`);
}

/** Builds a simple, realistic-looking one-page agreement PDF. */
async function buildAgreementPdf(title: string, bodyLines: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawText(title, { x: 72, y: 720, size: 20, font: bold, color: rgb(0.1, 0.1, 0.2) });
  page.drawLine({ start: { x: 72, y: 710 }, end: { x: 540, y: 710 }, thickness: 1, color: rgb(0.8, 0.8, 0.85) });

  let y = 680;
  for (const line of bodyLines) {
    page.drawText(line, { x: 72, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
    y -= 22;
  }

  // Signature block labels (the actual fields overlay near here at signing time).
  page.drawText('Signature:', { x: 72, y: 180, size: 11, font: bold });
  page.drawLine({ start: { x: 150, y: 176 }, end: { x: 380, y: 176 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });
  page.drawText('Date:', { x: 72, y: 140, size: 11, font: bold });
  page.drawLine({ start: { x: 150, y: 136 }, end: { x: 300, y: 136 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

interface EnvelopeSpec {
  id: string;
  name: string;
  status: string;
  message: string;
  docTitle: string;
  docBody: string[];
  recipients: Array<{
    id: string;
    name: string;
    email: string;
    routingOrder: number;
    status: string;
    accessToken: string;
  }>;
  completedAt?: boolean;
}

const ADMIN_EMAIL = 'admin@docusign.local';

const ENVELOPES: EnvelopeSpec[] = [
  {
    id: 'e1111111-1111-4111-8111-111111111111',
    name: 'Mutual NDA — Acme Corp',
    status: 'sent',
    message: 'Please review and sign the mutual non-disclosure agreement.',
    docTitle: 'Mutual Non-Disclosure Agreement',
    docBody: [
      'This Mutual Non-Disclosure Agreement ("Agreement") is entered into',
      'between Acme Corp and the undersigned party as of the date signed.',
      '',
      '1. Confidential Information. Each party may disclose confidential',
      '   business, technical, and financial information to the other.',
      '2. Obligations. The receiving party shall protect such information',
      '   with the same degree of care it uses for its own confidential data.',
      '3. Term. The obligations herein survive for three (3) years from the',
      '   date of disclosure.',
      '',
      'By signing below, the parties agree to the terms above.',
    ],
    recipients: [
      {
        id: 'a1111111-1111-4111-8111-111111111111',
        name: 'Alice Johnson',
        email: 'alice@example.com',
        routingOrder: 1,
        status: 'sent',
        accessToken: 'sign-nda-alice-0000000000000001',
      },
    ],
  },
  {
    id: 'e2222222-2222-4222-8222-222222222222',
    name: 'Consulting Services Agreement',
    status: 'delivered',
    message: 'Countersignature needed on the Q3 consulting agreement.',
    docTitle: 'Consulting Services Agreement',
    docBody: [
      'This Consulting Services Agreement is made between the Company and',
      'the Consultant for professional services rendered in Q3 2026.',
      '',
      '1. Scope. Consultant will provide advisory services as described in',
      '   Exhibit A, attached and incorporated by reference.',
      '2. Compensation. Company shall pay Consultant the fees set forth in',
      '   Exhibit B, net thirty (30) days from invoice.',
      '3. Independent Contractor. Consultant is an independent contractor',
      '   and not an employee of the Company.',
      '',
      'Signed by the authorized representatives below.',
    ],
    recipients: [
      {
        id: 'a2222222-2222-4222-8222-222222222222',
        name: 'Bob Smith',
        email: 'bob@example.com',
        routingOrder: 1,
        status: 'delivered',
        accessToken: 'sign-consulting-bob-000000000002',
      },
    ],
  },
  {
    id: 'e3333333-3333-4333-8333-333333333333',
    name: 'Employee Offer Letter — Carol Williams',
    status: 'completed',
    message: 'Welcome aboard! Your signed offer letter.',
    docTitle: 'Offer of Employment',
    docBody: [
      'Dear Carol Williams,',
      '',
      'We are pleased to offer you the position of Senior Engineer at the',
      'Company, reporting to the VP of Engineering. Your start date will be',
      'the first business day of next month.',
      '',
      '1. Compensation. Your annual base salary will be as discussed.',
      '2. Benefits. You will be eligible for the standard benefits package.',
      '3. At-Will Employment. Your employment is at-will.',
      '',
      'We look forward to working with you.',
    ],
    completedAt: true,
    recipients: [
      {
        id: 'a3333333-3333-4333-8333-333333333333',
        name: 'Carol Williams',
        email: 'carol@example.com',
        routingOrder: 1,
        status: 'completed',
        accessToken: 'sign-offer-carol-0000000000003',
      },
    ],
  },
  {
    id: 'e4444444-4444-4444-8444-444444444444',
    name: 'SaaS Order Form — Draft',
    status: 'draft',
    message: '',
    docTitle: 'SaaS Order Form',
    docBody: [
      'Order Form for the Company subscription services.',
      '',
      'Plan: Enterprise (annual)',
      'Seats: 250',
      'Term: 12 months, auto-renewing',
      '',
      'This order form is subject to the Master Subscription Agreement.',
    ],
    recipients: [
      {
        id: 'a4444444-4444-4444-8444-444444444444',
        name: 'Alice Johnson',
        email: 'alice@example.com',
        routingOrder: 1,
        status: 'created',
        accessToken: 'sign-order-alice-0000000000004',
      },
    ],
  },
];

async function seed(): Promise<void> {
  console.log('Seeding users, envelopes, documents, recipients, and fields...');
  await seedUsers();
  await initializeMinio();

  const { rows: adminRows } = await pool.query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
  if (adminRows.length === 0) {
    throw new Error(`Admin user ${ADMIN_EMAIL} not found after user seed.`);
  }
  const senderId = adminRows[0].id;

  for (const env of ENVELOPES) {
    // Skip if already seeded (idempotent re-runs).
    const existing = await pool.query('SELECT 1 FROM envelopes WHERE id = $1', [env.id]);
    if (existing.rowCount) {
      console.log(`  envelope ${env.name} already present, skipping`);
      continue;
    }

    await pool.query(
      `INSERT INTO envelopes (id, sender_id, name, status, authentication_level, message, completed_at)
       VALUES ($1, $2, $3, $4, 'email', $5, $6)`,
      [env.id, senderId, env.name, env.status, env.message || null, env.completedAt ? new Date() : null]
    );

    // Document → MinIO + row.
    const pdf = await buildAgreementPdf(env.docTitle, env.docBody);
    const documentId = randomUUID();
    const s3Key = `${env.id}/${documentId}.pdf`;
    await uploadDocument(s3Key, pdf, 'application/pdf');
    await pool.query(
      `INSERT INTO documents (id, envelope_id, name, page_count, s3_key, status, file_size)
       VALUES ($1, $2, $3, 1, $4, 'uploaded', $5)`,
      [documentId, env.id, `${env.docTitle}.pdf`, s3Key, pdf.length]
    );

    for (const r of env.recipients) {
      await pool.query(
        `INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, status, access_token, completed_at)
         VALUES ($1, $2, $3, $4, 'signer', $5, $6, $7, $8)`,
        [r.id, env.id, r.name, r.email, r.routingOrder, r.status, r.accessToken, r.status === 'completed' ? new Date() : null]
      );

      // Signature + date fields positioned over the signature block drawn in the PDF.
      const signatureFieldId = randomUUID();
      const completed = r.status === 'completed';
      await pool.query(
        `INSERT INTO document_fields (id, document_id, recipient_id, type, page_number, x, y, width, height, required, completed, value)
         VALUES ($1, $2, $3, 'signature', 1, 150, 596, 220, 40, true, $4, $5)`,
        [signatureFieldId, documentId, r.id, completed, completed ? r.name : null]
      );
      await pool.query(
        `INSERT INTO document_fields (id, document_id, recipient_id, type, page_number, x, y, width, height, required, completed, value)
         VALUES ($1, $2, $3, 'date', 1, 150, 636, 150, 30, true, $4, $5)`,
        [randomUUID(), documentId, r.id, completed, completed ? new Date().toISOString().slice(0, 10) : null]
      );
    }

    // Audit trail: at minimum a creation + sent event so the hash chain is non-empty.
    await auditService.log(env.id, 'envelope.created', { name: env.name }, ADMIN_EMAIL);
    if (env.status !== 'draft') {
      await auditService.log(env.id, 'envelope.sent', { recipients: env.recipients.length }, ADMIN_EMAIL);
    }
    if (env.completedAt) {
      await auditService.log(env.id, 'envelope.completed', {}, ADMIN_EMAIL);
    }

    console.log(`  seeded "${env.name}" (${env.status}) — token: ${env.recipients[0].accessToken}`);
  }

  console.log('Envelope seeding complete.');
  console.log('Sign a pending envelope at: /sign/sign-nda-alice-0000000000000001');
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Envelope seeding failed:', err);
    pool.end();
    process.exit(1);
  });
