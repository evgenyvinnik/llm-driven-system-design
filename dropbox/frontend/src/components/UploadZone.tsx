import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FolderPlus } from 'lucide-react';
import { useFileStore } from '../stores/fileStore';

interface UploadZoneProps {
  onCreateFolder: () => void;
}

export function UploadZone({ onCreateFolder }: UploadZoneProps) {
  const { uploadFile, uploadingFiles } = useFileStore();

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      acceptedFiles.forEach((file) => {
        uploadFile(file);
      });
    },
    [uploadFile]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
  });

  return (
    <div
      {...getRootProps()}
      className={`relative ${isDragActive ? 'ring-2 ring-dropbox-blue ring-inset' : ''}`}
    >
      <input {...getInputProps()} />

      {/* Drop overlay */}
      {isDragActive && (
        <div className="absolute inset-0 bg-dropbox-blue bg-opacity-10 z-10 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <Upload size={48} className="mx-auto text-dropbox-blue mb-4" />
            <p className="text-lg font-medium text-gray-900">Drop files here to upload</p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-4 p-4 border-b border-gray-200">
        <label className="flex items-center gap-2 px-4 py-2 bg-dropbox-blue text-white rounded-lg cursor-pointer hover:bg-dropbox-blue-dark transition-colors">
          <Upload size={20} />
          <span>Upload files</span>
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              files.forEach((file) => uploadFile(file));
              e.target.value = '';
            }}
          />
        </label>

        <button
          onClick={onCreateFolder}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <FolderPlus size={20} />
          <span>New folder</span>
        </button>
      </div>

      {/* Upload progress */}
      {uploadingFiles.length > 0 && (
        <div className="absolute bottom-4 right-4 w-80 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-20">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
            <p className="font-medium text-sm">
              Uploading {uploadingFiles.filter((f) => f.status === 'uploading').length} files
            </p>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {uploadingFiles.map((file) => (
              <div key={file.id} className="px-4 py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm truncate flex-1">{file.name}</p>
                  <span
                    className={`text-xs ml-2 ${
                      file.status === 'completed'
                        ? 'text-green-600'
                        : file.status === 'error'
                        ? 'text-red-600'
                        : 'text-gray-500'
                    }`}
                  >
                    {file.status === 'completed'
                      ? 'Done'
                      : file.status === 'error'
                      ? 'Failed'
                      : `${Math.round(file.progress)}%`}
                  </span>
                </div>
                <div className="w-full h-1 bg-gray-200 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      file.status === 'completed'
                        ? 'bg-green-500'
                        : file.status === 'error'
                        ? 'bg-red-500'
                        : 'bg-dropbox-blue'
                    }`}
                    style={{ width: `${file.progress}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
