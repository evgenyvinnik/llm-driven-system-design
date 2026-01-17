/**
 * Experience section component displaying user's work history.
 * Shows a list of professional experiences with company, title, dates, and descriptions.
 *
 * @module components/profile/ExperienceSection
 */
import { Building2, Plus } from 'lucide-react';
import type { Experience } from '../../types';

/**
 * Props for the ExperienceSection component.
 */
interface ExperienceSectionProps {
  /** List of user's work experiences */
  experiences: Experience[];
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Callback when add experience button is clicked */
  onAddExperience?: () => void;
}

/**
 * Formats the date range for an experience entry.
 * Displays start year through end year or "Present" for current positions.
 *
 * @param startDate - The start date of the experience
 * @param endDate - The end date of the experience (optional)
 * @param isCurrent - Whether this is a current position
 * @returns Formatted date range string
 */
function formatDateRange(
  startDate: string,
  endDate: string | undefined,
  isCurrent: boolean
): string {
  const startYear = new Date(startDate).getFullYear();
  const endPart = isCurrent ? 'Present' : new Date(endDate!).getFullYear();
  return `${startYear} - ${endPart}`;
}

/**
 * Displays the "Experience" section of a user's profile.
 * Shows work history entries with company icons, titles, dates, and descriptions.
 * Includes an add button for the profile owner.
 *
 * @param props - Component props
 * @returns The experience section JSX element
 */
export function ExperienceSection({
  experiences,
  isOwnProfile,
  onAddExperience,
}: ExperienceSectionProps) {
  return (
    <div className="card p-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Experience</h2>
        {isOwnProfile && (
          <button
            onClick={onAddExperience}
            className="text-gray-600 hover:bg-gray-100 p-2 rounded-full"
            aria-label="Add experience"
          >
            <Plus className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Experience list or empty state */}
      {experiences.length === 0 ? (
        <p className="text-gray-500">No experience added yet</p>
      ) : (
        <div className="space-y-4">
          {experiences.map((exp) => (
            <ExperienceItem key={exp.id} experience={exp} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Props for the ExperienceItem sub-component.
 */
interface ExperienceItemProps {
  /** The experience entry to display */
  experience: Experience;
}

/**
 * Displays a single experience entry with company logo, title, and details.
 *
 * @param props - Component props
 * @returns The experience item JSX element
 */
function ExperienceItem({ experience }: ExperienceItemProps) {
  return (
    <div className="flex gap-4">
      {/* Company icon placeholder */}
      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
        <Building2 className="w-6 h-6 text-gray-400" />
      </div>

      {/* Experience details */}
      <div>
        <h3 className="font-semibold">{experience.title}</h3>
        <div className="text-gray-700">{experience.company_name}</div>
        <div className="text-sm text-gray-500">
          {formatDateRange(
            experience.start_date,
            experience.end_date,
            experience.is_current
          )}
        </div>
        {experience.description && (
          <p className="mt-2 text-sm text-gray-600">{experience.description}</p>
        )}
      </div>
    </div>
  );
}
