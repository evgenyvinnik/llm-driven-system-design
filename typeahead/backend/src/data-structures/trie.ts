/**
 * Suggestion stored in trie nodes
 */
export interface Suggestion {
  phrase: string;
  count: number;
  lastUpdated: number;
}

/**
 * Normalize a phrase for storage: lowercase and trim both ends.
 * This is how phrases are stored in phrase_counts.
 */
export function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().trim();
}

/**
 * Normalize a typed prefix for lookup: lowercase and trim leading whitespace only.
 * A trailing space marks a word boundary ("java " should complete to "java spring boot",
 * not "javascript"), so a trailing whitespace run is kept as a single space.
 */
export function normalizePrefix(prefix: string): string {
  const lookup = prefix.toLowerCase().trimStart();
  const trimmed = lookup.trimEnd(); // not /\s+$/, which backtracks quadratically on inner runs
  return trimmed.length < lookup.length ? `${trimmed} ` : lookup;
}

/**
 * Highest count first; ties broken by phrase so rebuilt lists match incremental ones.
 */
function compareSuggestions(a: Suggestion, b: Suggestion): number {
  return b.count - a.count || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0);
}

/**
 * TrieNode represents a single node in the Trie.
 * Each node stores:
 * - children: Map of character to child TrieNode
 * - isEndOfWord: whether this node represents a complete phrase
 * - suggestions: pre-computed top-k suggestions at this prefix
 * - count: frequency count if this is an end node
 */
class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isEndOfWord: boolean = false;
  suggestions: Suggestion[] = [];
  count: number = 0;
  lastUpdated: number = Date.now();
}

/**
 * Trie statistics
 */
export interface TrieStats {
  phraseCount: number;
  nodeCount: number;
  maxDepth: number;
  topK: number;
}

/**
 * Serialized trie data
 */
interface SerializedTrie {
  topK: number;
  size: number;
  phrases: Array<{ phrase: string; count: number }>;
}

/**
 * Trie data structure with pre-computed top-k suggestions at each node.
 * This design trades memory for query speed - O(prefix_length) lookups.
 */
export class Trie {
  private _root!: TrieNode;
  topK: number;
  size: number;
  phraseMap: Map<string, number>;
  // Node counts per depth, maintained on insert/remove so getStats() is O(1)
  private depthCounts: number[] = [];
  private nodeCount: number = 0;

  constructor(topK: number = 10) {
    this.root = new TrieNode();
    this.topK = topK;
    this.size = 0;
    this.phraseMap = new Map();
  }

  get root(): TrieNode {
    return this._root;
  }

  /**
   * Replacing the root (e.g. clearing before a rebuild) recounts the new tree once.
   */
  set root(node: TrieNode) {
    this._root = node;
    this.depthCounts = [];
    this.nodeCount = 0;

    const stack: Array<[TrieNode, number]> = [[node, 0]];
    while (stack.length > 0) {
      const [current, depth] = stack.pop()!;
      this._countNode(depth);
      for (const child of current.children.values()) {
        stack.push([child, depth + 1]);
      }
    }
  }

  /**
   * Remove every phrase.
   */
  clear(): void {
    this.root = new TrieNode();
    this.size = 0;
    this.phraseMap.clear();
  }

  /**
   * Insert or update a phrase in the trie with its count.
   * lastUpdated is epoch ms of the phrase's last count change (defaults to now).
   * Updates top-k suggestions at each prefix node, including the root.
   */
  insert(phrase: string, count: number, lastUpdated: number = Date.now()): void {
    if (!phrase || phrase.length === 0) return;

    const normalizedPhrase = normalizePhrase(phrase);
    if (normalizedPhrase.length === 0) return;

    // Counts can arrive as strings (JSON bodies, pg BIGINT); keep them finite non-negative integers
    const numericCount = Number(count);
    if (!Number.isFinite(numericCount)) return;
    const safeCount = Math.max(0, Math.floor(numericCount));
    const timestamp = Number.isFinite(Number(lastUpdated)) ? Number(lastUpdated) : Date.now();

    // Track if this is a new phrase, and whether its count went down
    const previousCount = this.phraseMap.get(normalizedPhrase);
    if (previousCount === undefined) {
      this.size++;
    }
    this.phraseMap.set(normalizedPhrase, safeCount);
    const decreased = previousCount !== undefined && safeCount < previousCount;

    let node = this.root;
    const path: TrieNode[] = [node];
    // ends[i] = length of the prefix spelled by path[i]
    const ends: number[] = [0];

    for (const char of normalizedPhrase) {
      let child = node.children.get(char);
      if (!child) {
        child = new TrieNode();
        node.children.set(char, child);
        this._countNode(path.length);
      }
      node = child;
      path.push(node);
      ends.push(ends[ends.length - 1] + char.length);
    }

    node.isEndOfWord = true;
    node.count = safeCount;
    node.lastUpdated = timestamp;

    // Update top-k bottom-up, so a node that must be rebuilt sees its children's final lists
    for (let i = path.length - 1; i >= 0; i--) {
      const pathNode = path[i];
      const existing = pathNode.suggestions.find((s) => s.phrase === normalizedPhrase);

      // A full list may have evicted phrases that now outrank the lowered count
      if (existing && decreased && pathNode.suggestions.length >= this.topK) {
        this._rebuildSuggestions(pathNode, normalizedPhrase.slice(0, ends[i]));
      } else {
        this._updateSuggestions(pathNode, existing, normalizedPhrase, safeCount, timestamp);
      }
    }
  }

