/**
 * Snowflake ID Generator
 *
 * 64-bit ID structure:
 * - 41 bits: Milliseconds since epoch (69 years)
 * - 10 bits: Machine ID (1024 machines)
 * - 12 bits: Sequence number (4096 IDs per millisecond per machine)
 *
 * Benefits:
 * - Time-ordered (can sort by ID)
 * - No coordination needed between machines
 * - 4 million IDs per second per machine
 */

const EPOCH = 1704067200000n; // 2024-01-01 00:00:00 UTC
const MACHINE_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;

const MACHINE_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + MACHINE_ID_BITS;

const MAX_MACHINE_ID = (1n << MACHINE_ID_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export class SnowflakeGenerator {
  private machineId: bigint;
  private sequence: bigint = 0n;
  private lastTimestamp: bigint = -1n;

  constructor(machineId?: number) {
    // Generate machine ID from process ID and random number if not provided
    const id = machineId ?? (process.pid % 1024);
    this.machineId = BigInt(id) & MAX_MACHINE_ID;
  }

  generate(): bigint {
    let timestamp = BigInt(Date.now()) - EPOCH;

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // Wait for next millisecond
        while (timestamp <= this.lastTimestamp) {
          timestamp = BigInt(Date.now()) - EPOCH;
        }
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      (timestamp << TIMESTAMP_SHIFT) |
      (this.machineId << MACHINE_ID_SHIFT) |
      this.sequence;

    return id;
  }

  generateString(): string {
    return this.generate().toString();
  }

  // Extract timestamp from ID
  static extractTimestamp(id: bigint | string): Date {
    const bigId = typeof id === 'string' ? BigInt(id) : id;
    const timestamp = (bigId >> TIMESTAMP_SHIFT) + EPOCH;
    return new Date(Number(timestamp));
  }
}

// Singleton instance
export const snowflake = new SnowflakeGenerator();
