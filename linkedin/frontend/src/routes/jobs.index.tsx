import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { jobsApi } from '../services/api';
import type { Job } from '../types';
import { JobCard } from '../components/JobCard';
import { Search, Briefcase, MapPin, Building2 } from 'lucide-react';

export const Route = createFileRoute('/jobs')({
  component: JobsPage,
});

function JobsPage() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [recommendedJobs, setRecommendedJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState({
    location: '',
    is_remote: false,
    employment_type: '',
    experience_level: '',
  });
  const [showFilters, setShowFilters] = useState(false);
  const [activeTab, setActiveTab] = useState<'search' | 'recommended'>('search');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const loadJobs = async () => {
      try {
        const [jobsData, recommendedData] = await Promise.all([
          jobsApi.getJobs(),
          jobsApi.getRecommended(10),
        ]);
        setJobs(jobsData.jobs);
        setRecommendedJobs(recommendedData.jobs);
      } catch (error) {
        console.error('Failed to load jobs:', error);
      }
      setLoading(false);
    };

    loadJobs();
  }, [isAuthenticated, navigate]);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    try {
      const { jobs: searchResults } = await jobsApi.getJobs({
        q: searchQuery || undefined,
        ...filters,
        is_remote: filters.is_remote || undefined,
        employment_type: filters.employment_type || undefined,
        experience_level: filters.experience_level || undefined,
        location: filters.location || undefined,
      });
      setJobs(searchResults);
    } catch (error) {
      console.error('Failed to search jobs:', error);
    }
    setLoading(false);
  };

  if (!isAuthenticated) return null;

  return (
    <main className="max-w-5xl mx-auto px-4 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Sidebar */}
        <div className="lg:col-span-1">
          <div className="card p-4 space-y-3">
            <button
              onClick={() => setActiveTab('search')}
              className={`flex items-center gap-3 w-full p-3 rounded ${
                activeTab === 'search' ? 'bg-blue-50 text-linkedin-blue' : 'hover:bg-gray-100'
              }`}
            >
              <Briefcase className="w-5 h-5" />
              <span className="font-medium">Job search</span>
            </button>
            <button
              onClick={() => setActiveTab('recommended')}
              className={`flex items-center gap-3 w-full p-3 rounded ${
                activeTab === 'recommended' ? 'bg-blue-50 text-linkedin-blue' : 'hover:bg-gray-100'
              }`}
            >
              <Building2 className="w-5 h-5" />
              <span className="font-medium">Recommended for you</span>
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4">
          {/* Search */}
          <div className="card p-4">
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search jobs by title, skill, or company"
                  className="input pl-10"
                />
              </div>
              <button type="submit" className="btn-primary">
                Search
              </button>
            </form>

            <button
              onClick={() => setShowFilters(!showFilters)}
              className="text-sm text-linkedin-blue mt-2 hover:underline"
            >
              {showFilters ? 'Hide filters' : 'Show filters'}
            </button>

            {showFilters && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Location</label>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={filters.location}
                      onChange={(e) => setFilters({ ...filters, location: e.target.value })}
                      placeholder="City, state, or country"
                      className="input pl-9"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Experience Level</label>
                  <select
                    value={filters.experience_level}
                    onChange={(e) => setFilters({ ...filters, experience_level: e.target.value })}
                    className="input"
                  >
                    <option value="">All levels</option>
                    <option value="Entry-Level">Entry Level</option>
                    <option value="Mid-Level">Mid Level</option>
                    <option value="Senior">Senior</option>
                    <option value="Director">Director</option>
                    <option value="Executive">Executive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Employment Type</label>
                  <select
                    value={filters.employment_type}
                    onChange={(e) => setFilters({ ...filters, employment_type: e.target.value })}
                    className="input"
                  >
                    <option value="">All types</option>
                    <option value="Full-time">Full-time</option>
                    <option value="Part-time">Part-time</option>
                    <option value="Contract">Contract</option>
                    <option value="Internship">Internship</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.is_remote}
                      onChange={(e) => setFilters({ ...filters, is_remote: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-linkedin-blue focus:ring-linkedin-blue"
                    />
                    <span className="text-sm font-medium">Remote only</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Job List */}
          <div className="card">
            <div className="p-4 border-b">
              <h2 className="font-semibold">
                {activeTab === 'search'
                  ? `${jobs.length} jobs found`
                  : 'Jobs for you'}
              </h2>
            </div>

            {loading ? (
              <div className="p-8 text-center text-gray-500">Loading jobs...</div>
            ) : (
              <div className="divide-y">
                {(activeTab === 'search' ? jobs : recommendedJobs).length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    <Briefcase className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                    <p>No jobs found</p>
                    <p className="text-sm mt-2">Try adjusting your search or filters</p>
                  </div>
                ) : (
                  (activeTab === 'search' ? jobs : recommendedJobs).map((job) => (
                    <div key={job.id} className="p-4">
                      <JobCard
                        job={job}
                        showMatchScore={activeTab === 'recommended'}
                        matchScore={job.match_score}
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
