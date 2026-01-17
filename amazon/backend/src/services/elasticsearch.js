import { Client } from '@elastic/elasticsearch';

let client = null;

const INDEX_NAME = 'products';

export async function initializeElasticsearch() {
  client = new Client({
    node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
  });

  // Check connection
  try {
    const health = await client.cluster.health();
    console.log('Elasticsearch connected:', health.status);

    // Create index if it doesn't exist
    const indexExists = await client.indices.exists({ index: INDEX_NAME });
    if (!indexExists) {
      await createProductIndex();
    }
  } catch (error) {
    console.warn('Elasticsearch not available, search features disabled:', error.message);
  }

  return client;
}

export function getElasticsearch() {
  return client;
}

async function createProductIndex() {
  await client.indices.create({
    index: INDEX_NAME,
    body: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          analyzer: {
            product_analyzer: {
              type: 'custom',
              tokenizer: 'standard',
              filter: ['lowercase', 'asciifolding', 'porter_stem']
            }
          }
        }
      },
      mappings: {
        properties: {
          id: { type: 'integer' },
          title: {
            type: 'text',
            analyzer: 'product_analyzer',
            fields: {
              keyword: { type: 'keyword' }
            }
          },
          description: { type: 'text', analyzer: 'product_analyzer' },
          category_id: { type: 'integer' },
          category_name: { type: 'keyword' },
          category_slug: { type: 'keyword' },
          seller_id: { type: 'integer' },
          seller_name: { type: 'keyword' },
          price: { type: 'float' },
          compare_at_price: { type: 'float' },
          rating: { type: 'float' },
          review_count: { type: 'integer' },
          in_stock: { type: 'boolean' },
          stock_quantity: { type: 'integer' },
          attributes: { type: 'object' },
          images: { type: 'keyword' },
          created_at: { type: 'date' }
        }
      }
    }
  });
  console.log('Products index created');
}

export async function indexProduct(product) {
  if (!client) return;

  try {
    await client.index({
      index: INDEX_NAME,
      id: product.id.toString(),
      body: {
        id: product.id,
        title: product.title,
        description: product.description,
        category_id: product.category_id,
        category_name: product.category_name,
        category_slug: product.category_slug,
        seller_id: product.seller_id,
        seller_name: product.seller_name,
        price: parseFloat(product.price),
        compare_at_price: product.compare_at_price ? parseFloat(product.compare_at_price) : null,
        rating: parseFloat(product.rating) || 0,
        review_count: product.review_count || 0,
        in_stock: product.stock_quantity > 0,
        stock_quantity: product.stock_quantity || 0,
        attributes: product.attributes || {},
        images: product.images || [],
        created_at: product.created_at
      }
    });
    await client.indices.refresh({ index: INDEX_NAME });
  } catch (error) {
    console.error('Error indexing product:', error);
  }
}

export async function deleteProductFromIndex(productId) {
  if (!client) return;

  try {
    await client.delete({
      index: INDEX_NAME,
      id: productId.toString()
    });
  } catch (error) {
    console.error('Error deleting product from index:', error);
  }
}

export async function searchProducts(query, filters = {}, page = 0, limit = 20) {
  if (!client) {
    return { products: [], total: 0, aggregations: {} };
  }

  const must = [];
  const filter = [];

  // Full-text search
  if (query) {
    must.push({
      multi_match: {
        query: query,
        fields: ['title^3', 'description', 'category_name', 'seller_name'],
        type: 'best_fields',
        fuzziness: 'AUTO'
      }
    });
  } else {
    must.push({ match_all: {} });
  }

  // Category filter
  if (filters.category) {
    filter.push({ term: { category_slug: filters.category } });
  }

  // Price range filter
  if (filters.minPrice || filters.maxPrice) {
    const rangeQuery = { range: { price: {} } };
    if (filters.minPrice) rangeQuery.range.price.gte = parseFloat(filters.minPrice);
    if (filters.maxPrice) rangeQuery.range.price.lte = parseFloat(filters.maxPrice);
    filter.push(rangeQuery);
  }

  // In stock filter
  if (filters.inStock) {
    filter.push({ term: { in_stock: true } });
  }

  // Rating filter
  if (filters.minRating) {
    filter.push({ range: { rating: { gte: parseFloat(filters.minRating) } } });
  }

  // Build sort
  let sort = [];
  switch (filters.sortBy) {
    case 'price_asc':
      sort = [{ price: 'asc' }];
      break;
    case 'price_desc':
      sort = [{ price: 'desc' }];
      break;
    case 'rating':
      sort = [{ rating: 'desc' }];
      break;
    case 'newest':
      sort = [{ created_at: 'desc' }];
      break;
    default:
      sort = [{ _score: 'desc' }];
  }

  try {
    const result = await client.search({
      index: INDEX_NAME,
      body: {
        query: {
          bool: {
            must,
            filter
          }
        },
        sort,
        from: page * limit,
        size: limit,
        aggs: {
          categories: {
            terms: { field: 'category_slug', size: 20 }
          },
          price_ranges: {
            range: {
              field: 'price',
              ranges: [
                { key: 'Under $25', to: 25 },
                { key: '$25-$50', from: 25, to: 50 },
                { key: '$50-$100', from: 50, to: 100 },
                { key: '$100-$200', from: 100, to: 200 },
                { key: 'Over $200', from: 200 }
              ]
            }
          },
          avg_rating: {
            avg: { field: 'rating' }
          },
          rating_buckets: {
            range: {
              field: 'rating',
              ranges: [
                { key: '4 stars & up', from: 4 },
                { key: '3 stars & up', from: 3 },
                { key: '2 stars & up', from: 2 },
                { key: '1 star & up', from: 1 }
              ]
            }
          }
        }
      }
    });

    return {
      products: result.hits.hits.map(hit => ({
        ...hit._source,
        score: hit._score
      })),
      total: result.hits.total.value,
      aggregations: result.aggregations
    };
  } catch (error) {
    console.error('Elasticsearch search error:', error);
    return { products: [], total: 0, aggregations: {} };
  }
}

export async function bulkIndexProducts(products) {
  if (!client || products.length === 0) return;

  const operations = products.flatMap(product => [
    { index: { _index: INDEX_NAME, _id: product.id.toString() } },
    {
      id: product.id,
      title: product.title,
      description: product.description,
      category_id: product.category_id,
      category_name: product.category_name,
      category_slug: product.category_slug,
      seller_id: product.seller_id,
      seller_name: product.seller_name,
      price: parseFloat(product.price),
      compare_at_price: product.compare_at_price ? parseFloat(product.compare_at_price) : null,
      rating: parseFloat(product.rating) || 0,
      review_count: product.review_count || 0,
      in_stock: product.stock_quantity > 0,
      stock_quantity: product.stock_quantity || 0,
      attributes: product.attributes || {},
      images: product.images || [],
      created_at: product.created_at
    }
  ]);

  try {
    await client.bulk({ operations });
    await client.indices.refresh({ index: INDEX_NAME });
    console.log(`Indexed ${products.length} products`);
  } catch (error) {
    console.error('Bulk indexing error:', error);
  }
}
