import { Link } from '@tanstack/react-router';
import { Save } from 'lucide-react';

/**
 * Form data structure for business information.
 */
export interface BusinessFormData {
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  phone: string;
  website: string;
  email: string;
  price_level: number;
}

/**
 * Props for the BusinessInfoForm component.
 */
interface BusinessInfoFormProps {
  /** Current form data */
  formData: BusinessFormData;
  /** Callback when a form field changes */
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  /** Callback when form is submitted */
  onSubmit: (e: React.FormEvent) => void;
  /** Whether the form is currently saving */
  isSaving: boolean;
  /** Success message to display (if any) */
  success?: string | null;
  /** Error message to display (if any) */
  error?: string | null;
  /** Business slug for the view public page link */
  businessSlug: string;
}

/**
 * BusinessInfoForm renders a comprehensive form for editing business details
 * including name, description, contact info, and address.
 *
 * @param props - Component properties
 * @returns Business info form component
 */
export function BusinessInfoForm({
  formData,
  onChange,
  onSubmit,
  isSaving,
  success,
  error,
  businessSlug,
}: BusinessInfoFormProps) {
  return (
    <form onSubmit={onSubmit} className="bg-white rounded-lg shadow p-8">
      {/* Success Message */}
      {success && (
        <div className="bg-green-50 text-green-600 px-4 py-3 rounded-md text-sm mb-6">
          {success}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-md text-sm mb-6">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* Basic Info Section */}
        <BasicInfoSection formData={formData} onChange={onChange} />

        {/* Contact Info Section */}
        <ContactInfoSection formData={formData} onChange={onChange} />

        {/* Address Section */}
        <AddressSection formData={formData} onChange={onChange} />

        {/* Action Buttons */}
        <FormActions isSaving={isSaving} businessSlug={businessSlug} />
      </div>
    </form>
  );
}

/**
 * Props for form section components.
 */
interface FormSectionProps {
  formData: BusinessFormData;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
}

/**
 * BasicInfoSection renders the business name and description fields.
 */
function BasicInfoSection({ formData, onChange }: FormSectionProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Business Name
        </label>
        <input
          type="text"
          name="name"
          value={formData.name}
          onChange={onChange}
          className="input-field"
          required
        />
      </div>

      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          name="description"
          value={formData.description}
          onChange={onChange}
          className="input-field h-24"
        />
      </div>
    </div>
  );
}

/**
 * ContactInfoSection renders phone, website, email, and price level fields.
 */
function ContactInfoSection({ formData, onChange }: FormSectionProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Phone
        </label>
        <input
          type="tel"
          name="phone"
          value={formData.phone}
          onChange={onChange}
          className="input-field"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Website
        </label>
        <input
          type="url"
          name="website"
          value={formData.website}
          onChange={onChange}
          className="input-field"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Email
        </label>
        <input
          type="email"
          name="email"
          value={formData.email}
          onChange={onChange}
          className="input-field"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Price Level
        </label>
        <select
          name="price_level"
          value={formData.price_level}
          onChange={onChange}
          className="input-field"
        >
          <option value={1}>$ - Budget</option>
          <option value={2}>$$ - Moderate</option>
          <option value={3}>$$$ - Upscale</option>
          <option value={4}>$$$$ - Premium</option>
        </select>
      </div>
    </div>
  );
}

/**
 * AddressSection renders the address fields including street, city, state, and ZIP.
 */
function AddressSection({ formData, onChange }: FormSectionProps) {
  return (
    <div>
      <h3 className="font-medium text-gray-700 mb-2">Address</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <input
            type="text"
            name="address"
            value={formData.address}
            onChange={onChange}
            className="input-field"
            placeholder="Street Address"
            required
          />
        </div>
        <input
          type="text"
          name="city"
          value={formData.city}
          onChange={onChange}
          className="input-field"
          placeholder="City"
          required
        />
        <div className="flex gap-2">
          <input
            type="text"
            name="state"
            value={formData.state}
            onChange={onChange}
            className="input-field"
            placeholder="State"
            required
          />
          <input
            type="text"
            name="zip_code"
            value={formData.zip_code}
            onChange={onChange}
            className="input-field"
            placeholder="ZIP"
            required
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Props for FormActions component.
 */
interface FormActionsProps {
  /** Whether the form is currently saving */
  isSaving: boolean;
  /** Business slug for the view public page link */
  businessSlug: string;
}

/**
 * FormActions renders the save and view public page buttons.
 */
function FormActions({ isSaving, businessSlug }: FormActionsProps) {
  return (
    <div className="flex gap-4">
      <button
        type="submit"
        disabled={isSaving}
        className="btn-primary flex items-center gap-2 disabled:opacity-50"
      >
        <Save className="w-4 h-4" />
        {isSaving ? 'Saving...' : 'Save Changes'}
      </button>
      <Link
        to="/business/$slug"
        params={{ slug: businessSlug }}
        className="btn-outline"
      >
        View Public Page
      </Link>
    </div>
  );
}
