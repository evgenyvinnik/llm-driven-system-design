/**
 * Demo story: uploads the sample corpus for both orgs through the real API and
 * pipeline, then leaves behind every state worth looking at:
 *
 * - ready documents: org-wide, shared with a group, private;
 * - a failed one (binary bytes in a .txt) with its reason and a Retry button;
 * - a document with a newer version (v2 current, v1 retired);
 * - a duplicate upload detected by content hash;
 * - answered questions with citations, a "not found" for a reader without
 *   access, and a cross-tenant "not found";
 * - a revoke while the index metadata sync is paused: carol's next question
 *   shows the re-check dropping the stale index rows, and her earlier answer
 *   from that document is redacted;
 * - one deletion fully purged, and one whose purge is stuck retrying because
 *   a simulated blob-store outage is armed (it clears itself after ~40 failed
 *   blob calls, about 7 minutes, or disarm it on the Ops page).
 *
 * Run after `npm run db:migrate && npm run db:seed` with the stack up:
 *   npm run demo:story          (API_URL or PORT selects the API; default :3000)
 * Safe to rerun: uploads dedupe, a repeated new version is "unchanged".
 * @module demo/story
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { API, Client, sleep } from './client.js'

const corpus = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sample-corpus')
const acme = (f: string) => join(corpus, 'acme', f)
const globex = (f: string) => join(corpus, 'globex', f)

interface Doc {
  id: string
  title: string
  status: string
  currentVersionNo: number | null
  latestVersionNo: number
  latestVersionStatus: string | null
  failureReason: string | null
}

function log(msg: string): void {
  console.log(`[demo] ${msg}`)
}

async function uploadDoc(c: Client, file: string, opts: { filename?: string } = {}): Promise<Doc> {
  const r = await c.upload<{ document: Doc; duplicate: boolean }>(file, opts)
  if (r.status >= 400) throw new Error(`upload ${file} → ${r.status} ${JSON.stringify(r.body)}`)
  log(`${c.username} uploaded ${opts.filename ?? file.split('/').pop()} → ${r.body.document.title}${r.body.duplicate ? ' (duplicate: existing document returned)' : ''}`)
  return r.body.document
}

async function share(c: Client, doc: Doc, scope: 'private' | 'group' | 'org', groupId?: string): Promise<void> {
  const r = await c.call('PATCH', `/documents/${doc.id}/sharing`, { scope, groupId: groupId ?? null })
  if (r.status !== 200) throw new Error(`share ${doc.title} → ${r.status}`)
  log(`${c.username} shared "${doc.title}" as ${scope}${groupId ? ` (${groupId})` : ''}`)
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function documentsOf(c: Client): Promise<Doc[]> {
  return (await c.call<{ documents: Doc[] }>('GET', '/documents')).body.documents
}

async function settled(c: Client, ids: string[]): Promise<void> {
  await waitFor(`${ids.length} documents to finish processing`, async () => {
    const docs = await documentsOf(c)
    return ids.every((id) => {
      const d = docs.find((x) => x.id === id)
      return d && (d.status === 'ready' || d.status === 'failed') && d.latestVersionStatus !== 'processing' && d.latestVersionStatus !== 'uploaded'
    })
  })
}

async function ask(c: Client, question: string): Promise<string> {
  const r = await c.call<{ run: { id: string } }>('POST', '/answers', { question })
  const run = await waitFor(`answer to "${question}"`, async () => {
    const g = await c.call<{ run: { status: string; outputText: string; citations: unknown[] } }>('GET', `/answers/${r.body.run.id}`)
    return ['completed', 'failed', 'cancelled'].includes(g.body.run.status) ? g.body.run : null
  })
  log(`${c.username} asked "${question}" → ${run.status}: ${run.outputText.slice(0, 110)}${run.outputText.length > 110 ? '…' : ''} (${run.citations.length} citations)`)
  return run.outputText
}

async function main(): Promise<void> {
  log(`API ${API}`)
  const alice = await new Client('alice').login()
  const carol = await new Client('carol').login()
  const bob = await new Client('bob').login()
  const admin = await new Client('admin').login()

  // Make sure no fault is armed from an earlier run before uploading.
  await admin.call('PUT', '/ops/chaos', { name: 'blob_outage', value: 0 })

  const expense = await uploadDoc(alice, acme('expense-policy.md'))
  const vacation = await uploadDoc(alice, acme('vacation-policy.md'))
  const runbook = await uploadDoc(alice, acme('incident-runbook.md'))
  const backup = await uploadDoc(alice, acme('backup-retention-v1.txt'), { filename: 'backup-retention.txt' })
  const budget = await uploadDoc(alice, acme('q3-budget.html'))
  const notes = await uploadDoc(alice, acme('alice-notes.txt'))
  const wifi = await uploadDoc(alice, acme('office-wifi.txt'))
  const rates = await uploadDoc(alice, acme('contractor-rates.md'))
  const scanned = await uploadDoc(alice, acme('scanned-report.txt'))
  const onboarding = await uploadDoc(carol, acme('carol-onboarding.md'))
  const security = await uploadDoc(bob, globex('security-policy.md'))
  const pricing = await uploadDoc(bob, globex('pricing.html'))

  await share(alice, expense, 'org')
  await share(alice, vacation, 'org')
  await share(alice, runbook, 'group', 'grp_acme_eng')
  await share(alice, backup, 'group', 'grp_acme_eng')
  await share(alice, budget, 'group', 'grp_acme_finance')
  await share(alice, wifi, 'org')
  await share(alice, rates, 'org')
  await share(bob, security, 'org')
  await share(bob, pricing, 'group', 'grp_globex_ops')

  await settled(alice, [expense, vacation, runbook, backup, budget, notes, wifi, rates, scanned].map((d) => d.id))
  await settled(carol, [onboarding.id])
  await settled(bob, [security.id, pricing.id])
  const failed = (await documentsOf(alice)).find((d) => d.id === scanned.id)
  log(`failed document "${failed?.title}": ${failed?.failureReason}`)

  // A newer version: processed fully, then switched; v1 is retired a few seconds later.
  const v2 = await alice.upload<{ unchanged: boolean }>(acme('backup-retention-v2.txt'), { documentId: backup.id, filename: 'backup-retention.txt' })
  log(`alice uploaded a new version of "${backup.title}" → ${v2.status}${v2.body.unchanged ? ' (unchanged)' : ''}`)
  await waitFor('backup retention v2 to become current', async () => (await documentsOf(alice)).find((d) => d.id === backup.id && d.currentVersionNo === 2))

  // Duplicate detection: carol re-uploads bytes she can already read → the existing document comes back.
  await uploadDoc(carol, acme('expense-policy.md'), { filename: 'expense-policy-copy.md' })

  await sleep(4000) // let the lazy index-metadata sync land so the index matches the truth again
  await ask(alice, 'How long do I have to submit expense receipts?')
  await ask(alice, 'What is the backup retention period?')
  await ask(alice, 'What is the Q3 marketing budget?')
  await ask(carol, 'What happens if the primary on-call engineer does not acknowledge a page?')
  await ask(carol, 'What is the Q3 marketing budget?')
  await ask(bob, 'How long do I have to submit expense claims?')
  await ask(bob, 'How long must passwords be?')

  // A revoke the index hasn't caught up with: the re-check drops the stale rows on carol's very next question,
  // and her earlier answer from that document is redacted in her history.
  await admin.call('PUT', '/ops/chaos', { name: 'acl_sync_paused', value: 1 })
  await share(alice, runbook, 'private')
  await ask(carol, 'Who gets paged if the primary on-call engineer does not acknowledge within 5 minutes?')
  await admin.call('PUT', '/ops/chaos', { name: 'acl_sync_paused', value: 0 })
  log('carol\'s question after the unshare: the runbook\'s index rows still said "Engineering", and the re-check dropped them')

  // Deletion, fully purged.
  await alice.call('DELETE', `/documents/${wifi.id}`)
  log(`alice deleted "${wifi.title}" (tombstone first; purge follows)`)
  await waitFor('purge of the Wi-Fi document', async () => {
    const del = (await alice.call<{ documents: { id: string; purgeCompletedAt: string | null }[] }>('GET', '/documents/deleted')).body.documents
    return del.find((d) => d.id === wifi.id && d.purgeCompletedAt)
  })
  log('purge complete: cache, index, embeddings, chunks and blobs removed')

  // Deletion during a simulated blob-store outage: purge does 4/5 and keeps retrying the blobs.
  await admin.call('PUT', '/ops/chaos', { name: 'blob_outage', value: 40 })
  await alice.call('DELETE', `/documents/${rates.id}`)
  log(`alice deleted "${rates.title}" while the blob store is "down"`)
  await waitFor('purge to reach 4/5', async () => {
    const del = (await alice.call<{ documents: { id: string; purge: { done: number; lastError: string | null } | null }[] }>('GET', '/documents/deleted')).body.documents
    const d = del.find((x) => x.id === rates.id)
    return d?.purge && d.purge.done === 4 && d.purge.lastError ? d : null
  })
  log('purge at 4/5, retrying blobs with backoff (simulated MinIO outage clears after ~40 blob calls, or disarm it on the Ops page)')
  log('done')
}

main().catch((err) => {
  console.error('[demo] failed:', err)
  process.exit(1)
})
