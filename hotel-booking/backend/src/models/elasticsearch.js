const { Client } = require('@elastic/elasticsearch');
const config = require('../config');

const client = new Client({
  node: config.elasticsearch.url,
});

// Index name for hotels
const HOTELS_INDEX = 'hotels';

// Create or update the hotels index mapping
async function setupIndex() {
  try {
    const indexExists = await client.indices.exists({ index: HOTELS_INDEX });

    if (!indexExists) {
      await client.indices.create({
        index: HOTELS_INDEX,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
          },
          mappings: {
            properties: {
              hotel_id: { type: 'keyword' },
              name: { type: 'text', analyzer: 'standard' },
              description: { type: 'text' },
              city: { type: 'keyword' },
              state: { type: 'keyword' },
              country: { type: 'keyword' },
              address: { type: 'text' },
              location: { type: 'geo_point' },
              star_rating: { type: 'integer' },
              amenities: { type: 'keyword' },
              images: { type: 'keyword' },
              check_in_time: { type: 'keyword' },
              check_out_time: { type: 'keyword' },
              is_active: { type: 'boolean' },
              room_types: {
                type: 'nested',
                properties: {
                  id: { type: 'keyword' },
                  name: { type: 'text' },
                  capacity: { type: 'integer' },
                  base_price: { type: 'float' },
                  amenities: { type: 'keyword' },
                },
              },
              min_price: { type: 'float' },
              max_capacity: { type: 'integer' },
              avg_rating: { type: 'float' },
              review_count: { type: 'integer' },
            },
          },
        },
      });
      console.log('Elasticsearch hotels index created');
    }
  } catch (error) {
    console.error('Error setting up Elasticsearch index:', error);
  }
}

// Index a hotel document
async function indexHotel(hotel) {
  try {
    await client.index({
      index: HOTELS_INDEX,
      id: hotel.hotel_id,
      body: hotel,
      refresh: true,
    });
  } catch (error) {
    console.error('Error indexing hotel:', error);
    throw error;
  }
}

// Remove a hotel from the index
async function removeHotel(hotelId) {
  try {
    await client.delete({
      index: HOTELS_INDEX,
      id: hotelId,
      refresh: true,
    });
  } catch (error) {
    if (error.statusCode !== 404) {
      console.error('Error removing hotel from index:', error);
      throw error;
    }
  }
}

// Search hotels
async function searchHotels(params) {
  const {
    city,
    country,
    guests,
    minStars,
    maxPrice,
    minPrice,
    amenities,
    lat,
    lon,
    radius = '50km',
    page = 1,
    limit = 20,
    sortBy = 'relevance',
  } = params;

  const must = [];
  const filter = [];

  // Location filter (city or geo-distance)
  if (city) {
    must.push({ match: { city: city } });
  }

  if (country) {
    filter.push({ term: { country: country } });
  }

  if (lat && lon) {
    filter.push({
      geo_distance: {
        distance: radius,
        location: { lat: parseFloat(lat), lon: parseFloat(lon) },
      },
    });
  }

  // Guest capacity filter
  if (guests) {
    filter.push({ range: { max_capacity: { gte: parseInt(guests) } } });
  }

  // Star rating filter
  if (minStars) {
    filter.push({ range: { star_rating: { gte: parseInt(minStars) } } });
  }

  // Price filters
  if (minPrice) {
    filter.push({ range: { min_price: { gte: parseFloat(minPrice) } } });
  }
  if (maxPrice) {
    filter.push({ range: { min_price: { lte: parseFloat(maxPrice) } } });
  }

  // Amenities filter
  if (amenities && amenities.length > 0) {
    const amenityList = Array.isArray(amenities) ? amenities : [amenities];
    filter.push({ terms: { amenities: amenityList } });
  }

  // Only active hotels
  filter.push({ term: { is_active: true } });

  // Build sort
  let sort = [];
  switch (sortBy) {
    case 'price_asc':
      sort = [{ min_price: 'asc' }];
      break;
    case 'price_desc':
      sort = [{ min_price: 'desc' }];
      break;
    case 'rating':
      sort = [{ avg_rating: 'desc' }];
      break;
    case 'stars':
      sort = [{ star_rating: 'desc' }];
      break;
    default:
      sort = [{ _score: 'desc' }, { avg_rating: 'desc' }];
  }

  const query = {
    bool: {
      must: must.length > 0 ? must : [{ match_all: {} }],
      filter,
    },
  };

  try {
    const result = await client.search({
      index: HOTELS_INDEX,
      body: {
        from: (page - 1) * limit,
        size: limit,
        query,
        sort,
      },
    });

    const hits = result.hits.hits.map((hit) => ({
      ...hit._source,
      _score: hit._score,
    }));

    return {
      hotels: hits,
      total: result.hits.total.value,
      page,
      limit,
      totalPages: Math.ceil(result.hits.total.value / limit),
    };
  } catch (error) {
    console.error('Error searching hotels:', error);
    throw error;
  }
}

module.exports = {
  client,
  HOTELS_INDEX,
  setupIndex,
  indexHotel,
  removeHotel,
  searchHotels,
};
