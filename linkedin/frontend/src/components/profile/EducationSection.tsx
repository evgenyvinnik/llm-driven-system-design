/**
 * Education section component displaying user's academic history.
 * Shows a list of education entries with school, degree, field of study, and dates.
 *
 * @module components/profile/EducationSection
 */
import { Building2, Plus } from 'lucide-react';
import type { Education } from '../../types';

/**
 * Props for the EducationSection component.
 */
interface EducationSectionProps {
  /** List of user's education entries */
  education: Education[];
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Callback when add education button is clicked */
  onAddEducation?: () => void;
}

/**
 * Formats the year range for an education entry.
 * Displays start year through end year or "Present" for ongoing education.
 *
 * @param startYear - The start year (optional)
 * @param endYear - The end year (optional)
 * @returns Formatted year range string or null if no years provided
 */
function formatYearRange(
  startYear: number | undefined,
  endYear: number | undefined
): string | null {
  if (!startYear && !endYear) {
    return null;
  }
  return `${startYear || ''} - ${endYear || 'Present'}`;
}

/**
 * Displays the "Education" section of a user's profile.
 * Shows academic history entries with school logos, degrees, and dates.
 * Includes an add button for the profile owner.
 *
 * @param props - Component props
 * @returns The education section JSX element
 */
export function EducationSection({
  education,
  isOwnProfile,
  onAddEducation,
}: EducationSectionProps) {
  return (
    <div className="card p-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Education</h2>
        {isOwnProfile && (
          <button
            onClick={onAddEducation}
            className="text-gray-600 hover:bg-gray-100 p-2 rounded-full"
            aria-label="Add education"
          >
            <Plus className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Education list or empty state */}
      {education.length === 0 ? (
        <p className="text-gray-500">No education added yet</p>
      ) : (
        <div className="space-y-4">
          {education.map((edu) => (
            <EducationItem key={edu.id} education={edu} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Props for the EducationItem sub-component.
 */
interface EducationItemProps {
  /** The education entry to display */
  education: Education;
}

/**
 * Displays a single education entry with school logo, degree, and details.
 *
 * @param props - Component props
 * @returns The education item JSX element
 */
function EducationItem({ education }: EducationItemProps) {
  const yearRange = formatYearRange(education.start_year, education.end_year);

  return (
    <div className="flex gap-4">
      {/* School icon placeholder */}
      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
        <Building2 className="w-6 h-6 text-gray-400" />
      </div>

      {/* Education details */}
      <div>
        <h3 className="font-semibold">{education.school_name}</h3>
        {education.degree && (
          <div className="text-gray-700">
            {education.degree}
            {education.field_of_study && `, ${education.field_of_study}`}
          </div>
        )}
        {yearRange && <div className="text-sm text-gray-500">{yearRange}</div>}
      </div>
    </div>
  );
}
