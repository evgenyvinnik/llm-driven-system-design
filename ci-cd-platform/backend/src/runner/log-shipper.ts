/**
 * Masks a job's output and ships it as numbered chunks. Masking here means a value
 * doesn't leave the machine in the clear; the API masks again, because it can't assume
 * every runner did. Numbers are assigned once, so a retried chunk is the same chunk and
 * the server can recognize it.
 * @module runner/log-shipper
 */
import { logger } from '../shared/logger.js'
import { StreamMasker } from '../secrets/masking.js'
import { LeaseLostError, type RunnerClient } from './client.js'
import type { ClaimedJob } from '../scheduling/claim.js'

const FLUSH_MS = 200
const FLUSH_BYTES = 32 * 1024
const MAX_BATCH = 20

export class LogShipper {
  private readonly masker: StreamMasker
  private pendingLines: string[] = []
  private pendingBytes = 0
  private pendingStep = 0
  private seq = 0
  private queue: { seq: number; stepIndex: number; text: string }[] = []
  private timer: NodeJS.Timeout | null = null
  private sending: Promise<void> | null = null
  private lost = false

  constructor(
    private readonly client: RunnerClient,
    private readonly job: ClaimedJob,
    private readonly onLost: () => void,
  ) {
    this.masker = new StreamMasker(Object.values(job.secrets))
    this.timer = setInterval(() => void this.tick(), FLUSH_MS)
    this.timer.unref()
  }

  /** Output from a step: buffered until its line is complete, then masked. */
  write(stepIndex: number, text: string): void {
    this.addLines(stepIndex, this.masker.feed(text))
  }

  /** A line from the runner itself. Ends whatever partial line the step left. */
  note(stepIndex: number, text: string): void {
    this.addLines(stepIndex, [...this.masker.flush(), text])
  }

  endStep(stepIndex: number): void {
    this.addLines(stepIndex, this.masker.flush())
  }

  private addLines(stepIndex: number, lines: string[]): void {
    if (lines.length === 0) return
    if (stepIndex !== this.pendingStep) this.seal()
    this.pendingStep = stepIndex
    for (const line of lines) {
      this.pendingLines.push(line)
      this.pendingBytes += line.length + 1
      if (this.pendingBytes >= FLUSH_BYTES) this.seal()
    }
  }

  private seal(): void {
    if (this.pendingLines.length === 0) return
    this.queue.push({ seq: ++this.seq, stepIndex: this.pendingStep, text: `${this.pendingLines.join('\n')}\n` })
    this.pendingLines = []
    this.pendingBytes = 0
  }

  private tick(): void {
    this.seal()
    if (!this.sending && this.queue.length > 0 && !this.lost) {
      this.sending = this.sendAll().finally(() => {
        this.sending = null
      })
    }
  }

  private async sendAll(): Promise<void> {
    let delay = 100
    while (this.queue.length > 0 && !this.lost) {
      const batch = this.queue.slice(0, MAX_BATCH)
      try {
        await this.client.uploadLogs(this.job, batch)
        this.queue.splice(0, batch.length)
        delay = 100
      } catch (err) {
        if (err instanceof LeaseLostError) {
          this.lost = true
          this.onLost()
          return
        }
        logger.warn({ err: (err as Error).message, jobId: this.job.jobId }, 'log upload failed; retrying the same chunks')
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 2000)
      }
    }
  }

  /** Everything written so far is on the server, or the lease is gone. Bounded, so a dead API can't hang the job. */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    this.seal()
    while (!this.lost && Date.now() < deadline && (this.queue.length > 0 || this.sending)) {
      this.tick()
      if (this.sending) await Promise.race([this.sending, new Promise((resolve) => setTimeout(resolve, 100))])
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
