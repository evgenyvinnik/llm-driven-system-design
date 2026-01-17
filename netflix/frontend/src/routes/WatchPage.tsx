import React from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { VideoPlayer } from '../components';
import { videoService } from '../services/videos';
import { usePlayerStore } from '../stores/playerStore';
import type { Video, Episode } from '../types';

export function WatchPage() {
  const { videoId } = useParams({ from: '/watch/$videoId' });
  const search = useSearch({ from: '/watch/$videoId' });
  const episodeId = (search as { episodeId?: string }).episodeId;

  const { reset } = usePlayerStore();
  const [video, setVideo] = React.useState<Video | null>(null);
  const [episode, setEpisode] = React.useState<Episode | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    loadContent();

    return () => {
      reset();
    };
  }, [videoId, episodeId]);

  const loadContent = async () => {
    setIsLoading(true);
    try {
      const { video: videoData } = await videoService.getVideo(videoId);
      setVideo(videoData);

      // Find episode if episodeId is provided
      if (episodeId && videoData.seasons) {
        for (const season of videoData.seasons) {
          const ep = season.episodes.find((e) => e.id === episodeId);
          if (ep) {
            setEpisode(ep);
            break;
          }
        }
      }
    } catch (error) {
      console.error('Failed to load content:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!video) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <p className="text-white">Content not found</p>
      </div>
    );
  }

  // Determine title and subtitle
  let title = video.title;
  let subtitle: string | undefined;

  if (episode) {
    // Find season number
    let seasonNumber = 1;
    if (video.seasons) {
      for (const season of video.seasons) {
        if (season.episodes.some((e) => e.id === episode.id)) {
          seasonNumber = season.seasonNumber;
          break;
        }
      }
    }
    subtitle = `S${seasonNumber} E${episode.episodeNumber}: ${episode.title}`;
  }

  return (
    <div className="h-screen w-screen bg-black">
      <VideoPlayer
        videoId={videoId}
        episodeId={episodeId}
        title={title}
        subtitle={subtitle}
      />
    </div>
  );
}
