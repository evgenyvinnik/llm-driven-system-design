import crypto from 'crypto';

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '4194304', 10); // 4MB default

export { CHUNK_SIZE };

// Calculate SHA-256 hash of data
export function calculateHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Calculate content hash from chunk hashes
export function calculateContentHash(chunkHashes: string[]): string {
  const combined = chunkHashes.join('');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// Split buffer into fixed-size chunks
export function splitIntoChunks(data: Buffer, chunkSize: number = CHUNK_SIZE): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    chunks.push(data.subarray(offset, end));
    offset = end;
  }

  return chunks;
}

// Calculate number of chunks for a file
export function calculateChunkCount(fileSize: number, chunkSize: number = CHUNK_SIZE): number {
  return Math.ceil(fileSize / chunkSize);
}

// Generate random token
export function generateToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
}

// Get MIME type from filename
export function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';

  const mimeTypes: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    rtf: 'application/rtf',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',

    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',

    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',

    // Archives
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',

    // Code
    js: 'application/javascript',
    ts: 'application/typescript',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    xml: 'application/xml',

    // Other
    md: 'text/markdown',
    csv: 'text/csv',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

// Format bytes to human readable
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
