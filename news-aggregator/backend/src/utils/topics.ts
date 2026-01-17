/**
 * Topic extraction using keyword-based classification.
 * In production, this would use ML models like BERT for better accuracy.
 */

const TOPIC_KEYWORDS: Record<string, string[]> = {
  technology: [
    'tech', 'software', 'hardware', 'app', 'startup', 'ai', 'artificial intelligence',
    'machine learning', 'programming', 'developer', 'silicon valley', 'google', 'apple',
    'microsoft', 'amazon', 'facebook', 'meta', 'twitter', 'crypto', 'blockchain',
    'cybersecurity', 'data', 'cloud', 'saas', 'api', 'open source', 'computer',
    'smartphone', 'laptop', 'gadget', 'internet', 'digital', 'algorithm', 'nvidia',
    'semiconductor', 'chip', 'processor', 'gpu', 'computing', 'robot', 'automation',
  ],
  politics: [
    'president', 'congress', 'senate', 'election', 'vote', 'democrat', 'republican',
    'government', 'policy', 'legislation', 'bill', 'law', 'political', 'campaign',
    'white house', 'capitol', 'supreme court', 'justice', 'ambassador', 'diplomat',
    'foreign policy', 'immigration', 'taxes', 'budget', 'bipartisan', 'partisan',
  ],
  business: [
    'stock', 'market', 'economy', 'finance', 'investment', 'wall street', 'nasdaq',
    'dow', 'earnings', 'revenue', 'profit', 'loss', 'merger', 'acquisition', 'ipo',
    'startup', 'venture', 'funding', 'ceo', 'executive', 'corporate', 'company',
    'business', 'industry', 'trade', 'commerce', 'banking', 'fed', 'interest rate',
  ],
  sports: [
    'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball',
    'hockey', 'tennis', 'golf', 'olympics', 'championship', 'playoff', 'tournament',
    'game', 'match', 'score', 'win', 'lose', 'team', 'player', 'coach', 'athlete',
    'espn', 'league', 'season', 'draft', 'trade', 'injury', 'stadium',
  ],
  entertainment: [
    'movie', 'film', 'tv', 'television', 'show', 'series', 'actor', 'actress',
    'celebrity', 'hollywood', 'netflix', 'disney', 'streaming', 'music', 'album',
    'concert', 'tour', 'award', 'oscar', 'grammy', 'emmy', 'red carpet', 'premiere',
    'box office', 'theater', 'broadway', 'video game', 'gaming',
  ],
  science: [
    'research', 'study', 'scientist', 'discovery', 'experiment', 'nasa', 'space',
    'planet', 'astronomy', 'physics', 'biology', 'chemistry', 'medicine', 'health',
    'vaccine', 'disease', 'clinical', 'trial', 'gene', 'dna', 'climate', 'environment',
    'nature', 'species', 'evolution', 'laboratory', 'university',
  ],
  world: [
    'international', 'global', 'world', 'country', 'nation', 'foreign', 'overseas',
    'europe', 'asia', 'africa', 'middle east', 'united nations', 'un', 'treaty',
    'war', 'conflict', 'peace', 'crisis', 'refugee', 'humanitarian', 'embassy',
  ],
  health: [
    'health', 'medical', 'hospital', 'doctor', 'patient', 'treatment', 'drug',
    'fda', 'pharmaceutical', 'therapy', 'surgery', 'diagnosis', 'symptom', 'disease',
    'virus', 'pandemic', 'covid', 'vaccine', 'mental health', 'wellness', 'diet',
    'nutrition', 'exercise', 'fitness', 'healthcare', 'insurance', 'medicare',
  ],
};

/**
 * Extract topics from article text
 */
export function extractTopics(title: string, body?: string): string[] {
  const text = `${title} ${body || ''}`.toLowerCase();
  const topicScores: Map<string, number> = new Map();

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      // Count occurrences
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) {
        // Weight title matches more heavily
        const titleMatches = title.toLowerCase().match(regex);
        score += matches.length;
        if (titleMatches) {
          score += titleMatches.length * 2;
        }
      }
    }
    if (score > 0) {
      topicScores.set(topic, score);
    }
  }

  // Return topics sorted by score
  return Array.from(topicScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => topic);
}

/**
 * Simple named entity extraction
 * In production, use NLP libraries like spaCy or Stanford NER
 */
export function extractEntities(text: string): { name: string; type: string }[] {
  const entities: { name: string; type: string }[] = [];

  // Simple pattern for capitalized words (likely proper nouns)
  const words = text.split(/\s+/);
  const seenNames = new Set<string>();

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // Skip common words and short words
    if (word.length < 3) continue;

    // Check for capitalized words (potential entities)
    if (/^[A-Z][a-z]+$/.test(word)) {
      // Check if next word is also capitalized (compound name)
      const next = words[i + 1];
      let entityName = word;

      if (next && /^[A-Z][a-z]+$/.test(next)) {
        entityName = `${word} ${next}`;
        i++;
      }

      // Skip common English words that are often capitalized
      const commonWords = ['The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How', 'If', 'But', 'And', 'Or', 'Not', 'Are', 'Was', 'Were', 'Will', 'Would', 'Could', 'Should', 'May', 'Might', 'Must', 'New', 'More', 'Most', 'Some', 'All', 'Many', 'Much', 'Other', 'First', 'Last'];

      if (!commonWords.includes(word) && !seenNames.has(entityName.toLowerCase())) {
        seenNames.add(entityName.toLowerCase());
        entities.push({
          name: entityName,
          type: 'UNKNOWN', // Would need NER model for proper classification
        });
      }
    }
  }

  return entities.slice(0, 10);
}
