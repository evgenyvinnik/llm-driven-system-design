import { create } from 'zustand';
import type { Video } from '../types';
import { videosApi, uploadApi } from '../services/api';
import { ChunkedUploader, type UploadSnapshot } from '../services/chunkedUploader';

interface VideoState {
  videos: Video[];
  currentVideo: Video | null;
  total: number;
  page: number;
  loading: boolean;
  recordedBlob: Blob | null;
  /** Progress of the upload that runs while recording; null when no recording is in flight. */
  recordingUpload: UploadSnapshot | null;
  error: string | null;
  fetchVideos: (params?: { page?: number; search?: string; folderId?: string }) => Promise<void>;
  fetchVideo: (id: string) => Promise<void>;
  deleteVideo: (id: string) => Promise<void>;
  updateVideo: (id: string, data: { title?: string; description?: string }) => Promise<void>;
  setRecordedBlob: (blob: Blob | null) => void;
  clearError: () => void;
  /** Recording started: create the video and open its multipart upload in the background. */
  beginRecordingUpload: () => void;
  /** A MediaRecorder chunk arrived. */
  pushRecordingChunk: (chunk: Blob) => void;
  /** Recording stopped: send the tail and complete the upload. */
  finishRecordingUpload: (durationSeconds: number) => void;
  retryRecordingUpload: () => void;
  /** Applies the title the user typed once the upload is complete. */
  saveRecording: (title: string, description?: string) => Promise<Video>;
  discardRecording: () => Promise<void>;
}

// The uploader holds the recorded chunks and in-flight requests; it lives outside React
// state and only its snapshot goes into the store.
let uploader: ChunkedUploader | null = null;
let completion: Promise<Video> | null = null;

function defaultTitle(): string {
  return `Recording ${new Date().toLocaleString()}`;
}

/** Video library state, plus the streaming upload of the recording in progress. */
export const useVideoStore = create<VideoState>((set, get) => ({
  videos: [],
  currentVideo: null,
  total: 0,
  page: 1,
  loading: false,
  recordedBlob: null,
  recordingUpload: null,
  error: null,

  fetchVideos: async (params) => {
    set({ loading: true, error: null });
    try {
      const result = await videosApi.list(params);
      set({ videos: result.videos, total: result.total, page: result.page, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load videos';
      set({ error: message, loading: false });
    }
  },

  fetchVideo: async (id) => {
    set({ loading: true, error: null, currentVideo: null });
    try {
      const { video } = await videosApi.get(id);
      set({ currentVideo: video, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load video';
      set({ error: message, loading: false });
    }
  },

  deleteVideo: async (id) => {
    try {
      await videosApi.delete(id);
      set({ videos: get().videos.filter((v) => v.id !== id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete video';
      set({ error: message });
    }
  },

  updateVideo: async (id, data) => {
    try {
      const { video } = await videosApi.update(id, data);
      set({
        videos: get().videos.map((v) => (v.id === id ? video : v)),
        currentVideo: get().currentVideo?.id === id ? video : get().currentVideo,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update video';
      set({ error: message });
    }
  },

  setRecordedBlob: (blob) => set({ recordedBlob: blob }),
  clearError: () => set({ error: null }),

  beginRecordingUpload: () => {
    // The id is generated here, so retrying a create whose response was lost
    // returns the same video instead of making a second one.
    const videoId = crypto.randomUUID();
    const title = defaultTitle();
    uploader = new ChunkedUploader({
      start: async () => {
        await videosApi.create(title, undefined, videoId);
        const { partSize } = await uploadApi.startMultipart(videoId);
        return { videoId, partSize };
      },
      partUrl: async (id, partNumber) => (await uploadApi.partUrl(id, partNumber)).url,
      putPart: uploadApi.putPart,
      complete: async (id, partCount, durationSeconds) =>
        (await uploadApi.complete(id, partCount, durationSeconds)).video,
    });
    completion = null;
    uploader.subscribe((snapshot) => set({ recordingUpload: snapshot }));
    uploader.begin();
    set({ error: null });
  },

  pushRecordingChunk: (chunk) => {
    uploader?.push(chunk);
  },

  finishRecordingUpload: (durationSeconds) => {
    if (!uploader) return;
    completion = uploader.finish(durationSeconds);
    // Failures surface through the snapshot's 'error' phase; keep the promise handled.
    completion.catch(() => undefined);
  },

  retryRecordingUpload: () => {
    const resumed = uploader?.retry();
    if (resumed) {
      completion = resumed;
      completion.catch(() => undefined);
    }
  },

  saveRecording: async (title, description) => {
    if (!completion) throw new Error('No recording to save');
    const uploaded = await completion;
    const { video } = await videosApi.update(uploaded.id, { title, description });
    uploader = null;
    completion = null;
    set({ videos: [video, ...get().videos.filter((v) => v.id !== video.id)], recordingUpload: null });
    return video;
  },

  discardRecording: async () => {
    const active = uploader;
    uploader = null;
    completion = null;
    set({ recordingUpload: null, recordedBlob: null });
    if (!active) return;
    const videoId = await active.abort();
    // Deleting the video also aborts its multipart upload on the server.
    if (videoId) await videosApi.delete(videoId).catch(() => undefined);
  },
}));
