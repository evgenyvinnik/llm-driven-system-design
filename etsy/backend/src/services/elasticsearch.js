import { Client } from '@elastic/elasticsearch';
import config from '../config.js';

const esClient = new Client({
  node: config.elasticsearch.url,
});

// Product index mapping with synonyms for handmade marketplace
const productIndexSettings = {
  settings: {
    analysis: {
      analyzer: {
        etsy_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'synonym_filter', 'stemmer'],
        },
      },
      filter: {
        synonym_filter: {
          type: 'synonym',
          synonyms: [
            'handmade, handcrafted, artisan, homemade, hand-made',
            'vintage, antique, retro, old, classic',
            'wallet, billfold, purse, cardholder',
            'necklace, pendant, chain, choker',
            'earrings, studs, drops, hoops',
            'ring, band, signet',
            'leather, genuine leather, real leather, cowhide',
            'silver, sterling, 925',
            'gold, golden, gilt',
            'wood, wooden, timber',
          ],
        },
      },
    },
  },
  mappings: {
    properties: {
      id: { type: 'integer' },
      shop_id: { type: 'integer' },
      shop_name: { type: 'keyword' },
      shop_rating: { type: 'float' },
      shop_sales_count: { type: 'integer' },
      title: { type: 'text', analyzer: 'etsy_analyzer' },
      description: { type: 'text', analyzer: 'etsy_analyzer' },
      price: { type: 'float' },
      quantity: { type: 'integer' },
      category_id: { type: 'integer' },
      category_name: { type: 'keyword' },
      tags: { type: 'keyword' },
      images: { type: 'keyword' },
      is_vintage: { type: 'boolean' },
      is_handmade: { type: 'boolean' },
      shipping_price: { type: 'float' },
      view_count: { type: 'integer' },
      favorite_count: { type: 'integer' },
      created_at: { type: 'date' },
    },
  },
};

export async function initializeIndex() {
  try {
    const indexExists = await esClient.indices.exists({ index: 'products' });
    if (!indexExists) {
      await esClient.indices.create({
        index: 'products',
        ...productIndexSettings,
      });
      console.log('Created Elasticsearch products index');
    }
  } catch (error) {
    console.error('Error initializing Elasticsearch index:', error);
  }
}

export async function indexProduct(product) {
  try {
    await esClient.index({
      index: 'products',
      id: product.id.toString(),
      document: {
        id: product.id,
        shop_id: product.shop_id,
        shop_name: product.shop_name,
        shop_rating: product.shop_rating || 0,
        shop_sales_count: product.shop_sales_count || 0,
        title: product.title,
        description: product.description,
        price: parseFloat(product.price),
        quantity: product.quantity,
        category_id: product.category_id,
        category_name: product.category_name,
        tags: product.tags,
        images: product.images,
        is_vintage: product.is_vintage,
        is_handmade: product.is_handmade,
        shipping_price: parseFloat(product.shipping_price || 0),
        view_count: product.view_count || 0,
        favorite_count: product.favorite_count || 0,
        created_at: product.created_at,
      },
    });
  } catch (error) {
    console.error('Error indexing product:', error);
  }
}

export async function deleteProductFromIndex(productId) {
  try {
    await esClient.delete({
      index: 'products',
      id: productId.toString(),
    });
  } catch (error) {
    console.error('Error deleting product from index:', error);
  }
}

export async function searchProducts(query, filters = {}) {
  const must = [];
  const filter = [];

  if (query) {
    must.push({
      multi_match: {
        query: query,
        fields: ['title^3', 'description', 'tags^2'],
        fuzziness: 'AUTO',
        prefix_length: 2,
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  // Apply filters
  if (filters.categoryId) {
    filter.push({ term: { category_id: parseInt(filters.categoryId) } });
  }

  if (filters.priceMin) {
    filter.push({ range: { price: { gte: parseFloat(filters.priceMin) } } });
  }

  if (filters.priceMax) {
    filter.push({ range: { price: { lte: parseFloat(filters.priceMax) } } });
  }

  if (filters.isVintage !== undefined) {
    filter.push({ term: { is_vintage: filters.isVintage === 'true' } });
  }

  if (filters.isHandmade !== undefined) {
    filter.push({ term: { is_handmade: filters.isHandmade === 'true' } });
  }

  if (filters.freeShipping === 'true') {
    filter.push({ term: { shipping_price: 0 } });
  }

  // Only show in-stock items
  filter.push({ range: { quantity: { gt: 0 } } });

  const body = {
    query: {
      function_score: {
        query: {
          bool: {
            must,
            filter,
          },
        },
        functions: [
          {
            field_value_factor: {
              field: 'shop_rating',
              factor: 1.5,
              modifier: 'sqrt',
              missing: 1,
            },
          },
          {
            field_value_factor: {
              field: 'shop_sales_count',
              factor: 1.2,
              modifier: 'log1p',
              missing: 1,
            },
          },
          {
            gauss: {
              created_at: {
                origin: 'now',
                scale: '30d',
              },
            },
          },
        ],
        score_mode: 'sum',
        boost_mode: 'multiply',
      },
    },
    aggs: {
      categories: { terms: { field: 'category_name', size: 20 } },
      price_ranges: {
        range: {
          field: 'price',
          ranges: [
            { key: 'Under $25', to: 25 },
            { key: '$25-$50', from: 25, to: 50 },
            { key: '$50-$100', from: 50, to: 100 },
            { key: 'Over $100', from: 100 },
          ],
        },
      },
    },
    from: filters.offset || 0,
    size: filters.limit || 20,
  };

  // Sort options
  if (filters.sort) {
    switch (filters.sort) {
      case 'price_asc':
        body.sort = [{ price: 'asc' }];
        break;
      case 'price_desc':
        body.sort = [{ price: 'desc' }];
        break;
      case 'newest':
        body.sort = [{ created_at: 'desc' }];
        break;
      case 'popular':
        body.sort = [{ view_count: 'desc' }];
        break;
      default:
        // relevance (default)
        break;
    }
  }

  try {
    const result = await esClient.search({
      index: 'products',
      ...body,
    });

    return {
      products: result.hits.hits.map((hit) => ({
        ...hit._source,
        score: hit._score,
      })),
      total: result.hits.total.value,
      aggregations: result.aggregations,
    };
  } catch (error) {
    console.error('Elasticsearch search error:', error);
    throw error;
  }
}

export async function getSimilarProducts(productId, limit = 6) {
  try {
    const result = await esClient.search({
      index: 'products',
      query: {
        more_like_this: {
          fields: ['title', 'description', 'tags'],
          like: [{ _index: 'products', _id: productId.toString() }],
          min_term_freq: 1,
          min_doc_freq: 1,
        },
      },
      size: limit,
    });

    return result.hits.hits.map((hit) => hit._source);
  } catch (error) {
    console.error('Error getting similar products:', error);
    return [];
  }
}

export default esClient;
