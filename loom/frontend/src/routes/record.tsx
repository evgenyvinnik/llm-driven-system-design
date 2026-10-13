import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useVideoStore } from '../stores/videoStore';
import { RecordingInterface } from '../components/RecordingInterface';
import { RecordingPreview } from '../components/RecordingPreview';
import { UploadProgress } from '../components/UploadProgress';
import type { UploadSnapshot } from '../services/chunkedUploader';

function percentUploaded(upload: UploadSnapshot | null): number {
  if (!upload || upload.recordedBytes === 0) return 0;
  return Math.min(100, Math.round((upload.uploadedBytes / upload.recordedBytes) * 100));
}

function RecordPage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();
  const recordedBlob = useVideoStore((s) => s.recordedBlob);
  const setRecordedBlob = useVideoStore((s) => s.setRecordedBlob);
  const upload = useVideoStore((s) => s.recordingUpload);
  const beginRecordingUpload = useVideoStore((s) => s.beginRecordingUpload);
  const pushRecordingChunk = useVideoStore((s) => s.pushRecordingChunk);
  const finishRecordingUpload = useVideoStore((s) => s.finishRecordingUpload);
  const retryRecordingUpload = useVideoStore((s) => s.retryRecordingUpload);
  const saveRecording = useVideoStore((s) => s.saveRecording);
  const discardRecording = useVideoStore((s) => s.discardRecording);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const durationRef = useRef(0);

  useEffect(() => {
    if (!loading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    // Drop the local preview on unmount. An upload still running keeps going in the
    // background and the video is saved under its default title.
    return () => {
      setRecordedBlob(null);
    };
  }, [setRecordedBlob]);

  const handleRecordingComplete = useCallback(
    (blob: Blob, duration: number) => {
      setRecordedBlob(blob);
      durationRef.current = duration;
      setTitle(`Recording ${new Date().toLocaleDateString()}`);
      finishRecordingUpload(duration);
    },
    [setRecordedBlob, finishRecordingUpload],
  );

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const video = await saveRecording(title.trim(), description.trim() || undefined);
      setRecordedBlob(null);
      navigate({ to: '/videos/$videoId', params: { videoId: video.id } });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the recording');
    }
    setSaving(false);
  };

  const handleDiscard = async () => {
    await discardRecording();
    setTitle('');
    setDescription('');
    setSaveError(null);
  };

  if (loading || !user) return null;

  const progress = percentUploaded(upload);
  const uploadFailed = upload?.phase === 'error';

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold text-loom-text mb-6">Record Video</h1>

      {saveError && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-6" role="alert">
          {saveError}
        </div>
      )}

      {saving && upload?.phase !== 'done' ? (
        <UploadProgress progress={progress} label="Finishing upload..." />
      ) : recordedBlob ? (
        <div className="space-y-6">
          <RecordingPreview blob={recordedBlob} />

          <div className="bg-white rounded-lg border border-loom-border p-6">
            <div className="space-y-4">
              <div className="text-sm" aria-live="polite">
                {upload?.phase === 'done' && (
                  <span className="text-loom-success">Uploaded - ready to save and share.</span>
                )}
                {(upload?.phase === 'finishing' || upload?.phase === 'recording') && (
                  <span className="text-loom-secondary">Uploading the last part... {progress}%</span>
                )}
                {uploadFailed && (
                  <span className="text-loom-danger">
                    Upload paused: {upload?.error}.{' '}
                    <button onClick={retryRecordingUpload} className="underline font-medium">
                      Retry
                    </button>
                  </span>
                )}
              </div>
              <div>
                <label htmlFor="recording-title" className="block text-sm font-medium text-loom-text mb-1">
                  Title
                </label>
                <input
                  id="recording-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-loom-border rounded-lg focus:outline-none focus:ring-2 focus:ring-loom-primary"
                  placeholder="Give your video a title"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="recording-description" className="block text-sm font-medium text-loom-text mb-1">
                  Description (optional)
                </label>
                <textarea
                  id="recording-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-loom-border rounded-lg focus:outline-none focus:ring-2 focus:ring-loom-primary resize-none"
                  rows={3}
                  placeholder="Add a description..."
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSave}
                  disabled={!title.trim() || saving || uploadFailed}
                  className="px-6 py-2 bg-loom-primary text-white rounded-lg hover:bg-loom-hover font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save Video
                </button>
                <button
                  onClick={handleDiscard}
                  className="px-6 py-2 text-loom-secondary border border-loom-border rounded-lg hover:bg-gray-50"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <RecordingInterface
          onRecordingStart={beginRecordingUpload}
          onChunk={pushRecordingChunk}
          onRecordingComplete={handleRecordingComplete}
          uploadStatus={upload}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/record')({
  component: RecordPage,
});
