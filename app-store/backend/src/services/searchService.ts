import { esClient, APP_INDEX } from '../config/elasticsearch.js';
import { cacheGet, cacheSet } from '../config/redis.js';
import type { App, SearchParams, PaginatedResponse } from '../types/index.js';

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

export class SearchService {
  private readonly CACHE_TTL = 60; // 1 minute for search results

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
    const must: unknown[] = [];
    const filter: unknown[] = [];

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
    let sort: unknown[];
    switch (sortBy) {
      case 'rating':
        sort = [{ averageRating: 'desc' }, { ratingCount: 'desc' }];
        break;
      case 'downloads':
        sort = [{ downloadCount: 'desc' }];
        break;
      case 'date':
        sort = [{ lastUpdated: 'desc' }];
        break;
      default:
        sort = q.trim() ? [{ _score: 'desc' }, { qualityScore: 'desc' }] : [{ downloadCount: 'desc' }];
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
      .map(({ _score, qualityScore, _finalScore, ...app }) => app);
  }

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

      const suggestions = response.suggest?.['app-suggest']?.[0]?.options || [];
      return suggestions.map((s: { text: string }) => s.text);
    } catch (error) {
      console.error('Elasticsearch suggest error:', error);
      return [];
    }
  }

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

  async removeApp(appId: string): Promise<void> {
    await esClient.delete({
      index: APP_INDEX,
      id: appId,
    });
  }

  private calculateQualityScore(app: Partial<App>): number {
    const ratingScore = (app.averageRating || 0) / 5;
    const ratingCountScore = Math.min((app.ratingCount || 0) / 1000, 1);
    const downloadScore = Math.min(Math.log10((app.downloadCount || 1) + 1) / 6, 1);

    return ratingScore * 0.4 + ratingCountScore * 0.3 + downloadScore * 0.3;
  }

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

export const searchService = new SearchService();
