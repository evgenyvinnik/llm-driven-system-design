import { create } from 'zustand';

interface MediaState {
  localStream: MediaStream | null;
  isMuted: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  selectedCamera: string;
  selectedMic: string;

  setLocalStream: (stream: MediaStream | null) => void;
  setIsMuted: (val: boolean) => void;
  setIsVideoOn: (val: boolean) => void;
  setIsScreenSharing: (val: boolean) => void;
  setIsHandRaised: (val: boolean) => void;
  setSelectedCamera: (deviceId: string) => void;
  setSelectedMic: (deviceId: string) => void;
  reset: () => void;
}

const initialState = {
  localStream: null,
  isMuted: false,
  isVideoOn: true,
  isScreenSharing: false,
  isHandRaised: false,
  selectedCamera: '',
  selectedMic: '',
};

/** Local media device state with mute, video, screen share, and hand raise toggles. */
export const useMediaStore = create<MediaState>((set) => ({
  ...initialState,

  setLocalStream: (stream) => set({ localStream: stream }),
  // Keep the real tracks in step with the flags: flipping only the flag left the
  // microphone live while the UI said "muted", and the camera light on.
  setIsMuted: (val) =>
    set((state) => {
      state.localStream?.getAudioTracks().forEach((track) => {
        track.enabled = !val;
      });
      return { isMuted: val };
    }),
  setIsVideoOn: (val) =>
    set((state) => {
      state.localStream?.getVideoTracks().forEach((track) => {
        track.enabled = val;
      });
      return { isVideoOn: val };
    }),
  setIsScreenSharing: (val) => set({ isScreenSharing: val }),
  setIsHandRaised: (val) => set({ isHandRaised: val }),
  setSelectedCamera: (deviceId) => set({ selectedCamera: deviceId }),
  setSelectedMic: (deviceId) => set({ selectedMic: deviceId }),

  reset: () => {
    set((state) => {
      if (state.localStream) {
        state.localStream.getTracks().forEach((track) => track.stop());
      }
      return initialState;
    });
  },
}));
