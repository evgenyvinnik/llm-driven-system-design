import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { listingsAPI } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { getPropertyTypeLabel, getRoomTypeLabel, getAmenityLabel } from '../../utils/helpers';

export const Route = createFileRoute('/host/listings/new')({
  component: NewListingPage,
});

const PROPERTY_TYPES = ['apartment', 'house', 'room', 'studio', 'villa', 'cabin', 'cottage', 'loft'];
const ROOM_TYPES = ['entire_place', 'private_room', 'shared_room'];
const AMENITIES = ['wifi', 'kitchen', 'air_conditioning', 'heating', 'washer', 'dryer', 'tv', 'pool', 'hot_tub', 'parking', 'gym', 'workspace', 'coffee_maker', 'fireplace'];

function NewListingPage() {
  const { user, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [propertyType, setPropertyType] = useState('apartment');
  const [roomType, setRoomType] = useState('entire_place');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [maxGuests, setMaxGuests] = useState(2);
  const [bedrooms, setBedrooms] = useState(1);
  const [beds, setBeds] = useState(1);
  const [bathrooms, setBathrooms] = useState(1);
  const [amenities, setAmenities] = useState<string[]>([]);
  const [houseRules, setHouseRules] = useState('');
  const [pricePerNight, setPricePerNight] = useState(100);
  const [cleaningFee, setCleaningFee] = useState(50);
  const [instantBook, setInstantBook] = useState(true);
  const [minimumNights, setMinimumNights] = useState(1);

  const toggleAmenity = (amenity: string) => {
    setAmenities((prev) =>
      prev.includes(amenity) ? prev.filter((a) => a !== amenity) : [...prev, amenity]
    );
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    setError('');

    try {
      const response = await listingsAPI.create({
        title,
        description,
        property_type: propertyType,
        room_type: roomType as 'entire_place' | 'private_room' | 'shared_room',
        city,
        state,
        country,
        latitude: parseFloat(latitude) || 40.7128,
        longitude: parseFloat(longitude) || -74.0060,
        max_guests: maxGuests,
        bedrooms,
        beds,
        bathrooms,
        amenities,
        house_rules: houseRules,
        price_per_night: pricePerNight,
        cleaning_fee: cleaningFee,
        instant_book: instantBook,
        minimum_nights: minimumNights,
      });

      navigate({ to: `/host/listings/${response.listing.id}/edit` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create listing');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isAuthenticated || !user?.is_host) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Become a host first</h1>
        <a href="/become-host" className="btn-primary">
          Become a Host
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Create a new listing</h1>

      {/* Progress */}
      <div className="flex gap-2 mb-8">
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            className={`flex-1 h-1 rounded ${s <= step ? 'bg-airbnb' : 'bg-gray-200'}`}
          />
        ))}
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6">{error}</div>
      )}

      {/* Step 1: Basic Info */}
      {step === 1 && (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Tell us about your place</h2>

          <div>
            <label className="block text-sm font-medium mb-2">Property type</label>
            <select
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              className="w-full input-field"
            >
              {PROPERTY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {getPropertyTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Room type</label>
            <select
              value={roomType}
              onChange={(e) => setRoomType(e.target.value)}
              className="w-full input-field"
            >
              {ROOM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {getRoomTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cozy apartment in downtown..."
              className="w-full input-field"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your space..."
              rows={4}
              className="w-full input-field"
            />
          </div>

          <button
            onClick={() => setStep(2)}
            disabled={!title}
            className="btn-primary disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {/* Step 2: Location */}
      {step === 2 && (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Where is your place located?</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">State/Province</label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full input-field"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Country</label>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full input-field"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Latitude</label>
              <input
                type="number"
                step="any"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="40.7128"
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Longitude</label>
              <input
                type="number"
                step="any"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="-74.0060"
                className="w-full input-field"
              />
            </div>
          </div>

          <div className="flex gap-4">
            <button onClick={() => setStep(1)} className="btn-secondary">
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={!city || !country}
              className="btn-primary disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Details */}
      {step === 3 && (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Share some details</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Max guests</label>
              <input
                type="number"
                min={1}
                value={maxGuests}
                onChange={(e) => setMaxGuests(parseInt(e.target.value) || 1)}
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Bedrooms</label>
              <input
                type="number"
                min={0}
                value={bedrooms}
                onChange={(e) => setBedrooms(parseInt(e.target.value) || 0)}
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Beds</label>
              <input
                type="number"
                min={1}
                value={beds}
                onChange={(e) => setBeds(parseInt(e.target.value) || 1)}
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Bathrooms</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={bathrooms}
                onChange={(e) => setBathrooms(parseFloat(e.target.value) || 1)}
                className="w-full input-field"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Amenities</label>
            <div className="flex flex-wrap gap-2">
              {AMENITIES.map((amenity) => (
                <button
                  key={amenity}
                  type="button"
                  onClick={() => toggleAmenity(amenity)}
                  className={`px-3 py-2 rounded-lg text-sm ${
                    amenities.includes(amenity)
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {getAmenityLabel(amenity)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">House rules</label>
            <textarea
              value={houseRules}
              onChange={(e) => setHouseRules(e.target.value)}
              placeholder="No smoking, no parties..."
              rows={3}
              className="w-full input-field"
            />
          </div>

          <div className="flex gap-4">
            <button onClick={() => setStep(2)} className="btn-secondary">
              Back
            </button>
            <button onClick={() => setStep(4)} className="btn-primary">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Pricing */}
      {step === 4 && (
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Set your price</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Price per night ($)</label>
              <input
                type="number"
                min={10}
                value={pricePerNight}
                onChange={(e) => setPricePerNight(parseInt(e.target.value) || 0)}
                className="w-full input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Cleaning fee ($)</label>
              <input
                type="number"
                min={0}
                value={cleaningFee}
                onChange={(e) => setCleaningFee(parseInt(e.target.value) || 0)}
                className="w-full input-field"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Minimum nights</label>
            <input
              type="number"
              min={1}
              value={minimumNights}
              onChange={(e) => setMinimumNights(parseInt(e.target.value) || 1)}
              className="w-full input-field"
            />
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={instantBook}
              onChange={(e) => setInstantBook(e.target.checked)}
              className="w-5 h-5"
            />
            <div>
              <span className="font-medium">Instant Book</span>
              <p className="text-sm text-gray-500">Allow guests to book immediately without approval</p>
            </div>
          </label>

          <div className="flex gap-4">
            <button onClick={() => setStep(3)} className="btn-secondary">
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={isLoading}
              className="btn-primary disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create Listing'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
