import { useState, useRef, useCallback, useEffect } from 'react';
import type { UploadSnapshot } from '../services/chunkedUploader';

interface RecordingInterfaceProps {
  /** Called once capture has started, before the first chunk. */
  onRecordingStart?: () => void;
  /** Every MediaRecorder chunk, as it is produced, so it can be uploaded right away. */
  onChunk?: (chunk: Blob) => void;
  onRecordingComplete: (blob: Blob, duration: number) => void;
  /** Live upload progress to show while recording. */
  uploadStatus?: UploadSnapshot | null;
}

/** WebM variants in order of preference; the server stores WebM, so nothing else is offered. */
const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** Browser-based recording interface with screen/camera selection, pause/resume, and MediaRecorder capture. */
export function RecordingInterface({
  onRecordingStart,
  onChunk,
  onRecordingComplete,
  uploadStatus,
}: RecordingInterfaceProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [recordingMode, setRecordingMode] = useState<'screen' | 'camera'>('screen');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (previewStream && previewVideoRef.current) {
      previewVideoRef.current.srcObject = previewStream;
    }
    return () => {
      if (previewStream) {
        previewStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [previewStream]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (previewStream) {
        previewStream.getTracks().forEach((t) => t.stop());
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    chunksRef.current = [];
    const mimeType = pickMimeType();
    if (!mimeType) {
      setError('This browser cannot record WebM video. Try Chrome, Edge or Firefox.');
      return;
    }

    try {
      let stream: MediaStream;

      if (recordingMode === 'screen') {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1920, height: 1080, frameRate: 30 },
          audio: true,
        });

        // Try to add microphone audio
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const combinedStream = new MediaStream([
            ...displayStream.getVideoTracks(),
            ...displayStream.getAudioTracks(),
            ...audioStream.getAudioTracks(),
          ]);
          stream = combinedStream;
        } catch {
          stream = displayStream;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, frameRate: 30 },
          audio: true,
        });
      }

      setPreviewStream(stream);

      const mediaRecorder = new MediaRecorder(stream, { mimeType });

      // Each one-second chunk is kept for the local preview and handed to the uploader
      // immediately, so most of the recording is in storage before Stop is pressed.
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          onChunk?.(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const duration = (Date.now() - startTimeRef.current) / 1000;
        stream.getTracks().forEach((t) => t.stop());
        setPreviewStream(null);
        onRecordingComplete(blob, duration);
      };

      // Handle user stopping screen share via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
          setIsRecording(false);
          setIsPaused(false);
          if (timerRef.current) clearInterval(timerRef.current);
        }
      });

      mediaRecorderRef.current = mediaRecorder;
      onRecordingStart?.();
      mediaRecorder.start(1000); // Collect data every second
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording';
      setError(message);
    }
  }, [recordingMode, onRecordingComplete, onRecordingStart, onChunk]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsPaused(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const togglePause = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (isPaused) {
      mediaRecorderRef.current.resume();
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } else {
      mediaRecorderRef.current.pause();
      if (timerRef.current) clearInterval(timerRef.current);
    }
    setIsPaused(!isPaused);
  }, [isPaused]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* Mode Selector */}
      {!isRecording && (
        <div className="flex gap-4 justify-center">
          <button
            onClick={() => setRecordingMode('screen')}
            className={`px-6 py-4 rounded-xl border-2 transition-all ${
              recordingMode === 'screen'
                ? 'border-loom-primary bg-loom-primary/5'
                : 'border-loom-border hover:border-loom-primary/50'
            }`}
          >
            <div className="text-2xl mb-2">
              <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8 mx-auto">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M8 21h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-sm font-medium text-loom-text">Screen</div>
            <div className="text-xs text-loom-secondary mt-1">Record your screen</div>
          </button>

          <button
            onClick={() => setRecordingMode('camera')}
            className={`px-6 py-4 rounded-xl border-2 transition-all ${
              recordingMode === 'camera'
                ? 'border-loom-primary bg-loom-primary/5'
                : 'border-loom-border hover:border-loom-primary/50'
            }`}
          >
            <div className="text-2xl mb-2">
              <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8 mx-auto">
                <path d="M23 7l-7 5 7 5V7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <rect x="1" y="5" width="15" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="text-sm font-medium text-loom-text">Camera</div>
            <div className="text-xs text-loom-secondary mt-1">Record from webcam</div>
          </button>
        </div>
      )}

      {/* Preview / Recording Area */}
      <div className="aspect-video bg-gray-900 rounded-xl overflow-hidden relative">
        {previewStream ? (
          <video
            ref={previewVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-400">
              <svg viewBox="0 0 48 48" fill="none" className="w-16 h-16 mx-auto mb-4 opacity-50">
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
                <polygon points="20,16 34,24 20,32" fill="currentColor" />
              </svg>
              <p className="text-sm">Click Start Recording to begin</p>
            </div>
          </div>
        )}

        {/* Recording indicator */}
        {isRecording && (
          <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 px-3 py-1.5 rounded-full">
            <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-loom-warning' : 'bg-loom-danger recording-pulse'}`} />
            <span className="text-white text-sm font-mono">
              {formatTime(recordingTime)}
            </span>
            {isPaused && <span className="text-loom-warning text-xs">PAUSED</span>}
          </div>
        )}

        {/* Upload progress while recording: shows that bytes leave as they are recorded */}
        {isRecording && uploadStatus && (
          <div
            className="absolute top-4 right-4 bg-black/60 px-3 py-1.5 rounded-full text-white text-xs"
            aria-live="polite"
          >
            {uploadStatus.phase === 'error'
              ? 'Upload paused - will retry'
              : `Uploaded ${formatMegabytes(uploadStatus.uploadedBytes)} of ${formatMegabytes(uploadStatus.recordedBytes)}`}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex justify-center gap-4">
        {isRecording ? (
          <>
            <button
              onClick={togglePause}
              className="px-6 py-3 bg-loom-warning text-white rounded-xl hover:bg-loom-warning/80 font-medium"
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={stopRecording}
              className="px-6 py-3 bg-loom-danger text-white rounded-xl hover:bg-loom-danger/80 font-medium"
            >
              Stop Recording
            </button>
          </>
        ) : (
          <button
            onClick={startRecording}
            className="px-8 py-3 bg-loom-primary text-white rounded-xl hover:bg-loom-hover font-medium flex items-center gap-2"
          >
            <span className="w-3 h-3 rounded-full bg-loom-accent" />
            Start Recording
          </button>
        )}
      </div>
    </div>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
