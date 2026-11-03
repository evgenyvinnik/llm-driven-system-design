import { useRef, useEffect } from 'react';
import { useMediaDevices } from '../hooks/useMediaDevices';
import type { MediaDeviceOption } from '../types';

interface MeetingLobbyProps {
  meetingTitle: string;
  meetingCode: string;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  onJoin: () => void;
  loading?: boolean;
  waitingRoom?: boolean;
}

/** Renders the pre-join lobby with camera preview, device selection, and join controls. */
export function MeetingLobby({
  meetingTitle,
  meetingCode,
  displayName,
  onDisplayNameChange,
  onJoin,
  loading,
  waitingRoom,
}: MeetingLobbyProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const {
    devices,
    localStream,
    isMuted,
    isVideoOn,
    selectedCamera,
    selectedMic,
    getUserMedia,
    toggleMute,
    toggleVideo,
    selectCamera,
    selectMic,
    enumerateDevices,
  } = useMediaDevices();

  // Initialize camera/mic
  useEffect(() => {
    const init = async () => {
      await enumerateDevices();
      await getUserMedia();
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach stream to video element
  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-60px)] p-6">
      <div className="max-w-xl w-full space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-zoom-text mb-1">{meetingTitle}</h1>
          <p className="text-zoom-secondary font-mono">{meetingCode}</p>
          {waitingRoom && (
            <p className="text-zoom-secondary text-sm mt-2">This meeting has a waiting room: the host admits each participant.</p>
          )}
        </div>

        {/* Video preview */}
        <div className="relative bg-zoom-card rounded-xl overflow-hidden aspect-video">
          {isVideoOn && localStream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover transform scale-x-[-1]"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div className="w-24 h-24 rounded-full bg-zoom-primary flex items-center justify-center text-3xl font-bold text-white">
                {displayName ? displayName[0].toUpperCase() : '?'}
              </div>
            </div>
          )}

          {/* Camera/Mic toggles overlay */}
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-3">
            <button
              onClick={toggleMute}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                isMuted ? 'bg-zoom-red' : 'bg-zoom-controlbar/80 hover:bg-zoom-controlbar'
              }`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                </svg>
              )}
            </button>
            <button
              onClick={toggleVideo}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                !isVideoOn ? 'bg-zoom-red' : 'bg-zoom-controlbar/80 hover:bg-zoom-controlbar'
              }`}
              title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
            >
              {isVideoOn ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Device selection */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-zoom-secondary mb-1">Camera</label>
            <select
              value={selectedCamera}
              onChange={(e) => selectCamera(e.target.value)}
              className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-3 py-2 text-sm text-zoom-text focus:outline-none focus:border-zoom-primary"
            >
              {cameras.map((cam: MediaDeviceOption) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zoom-secondary mb-1">Microphone</label>
            <select
              value={selectedMic}
              onChange={(e) => selectMic(e.target.value)}
              className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-3 py-2 text-sm text-zoom-text focus:outline-none focus:border-zoom-primary"
            >
              {mics.map((mic: MediaDeviceOption) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Display name + Join */}
        <div className="space-y-3">
          <input
            type="text"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="Display name"
            className="w-full bg-zoom-surface border border-zoom-card rounded-lg px-4 py-2.5 text-zoom-text placeholder-zoom-secondary focus:outline-none focus:border-zoom-primary"
          />
          <button
            onClick={onJoin}
            disabled={!displayName.trim() || loading}
            className="w-full bg-zoom-primary hover:bg-zoom-hover disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold text-lg transition-colors"
          >
            {loading ? 'Joining...' : 'Join Meeting'}
          </button>
        </div>
      </div>
    </div>
  );
}
