/**
 * New Listing Page - Multi-step wizard for creating a new property listing.
 *
 * This component orchestrates the listing creation flow using modular step
 * components and a custom form hook. The wizard guides hosts through:
 * 1. Basic Info - Property type, title, description
 * 2. Location - City, state, country, coordinates
 * 3. Details - Capacity, amenities, house rules
 * 4. Pricing - Price per night, fees, booking settings
 *
 * @module routes/host/listings.new
 */
import { createFileRoute } from '@tanstack/react-router';
import { useAuthStore } from '../../stores/authStore';
import {
  ProgressIndicator,
  StepBasicInfo,
  StepLocation,
  StepDetails,
  StepPricing,
  useListingForm,
} from '../../components/listing-form';

export const Route = createFileRoute('/host/listings/new')({
  component: NewListingPage,
});

/**
 * Renders the new listing creation wizard.
 * Requires the user to be authenticated and be a host.
 *
 * @returns The new listing page component
 */
function NewListingPage() {
  const { user, isAuthenticated } = useAuthStore();
  const {
    step,
    formData,
    isLoading,
    error,
    goToNextStep,
    goToPreviousStep,
    updateField,
    submitForm,
  } = useListingForm();

  // Redirect non-hosts to the become-host page
  if (!isAuthenticated || !user?.is_host) {
    return <NotHostMessage />;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Create a new listing</h1>

      <ProgressIndicator currentStep={step} />

      {error && <ErrorMessage message={error} />}

      {step === 1 && (
        <StepBasicInfo
          formData={formData}
          onUpdate={updateField}
          onNext={goToNextStep}
        />
      )}

      {step === 2 && (
        <StepLocation
          formData={formData}
          onUpdate={updateField}
          onNext={goToNextStep}
          onBack={goToPreviousStep}
        />
      )}

      {step === 3 && (
        <StepDetails
          formData={formData}
          onUpdate={updateField}
          onNext={goToNextStep}
          onBack={goToPreviousStep}
        />
      )}

      {step === 4 && (
        <StepPricing
          formData={formData}
          onUpdate={updateField}
          onNext={goToNextStep}
          onBack={goToPreviousStep}
          isLoading={isLoading}
          onSubmit={submitForm}
        />
      )}
    </div>
  );
}

/**
 * Message shown when a user who is not a host tries to create a listing.
 *
 * @returns A prompt to become a host
 */
function NotHostMessage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-bold mb-4">Become a host first</h1>
      <a href="/become-host" className="btn-primary">
        Become a Host
      </a>
    </div>
  );
}

/**
 * Displays an error message in a styled alert box.
 *
 * @param props - Component props
 * @param props.message - The error message to display
 * @returns An error alert component
 */
function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6">{message}</div>
  );
}
