import { create } from 'zustand';
import { UploadSession, UploadProgress, TranscodingStatus } from '../types';
import { api } from '../services/api';

interface UploadState {
  currentUpload: UploadProgress | null;
  transcodingStatus: TranscodingStatus | null;
  isUploading: boolean;
  error: string | null;

  startUpload: (file: File, title: string, description: string, categories: string[], tags: string[]) => Promise<string>;
  cancelUpload: () => Promise<void>;
  checkTranscodingStatus: (videoId: string) => Promise<void>;
  clearUpload: () => void;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

export const useUploadStore = create<UploadState>((set, get) => ({
  currentUpload: null,
  transcodingStatus: null,
  isUploading: false,
  error: null,

  startUpload: async (file, title, description, categories, tags) => {
    set({ isUploading: true, error: null });

    try {
      // For files under 50MB, use simple upload
      if (file.size < 50 * 1024 * 1024) {
        set({
          currentUpload: {
            uploadId: 'simple',
            filename: file.name,
            fileSize: file.size,
            status: 'active',
            uploadedChunks: 0,
            totalChunks: 1,
            progress: 0,
          },
        });

        const result = await api.simpleUpload(file, title, description, categories, tags);

        set({
          currentUpload: {
            uploadId: 'simple',
            filename: file.name,
            fileSize: file.size,
            status: 'completed',
            uploadedChunks: 1,
            totalChunks: 1,
            progress: 100,
          },
          isUploading: false,
        });

        return result.videoId;
      }

      // For larger files, use chunked upload
      const initResponse = await api.post<UploadSession>('/uploads/init', {
        filename: file.name,
        fileSize: file.size,
        contentType: file.type,
      });

      const { uploadId, totalChunks } = initResponse;

      set({
        currentUpload: {
          uploadId,
          filename: file.name,
          fileSize: file.size,
          status: 'active',
          uploadedChunks: 0,
          totalChunks,
          progress: 0,
        },
      });

      // Upload chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const chunkResult = await api.uploadChunk(uploadId, i, chunk);

        set({
          currentUpload: {
            uploadId,
            filename: file.name,
            fileSize: file.size,
            status: 'active',
            uploadedChunks: chunkResult.uploadedChunks,
            totalChunks: chunkResult.totalChunks,
            progress: Math.round((chunkResult.uploadedChunks / chunkResult.totalChunks) * 100),
          },
        });
      }

      // Complete upload
      const completeResponse = await api.post<{ videoId: string }>(`/uploads/${uploadId}/complete`, {
        title,
        description,
        categories,
        tags,
      });

      set({
        currentUpload: {
          ...get().currentUpload!,
          status: 'completed',
          progress: 100,
        },
        isUploading: false,
      });

      return completeResponse.videoId;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Upload failed',
        isUploading: false,
      });
      throw error;
    }
  },

  cancelUpload: async () => {
    const upload = get().currentUpload;
    if (upload && upload.status === 'active' && upload.uploadId !== 'simple') {
      try {
        await api.delete(`/uploads/${upload.uploadId}`);
      } catch (error) {
        console.error('Failed to cancel upload:', error);
      }
    }
    set({ currentUpload: null, isUploading: false, error: null });
  },

  checkTranscodingStatus: async (videoId) => {
    try {
      const status = await api.get<TranscodingStatus>(`/uploads/${videoId}/transcoding`);
      set({ transcodingStatus: status });
    } catch (error) {
      console.error('Failed to check transcoding status:', error);
    }
  },

  clearUpload: () => {
    set({ currentUpload: null, transcodingStatus: null, error: null });
  },
}));