  /**
   * Update the top-k suggestions at a node.
   * Maintains sorted order by count (descending).
   */
  private _updateSuggestions(
    node: TrieNode,
    existing: Suggestion | undefined,
    phrase: string,
    count: number,
    lastUpdated: number
  ): void {
    if (existing) {
      // Update existing
      existing.count = count;
      existing.lastUpdated = lastUpdated;
    } else {
      // Add new suggestion
      node.suggestions.push({ phrase, count, lastUpdated });
    }

    // Sort by count descending
    node.suggestions.sort(compareSuggestions);

    // Keep only top-k
    if (node.suggestions.length > this.topK) {
      node.suggestions = node.suggestions.slice(0, this.topK);
    }
  }

  /**
   * Recompute a node's top-k from its own phrase and its children's top-k lists.
   * Each child list is already the top-k of its subtree, so their union holds the answer.
   * nodePrefix is the string the node spells (its phrase, if it ends one).
   */
  private _rebuildSuggestions(node: TrieNode, nodePrefix: string): void {
    const candidates: Suggestion[] = [];

    if (node.isEndOfWord) {
      candidates.push({ phrase: nodePrefix, count: node.count, lastUpdated: node.lastUpdated });
    }
    for (const child of node.children.values()) {
      candidates.push(...child.suggestions);
    }

    candidates.sort(compareSuggestions);
    node.suggestions = candidates.slice(0, this.topK).map((s) => ({ ...s }));
  }

  /**
   * Get suggestions for a prefix.
   * Returns pre-computed top-k suggestions; an empty prefix returns the global top-k.
   */
  getSuggestions(prefix: string): Suggestion[] {
    const normalizedPrefix = prefix ? normalizePrefix(prefix) : '';
    let node: TrieNode | undefined = this.root;

    for (const char of normalizedPrefix) {
      node = node.children.get(char);
      if (!node) {
        return []; // No matches for this prefix
      }
    }

    // Copies, so callers can't mutate the stored lists
    return node.suggestions.map((s) => ({ ...s }));
  }

  /**
   * Find phrases whose start is within maxDistance edits of the prefix (insert, delete,
   * substitute, or swap two adjacent characters). Walks the trie carrying one edit-distance
   * row per node and prunes branches that can no longer match, so the work is bounded by
   * the nodes near the prefix (and by maxNodes), not by generating every variant.
   * Each phrase is reported once, with the smallest distance found.
   */
  findFuzzy(
    prefix: string,
    maxDistance: number,
    maxNodes: number = 20000
  ): Array<Suggestion & { distance: number }> {
    const query = Array.from(normalizePrefix(prefix));
    const m = query.length;
    const matches = new Map<string, Suggestion & { distance: number }>();
    if (m === 0 || !(maxDistance >= 1)) return [];

    interface Frame {
      node: TrieNode;
      char: string;
      prevRow: number[];
      prevPrevRow: number[] | null;
      prevChar: string;
    }

    const firstRow = Array.from({ length: m + 1 }, (_, i) => i);
    const stack: Frame[] = [];
    for (const [char, child] of this.root.children) {
      stack.push({ node: child, char, prevRow: firstRow, prevPrevRow: null, prevChar: '' });
    }

    let visited = 0;
    while (stack.length > 0 && visited < maxNodes) {
      const { node, char, prevRow, prevPrevRow, prevChar } = stack.pop()!;
      visited++;

      // row[i] = distance between query[0..i) and the string spelled by this node
      const row: number[] = new Array(m + 1);
      row[0] = prevRow[0] + 1;
      let rowMin = row[0];
      for (let i = 1; i <= m; i++) {
        const cost = query[i - 1] === char ? 0 : 1;
        let value = Math.min(prevRow[i] + 1, row[i - 1] + 1, prevRow[i - 1] + cost);
        if (prevPrevRow && i > 1 && query[i - 1] === prevChar && query[i - 2] === char) {
          value = Math.min(value, prevPrevRow[i - 2] + 1); // adjacent transposition
        }
        row[i] = value;
        if (value < rowMin) rowMin = value;
      }

      const distance = row[m];
      if (distance <= maxDistance) {
        for (const s of node.suggestions) {
          const existing = matches.get(s.phrase);
          if (!existing || distance < existing.distance) {
            matches.set(s.phrase, { ...s, distance });
          }
        }
      }

      // Distances never drop below the row minimum deeper down, so prune here
      if (rowMin <= maxDistance) {
        for (const [childChar, child] of node.children) {
          stack.push({ node: child, char: childChar, prevRow: row, prevPrevRow: prevRow, prevChar: char });
        }
      }
    }

    return Array.from(matches.values());
  }

