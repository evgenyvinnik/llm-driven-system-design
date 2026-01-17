/**
 * Profile about section component displaying the user's summary/bio.
 * Shows the "About" card with the user's professional summary text.
 *
 * @module components/profile/ProfileAbout
 */

/**
 * Props for the ProfileAbout component.
 */
interface ProfileAboutProps {
  /** The user's summary/bio text */
  summary: string;
}

/**
 * Displays the "About" section of a user's profile.
 * Shows a card with the user's professional summary text.
 * Only renders if the summary is provided and not empty.
 *
 * @param props - Component props
 * @returns The about section JSX element or null if no summary
 */
export function ProfileAbout({ summary }: ProfileAboutProps) {
  if (!summary) {
    return null;
  }

  return (
    <div className="card p-6">
      <h2 className="text-xl font-semibold mb-4">About</h2>
      <p className="whitespace-pre-wrap">{summary}</p>
    </div>
  );
}
