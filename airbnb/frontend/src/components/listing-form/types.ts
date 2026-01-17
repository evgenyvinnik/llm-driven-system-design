/**
 * Types and constants for the listing creation/edit form.
 * This module provides shared type definitions used across all listing form step components.
 */

/** Available property types for a listing */
export const PROPERTY_TYPES = [
  'apartment',
  'house',
  'room',
  'studio',
  'villa',
  'cabin',
  'cottage',
  'loft',
] as const;

/** Room type options defining how much of the space guests get */
export const ROOM_TYPES = ['entire_place', 'private_room', 'shared_room'] as const;

/** Available amenities that can be added to a listing */
export const AMENITIES = [
  'wifi',
  'kitchen',
  'air_conditioning',
  'heating',
  'washer',
  'dryer',
  'tv',
  'pool',
  'hot_tub',
  'parking',
  'gym',
  'workspace',
  'coffee_maker',
  'fireplace',
] as const;

/** Total number of steps in the listing creation wizard */
export const TOTAL_STEPS = 4;

/** Type for property type values */
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Type for room type values */
export type RoomType = (typeof ROOM_TYPES)[number];

/** Type for amenity values */
export type Amenity = (typeof AMENITIES)[number];

/**
 * Form data for creating or editing a listing.
 * Contains all fields needed across all wizard steps.
 */
export interface ListingFormData {
  // Step 1: Basic Info
  title: string;
  description: string;
  propertyType: PropertyType;
  roomType: RoomType;

  // Step 2: Location
  city: string;
  state: string;
  country: string;
  latitude: string;
  longitude: string;

  // Step 3: Details
  maxGuests: number;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  amenities: string[];
  houseRules: string;

  // Step 4: Pricing
  pricePerNight: number;
  cleaningFee: number;
  instantBook: boolean;
  minimumNights: number;
}

/**
 * Props passed to each step component for navigation.
 */
export interface StepNavigationProps {
  /** Callback to move to the next step */
  onNext: () => void;
  /** Callback to move to the previous step (undefined for first step) */
  onBack?: () => void;
}

/**
 * Default values for a new listing form.
 */
export const DEFAULT_FORM_DATA: ListingFormData = {
  title: '',
  description: '',
  propertyType: 'apartment',
  roomType: 'entire_place',
  city: '',
  state: '',
  country: '',
  latitude: '',
  longitude: '',
  maxGuests: 2,
  bedrooms: 1,
  beds: 1,
  bathrooms: 1,
  amenities: [],
  houseRules: '',
  pricePerNight: 100,
  cleaningFee: 50,
  instantBook: true,
  minimumNights: 1,
};
