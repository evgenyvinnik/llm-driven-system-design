# Design DocuSign - Development with Claude

## Project Context

Building an electronic signature platform to understand document workflows, legal compliance, and audit trail integrity.

**Key Learning Goals:**
- Build document processing pipelines
- Design workflow state machines
- Implement tamper-proof audit trails
- Handle multi-party signing flows

---

## Key Challenges to Explore

### 1. Workflow Orchestration

**Challenge**: Complex signing orders with parallel/serial routing

**Approaches:**
- State machine with explicit transitions
- Event-driven with saga pattern
- Workflow engine (temporal.io style)
- Database-backed queue

**Implementation**: Used explicit state machine in `workflowEngine.js` with defined state transitions:
```
draft -> sent -> delivered -> signed -> completed
                           -> declined
       -> voided
```

### 2. Audit Trail Integrity

**Problem**: Proving documents weren't tampered with

**Solutions:**
- Hash chain (blockchain-lite)
- Timestamping authorities
- Digital signatures on logs
- Write-once storage

**Implementation**: Implemented hash chain in `auditService.js`. Each event includes:
- SHA-256 hash of event data
- Reference to previous event's hash
- Chain verification function to detect tampering

### 3. Document Rendering

**Challenge**: Consistent PDF rendering across platforms

**Solutions:**
- Server-side rendering
- PDF.js for client preview
- Pre-rendered page images
- Canvas-based field overlay

**Implementation**: Using react-pdf (PDF.js wrapper) for client-side rendering with CSS overlay for field placement.

---

## Development Phases

### Phase 1: Document Management (Completed)
- [x] PDF upload with pdf-lib validation
- [x] Page rendering with react-pdf
- [x] Field placement UI with click-to-add
- [ ] Template system (not implemented)

### Phase 2: Signing Workflow (In Progress)
- [x] Recipient management with routing order
- [x] Routing logic (serial/parallel signing)
- [x] Email notifications (simulated)
- [x] Signing ceremony with access tokens

### Phase 3: Signature Capture (Completed)
- [x] Draw signature with signature_pad
- [x] Type signature with preview
- [x] Field completion tracking
- [x] Document finalization

### Phase 4: Compliance (Completed)
- [x] Audit trail with hash chain
- [x] Certificate data generation
- [x] Session-based authentication
- [x] MinIO for document storage

---

## Architecture Decisions

### Why State Machine over Event Sourcing?
For a learning project, explicit state machine provides:
- Clear visibility into allowed transitions
- Easier debugging and testing
- Simpler mental model
- Direct mapping to UI states

### Why Hash Chain for Audit?
- Simpler than full blockchain
- Provides tamper-evidence
- Can be verified independently
- Meets legal compliance requirements

### Why MinIO over S3?
- Runs locally without AWS account
- S3-compatible API for production migration
- Separate buckets for documents and signatures

---

## Known Limitations

1. **No real email sending** - Emails are stored in database for inspection
2. **Basic authentication** - No OAuth, MFA, or access codes implemented
3. **No PDF flattening** - Completed documents don't embed signatures into PDF
4. **Single-server** - No distributed locking for concurrent signing
5. **No templates** - Each envelope must be created from scratch

---

## Future Enhancements

- [ ] PDF flattening with pdf-lib to embed signatures
- [ ] Real email integration (SendGrid, SES)
- [ ] SMS verification for high-security envelopes
- [ ] Template system for recurring documents
- [ ] Bulk send capabilities
- [ ] Real-time signing status with WebSockets
- [ ] Mobile-responsive signing experience

---

## Resources

- [DocuSign Developer Center](https://developers.docusign.com/)
- [ESIGN Act](https://www.fdic.gov/resources/supervision-and-examinations/consumer-compliance-examination-manual/documents/10/x-3-1.pdf)
- [eIDAS Regulation](https://digital-strategy.ec.europa.eu/en/policies/eidas-regulation)
- [pdf-lib Documentation](https://pdf-lib.js.org/)
- [react-pdf Documentation](https://react-pdf.org/)
