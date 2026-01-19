/**
 * @fileoverview Search service for app discovery using Elasticsearch.
 * Provides full-text search, autocomplete suggestions, and similar app recommendations.
 */

import { esClient, APP_INDEX } from '../config/elasticsearch.js';
import { cacheGet, cacheSet } from '../config/redis.js';
import type { App, SearchParams, PaginatedResponse } from '../types/index.js';
import type { estypes } from '@elastic/elasticsearch';

/**
 * Elasticsearch document structure for indexed apps.
 * Contains searchable fields and ranking signals.
 */
interface ESAppDocument {
  id: string;
  bundleId: string;
  name: string;
  developer: string;
  developerId: string;
  description: string;
  keywords: string;
  category: string;
  isFree: boolean;
  price: number;
  averageRating: number;
  ratingCount: number;
  downloadCount: number;
  releaseDate: string;
  lastUpdated: string;
  ageRating: string;
  size: number;
  version: string;
  iconUrl?: string;
  screenshots?: string[];
  qualityScore: number;
  engagementScore: number;
}

interface SearchHit {
  _id: string;
  _score: number;
  _source: ESAppDocument;
}

/**
 * Service class for app search and discovery operations.
 * Uses Elasticsearch for full-text search with caching for popular queries.
 */
export class SearchService {
  /** Cache time-to-live for search results (1 minute) */
  private readonly CACHE_TTL = 60;

