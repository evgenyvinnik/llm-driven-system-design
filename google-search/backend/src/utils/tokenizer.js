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
export const tokenize = (text) => {
  if (!text) return [];
  return tokenizer.tokenize(text.toLowerCase()) || [];
};

/**
 * Remove stopwords from tokens
 */
export const removeStopwords = (tokens) => {
  return tokens.filter((token) => !allStopwords.has(token) && token.length > 1);
};

/**
 * Stem a word using Porter Stemmer
 */
export const stem = (word) => {
  return PorterStemmer.stem(word);
};

/**
 * Full text processing: tokenize, remove stopwords, stem
 */
export const processText = (text) => {
  const tokens = tokenize(text);
  const filtered = removeStopwords(tokens);
  return filtered.map(stem);
};

/**
 * Calculate term frequency
 */
export const calculateTF = (terms) => {
  const tf = new Map();
  for (const term of terms) {
    tf.set(term, (tf.get(term) || 0) + 1);
  }
  return tf;
};

/**
 * Calculate normalized TF (log normalization)
 */
export const calculateNormalizedTF = (termFreq) => {
  if (termFreq === 0) return 0;
  return 1 + Math.log10(termFreq);
};

/**
 * Calculate IDF
 */
export const calculateIDF = (docCount, termDocCount) => {
  if (termDocCount === 0) return 0;
  return Math.log10(docCount / termDocCount);
};

/**
 * Calculate TF-IDF score
 */
export const calculateTFIDF = (tf, idf) => {
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
export const calculateBM25 = (termFreq, docLength, avgDocLength, docCount, termDocCount) => {
  const idf = Math.log((docCount - termDocCount + 0.5) / (termDocCount + 0.5) + 1);
  const tfNorm = (termFreq * (BM25_K1 + 1)) /
    (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength)));
  return idf * tfNorm;
};

/**
 * Extract keywords from text (top N terms by frequency)
 */
export const extractKeywords = (text, topN = 10) => {
  const terms = processText(text);
  const tf = calculateTF(terms);

  // Sort by frequency
  const sorted = [...tf.entries()].sort((a, b) => b[1] - a[1]);

  return sorted.slice(0, topN).map(([term, freq]) => ({ term, frequency: freq }));
};
