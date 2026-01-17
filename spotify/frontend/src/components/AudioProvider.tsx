import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { setAudioRef, setCurrentTime, setDuration, onTrackEnd, volume, isMuted } = usePlayerStore();

  useEffect(() => {
    if (audioRef.current) {
      setAudioRef(audioRef.current);

      const audio = audioRef.current;

      const handleTimeUpdate = () => {
        setCurrentTime(audio.currentTime);
      };

      const handleLoadedMetadata = () => {
        setDuration(audio.duration);
      };

      const handleEnded = () => {
        onTrackEnd();
      };

      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('loadedmetadata', handleLoadedMetadata);
      audio.addEventListener('ended', handleEnded);

      // Set initial volume
      audio.volume = isMuted ? 0 : volume;

      return () => {
        audio.removeEventListener('timeupdate', handleTimeUpdate);
        audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
        audio.removeEventListener('ended', handleEnded);
      };
    }
  }, [setAudioRef, setCurrentTime, setDuration, onTrackEnd, volume, isMuted]);

  return (
    <>
      <audio ref={audioRef} />
      {children}
    </>
  );
}