  /**
   * Performs a full-text search for apps with filtering and sorting.
   * Combines text relevance with quality signals for ranking.
   * @param params - Search parameters including query, filters, and pagination
   * @returns Paginated list of matching apps
   */
  async search(params: SearchParams): Promise<PaginatedResponse<Partial<App>>> {
    const {
      q = '',
      category,
      priceType = 'all',
      minRating,
      sortBy = 'relevance',
      page = 1,
      limit = 20,
    } = params;

    // Build cache key
    const cacheKey = `search:${JSON.stringify(params)}`;
    const cached = await cacheGet<PaginatedResponse<Partial<App>>>(cacheKey);
    if (cached) return cached;

    // Build Elasticsearch query
    const must: estypes.QueryDslQueryContainer[] = [];
    const filter: estypes.QueryDslQueryContainer[] = [];

    // Text search
    if (q.trim()) {
      must.push({
        multi_match: {
          query: q,
          fields: ['name^3', 'developer^2', 'description', 'keywords'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      });
    } else {
      must.push({ match_all: {} });
    }

    // Category filter
    if (category) {
      filter.push({ term: { category } });
    }

    // Price filter
    if (priceType === 'free') {
      filter.push({ term: { isFree: true } });
    } else if (priceType === 'paid') {
      filter.push({ term: { isFree: false } });
    }

    // Rating filter
    if (minRating) {
      filter.push({ range: { averageRating: { gte: minRating } } });
    }

    // Build sort
    let sort: estypes.SortCombinations[];
    switch (sortBy) {
      case 'rating':
        sort = [{ averageRating: 'desc' as const }, { ratingCount: 'desc' as const }];
        break;
      case 'downloads':
        sort = [{ downloadCount: 'desc' as const }];
        break;
      case 'date':
        sort = [{ lastUpdated: 'desc' as const }];
        break;
      default:
        sort = q.trim() ? [{ _score: { order: 'desc' as const } }, { qualityScore: 'desc' as const }] : [{ downloadCount: 'desc' as const }];
    }

    const from = (page - 1) * limit;

    try {
      const response = await esClient.search<ESAppDocument>({
        index: APP_INDEX,
        body: {
          query: {
            bool: {
              must,
              filter,
            },
          },
          sort,
          from,
          size: limit,
          track_total_hits: true,
        },
      });

      const hits = response.hits.hits as SearchHit[];
      const total = typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total?.value || 0;

      // Re-rank results if text search with quality signals
      let apps = hits.map((hit) => this.mapESDocumentToApp(hit._source, hit._score));

      if (q.trim() && sortBy === 'relevance') {
        apps = this.rerank(apps);
      }

      const result: PaginatedResponse<Partial<App>> = {
        data: apps,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };

      await cacheSet(cacheKey, result, this.CACHE_TTL);
      return result;
    } catch (error) {
      console.error('Elasticsearch search error:', error);
      throw error;
    }
  }

  /**
   * Re-ranks search results by combining text relevance with quality signals.
   * Applies 60% weight to text relevance and 40% to quality score.
   * @param apps - Initial search results with scores
   * @returns Re-ranked apps without internal scoring fields
   */
  private rerank(apps: (Partial<App> & { _score?: number; qualityScore?: number })[]): Partial<App>[] {
    return apps
      .map((app) => {
        const textScore = app._score || 0;
        const qualityScore = app.qualityScore || 0;

        // Combine text relevance (60%) with quality (40%)
        const finalScore = textScore * 0.6 + qualityScore * 0.4;

        return { ...app, _finalScore: finalScore };
      })
      .sort((a, b) => (b._finalScore || 0) - (a._finalScore || 0))
      .map(({ _score, _finalScore, ...app }) => app);
  }

  /**
   * Provides autocomplete suggestions for search queries.
   * Uses Elasticsearch completion suggester for fast prefix matching.
   * @param query - Partial search query
   * @param limit - Maximum number of suggestions
   * @returns Array of suggested app names
   */
  async suggest(query: string, limit = 5): Promise<string[]> {
    if (!query.trim()) return [];

    try {
      const response = await esClient.search({
        index: APP_INDEX,
        body: {
          suggest: {
            'app-suggest': {
              prefix: query,
              completion: {
                field: 'name.suggest',
                size: limit,
                skip_duplicates: true,
              },
            },
          },
        },
      });

      const suggestResult = response.suggest?.['app-suggest']?.[0]?.options;
      const suggestions = Array.isArray(suggestResult) ? suggestResult : [];
      return suggestions.map((s) => (s as estypes.SearchCompletionSuggestOption<ESAppDocument>).text);
    } catch (error) {
      console.error('Elasticsearch suggest error:', error);
      return [];
    }
  }

  /**
   * Finds apps similar to a given app using content-based filtering.
   * Uses Elasticsearch more_like_this query on name, description, and keywords.
   * @param appId - Source app UUID
   * @param limit - Maximum number of similar apps to return
   * @returns Array of similar apps
   */
  async getSimilarApps(appId: string, limit = 10): Promise<Partial<App>[]> {
    const cacheKey = `similar:${appId}:${limit}`;
    const cached = await cacheGet<Partial<App>[]>(cacheKey);
    if (cached) return cached;

    try {
      // Get the app first
      const appResponse = await esClient.get<ESAppDocument>({
        index: APP_INDEX,
        id: appId,
      });

      if (!appResponse.found) {
        return [];
      }

      const app = appResponse._source!;

      // Find similar apps using more_like_this
      const response = await esClient.search<ESAppDocument>({
        index: APP_INDEX,
        body: {
          query: {
            bool: {
              must: [
                {
                  more_like_this: {
                    fields: ['name', 'description', 'keywords'],
                    like: [
                      {
                        _index: APP_INDEX,
                        _id: appId,
                      },
                    ],
                    min_term_freq: 1,
                    min_doc_freq: 1,
                  },
                },
              ],
              filter: [
                { term: { category: app.category } },
              ],
              must_not: [
                { term: { id: appId } },
              ],
            },
          },
          size: limit,
        },
      });

      const hits = response.hits.hits as SearchHit[];
      const apps = hits.map((hit) => this.mapESDocumentToApp(hit._source, hit._score));

      await cacheSet(cacheKey, apps, 300);
      return apps;
    } catch (error) {
      console.error('Elasticsearch similar apps error:', error);
      return [];
    }
  }

  /**
   * Indexes an app document in Elasticsearch for search.
   * Called when an app is created, updated, or published.
   * @param app - App data to index
   */
  async indexApp(app: Partial<App> & { developer?: { name: string } }): Promise<void> {
    const document: ESAppDocument = {
      id: app.id!,
      bundleId: app.bundleId!,
      name: app.name!,
      developer: app.developer?.name || '',
      developerId: app.developerId!,
      description: app.description || '',
      keywords: app.keywords?.join(' ') || '',
      category: app.category?.slug || '',
      isFree: app.isFree !== false,
      price: app.price || 0,
      averageRating: app.averageRating || 0,
      ratingCount: app.ratingCount || 0,
      downloadCount: app.downloadCount || 0,
      releaseDate: app.publishedAt?.toISOString() || new Date().toISOString(),
      lastUpdated: app.updatedAt?.toISOString() || new Date().toISOString(),
      ageRating: app.ageRating || '4+',
      size: app.sizeBytes || 0,
      version: app.version || '1.0.0',
      iconUrl: app.iconUrl || undefined,
      qualityScore: this.calculateQualityScore(app),
      engagementScore: Math.random() * 0.5 + 0.5, // Placeholder
    };

    await esClient.index({
      index: APP_INDEX,
      id: app.id!,
      document,
    });
  }

  /**
   * Removes an app from the search index.
   * Called when an app is deleted or unpublished.
   * @param appId - App UUID to remove
   */
  async removeApp(appId: string): Promise<void> {
    await esClient.delete({
      index: APP_INDEX,
      id: appId,
    });
  }

  /**
   * Calculates a quality score for an app based on ratings and downloads.
   * Used for ranking in search results.
   * @param app - App data
   * @returns Quality score between 0 and 1
   */
  private calculateQualityScore(app: Partial<App>): number {
    const ratingScore = (app.averageRating || 0) / 5;
    const ratingCountScore = Math.min((app.ratingCount || 0) / 1000, 1);
    const downloadScore = Math.min(Math.log10((app.downloadCount || 1) + 1) / 6, 1);

    return ratingScore * 0.4 + ratingCountScore * 0.3 + downloadScore * 0.3;
  }

  /**
   * Maps an Elasticsearch document to a partial App object.
   * @param doc - Elasticsearch source document
   * @param score - Optional relevance score from search
   * @returns App object with search metadata
   */
  private mapESDocumentToApp(doc: ESAppDocument, score?: number): Partial<App> & { _score?: number; qualityScore?: number } {
    return {
      id: doc.id,
      bundleId: doc.bundleId,
      name: doc.name,
      developerId: doc.developerId,
      description: doc.description,
      keywords: doc.keywords.split(' ').filter(Boolean),
      isFree: doc.isFree,
      price: doc.price,
      averageRating: doc.averageRating,
      ratingCount: doc.ratingCount,
      downloadCount: doc.downloadCount,
      ageRating: doc.ageRating,
      sizeBytes: doc.size,
      version: doc.version,
      iconUrl: doc.iconUrl || null,
      developer: { name: doc.developer } as App['developer'],
      _score: score,
      qualityScore: doc.qualityScore,
    };
  }
}

/** Singleton instance of the search service */
export const searchService = new SearchService();
