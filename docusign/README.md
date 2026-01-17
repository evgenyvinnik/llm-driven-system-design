# Design DocuSign - Electronic Signature Platform

## Overview

A simplified DocuSign-like platform demonstrating document workflows, electronic signatures, and secure audit trails. This educational project focuses on building a legally compliant signature system with multi-party signing flows.

## Key Features

### 1. Document Management
- PDF upload and processing
- Template creation
- Field placement (signature, initial, date, text, checkbox)
- Version control

### 2. Signing Workflow
- Multi-party routing
- Signing order (serial/parallel)
- Role-based access
- Email notifications (simulated)

### 3. Electronic Signatures
- Draw signature on canvas
- Type signature with custom font
- Field completion tracking

### 4. Authentication
- Session-based auth with Redis
- Email verification for signers

### 5. Audit Trail
- Tamper-proof hash chain
- Complete event logging
- IP addresses and timestamps
- Certificate of completion

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- pnpm, npm, or yarn

### 1. Start Infrastructure

```bash
cd docusign
docker-compose up -d
```

This starts:
- PostgreSQL (port 5432)
- Redis (port 6379)
- MinIO (ports 9000, 9001)

Wait for services to be healthy:
```bash
docker-compose ps
```

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on http://localhost:3001

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

### 4. Access the Application

Open http://localhost:5173 in your browser.

**Test Accounts:**
- Admin: `admin@docusign.local` (any password)
- User: `alice@example.com` (any password)
- User: `bob@example.com` (any password)

## Running Without Docker

If you prefer to run services natively:

### PostgreSQL

```bash
# macOS with Homebrew
brew install postgresql@16
brew services start postgresql@16
createdb docusign
psql docusign < backend/db/init.sql
```

Set environment variables:
```bash
export POSTGRES_HOST=localhost
export POSTGRES_USER=your_username
export POSTGRES_PASSWORD=your_password
```

### Redis

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

### MinIO

```bash
# macOS with Homebrew
brew install minio/stable/minio
minio server ~/minio-data --console-address ":9001"
```

Create buckets:
```bash
mc alias set local http://localhost:9000 minioadmin minioadmin123
mc mb local/docusign-documents
mc mb local/docusign-signatures
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Envelopes
- `GET /api/v1/envelopes` - List envelopes
- `POST /api/v1/envelopes` - Create envelope
- `GET /api/v1/envelopes/:id` - Get envelope details
- `POST /api/v1/envelopes/:id/send` - Send for signing
- `POST /api/v1/envelopes/:id/void` - Void envelope

### Documents
- `POST /api/v1/documents/upload/:envelopeId` - Upload PDF
- `GET /api/v1/documents/:id/view` - View document

### Recipients
- `POST /api/v1/recipients/:envelopeId` - Add recipient
- `GET /api/v1/recipients/envelope/:envelopeId` - List recipients

### Fields
- `POST /api/v1/fields/:documentId` - Add field
- `GET /api/v1/fields/document/:documentId` - List fields

### Signing (Public)
- `GET /api/v1/signing/session/:accessToken` - Get signing session
- `POST /api/v1/signing/sign/:accessToken` - Capture signature
- `POST /api/v1/signing/finish/:accessToken` - Complete signing
- `POST /api/v1/signing/decline/:accessToken` - Decline to sign

### Audit
- `GET /api/v1/audit/envelope/:envelopeId` - Get audit events
- `GET /api/v1/audit/verify/:envelopeId` - Verify chain integrity
- `GET /api/v1/audit/certificate/:envelopeId` - Get certificate

### Admin
- `GET /api/v1/admin/stats` - System statistics
- `GET /api/v1/admin/users` - List all users
- `GET /api/v1/admin/envelopes` - List all envelopes
- `GET /api/v1/admin/emails` - View simulated emails

## Architecture

```
docusign/
├── docker-compose.yml     # PostgreSQL, Redis, MinIO
├── backend/
│   ├── src/
│   │   ├── index.js           # Express server
│   │   ├── routes/            # API endpoints
│   │   │   ├── auth.js
│   │   │   ├── envelopes.js
│   │   │   ├── documents.js
│   │   │   ├── recipients.js
│   │   │   ├── fields.js
│   │   │   ├── signing.js
│   │   │   ├── audit.js
│   │   │   └── admin.js
│   │   ├── services/          # Business logic
│   │   │   ├── auditService.js
│   │   │   ├── workflowEngine.js
│   │   │   └── emailService.js
│   │   ├── middleware/
│   │   │   └── auth.js
│   │   └── utils/
│   │       ├── db.js          # PostgreSQL
│   │       ├── redis.js       # Session storage
│   │       └── minio.js       # Document storage
│   └── db/
│       └── init.sql           # Database schema
└── frontend/
    └── src/
        ├── routes/            # TanStack Router pages
        ├── stores/            # Zustand state
        ├── services/          # API client
        └── types/             # TypeScript types
```

## Workflow

1. **Create Envelope** - Name your signing package
2. **Upload Document** - Add PDF documents
3. **Add Recipients** - Specify who needs to sign and in what order
4. **Place Fields** - Click on the document to add signature fields
5. **Send** - Recipients receive email with signing link
6. **Sign** - Recipients open link, view document, and sign
7. **Complete** - All signatures collected, audit trail verified

## Development

### Running Multiple Backend Instances

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

### Environment Variables

Backend (`backend/.env`):
```env
PORT=3001
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=docusign
POSTGRES_USER=docusign
POSTGRES_PASSWORD=docusign_dev
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
FRONTEND_URL=http://localhost:5173
```

## Key Technical Challenges

1. **Document Processing**: Parse and render PDFs, place interactive fields
2. **Workflow Engine**: Complex routing with conditions and parallel signing
3. **Legal Compliance**: Meet e-signature laws (ESIGN, eIDAS, UETA)
4. **Audit Integrity**: Tamper-proof logging with cryptographic verification
5. **Real-Time Collaboration**: Multiple signers viewing same document

## Architecture Details

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
