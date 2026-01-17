/**
 * Custom hook for managing listing form state and submission.
 * Encapsulates all form state, navigation, and API interaction logic.
 */
import { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { listingsAPI } from '../../services/api';
import { ListingFormData, DEFAULT_FORM_DATA, TOTAL_STEPS } from './types';

/**
 * Return type for the useListingForm hook.
 */
export interface UseListingFormReturn {
  /** Current wizard step (1-indexed) */
  step: number;
  /** Current form data */
  formData: ListingFormData;
  /** Whether the form is being submitted */
  isLoading: boolean;
  /** Error message if submission failed */
  error: string;
  /** Navigate to the next step */
  goToNextStep: () => void;
  /** Navigate to the previous step */
  goToPreviousStep: () => void;
  /** Update a single form field */
  updateField: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
  /** Submit the form to create a new listing */
  submitForm: () => Promise<void>;
}

/**
 * Hook for managing the listing creation form.
 * Handles multi-step navigation, form state, validation, and API submission.
 *
 * @returns Object containing form state and control functions
 *
 * @example
 * ```tsx
 * const { step, formData, updateField, goToNextStep, submitForm } = useListingForm();
 * ```
 */
export function useListingForm(): UseListingFormReturn {
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<ListingFormData>(DEFAULT_FORM_DATA);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Updates a single field in the form data.
   */
  const updateField = useCallback(
    <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  /**
   * Navigates to the next step if not at the end.
   */
  const goToNextStep = useCallback(() => {
    setStep((prev) => Math.min(prev + 1, TOTAL_STEPS));
  }, []);

  /**
   * Navigates to the previous step if not at the beginning.
   */
  const goToPreviousStep = useCallback(() => {
    setStep((prev) => Math.max(prev - 1, 1));
  }, []);

  /**
   * Submits the form to create a new listing.
   * On success, navigates to the edit page for the new listing.
   */
  const submitForm = useCallback(async () => {
    setIsLoading(true);
    setError('');

    try {
      const response = await listingsAPI.create({
        title: formData.title,
        description: formData.description,
        property_type: formData.propertyType,
        room_type: formData.roomType as 'entire_place' | 'private_room' | 'shared_room',
        city: formData.city,
        state: formData.state,
        country: formData.country,
        latitude: parseFloat(formData.latitude) || 40.7128,
        longitude: parseFloat(formData.longitude) || -74.006,
        max_guests: formData.maxGuests,
        bedrooms: formData.bedrooms,
        beds: formData.beds,
        bathrooms: formData.bathrooms,
        amenities: formData.amenities,
        house_rules: formData.houseRules,
        price_per_night: formData.pricePerNight,
        cleaning_fee: formData.cleaningFee,
        instant_book: formData.instantBook,
        minimum_nights: formData.minimumNights,
      });

      navigate({ to: `/host/listings/${response.listing.id}/edit` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create listing');
    } finally {
      setIsLoading(false);
    }
  }, [formData, navigate]);

  return {
    step,
    formData,
    isLoading,
    error,
    goToNextStep,
    goToPreviousStep,
    updateField,
    submitForm,
  };
}