  /**
   * Check if a phrase exists in the trie.
   */
  has(phrase: string): boolean {
    return this.phraseMap.has(normalizePhrase(phrase));
  }

  /**
   * Get the count for a phrase.
   */
  getCount(phrase: string): number {
    return this.phraseMap.get(normalizePhrase(phrase)) || 0;
  }

  /**
   * The lastUpdated (epoch ms) stored for a phrase, or undefined when it isn't in the trie.
   */
  getLastUpdated(phrase: string): number | undefined {
    const normalizedPhrase = normalizePhrase(phrase);
    if (!this.phraseMap.has(normalizedPhrase)) return undefined;

    let node = this.root;
    for (const char of normalizedPhrase) {
      const child = node.children.get(char);
      if (!child) return undefined;
      node = child;
    }
    return node.lastUpdated;
  }

  /**
   * Remove a phrase from the trie.
   * Refills each ancestor's top-k from its subtree and prunes nodes left with no phrases.
   */
  remove(phrase: string): boolean {
    const normalizedPhrase = normalizePhrase(phrase);
    if (!this.phraseMap.has(normalizedPhrase)) {
      return false;
    }

    let node: TrieNode = this.root;
    const path: TrieNode[] = [this.root];
    const chars: string[] = [];
    const ends: number[] = [0];

    // Traverse to the end
    for (const char of normalizedPhrase) {
      const child = node.children.get(char);
      if (!child) {
        return false;
      }
      node = child;
      path.push(node);
      chars.push(char);
      ends.push(ends[ends.length - 1] + char.length);
    }

    // Mark as not end of word
    node.isEndOfWord = false;
    node.count = 0;

    this.phraseMap.delete(normalizedPhrase);
    this.size--;

    // Bottom-up: drop the phrase from each list, refill lists that were full, prune dead leaves
    for (let depth = path.length - 1; depth >= 0; depth--) {
      const pathNode = path[depth];
      const before = pathNode.suggestions.length;
      pathNode.suggestions = pathNode.suggestions.filter((s) => s.phrase !== normalizedPhrase);

      // A full list may have evicted phrases from this subtree; a shorter one held them all
      if (before >= this.topK && pathNode.suggestions.length < before) {
        this._rebuildSuggestions(pathNode, normalizedPhrase.slice(0, ends[depth]));
      }

      if (depth > 0 && pathNode.children.size === 0 && !pathNode.isEndOfWord) {
        path[depth - 1].children.delete(chars[depth - 1]);
        this._uncountNode(depth);
      }
    }

    return true;
  }

  /**
   * Get all phrases in the trie (for debugging/export).
   */
  getAllPhrases(): Array<{ phrase: string; count: number }> {
    const phrases: Array<{ phrase: string; count: number }> = [];

    // Explicit stack: recursion depth would grow with phrase length
    const stack: Array<[TrieNode, string]> = [[this.root, '']];
    while (stack.length > 0) {
      const [node, prefix] = stack.pop()!;
      if (node.isEndOfWord) {
        phrases.push({ phrase: prefix, count: node.count });
      }

      for (const [char, child] of node.children) {
        stack.push([child, prefix + char]);
      }
    }

    return phrases;
  }

  /**
   * Serialize the trie to JSON for storage/transfer.
   */
  serialize(): string {
    const data: SerializedTrie = {
      topK: this.topK,
      size: this.size,
      phrases: this.getAllPhrases(),
    };

    return JSON.stringify(data);
  }

  /**
   * Deserialize a trie from JSON.
   */
  static deserialize(json: string): Trie {
    const data: SerializedTrie = JSON.parse(json);
    const trie = new Trie(data.topK);

    for (const { phrase, count } of data.phrases) {
      trie.insert(phrase, count);
    }

    return trie;
  }

  /**
   * Get statistics about the trie. O(1): counters are kept up to date on insert/remove.
   */
  getStats(): TrieStats {
    return {
      phraseCount: this.size,
      nodeCount: this.nodeCount,
      maxDepth: Math.max(0, this.depthCounts.length - 1),
      topK: this.topK,
    };
  }

  private _countNode(depth: number): void {
    this.depthCounts[depth] = (this.depthCounts[depth] || 0) + 1;
    this.nodeCount++;
  }

  private _uncountNode(depth: number): void {
    this.depthCounts[depth]--;
    this.nodeCount--;
    while (this.depthCounts.length > 0 && this.depthCounts[this.depthCounts.length - 1] === 0) {
      this.depthCounts.pop();
    }
  }
}
