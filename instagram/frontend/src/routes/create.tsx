import { useState, useRef } from 'react';
import { createFileRoute, useNavigate, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { postsApi, storiesApi } from '../services/api';
import { Button } from '../components/Button';
import { FILTERS, type Filter } from '../types';

export const Route = createFileRoute('/create')({
  component: CreatePage,
});

function CreatePage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [caption, setCaption] = useState('');
  const [location, setLocation] = useState('');
  const [isStory, setIsStory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    if (isStory && selectedFiles.length > 1) {
      setError('Stories can only have one image');
      return;
    }

    setFiles(selectedFiles);
    setFilters(selectedFiles.map(() => 'none'));

    // Create previews
    const newPreviews: string[] = [];
    selectedFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        newPreviews.push(e.target?.result as string);
        if (newPreviews.length === selectedFiles.length) {
          setPreviews(newPreviews);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFilterChange = (filter: Filter) => {
    setFilters((prev) => {
      const newFilters = [...prev];
      newFilters[currentIndex] = filter;
      return newFilters;
    });
  };

  const handleSubmit = async () => {
    if (files.length === 0) {
      setError('Please select at least one image');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const formData = new FormData();

      if (isStory) {
        formData.append('media', files[0]);
        formData.append('filter', filters[0]);
        await storiesApi.create(formData);
      } else {
        files.forEach((file) => {
          formData.append('media', file);
        });
        formData.append('caption', caption);
        if (location) formData.append('location', location);
        formData.append('filters', JSON.stringify(filters));
        await postsApi.create(formData);
      }

      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setLoading(false);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setFilters((prev) => prev.filter((_, i) => i !== index));
    if (currentIndex >= index && currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 text-center">Create new {isStory ? 'story' : 'post'}</h1>

      {/* Toggle between post and story */}
      <div className="flex justify-center gap-4 mb-6">
        <button
          onClick={() => setIsStory(false)}
          className={`px-4 py-2 rounded-full ${!isStory ? 'bg-black text-white' : 'bg-gray-100'}`}
        >
          Post
        </button>
        <button
          onClick={() => {
            setIsStory(true);
            if (files.length > 1) {
              setFiles([files[0]]);
              setPreviews([previews[0]]);
              setFilters([filters[0]]);
            }
          }}
          className={`px-4 py-2 rounded-full ${isStory ? 'bg-black text-white' : 'bg-gray-100'}`}
        >
          Story
        </button>
      </div>

      {files.length === 0 ? (
        /* File selection */
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-border-gray rounded-lg p-12 text-center cursor-pointer hover:border-gray-400 transition-colors"
        >
          <svg
            className="w-16 h-16 mx-auto mb-4 text-text-gray"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <p className="text-xl mb-2">Drag photos and videos here</p>
          <p className="text-text-gray mb-4">or click to select files</p>
          <Button variant="primary">Select from computer</Button>
        </div>
      ) : (
        /* Preview and editing */
        <div className="bg-white border border-border-gray rounded-lg overflow-hidden">
          {/* Image preview */}
          <div className="relative aspect-square bg-black">
            <img
              src={previews[currentIndex]}
              alt=""
              className={`w-full h-full object-contain filter-${filters[currentIndex]}`}
            />
            {/* Remove button */}
            <button
              onClick={() => removeFile(currentIndex)}
              className="absolute top-2 right-2 bg-black/50 text-white rounded-full w-8 h-8 flex items-center justify-center"
            >
              &times;
            </button>

            {/* Navigation for multiple images */}
            {files.length > 1 && (
              <>
                {currentIndex > 0 && (
                  <button
                    className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2"
                    onClick={() => setCurrentIndex((prev) => prev - 1)}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                )}
                {currentIndex < files.length - 1 && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2"
                    onClick={() => setCurrentIndex((prev) => prev + 1)}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                )}
                {/* Dots */}
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
                  {files.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentIndex(idx)}
                      className={`w-2 h-2 rounded-full ${idx === currentIndex ? 'bg-primary' : 'bg-white/50'}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Filters */}
          <div className="p-4 border-t border-border-gray">
            <h3 className="font-semibold mb-3">Filters</h3>
            <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-2">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  onClick={() => handleFilterChange(filter)}
                  className={`flex-shrink-0 ${filters[currentIndex] === filter ? 'ring-2 ring-primary' : ''}`}
                >
                  <div className="w-16 h-16 relative rounded overflow-hidden">
                    <img
                      src={previews[currentIndex]}
                      alt=""
                      className={`w-full h-full object-cover filter-${filter}`}
                    />
                  </div>
                  <p className="text-xs text-center mt-1 capitalize">{filter}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Caption and location (for posts only) */}
          {!isStory && (
            <div className="p-4 border-t border-border-gray space-y-4">
              <textarea
                placeholder="Write a caption..."
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full h-24 resize-none outline-none text-sm"
                maxLength={2200}
              />
              <input
                type="text"
                placeholder="Add location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full outline-none text-sm border-t border-border-gray pt-4"
              />
            </div>
          )}

          {/* Add more photos button */}
          {!isStory && files.length < 10 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full p-3 border-t border-border-gray text-primary text-sm font-semibold"
            >
              Add more photos
            </button>
          )}

          {/* Submit */}
          <div className="p-4 border-t border-border-gray">
            {error && <p className="text-red-500 text-sm text-center mb-3">{error}</p>}
            <Button
              onClick={handleSubmit}
              loading={loading}
              className="w-full"
            >
              Share
            </Button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple={!isStory}
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
}
