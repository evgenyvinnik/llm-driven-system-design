import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { StoryUser, Story } from '../types';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { storiesApi } from '../services/api';
import { formatTimeAgo } from '../utils/format';

interface StoryTrayProps {
  users: StoryUser[];
  onStoryViewed?: (userId: string) => void;
}

export function StoryTray({ users, onStoryViewed }: StoryTrayProps) {
  const [selectedUserIndex, setSelectedUserIndex] = useState<number | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [storyUser, setStoryUser] = useState<{ username: string; profilePictureUrl?: string } | null>(null);
  const [progress, setProgress] = useState(0);

  const selectedUser = selectedUserIndex !== null ? users[selectedUserIndex] : null;

  useEffect(() => {
    if (selectedUser) {
      loadStories(selectedUser.id);
    }
  }, [selectedUser]);

  useEffect(() => {
    if (stories.length > 0) {
      const timer = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            // Move to next story
            if (currentStoryIndex < stories.length - 1) {
              setCurrentStoryIndex((prevIdx) => prevIdx + 1);
              return 0;
            } else {
              // Move to next user
              if (selectedUserIndex !== null && selectedUserIndex < users.length - 1) {
                setSelectedUserIndex((prevIdx) => (prevIdx !== null ? prevIdx + 1 : null));
                setCurrentStoryIndex(0);
              } else {
                closeStoryViewer();
              }
              return 0;
            }
          }
          return prev + 2;
        });
      }, 100);

      return () => clearInterval(timer);
    }
  }, [stories, currentStoryIndex, selectedUserIndex, users.length]);

  const loadStories = async (userId: string) => {
    try {
      const response = await storiesApi.getUserStories(userId);
      setStories(response.stories);
      setStoryUser({ username: response.user.username, profilePictureUrl: response.user.profilePictureUrl });
      setCurrentStoryIndex(0);
      setProgress(0);

      // Mark first story as viewed
      if (response.stories.length > 0 && !response.stories[0].hasViewed) {
        await storiesApi.view(response.stories[0].id);
        onStoryViewed?.(userId);
      }
    } catch (error) {
      console.error('Error loading stories:', error);
    }
  };

  const closeStoryViewer = () => {
    setSelectedUserIndex(null);
    setStories([]);
    setCurrentStoryIndex(0);
    setProgress(0);
  };

  const handleStoryClick = async (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isLeftSide = x < rect.width / 2;

    if (isLeftSide) {
      // Previous story
      if (currentStoryIndex > 0) {
        setCurrentStoryIndex((prev) => prev - 1);
        setProgress(0);
      } else if (selectedUserIndex !== null && selectedUserIndex > 0) {
        setSelectedUserIndex((prev) => (prev !== null ? prev - 1 : null));
        setCurrentStoryIndex(0);
      }
    } else {
      // Next story
      if (currentStoryIndex < stories.length - 1) {
        const nextStory = stories[currentStoryIndex + 1];
        if (!nextStory.hasViewed) {
          await storiesApi.view(nextStory.id);
        }
        setCurrentStoryIndex((prev) => prev + 1);
        setProgress(0);
      } else if (selectedUserIndex !== null && selectedUserIndex < users.length - 1) {
        setSelectedUserIndex((prev) => (prev !== null ? prev + 1 : null));
        setCurrentStoryIndex(0);
      } else {
        closeStoryViewer();
      }
    }
  };

  const currentStory = stories[currentStoryIndex];

  return (
    <>
      {/* Story Tray */}
      <div className="bg-white border border-border-gray rounded-lg p-4 mb-4 overflow-x-auto hide-scrollbar">
        <div className="flex gap-4">
          {users.map((user, index) => (
            <button
              key={user.id}
              onClick={() => setSelectedUserIndex(index)}
              className="flex flex-col items-center gap-1 min-w-[66px]"
            >
              <Avatar
                src={user.profilePictureUrl}
                alt={user.username}
                size="lg"
                hasStory
                hasSeenStory={user.hasSeen}
              />
              <span className="text-xs truncate max-w-[66px]">{user.username}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Story Viewer Modal */}
      {selectedUserIndex !== null && stories.length > 0 && currentStory && (
        <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
          {/* Close button */}
          <button
            onClick={closeStoryViewer}
            className="absolute top-4 right-4 text-white text-3xl z-10"
          >
            &times;
          </button>

          {/* Story content */}
          <div
            className="relative w-full max-w-md h-full max-h-[90vh] bg-black"
            onClick={handleStoryClick}
          >
            {/* Progress bars */}
            <div className="absolute top-2 left-2 right-2 flex gap-1 z-10">
              {stories.map((_, idx) => (
                <div key={idx} className="flex-1 h-0.5 bg-white/30 rounded overflow-hidden">
                  <div
                    className="h-full bg-white transition-all duration-100"
                    style={{
                      width:
                        idx < currentStoryIndex
                          ? '100%'
                          : idx === currentStoryIndex
                          ? `${progress}%`
                          : '0%',
                    }}
                  />
                </div>
              ))}
            </div>

            {/* User info */}
            <div className="absolute top-6 left-2 right-2 flex items-center gap-2 z-10">
              <Avatar
                src={storyUser?.profilePictureUrl}
                alt={storyUser?.username || ''}
                size="sm"
              />
              <Link
                to="/profile/$username"
                params={{ username: storyUser?.username || '' }}
                className="text-white font-semibold text-sm"
                onClick={(e) => e.stopPropagation()}
              >
                {storyUser?.username}
              </Link>
              <span className="text-white/70 text-sm">
                {formatTimeAgo(currentStory.createdAt)}
              </span>
            </div>

            {/* Media */}
            <div className="w-full h-full flex items-center justify-center">
              {currentStory.mediaType === 'image' ? (
                <img
                  src={currentStory.mediaUrl}
                  alt=""
                  className={`max-w-full max-h-full object-contain filter-${currentStory.filterApplied || 'none'}`}
                />
              ) : (
                <video
                  src={currentStory.mediaUrl}
                  className={`max-w-full max-h-full object-contain filter-${currentStory.filterApplied || 'none'}`}
                  autoPlay
                  muted
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
