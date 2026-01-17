/**
 * TrieNode represents a single node in the Trie.
 * Each node stores:
 * - children: Map of character to child TrieNode
 * - isEndOfWord: whether this node represents a complete phrase
 * - suggestions: pre-computed top-k suggestions at this prefix
 * - count: frequency count if this is an end node
 */
class TrieNode {
  constructor() {
    this.children = new Map(); // Character -> TrieNode
    this.isEndOfWord = false;
    this.suggestions = []; // Top-k suggestions at this prefix: { phrase, count, lastUpdated }
    this.count = 0;
    this.lastUpdated = Date.now();
  }
}

/**
 * Trie data structure with pre-computed top-k suggestions at each node.
 * This design trades memory for query speed - O(prefix_length) lookups.
 */
export class Trie {
  constructor(topK = 10) {
    this.root = new TrieNode();
    this.topK = topK;
    this.size = 0;
    this.phraseMap = new Map(); // Quick lookup for phrase existence
  }

  /**
   * Insert or update a phrase in the trie with its count.
   * Updates top-k suggestions at each prefix node.
   */
  insert(phrase, count) {
    if (!phrase || phrase.length === 0) return;

    const normalizedPhrase = phrase.toLowerCase().trim();
    let node = this.root;

    // Track if this is a new phrase
    const isNew = !this.phraseMap.has(normalizedPhrase);
    if (isNew) {
      this.size++;
    }
    this.phraseMap.set(normalizedPhrase, count);

    for (const char of normalizedPhrase) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char);

      // Update top-k suggestions at each prefix node
      this._updateSuggestions(node, normalizedPhrase, count);
    }

    node.isEndOfWord = true;
    node.count = count;
    node.lastUpdated = Date.now();
  }

  /**
   * Update the top-k suggestions at a node.
   * Maintains sorted order by count (descending).
   */
  _updateSuggestions(node, phrase, count) {
    // Find existing suggestion for this phrase
    const existingIndex = node.suggestions.findIndex(s => s.phrase === phrase);

    if (existingIndex !== -1) {
      // Update existing
      node.suggestions[existingIndex].count = count;
      node.suggestions[existingIndex].lastUpdated = Date.now();
    } else {
      // Add new suggestion
      node.suggestions.push({
        phrase,
        count,
        lastUpdated: Date.now(),
      });
    }

    // Sort by count descending
    node.suggestions.sort((a, b) => b.count - a.count);

    // Keep only top-k
    if (node.suggestions.length > this.topK) {
      node.suggestions = node.suggestions.slice(0, this.topK);
    }
  }

  /**
   * Get suggestions for a prefix.
   * Returns pre-computed top-k suggestions.
   */
  getSuggestions(prefix) {
    if (!prefix || prefix.length === 0) {
      // Return top suggestions from root
      return this.root.suggestions.slice();
    }

    const normalizedPrefix = prefix.toLowerCase().trim();
    let node = this.root;

    for (const char of normalizedPrefix) {
      if (!node.children.has(char)) {
        return []; // No matches for this prefix
      }
      node = node.children.get(char);
    }

    return node.suggestions.slice();
  }

  /**
   * Increment the count for an existing phrase or insert with count 1.
   */
  incrementCount(phrase, delta = 1) {
    const normalizedPhrase = phrase.toLowerCase().trim();
    const currentCount = this.phraseMap.get(normalizedPhrase) || 0;
    this.insert(normalizedPhrase, currentCount + delta);
  }

  /**
   * Check if a phrase exists in the trie.
   */
  has(phrase) {
    return this.phraseMap.has(phrase.toLowerCase().trim());
  }

  /**
   * Get the count for a phrase.
   */
  getCount(phrase) {
    return this.phraseMap.get(phrase.toLowerCase().trim()) || 0;
  }

  /**
   * Remove a phrase from the trie.
   * Note: This doesn't remove the nodes, just marks it as not end of word
   * and removes from suggestions. For full cleanup, rebuild the trie.
   */
  remove(phrase) {
    const normalizedPhrase = phrase.toLowerCase().trim();
    if (!this.phraseMap.has(normalizedPhrase)) {
      return false;
    }

    let node = this.root;
    const path = [this.root];

    // Traverse to the end
    for (const char of normalizedPhrase) {
      if (!node.children.has(char)) {
        return false;
      }
      node = node.children.get(char);
      path.push(node);
    }

    // Mark as not end of word
    node.isEndOfWord = false;
    node.count = 0;

    // Remove from suggestions at each level
    for (const pathNode of path) {
      pathNode.suggestions = pathNode.suggestions.filter(s => s.phrase !== normalizedPhrase);
    }

    this.phraseMap.delete(normalizedPhrase);
    this.size--;

    return true;
  }

  /**
   * Get all phrases in the trie (for debugging/export).
   */
  getAllPhrases() {
    const phrases = [];

    const traverse = (node, prefix) => {
      if (node.isEndOfWord) {
        phrases.push({ phrase: prefix, count: node.count });
      }

      for (const [char, child] of node.children) {
        traverse(child, prefix + char);
      }
    };

    traverse(this.root, '');
    return phrases;
  }

  /**
   * Serialize the trie to JSON for storage/transfer.
   */
  serialize() {
    const data = {
      topK: this.topK,
      size: this.size,
      phrases: this.getAllPhrases(),
    };

    return JSON.stringify(data);
  }

  /**
   * Deserialize a trie from JSON.
   */
  static deserialize(json) {
    const data = JSON.parse(json);
    const trie = new Trie(data.topK);

    for (const { phrase, count } of data.phrases) {
      trie.insert(phrase, count);
    }

    return trie;
  }

  /**
   * Get statistics about the trie.
   */
  getStats() {
    let nodeCount = 0;
    let maxDepth = 0;

    const traverse = (node, depth) => {
      nodeCount++;
      maxDepth = Math.max(maxDepth, depth);

      for (const child of node.children.values()) {
        traverse(child, depth + 1);
      }
    };

    traverse(this.root, 0);

    return {
      phraseCount: this.size,
      nodeCount,
      maxDepth,
      topK: this.topK,
    };
  }
}
