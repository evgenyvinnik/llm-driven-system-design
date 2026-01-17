import { useState } from 'react';
import { Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import type { BusinessPhoto } from '../../types';

/**
 * Props for the PhotoGallery component.
 */
interface PhotoGalleryProps {
  /** Array of business photos to display */
  photos: BusinessPhoto[];
  /** Business name for alt text */
  businessName: string;
}

/**
 * PhotoGallery displays a full-width image carousel with navigation controls.
 *
 * Features:
 * - Previous/next navigation buttons
 * - Dot indicators for photo position
 * - "See all photos" button overlay
 *
 * @param props - Component properties
 * @returns A photo gallery component or null if no photos
 */
export function PhotoGallery({ photos, businessName }: PhotoGalleryProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  if (photos.length === 0) {
    return null;
  }

  /**
   * Navigate to the previous photo in the gallery.
   * Wraps around to the last photo when at the beginning.
   */
  const goToPrevious = () => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : photos.length - 1));
  };

  /**
   * Navigate to the next photo in the gallery.
   * Wraps around to the first photo when at the end.
   */
  const goToNext = () => {
    setCurrentIndex((i) => (i < photos.length - 1 ? i + 1 : 0));
  };

  return (
    <div className="relative h-64 md:h-96 bg-gray-900">
      <img
        src={photos[currentIndex]?.url}
        alt={businessName}
        className="w-full h-full object-cover"
      />

      {photos.length > 1 && (
        <>
          {/* Previous button */}
          <button
            onClick={goToPrevious}
            className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2 hover:bg-white"
            aria-label="Previous photo"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>

          {/* Next button */}
          <button
            onClick={goToNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2 hover:bg-white"
            aria-label="Next photo"
          >
            <ChevronRight className="w-6 h-6" />
          </button>

          {/* Dot indicators */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
            {photos.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentIndex(i)}
                className={`w-2 h-2 rounded-full ${
                  i === currentIndex ? 'bg-white' : 'bg-white/50'
                }`}
                aria-label={`Go to photo ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}

      {/* See all photos button */}
      <button className="absolute bottom-4 right-4 bg-white rounded-md px-4 py-2 flex items-center gap-2 hover:bg-gray-100">
        <Camera className="w-4 h-4" />
        See all {photos.length} photos
      </button>
    </div>
  );
}
