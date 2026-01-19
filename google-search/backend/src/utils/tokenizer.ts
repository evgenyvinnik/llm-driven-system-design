import natural from 'natural';

const { PorterStemmer, WordTokenizer, stopwords } = natural;

const tokenizer = new WordTokenizer();

// English stopwords set
const stopwordsSet = new Set(stopwords);

// Additional common stopwords
const additionalStopwords = new Set([
  'http', 'https', 'www', 'com', 'org', 'net', 'html', 'htm', 'php', 'asp',
  'also', 'however', 'would', 'could', 'should', 'shall', 'may', 'might',
]);

const allStopwords = new Set([...stopwordsSet, ...additionalStopwords]);

/**
 * Tokenize text into words
 */
export const tokenize = (text: string): string[] => {
  if (!text) return [];
  return tokenizer.tokenize(text.toLowerCase()) || [];
};

/**
 * Remove stopwords from tokens
 */
export const removeStopwords = (tokens: string[]): string[] => {
  return tokens.filter((token) => !allStopwords.has(token) && token.length > 1);
};

/**
 * Stem a word using Porter Stemmer
 */
export const stem = (word: string): string => {
  return PorterStemmer.stem(word);
};

/**
 * Full text processing: tokenize, remove stopwords, stem
 */
export const processText = (text: string): string[] => {
  const tokens = tokenize(text);
  const filtered = removeStopwords(tokens);
  return filtered.map(stem);
};

/**
 * Calculate term frequency
 */
export const calculateTF = (terms: string[]): Map<string, number> => {
  const tf = new Map<string, number>();
  for (const term of terms) {
    tf.set(term, (tf.get(term) || 0) + 1);
  }
  return tf;
};

/**
 * Calculate normalized TF (log normalization)
 */
export const calculateNormalizedTF = (termFreq: number): number => {
  if (termFreq === 0) return 0;
  return 1 + Math.log10(termFreq);
};

/**
 * Calculate IDF
 */
export const calculateIDF = (docCount: number, termDocCount: number): number => {
  if (termDocCount === 0) return 0;
  return Math.log10(docCount / termDocCount);
};

/**
 * Calculate TF-IDF score
 */
export const calculateTFIDF = (tf: number, idf: number): number => {
  return tf * idf;
};

/**
 * BM25 scoring parameters
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Calculate BM25 score for a term in a document
 */
export const calculateBM25 = (
  termFreq: number,
  docLength: number,
  avgDocLength: number,
  docCount: number,
  termDocCount: number
): number => {
  const idf = Math.log((docCount - termDocCount + 0.5) / (termDocCount + 0.5) + 1);
  const tfNorm = (termFreq * (BM25_K1 + 1)) /
    (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength)));
  return idf * tfNorm;
};

export interface KeywordResult {
  term: string;
  frequency: number;
}

/**
 * Extract keywords from text (top N terms by frequency)
 */
export const extractKeywords = (text: string, topN = 10): KeywordResult[] => {
  const terms = processText(text);
  const tf = calculateTF(terms);

  // Sort by frequency
  const sorted = [...tf.entries()].sort((a, b) => b[1] - a[1]);

  return sorted.slice(0, topN).map(([term, freq]) => ({ term, frequency: freq }));
};
