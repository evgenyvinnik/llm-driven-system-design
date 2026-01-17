import { Link } from '@tanstack/react-router';
import { MapPin, Phone, Globe, Clock } from 'lucide-react';
import type { Business, BusinessHours } from '../../types';

/** Days of the week for displaying business hours */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Props for the BusinessSidebar component.
 */
interface BusinessSidebarProps {
  /** The business to display sidebar information for */
  business: Business;
}

/**
 * BusinessSidebar displays contact information, business hours,
 * and claim business options in a sticky sidebar layout.
 *
 * @param props - Component properties
 * @returns The business sidebar component
 */
export function BusinessSidebar({ business }: BusinessSidebarProps) {
  const openStatus = isOpenNow(business.hours);

  return (
    <aside className="lg:w-80">
      <div className="bg-white rounded-lg shadow p-6 sticky top-4">
        {/* Contact Info */}
        <ContactInfo business={business} />

        {/* Hours */}
        {business.hours && business.hours.length > 0 && (
          <BusinessHoursSection hours={business.hours} openStatus={openStatus} />
        )}

        {/* Claim Business */}
        {!business.is_claimed && <ClaimBusinessSection />}
      </div>
    </aside>
  );
}

/**
 * Props for ContactInfo component.
 */
interface ContactInfoProps {
  /** The business to display contact info for */
  business: Business;
}

/**
 * ContactInfo displays the business address, phone, and website.
 *
 * @param props - Component properties
 * @returns Contact information section
 */
function ContactInfo({ business }: ContactInfoProps) {
  return (
    <div className="space-y-4 mb-6">
      {/* Address */}
      <div className="flex items-start gap-3">
        <MapPin className="w-5 h-5 text-gray-500 mt-0.5" />
        <div>
          <p className="text-gray-900">{business.address}</p>
          <p className="text-gray-600">
            {business.city}, {business.state} {business.zip_code}
          </p>
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(
              `${business.address}, ${business.city}, ${business.state}`
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-yelp-blue hover:underline text-sm"
          >
            Get Directions
          </a>
        </div>
      </div>

      {/* Phone */}
      {business.phone && (
        <div className="flex items-center gap-3">
          <Phone className="w-5 h-5 text-gray-500" />
          <a href={`tel:${business.phone}`} className="text-yelp-blue hover:underline">
            {business.phone}
          </a>
        </div>
      )}

      {/* Website */}
      {business.website && (
        <div className="flex items-center gap-3">
          <Globe className="w-5 h-5 text-gray-500" />
          <a
            href={business.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-yelp-blue hover:underline truncate"
          >
            {business.website.replace(/^https?:\/\//, '')}
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Props for BusinessHoursSection component.
 */
interface BusinessHoursSectionProps {
  /** Array of business hours for each day */
  hours: BusinessHours[];
  /** Whether the business is currently open (null if unknown) */
  openStatus: boolean | null;
}

/**
 * BusinessHoursSection displays the weekly business hours with open/closed status.
 *
 * @param props - Component properties
 * @returns Business hours section
 */
function BusinessHoursSection({ hours, openStatus }: BusinessHoursSectionProps) {
  return (
    <div className="border-t pt-6">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="w-5 h-5 text-gray-500" />
        <h3 className="font-semibold">Hours</h3>
        {openStatus !== null && (
          <span className={`text-sm ${openStatus ? 'text-green-600' : 'text-red-600'}`}>
            {openStatus ? 'Open Now' : 'Closed'}
          </span>
        )}
      </div>
      <div className="space-y-2 text-sm">
        {hours.map((h) => (
          <div key={h.day_of_week} className="flex justify-between">
            <span className="text-gray-600">{DAYS[h.day_of_week]}</span>
            <span className="text-gray-900">
              {h.is_closed ? 'Closed' : `${formatTime(h.open_time)} - ${formatTime(h.close_time)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * ClaimBusinessSection displays a prompt for unclaimed businesses.
 *
 * @returns Claim business section
 */
function ClaimBusinessSection() {
  return (
    <div className="border-t pt-6 mt-6">
      <p className="text-sm text-gray-600 mb-2">Is this your business?</p>
      <Link to="/login" className="text-yelp-blue hover:underline text-sm font-medium">
        Claim this business
      </Link>
    </div>
  );
}

/**
 * Formats a 24-hour time string to 12-hour format with AM/PM.
 *
 * @param time - Time string in HH:MM format
 * @returns Formatted time string (e.g., "9:00 AM")
 */
function formatTime(time: string): string {
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours);
  const period = h >= 12 ? 'PM' : 'AM';
  const formattedHour = h % 12 || 12;
  return `${formattedHour}:${minutes} ${period}`;
}

/**
 * Determines if a business is currently open based on its hours.
 *
 * @param hours - Array of business hours (optional)
 * @returns true if open, false if closed, null if hours unavailable
 */
function isOpenNow(hours?: BusinessHours[]): boolean | null {
  if (!hours) return null;

  const now = new Date();
  const dayOfWeek = now.getDay();
  const currentHours = hours.find((h) => h.day_of_week === dayOfWeek);

  if (!currentHours || currentHours.is_closed) return false;

  const currentTime = now.toTimeString().slice(0, 5);
  return currentTime >= currentHours.open_time && currentTime <= currentHours.close_time;
}
