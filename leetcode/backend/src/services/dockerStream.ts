/**
 * Demultiplexer for Docker's attach stream.
 *
 * With `Tty: false`, Docker interleaves stdout and stderr on one connection as frames:
 * an 8-byte header `[stream, 0, 0, 0, size (uint32 big-endian)]` followed by `size` bytes of
 * payload (stream 1 = stdout, 2 = stderr). Socket chunks do not respect frame boundaries, so
 * the parser keeps partial headers and payloads between calls instead of assuming each chunk
 * starts with a header.
 *
 * It also enforces output caps. A solution that prints in a loop must not be able to exhaust
 * the judge's memory: bytes past the cap are dropped and the caller is told, so it can kill the
 * container and report "output limit exceeded".
 */

export interface OutputLimits {
  stdoutBytes: number;
  stderrBytes: number;
}

type StreamName = 'stdout' | 'stderr';

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  exceeded = false;

  constructor(private readonly limit: number) {}

  append(data: Buffer): void {
    const room = this.limit - this.size;
    if (data.length > room) {
      this.exceeded = true;
      if (room > 0) this.store(data.subarray(0, room));
      return;
    }
    this.store(data);
  }

  private store(data: Buffer): void {
    // Copy: the socket may reuse the underlying memory of the chunk.
    this.chunks.push(Buffer.from(data));
    this.size += data.length;
  }

  toString(): string {
    // Decode once at the end so multi-byte UTF-8 characters split across frames stay intact.
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Incremental parser for Docker's multiplexed stdout/stderr stream. */
export class DockerStreamDemuxer {
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private frameStream: StreamName = 'stdout';
  private frameRemaining = 0;
  private readonly out: Record<StreamName, CappedBuffer>;

  constructor(limits: OutputLimits) {
    this.out = {
      stdout: new CappedBuffer(limits.stdoutBytes),
      stderr: new CappedBuffer(limits.stderrBytes),
    };
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.frameRemaining === 0) {
        const take = Math.min(8 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < 8) return;
        this.frameStream = this.header[0] === 2 ? 'stderr' : 'stdout';
        this.frameRemaining = this.header.readUInt32BE(4);
        this.headerBytes = 0;
        continue;
      }
      const take = Math.min(this.frameRemaining, chunk.length - offset);
      this.out[this.frameStream].append(chunk.subarray(offset, offset + take));
      this.frameRemaining -= take;
      offset += take;
    }
  }

  get stdout(): string {
    return this.out.stdout.toString();
  }

  get stderr(): string {
    return this.out.stderr.toString();
  }

  /** True once the program wrote more to stdout than the cap allows. */
  get stdoutLimitExceeded(): boolean {
    return this.out.stdout.exceeded;
  }
}

/** Builds one multiplexed frame; used by tests and by anything that needs to fake Docker. */
export function encodeDockerFrame(stream: StreamName, payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(8);
  header[0] = stream === 'stderr' ? 2 : 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
