const express = require('express');
const hotelService = require('../services/hotelService');
const roomService = require('../services/roomService');
const reviewService = require('../services/reviewService');
const searchService = require('../services/searchService');
const { authenticate, optionalAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Search hotels (public)
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const {
      city,
      country,
      checkIn,
      checkOut,
      guests,
      rooms,
      minStars,
      maxPrice,
      minPrice,
      amenities,
      lat,
      lon,
      radius,
      page,
      limit,
      sortBy,
    } = req.query;

    const result = await searchService.searchHotels({
      city,
      country,
      checkIn,
      checkOut,
      guests: guests ? parseInt(guests) : undefined,
      rooms: rooms ? parseInt(rooms) : undefined,
      minStars,
      maxPrice,
      minPrice,
      amenities: amenities ? amenities.split(',') : undefined,
      lat,
      lon,
      radius,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      sortBy,
    });

    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get hotel by ID with availability (public)
router.get('/:hotelId', optionalAuth, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { checkIn, checkOut, guests } = req.query;

    const hotel = await searchService.getHotelWithAvailability(
      hotelId,
      checkIn,
      checkOut,
      guests ? parseInt(guests) : 2
    );

    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    res.json(hotel);
  } catch (error) {
    console.error('Get hotel error:', error);
    res.status(500).json({ error: 'Failed to get hotel' });
  }
});

// Create hotel (hotel admin only)
router.post('/', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const hotel = await hotelService.createHotel(req.body, req.user.id);
    res.status(201).json(hotel);
  } catch (error) {
    console.error('Create hotel error:', error);
    res.status(500).json({ error: 'Failed to create hotel' });
  }
});

// Update hotel (hotel admin only, must own)
router.put('/:hotelId', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const hotel = await hotelService.updateHotel(req.params.hotelId, req.body, req.user.id);
    res.json(hotel);
  } catch (error) {
    console.error('Update hotel error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update hotel' });
  }
});

// Delete hotel (hotel admin only, must own)
router.delete('/:hotelId', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    await hotelService.deleteHotel(req.params.hotelId, req.user.id);
    res.json({ message: 'Hotel deleted successfully' });
  } catch (error) {
    console.error('Delete hotel error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete hotel' });
  }
});

// Get my hotels (hotel admin)
router.get('/admin/my-hotels', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const hotels = await hotelService.getHotelsByOwner(req.user.id);
    res.json(hotels);
  } catch (error) {
    console.error('Get my hotels error:', error);
    res.status(500).json({ error: 'Failed to get hotels' });
  }
});

// Room types routes
// Get room types for a hotel (public)
router.get('/:hotelId/rooms', async (req, res) => {
  try {
    const rooms = await roomService.getRoomTypesByHotel(req.params.hotelId);
    res.json(rooms);
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({ error: 'Failed to get room types' });
  }
});

// Create room type (hotel admin)
router.post('/:hotelId/rooms', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const room = await roomService.createRoomType(req.params.hotelId, req.body, req.user.id);
    res.status(201).json(room);
  } catch (error) {
    console.error('Create room error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create room type' });
  }
});

// Update room type (hotel admin)
router.put('/rooms/:roomTypeId', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const room = await roomService.updateRoomType(req.params.roomTypeId, req.body, req.user.id);
    res.json(room);
  } catch (error) {
    console.error('Update room error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update room type' });
  }
});

// Delete room type (hotel admin)
router.delete('/rooms/:roomTypeId', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    await roomService.deleteRoomType(req.params.roomTypeId, req.user.id);
    res.json({ message: 'Room type deleted successfully' });
  } catch (error) {
    console.error('Delete room error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete room type' });
  }
});

// Set price override (hotel admin)
router.post('/rooms/:roomTypeId/pricing', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
    const { date, price } = req.body;
    const override = await roomService.setPriceOverride(req.params.roomTypeId, date, price, req.user.id);
    res.json(override);
  } catch (error) {
    console.error('Set price override error:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to set price override' });
  }
});

// Get prices for date range
router.get('/rooms/:roomTypeId/pricing', async (req, res) => {
  try {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn and checkOut dates required' });
    }
    const prices = await roomService.getPricesForRange(req.params.roomTypeId, checkIn, checkOut);
    res.json(prices);
  } catch (error) {
    console.error('Get prices error:', error);
    res.status(500).json({ error: 'Failed to get prices' });
  }
});

// Reviews routes
// Get reviews for a hotel (public)
router.get('/:hotelId/reviews', async (req, res) => {
  try {
    const { page, limit } = req.query;
    const reviews = await reviewService.getReviewsByHotel(
      req.params.hotelId,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 10
    );
    res.json(reviews);
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Get review stats for a hotel (public)
router.get('/:hotelId/reviews/stats', async (req, res) => {
  try {
    const stats = await reviewService.getReviewStats(req.params.hotelId);
    res.json(stats);
  } catch (error) {
    console.error('Get review stats error:', error);
    res.status(500).json({ error: 'Failed to get review stats' });
  }
});

module.exports = router;
