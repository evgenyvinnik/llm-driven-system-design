/**
 * SimHash implementation for near-duplicate detection.
 *
 * SimHash creates a fingerprint that's similar for similar documents.
 * Articles with Hamming distance < 3 are considered duplicates.
 */

// Simple 64-bit hash function using FNV-1a
function hash64(str: string): bigint {
  let hash = 14695981039346656037n;
  const fnvPrime = 1099511628211n;

  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * fnvPrime) & 0xFFFFFFFFFFFFFFFFn;
  }

  return hash;
}

// Tokenize text into words
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
}

// Generate n-grams from tokens
function getNgrams(tokens: string[], n: number = 3): string[] {
  const ngrams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/**
 * Compute SimHash fingerprint for text content
 */
export function computeSimHash(text: string): bigint {
  const tokens = tokenize(text);

  // Use both unigrams and trigrams for better accuracy
  const features = [...tokens, ...getNgrams(tokens, 3)];

  if (features.length === 0) {
    return 0n;
  }

  const hashes = features.map(t => hash64(t));

  // Create weighted bit vector
  const vector = new Array(64).fill(0);

  for (const h of hashes) {
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) {
        vector[i]++;
      } else {
        vector[i]--;
      }
    }
  }

  // Convert to fingerprint
  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (vector[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

/**
 * Calculate Hamming distance between two fingerprints
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Check if two fingerprints are similar (Hamming distance < threshold)
 */
export function areSimilar(fp1: bigint, fp2: bigint, threshold: number = 3): boolean {
  return hammingDistance(fp1, fp2) < threshold;
}

/**
 * Find similar fingerprints from a list
 */
export function findSimilar(
  target: bigint,
  candidates: { id: string; fingerprint: bigint }[],
  threshold: number = 3
): { id: string; distance: number }[] {
  return candidates
    .map(c => ({
      id: c.id,
      distance: hammingDistance(target, c.fingerprint),
    }))
    .filter(c => c.distance < threshold)
    .sort((a, b) => a.distance - b.distance);
}
