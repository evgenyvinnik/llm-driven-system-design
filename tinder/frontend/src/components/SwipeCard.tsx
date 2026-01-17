import { useState, useRef } from 'react';
import type { DiscoveryCard } from '../types';
import ReignsAvatar from './ReignsAvatar';

/**
 * Props for the SwipeCard component.
 */
interface SwipeCardProps {
  /** The discovery card data to display */
  card: DiscoveryCard;
  /** Whether this card is the active/topmost card in the stack */
  isActive: boolean;
  /** Callback fired when user completes a swipe gesture */
  onSwipe?: (direction: 'like' | 'pass') => void;
  /** Enable Reigns: Her Majesty style procedural avatars instead of photos */
  useReignsStyle?: boolean;
}

/**
 * Swipeable profile card component for the discovery deck.
 * Supports touch and mouse drag gestures with visual feedback (rotation, opacity).
 * Shows LIKE/NOPE indicators based on drag direction.
 * @param props - SwipeCard component props
 * @returns Swipe card element
 */
export default function SwipeCard({ card, isActive, onSwipe, useReignsStyle = true }: SwipeCardProps) {
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [showInfo, setShowInfo] = useState(false);

  // Generate a unique seed for the avatar based on user ID and name
  const avatarSeed = `${card.id}-${card.name}`;
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  const photos = card.photos.length > 0 ? card.photos : [];
  const currentPhoto = photos[currentPhotoIndex];

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isActive) return;
    const touch = e.touches[0];
    setDragStart({ x: touch.clientX, y: touch.clientY });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!dragStart || !isActive) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - dragStart.x;
    const deltaY = touch.clientY - dragStart.y;
    setDragDelta({ x: deltaX, y: deltaY });
  };

  const handleTouchEnd = () => {
    if (!isActive) return;
    const threshold = 100;

    if (dragDelta.x > threshold && onSwipe) {
      onSwipe('like');
    } else if (dragDelta.x < -threshold && onSwipe) {
      onSwipe('pass');
    }

    setDragStart(null);
    setDragDelta({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isActive) return;
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStart || !isActive) return;
    const deltaX = e.clientX - dragStart.x;
    const deltaY = e.clientY - dragStart.y;
    setDragDelta({ x: deltaX, y: deltaY });
  };

  const handleMouseUp = () => {
    if (!isActive) return;
    const threshold = 100;

    if (dragDelta.x > threshold && onSwipe) {
      onSwipe('like');
    } else if (dragDelta.x < -threshold && onSwipe) {
      onSwipe('pass');
    }

    setDragStart(null);
    setDragDelta({ x: 0, y: 0 });
  };

  const handleMouseLeave = () => {
    if (dragStart) {
      setDragStart(null);
      setDragDelta({ x: 0, y: 0 });
    }
  };

  const nextPhoto = () => {
    if (currentPhotoIndex < photos.length - 1) {
      setCurrentPhotoIndex(currentPhotoIndex + 1);
    }
  };

  const prevPhoto = () => {
    if (currentPhotoIndex > 0) {
      setCurrentPhotoIndex(currentPhotoIndex - 1);
    }
  };

  const rotation = dragDelta.x * 0.1;
  const opacity = Math.max(0, 1 - Math.abs(dragDelta.x) / 500);

  return (
    <div
      ref={cardRef}
      className="w-full h-full bg-white rounded-2xl overflow-hidden select-none"
      style={{
        transform: isActive
          ? `translateX(${dragDelta.x}px) translateY(${dragDelta.y * 0.3}px) rotate(${rotation}deg)`
          : undefined,
        opacity: isActive ? opacity : 1,
        cursor: isActive ? 'grab' : 'default',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      {/* Photo or Reigns-style Avatar */}
      <div className="relative w-full h-full">
        {useReignsStyle ? (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800">
            <ReignsAvatar seed={avatarSeed} size={400} className="rounded-lg shadow-2xl" />
          </div>
        ) : currentPhoto ? (
          <img
            src={currentPhoto.url}
            alt={card.name}
            className="w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800">
            <ReignsAvatar seed={avatarSeed} size={400} className="rounded-lg shadow-2xl" />
          </div>
        )}

        {/* Photo navigation indicators */}
        {!useReignsStyle && photos.length > 1 && (
          <div className="absolute top-2 left-0 right-0 flex justify-center gap-1 px-4">
            {photos.map((_, index) => (
              <div
                key={index}
                className={`h-1 flex-1 rounded-full ${
                  index === currentPhotoIndex ? 'bg-white' : 'bg-white/50'
                }`}
              />
            ))}
          </div>
        )}

        {/* Photo navigation touch areas */}
        {!useReignsStyle && photos.length > 1 && (
          <>
            <button
              onClick={prevPhoto}
              className="absolute left-0 top-0 bottom-20 w-1/3"
            />
            <button
              onClick={nextPhoto}
              className="absolute right-0 top-0 bottom-20 w-1/3"
            />
          </>
        )}

        {/* Like/Nope indicators */}
        {isActive && dragDelta.x > 50 && (
          <div className="absolute top-10 left-6 border-4 border-green-500 text-green-500 px-4 py-2 rounded-lg transform -rotate-12 text-2xl font-bold">
            LIKE
          </div>
        )}
        {isActive && dragDelta.x < -50 && (
          <div className="absolute top-10 right-6 border-4 border-red-500 text-red-500 px-4 py-2 rounded-lg transform rotate-12 text-2xl font-bold">
            NOPE
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />

        {/* Info */}
        <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
          <div className="flex items-end justify-between">
            <div className="flex-1">
              <h2 className="text-2xl font-bold">
                {card.name}, {card.age}
              </h2>
              {card.job_title && (
                <p className="text-white/80 flex items-center gap-2 mt-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  {card.job_title}
                  {card.company && ` at ${card.company}`}
                </p>
              )}
              {card.school && (
                <p className="text-white/80 flex items-center gap-2 mt-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                  {card.school}
                </p>
              )}
              <p className="text-white/60 flex items-center gap-2 mt-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {card.distance}
              </p>
            </div>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>

          {/* Expanded info */}
          {showInfo && card.bio && (
            <div className="mt-4 pt-4 border-t border-white/20">
              <p className="text-white/90">{card.bio}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
