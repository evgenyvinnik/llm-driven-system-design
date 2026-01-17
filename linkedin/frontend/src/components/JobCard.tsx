/**
 * Job card component for displaying job listings.
 * Shows job title, company, location, salary, and match score.
 * Used in job search results and recommendations.
 *
 * @module components/JobCard
 */
import { Link } from '@tanstack/react-router';
import type { Job } from '../types';
import { MapPin, Clock, Building2, DollarSign } from 'lucide-react';

/**
 * Props for the JobCard component.
 */
interface JobCardProps {
  job: Job;
  showMatchScore?: boolean;
  matchScore?: number;
}

/**
 * Displays a job listing with company info and key details.
 * Links to the full job detail page when clicked.
 * Optionally shows a color-coded match score percentage.
 *
 * @param job - The job data to display
 * @param showMatchScore - Whether to show the match score badge
 * @param matchScore - Match score percentage (0-100)
 */
export function JobCard({ job, showMatchScore, matchScore }: JobCardProps) {
  const formatSalary = (min?: number, max?: number) => {
    if (!min && !max) return null;
    const format = (n: number) => `$${(n / 1000).toFixed(0)}k`;
    if (min && max) return `${format(min)} - ${format(max)}`;
    if (min) return `${format(min)}+`;
    return `Up to ${format(max!)}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString();
  };

  const salary = formatSalary(job.salary_min, job.salary_max);

  return (
    <Link
      to="/jobs/$jobId"
      params={{ jobId: String(job.id) }}
      className="block card p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex gap-4">
        <div className="w-14 h-14 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
          {job.company?.logo_url ? (
            <img
              src={job.company.logo_url}
              alt={job.company.name}
              className="w-full h-full object-cover rounded"
            />
          ) : (
            <Building2 className="w-8 h-8 text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-linkedin-blue hover:underline truncate">
            {job.title}
          </h3>
          <div className="text-sm text-gray-700">{job.company?.name}</div>

          <div className="flex items-center gap-3 mt-1 text-sm text-gray-600">
            {job.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" />
                {job.location}
                {job.is_remote && ' (Remote)'}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-500">
            {job.employment_type && (
              <span className="bg-gray-100 px-2 py-1 rounded">{job.employment_type}</span>
            )}
            {job.experience_level && (
              <span className="bg-gray-100 px-2 py-1 rounded">{job.experience_level}</span>
            )}
            {salary && (
              <span className="flex items-center gap-1 bg-green-50 text-green-700 px-2 py-1 rounded">
                <DollarSign className="w-3 h-3" />
                {salary}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Clock className="w-3 h-3" />
              {formatDate(job.created_at)}
            </span>

            {showMatchScore && matchScore !== undefined && (
              <span
                className={`text-xs font-semibold px-2 py-1 rounded ${
                  matchScore >= 70
                    ? 'bg-green-100 text-green-700'
                    : matchScore >= 40
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {matchScore}% Match
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
