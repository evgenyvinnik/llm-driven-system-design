import crypto from 'crypto';
import { pool, minioClient } from '../db.js';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
const CHUNKS_BUCKET = 'icloud-chunks';

export class ChunkService {
  constructor(chunkSize = CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  /**
   * Store a file by splitting it into content-addressed chunks
   * Returns array of chunk metadata
   */
  async storeFile(fileId, fileBuffer) {
    const chunks = [];
    const totalChunks = Math.ceil(fileBuffer.length / this.chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, fileBuffer.length);
      const chunkData = fileBuffer.slice(start, end);

      // Calculate SHA-256 hash of chunk
      const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');
      const storageKey = `chunks/${chunkHash.slice(0, 2)}/${chunkHash}`;

      // Check if chunk already exists (deduplication)
      const existingChunk = await pool.query(
        'SELECT chunk_hash FROM chunk_store WHERE chunk_hash = $1',
        [chunkHash]
      );

      if (existingChunk.rows.length === 0) {
        // Upload chunk to MinIO
        await minioClient.putObject(
          CHUNKS_BUCKET,
          storageKey,
          chunkData,
          chunkData.length,
          { 'Content-Type': 'application/octet-stream' }
        );

        // Add to chunk store
        await pool.query(
          `INSERT INTO chunk_store (chunk_hash, storage_key, chunk_size)
           VALUES ($1, $2, $3)`,
          [chunkHash, storageKey, chunkData.length]
        );
      } else {
        // Increment reference count for existing chunk
        await pool.query(
          'UPDATE chunk_store SET reference_count = reference_count + 1 WHERE chunk_hash = $1',
          [chunkHash]
        );
      }

      // Link chunk to file
      await pool.query(
        `INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_size, storage_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [fileId, i, chunkHash, chunkData.length, storageKey]
      );

      chunks.push({
        chunkIndex: i,
        chunkHash,
        chunkSize: chunkData.length,
        storageKey,
      });
    }

    return chunks;
  }

  /**
   * Assemble a file from its chunks
   */
  async assembleFile(chunks) {
    const buffers = [];

    for (const chunk of chunks) {
      const dataStream = await minioClient.getObject(CHUNKS_BUCKET, chunk.storage_key);

      // Collect stream data
      const chunkBuffers = [];
      for await (const data of dataStream) {
        chunkBuffers.push(data);
      }

      const chunkBuffer = Buffer.concat(chunkBuffers);

      // Verify chunk integrity
      const actualHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
      if (actualHash !== chunk.chunk_hash) {
        throw new Error(`Chunk integrity check failed for ${chunk.chunk_hash}`);
      }

      buffers.push(chunkBuffer);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Get chunks that differ between local and server versions
   * Used for delta sync
   */
  async getDeltaChunks(fileId, localChunkHashes) {
    const serverChunks = await pool.query(
      `SELECT chunk_index, chunk_hash, chunk_size, storage_key
       FROM file_chunks
       WHERE file_id = $1
       ORDER BY chunk_index`,
      [fileId]
    );

    const localHashSet = new Set(localChunkHashes);
    const missingChunks = [];
    const existingChunks = [];

    for (const chunk of serverChunks.rows) {
      if (localHashSet.has(chunk.chunk_hash)) {
        existingChunks.push({
          chunkIndex: chunk.chunk_index,
          chunkHash: chunk.chunk_hash,
        });
      } else {
        missingChunks.push({
          chunkIndex: chunk.chunk_index,
          chunkHash: chunk.chunk_hash,
          chunkSize: chunk.chunk_size,
          storageKey: chunk.storage_key,
        });
      }
    }

    return { missingChunks, existingChunks };
  }

  /**
   * Download a specific chunk
   */
  async downloadChunk(chunkHash) {
    const chunkInfo = await pool.query(
      'SELECT storage_key FROM chunk_store WHERE chunk_hash = $1',
      [chunkHash]
    );

    if (chunkInfo.rows.length === 0) {
      throw new Error(`Chunk not found: ${chunkHash}`);
    }

    const dataStream = await minioClient.getObject(
      CHUNKS_BUCKET,
      chunkInfo.rows[0].storage_key
    );

    const buffers = [];
    for await (const data of dataStream) {
      buffers.push(data);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Delete chunks that are no longer referenced
   */
  async cleanupOrphanedChunks() {
    // Find chunks with zero references
    const orphanedChunks = await pool.query(
      'SELECT chunk_hash, storage_key FROM chunk_store WHERE reference_count <= 0'
    );

    for (const chunk of orphanedChunks.rows) {
      try {
        await minioClient.removeObject(CHUNKS_BUCKET, chunk.storage_key);
        await pool.query('DELETE FROM chunk_store WHERE chunk_hash = $1', [chunk.chunk_hash]);
      } catch (error) {
        console.error(`Failed to cleanup chunk ${chunk.chunk_hash}:`, error);
      }
    }

    return orphanedChunks.rows.length;
  }
}
