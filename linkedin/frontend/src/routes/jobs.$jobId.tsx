import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { jobsApi } from '../services/api';
import type { Job } from '../types';
import {
  MapPin,
  Clock,
  Building2,
  DollarSign,
  Briefcase,
  Users,
  ArrowLeft,
  ExternalLink,
} from 'lucide-react';

export const Route = createFileRoute('/jobs/$jobId')({
  component: JobDetailPage,
});

function JobDetailPage() {
  const { jobId } = Route.useParams();
  const { isAuthenticated, user } = useAuthStore();
  const navigate = useNavigate();

  const [job, setJob] = useState<Job | null>(null);
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [coverLetter, setCoverLetter] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const loadJob = async () => {
      try {
        const { job: jobData, match_score } = await jobsApi.getJob(parseInt(jobId));
        setJob(jobData);
        setMatchScore(match_score);
      } catch (error) {
        console.error('Failed to load job:', error);
      }
      setLoading(false);
    };

    loadJob();
  }, [jobId, isAuthenticated, navigate]);

  const handleApply = async () => {
    setApplying(true);
    try {
      await jobsApi.apply(parseInt(jobId), { cover_letter: coverLetter || undefined });
      setApplied(true);
      setShowApplyModal(false);
    } catch (error) {
      console.error('Failed to apply:', error);
    }
    setApplying(false);
  };

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

    if (diffDays === 0) return 'Posted today';
    if (diffDays === 1) return 'Posted yesterday';
    if (diffDays < 7) return `Posted ${diffDays} days ago`;
    if (diffDays < 30) return `Posted ${Math.floor(diffDays / 7)} weeks ago`;
    return `Posted on ${date.toLocaleDateString()}`;
  };

  if (!isAuthenticated) return null;

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">Loading job...</div>
      </main>
    );
  }

  if (!job) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">Job not found</div>
      </main>
    );
  }

  const salary = formatSalary(job.salary_min, job.salary_max);

  return (
    <main className="max-w-4xl mx-auto px-4 py-6">
      <Link to="/jobs" className="flex items-center gap-2 text-linkedin-blue mb-4 hover:underline">
        <ArrowLeft className="w-4 h-4" />
        Back to jobs
      </Link>

      <div className="card">
        {/* Header */}
        <div className="p-6 border-b">
          <div className="flex gap-4">
            <div className="w-16 h-16 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
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

            <div className="flex-1">
              <h1 className="text-2xl font-bold">{job.title}</h1>
              <div className="text-lg text-gray-700 mt-1">
                {job.company?.name}
                {job.company?.location && ` - ${job.company.location}`}
              </div>

              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-gray-600">
                {job.location && (
                  <span className="flex items-center gap-1">
                    <MapPin className="w-4 h-4" />
                    {job.location}
                    {job.is_remote && ' (Remote)'}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  {formatDate(job.created_at)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-3">
                {job.employment_type && (
                  <span className="bg-gray-100 px-3 py-1 rounded-full text-sm">
                    {job.employment_type}
                  </span>
                )}
                {job.experience_level && (
                  <span className="bg-gray-100 px-3 py-1 rounded-full text-sm">
                    {job.experience_level}
                  </span>
                )}
                {salary && (
                  <span className="flex items-center gap-1 bg-green-50 text-green-700 px-3 py-1 rounded-full text-sm">
                    <DollarSign className="w-4 h-4" />
                    {salary}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 mt-6">
            {applied ? (
              <button disabled className="btn-primary opacity-50">
                Applied
              </button>
            ) : (
              <button onClick={() => setShowApplyModal(true)} className="btn-primary">
                Apply now
              </button>
            )}
            <button className="btn-secondary">Save</button>

            {matchScore !== null && (
              <div
                className={`ml-auto px-4 py-2 rounded-lg font-semibold ${
                  matchScore >= 70
                    ? 'bg-green-100 text-green-700'
                    : matchScore >= 40
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {matchScore}% Match
              </div>
            )}
          </div>
        </div>

        {/* Job Details */}
        <div className="p-6 space-y-6">
          {/* About the job */}
          <div>
            <h2 className="text-xl font-semibold mb-4">About the job</h2>
            <div className="prose max-w-none whitespace-pre-wrap">{job.description}</div>
          </div>

          {/* Required Skills */}
          {job.required_skills && job.required_skills.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold mb-4">Required Skills</h2>
              <div className="flex flex-wrap gap-2">
                {job.required_skills.map((skill) => (
                  <span
                    key={skill.id}
                    className="bg-blue-50 text-linkedin-blue px-3 py-1 rounded-full text-sm"
                  >
                    {skill.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Job details */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Job Details</h2>
            <div className="grid grid-cols-2 gap-4">
              {job.years_required !== undefined && job.years_required !== null && (
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <Briefcase className="w-6 h-6 text-gray-400" />
                  <div>
                    <div className="text-sm text-gray-500">Experience Required</div>
                    <div className="font-medium">{job.years_required}+ years</div>
                  </div>
                </div>
              )}
              {job.employment_type && (
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <Clock className="w-6 h-6 text-gray-400" />
                  <div>
                    <div className="text-sm text-gray-500">Employment Type</div>
                    <div className="font-medium">{job.employment_type}</div>
                  </div>
                </div>
              )}
              {job.is_remote && (
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <MapPin className="w-6 h-6 text-gray-400" />
                  <div>
                    <div className="text-sm text-gray-500">Work Location</div>
                    <div className="font-medium">Remote</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Company info */}
          {job.company && (
            <div>
              <h2 className="text-xl font-semibold mb-4">About {job.company.name}</h2>
              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg">
                <div className="w-16 h-16 bg-white rounded flex items-center justify-center border">
                  <Building2 className="w-8 h-8 text-gray-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-lg">{job.company.name}</h3>
                  <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-600">
                    {job.company.industry && <span>{job.company.industry}</span>}
                    {job.company.size && (
                      <span className="flex items-center gap-1">
                        <Users className="w-4 h-4" />
                        {job.company.size} employees
                      </span>
                    )}
                  </div>
                  {job.company.description && (
                    <p className="mt-2 text-gray-700">{job.company.description}</p>
                  )}
                  {job.company.website && (
                    <a
                      href={job.company.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-linkedin-blue hover:underline"
                    >
                      Visit website <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Apply Modal */}
      {showApplyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-lg m-4">
            <div className="p-4 border-b">
              <h2 className="text-xl font-semibold">Apply to {job.company?.name}</h2>
            </div>
            <div className="p-4 space-y-4">
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="font-medium">{user?.first_name} {user?.last_name}</div>
                <div className="text-sm text-gray-600">{user?.headline}</div>
                <div className="text-sm text-gray-500">{user?.email}</div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Cover Letter (optional)
                </label>
                <textarea
                  value={coverLetter}
                  onChange={(e) => setCoverLetter(e.target.value)}
                  rows={6}
                  placeholder="Tell the employer why you're a great fit for this role..."
                  className="input"
                />
              </div>
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button onClick={() => setShowApplyModal(false)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={handleApply} disabled={applying} className="btn-primary">
                {applying ? 'Submitting...' : 'Submit Application'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
