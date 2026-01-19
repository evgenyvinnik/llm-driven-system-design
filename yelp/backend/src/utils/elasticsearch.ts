import { Client } from '@elastic/elasticsearch';

export const elasticsearch = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
});

const BUSINESS_INDEX = 'businesses';

// Index mapping for businesses
const businessMapping = {
  mappings: {
    properties: {
      id: { type: 'keyword' },
      name: {
        type: 'text',
        analyzer: 'standard',
        fields: {
          keyword: { type: 'keyword' },
          suggest: {
            type: 'completion',
            analyzer: 'simple',
            preserve_separators: true,
            preserve_position_increments: true,
            max_input_length: 50
          }
        }
      },
      description: { type: 'text' },
      categories: { type: 'keyword' },
      category_names: { type: 'text' },
      location: { type: 'geo_point' },
      address: { type: 'text' },
      city: {
        type: 'text',
        fields: { keyword: { type: 'keyword' } }
      },
      state: { type: 'keyword' },
      zip_code: { type: 'keyword' },
      rating: { type: 'float' },
      review_count: { type: 'integer' },
      price_level: { type: 'integer' },
      is_claimed: { type: 'boolean' },
      is_verified: { type: 'boolean' },
      phone: { type: 'keyword' },
      website: { type: 'keyword' },
      photo_url: { type: 'keyword' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' }
    }
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        autocomplete: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'autocomplete_filter']
        }
      },
      filter: {
        autocomplete_filter: {
          type: 'edge_ngram',
          min_gram: 1,
          max_gram: 20
        }
      }
    }
  }
};

// Initialize Elasticsearch index
export async function initElasticsearch() {
  try {
    const indexExists = await elasticsearch.indices.exists({ index: BUSINESS_INDEX });

    if (!indexExists) {
      await elasticsearch.indices.create({
        index: BUSINESS_INDEX,
        body: businessMapping
      });
      console.log(`Created Elasticsearch index: ${BUSINESS_INDEX}`);
    }
  } catch (error) {
    console.error('Elasticsearch initialization error:', error);
    throw error;
  }
}

// Index a business document
export async function indexBusiness(business) {
  try {
    await elasticsearch.index({
      index: BUSINESS_INDEX,
      id: business.id,
      body: {
        id: business.id,
        name: business.name,
        description: business.description,
        categories: business.categories || [],
        category_names: business.category_names || [],
        location: {
          lat: parseFloat(business.latitude),
          lon: parseFloat(business.longitude)
        },
        address: business.address,
        city: business.city,
        state: business.state,
        zip_code: business.zip_code,
        rating: parseFloat(business.rating) || 0,
        review_count: parseInt(business.review_count) || 0,
        price_level: business.price_level,
        is_claimed: business.is_claimed,
        is_verified: business.is_verified,
        phone: business.phone,
        website: business.website,
        photo_url: business.photo_url,
        created_at: business.created_at,
        updated_at: business.updated_at
      },
      refresh: true
    });
  } catch (error) {
    console.error('Error indexing business:', error);
    throw error;
  }
}

// Update a business document
export async function updateBusinessIndex(businessId, updates) {
  try {
    await elasticsearch.update({
      index: BUSINESS_INDEX,
      id: businessId,
      body: {
        doc: updates
      },
      refresh: true
    });
  } catch (error) {
    console.error('Error updating business index:', error);
    throw error;
  }
}

// Delete a business document
export async function deleteBusinessIndex(businessId) {
  try {
    await elasticsearch.delete({
      index: BUSINESS_INDEX,
      id: businessId,
      refresh: true
    });
  } catch (error) {
    console.error('Error deleting business from index:', error);
    throw error;
  }
}

// Search businesses
export async function searchBusinesses(options) {
  const {
    query,
    category,
    latitude,
    longitude,
    distance = '10km',
    minRating,
    maxPriceLevel,
    sortBy = 'relevance',
    from = 0,
    size = 20
  } = options;

  const must = [];
  const filter = [];

  // Text search
  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ['name^3', 'description', 'category_names', 'city'],
        fuzziness: 'AUTO'
      }
    });
  }

  // Category filter
  if (category) {
    filter.push({ term: { categories: category } });
  }

  // Geo distance filter
  if (latitude && longitude) {
    filter.push({
      geo_distance: {
        distance,
        location: {
          lat: parseFloat(latitude),
          lon: parseFloat(longitude)
        }
      }
    });
  }

  // Rating filter
  if (minRating) {
    filter.push({ range: { rating: { gte: parseFloat(minRating) } } });
  }

  // Price level filter
  if (maxPriceLevel) {
    filter.push({ range: { price_level: { lte: parseInt(maxPriceLevel) } } });
  }

  // Build sort
  const sort = [];
  switch (sortBy) {
    case 'rating':
      sort.push({ rating: 'desc' });
      break;
    case 'review_count':
      sort.push({ review_count: 'desc' });
      break;
    case 'distance':
      if (latitude && longitude) {
        sort.push({
          _geo_distance: {
            location: {
              lat: parseFloat(latitude),
              lon: parseFloat(longitude)
            },
            order: 'asc',
            unit: 'km'
          }
        });
      }
      break;
    default:
      sort.push({ _score: 'desc' });
      sort.push({ rating: 'desc' });
  }

  const searchBody = {
    query: {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        filter
      }
    },
    sort,
    from,
    size
  };

  // Add distance calculation if location provided
  if (latitude && longitude) {
    searchBody.script_fields = {
      distance: {
        script: {
          source: "doc['location'].arcDistance(params.lat, params.lon) / 1000",
          params: {
            lat: parseFloat(latitude),
            lon: parseFloat(longitude)
          }
        }
      }
    };
  }

  try {
    const result = await elasticsearch.search({
      index: BUSINESS_INDEX,
      body: searchBody
    });

    return {
      total: result.hits.total.value,
      businesses: result.hits.hits.map(hit => ({
        ...hit._source,
        score: hit._score,
        distance: hit.fields?.distance?.[0]
      }))
    };
  } catch (error) {
    console.error('Search error:', error);
    throw error;
  }
}

// Autocomplete suggestions
export async function autocompleteBusiness(prefix, latitude, longitude) {
  const suggest = {
    business_suggest: {
      prefix,
      completion: {
        field: 'name.suggest',
        size: 10,
        skip_duplicates: true
      }
    }
  };

  try {
    const result = await elasticsearch.search({
      index: BUSINESS_INDEX,
      body: { suggest }
    });

    return result.suggest.business_suggest[0].options.map(opt => ({
      id: opt._source.id,
      name: opt._source.name,
      city: opt._source.city,
      rating: opt._source.rating
    }));
  } catch (error) {
    console.error('Autocomplete error:', error);
    throw error;
  }
}
