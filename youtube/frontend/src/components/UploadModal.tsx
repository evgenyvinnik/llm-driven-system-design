import { useState, useRef } from 'react';
import { useUploadStore } from '../stores/uploadStore';
import { useNavigate } from '@tanstack/react-router';
import { formatFileSize } from '../utils/format';

interface UploadModalProps {
  onClose: () => void;
}

export default function UploadModal({ onClose }: UploadModalProps) {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { currentUpload, isUploading, error, startUpload, cancelUpload, clearUpload } = useUploadStore();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categories, setCategories] = useState('');
  const [tags, setTags] = useState('');
  const [step, setStep] = useState<'select' | 'details' | 'uploading' | 'complete'>('select');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      const validTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
      if (!validTypes.includes(file.type)) {
        alert('Please select a valid video file (MP4, WebM, MOV, AVI)');
        return;
      }

      setSelectedFile(file);
      setTitle(file.name.replace(/\.[^/.]+$/, '')); // Remove extension
      setStep('details');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || !title.trim()) return;

    try {
      setStep('uploading');

      const categoriesArray = categories.split(',').map(c => c.trim()).filter(c => c);
      const tagsArray = tags.split(',').map(t => t.trim()).filter(t => t);

      const videoId = await startUpload(
        selectedFile,
        title.trim(),
        description.trim(),
        categoriesArray,
        tagsArray
      );

      setStep('complete');

      // Redirect to video page after a short delay
      setTimeout(() => {
        clearUpload();
        onClose();
        navigate({ to: '/watch/$videoId', params: { videoId } });
      }, 2000);
    } catch {
      setStep('details');
    }
  };

  const handleCancel = async () => {
    if (isUploading) {
      await cancelUpload();
    }
    clearUpload();
    onClose();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('video/')) {
      setSelectedFile(file);
      setTitle(file.name.replace(/\.[^/.]+$/, ''));
      setStep('details');
    }
  };

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal-content max-w-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-medium">Upload video</h2>
          <button onClick={handleCancel} className="p-1 hover:bg-yt-dark-hover rounded">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        {/* Step: Select file */}
        {step === 'select' && (
          <div
            className="border-2 border-dashed border-gray-600 rounded-lg p-12 text-center hover:border-gray-500 transition-colors cursor-pointer"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="w-16 h-16 bg-yt-dark-hover rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
              </svg>
            </div>
            <p className="text-lg mb-2">Drag and drop a video file to upload</p>
            <p className="text-sm text-gray-400 mb-4">Your video will be private until you publish it</p>
            <button className="btn-primary">Select file</button>
          </div>
        )}

        {/* Step: Enter details */}
        {step === 'details' && selectedFile && (
          <div className="space-y-4">
            <div className="bg-yt-dark-hover rounded-lg p-4 flex items-center gap-4">
              <div className="w-32 h-20 bg-gray-700 rounded flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
                </svg>
              </div>
              <div>
                <p className="font-medium">{selectedFile.name}</p>
                <p className="text-sm text-gray-400">{formatFileSize(selectedFile.size)}</p>
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Title (required)</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="input-field w-full"
                maxLength={100}
                required
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="input-field w-full h-24 resize-none"
                placeholder="Tell viewers about your video"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Categories (comma-separated)</label>
              <input
                type="text"
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
                className="input-field w-full"
                placeholder="e.g., Gaming, Music, Education"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Tags (comma-separated)</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="input-field w-full"
                placeholder="e.g., tutorial, review, vlog"
              />
            </div>

            {error && <p className="text-red-500 text-sm">{error}</p>}

            <div className="flex justify-end gap-3 pt-4">
              <button
                onClick={() => {
                  setSelectedFile(null);
                  setStep('select');
                }}
                className="btn-secondary"
              >
                Back
              </button>
              <button
                onClick={handleUpload}
                disabled={!title.trim()}
                className="btn-primary disabled:opacity-50"
              >
                Upload
              </button>
            </div>
          </div>
        )}

        {/* Step: Uploading */}
        {step === 'uploading' && currentUpload && (
          <div className="text-center py-8">
            <div className="w-16 h-16 mx-auto mb-4 relative">
              <svg className="w-full h-full animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
              </svg>
            </div>
            <p className="text-lg font-medium mb-2">Uploading...</p>
            <p className="text-gray-400 mb-4">{currentUpload.progress}% complete</p>
            <div className="w-full bg-gray-700 rounded-full h-2 mb-4">
              <div
                className="bg-yt-blue h-2 rounded-full transition-all duration-300"
                style={{ width: `${currentUpload.progress}%` }}
              />
            </div>
            <button onClick={handleCancel} className="text-red-400 hover:text-red-300">
              Cancel upload
            </button>
          </div>
        )}

        {/* Step: Complete */}
        {step === 'complete' && (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </div>
            <p className="text-lg font-medium mb-2">Upload complete!</p>
            <p className="text-gray-400">Your video is being processed...</p>
          </div>
        )}
      </div>
    </div>
  );
}
