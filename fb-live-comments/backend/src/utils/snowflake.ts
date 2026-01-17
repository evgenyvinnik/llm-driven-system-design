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

/** Custom epoch: 2024-01-01 00:00:00 UTC - IDs are valid for ~69 years from this date */
const EPOCH = 1704067200000n; // 2024-01-01 00:00:00 UTC

/** Number of bits allocated for machine/instance ID */
const MACHINE_ID_BITS = 10n;

/** Number of bits allocated for sequence number within a millisecond */
const SEQUENCE_BITS = 12n;

const MACHINE_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + MACHINE_ID_BITS;

const MAX_MACHINE_ID = (1n << MACHINE_ID_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

/**
 * Snowflake ID Generator Class
 *
 * Generates unique, time-ordered 64-bit IDs without coordination between instances.
 * Used for comment IDs to ensure chronological ordering and distributed generation.
 */
export class SnowflakeGenerator {
  /** Machine/instance identifier (0-1023) */
  private machineId: bigint;

  /** Sequence counter for IDs generated within the same millisecond */
  private sequence: bigint = 0n;

  /** Timestamp of the last ID generation */
  private lastTimestamp: bigint = -1n;

  /**
   * Creates a new Snowflake generator instance.
   *
   * @param machineId - Optional machine ID (0-1023). Defaults to process.pid % 1024.
   */
  constructor(machineId?: number) {
    // Generate machine ID from process ID and random number if not provided
    const id = machineId ?? (process.pid % 1024);
    this.machineId = BigInt(id) & MAX_MACHINE_ID;
  }

  /**
   * Generates a unique Snowflake ID.
   * If multiple IDs are generated in the same millisecond, uses sequence number.
   * Blocks briefly if sequence overflows within a millisecond.
   *
   * @returns A unique 64-bit ID as bigint
   */
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

  /**
   * Generates a unique Snowflake ID as a string.
   * Useful for database storage and JSON serialization.
   *
   * @returns A unique ID as a decimal string
   */
  generateString(): string {
    return this.generate().toString();
  }

  /**
   * Extracts the creation timestamp from a Snowflake ID.
   * Useful for determining when a comment was created from its ID alone.
   *
   * @param id - Snowflake ID as bigint or string
   * @returns Date object representing when the ID was generated
   */
  static extractTimestamp(id: bigint | string): Date {
    const bigId = typeof id === 'string' ? BigInt(id) : id;
    const timestamp = (bigId >> TIMESTAMP_SHIFT) + EPOCH;
    return new Date(Number(timestamp));
  }
}

/**
 * Singleton Snowflake generator instance for the current process.
 * Use this for all ID generation to ensure uniqueness across the application.
 */
export const snowflake = new SnowflakeGenerator();
