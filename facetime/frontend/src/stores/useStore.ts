import { create } from 'zustand';
import type { User, CallState } from '../types';
import { signalingService } from '../services/signaling';

interface AppState {
  // Auth
  currentUser: User | null;
  isLoggedIn: boolean;
  setCurrentUser: (user: User | null) => void;

  // Contacts
  contacts: User[];
  setContacts: (contacts: User[]) => void;

  // Call state
  callState: CallState;
  setCallState: (state: Partial<CallState>) => void;
  resetCallState: () => void;

  // WebRTC
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  setLocalStream: (stream: MediaStream | null) => void;
  setRemoteStream: (stream: MediaStream | null) => void;

  // UI state
  isMuted: boolean;
  isVideoOff: boolean;
  toggleMute: () => void;
  toggleVideo: () => void;
}

const initialCallState: CallState = {
  callId: '',
  caller: null,
  callees: [],
  callType: 'video',
  state: 'idle',
  direction: 'outgoing',
  startTime: null,
  isGroup: false,
};

export const useStore = create<AppState>((set, get) => ({
  // Auth
  currentUser: null,
  isLoggedIn: false,
  setCurrentUser: (user) => set({ currentUser: user, isLoggedIn: !!user }),

  // Contacts
  contacts: [],
  setContacts: (contacts) => set({ contacts }),

  // Call state
  callState: initialCallState,
  setCallState: (state) =>
    set((prev) => ({
      callState: { ...prev.callState, ...state },
    })),
  resetCallState: () => {
    const { localStream, remoteStream } = get();

    // Clean up streams
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
    }

    set({
      callState: initialCallState,
      localStream: null,
      remoteStream: null,
      isMuted: false,
      isVideoOff: false,
    });
  },

  // WebRTC
  localStream: null,
  remoteStream: null,
  setLocalStream: (stream) => set({ localStream: stream }),
  setRemoteStream: (stream) => set({ remoteStream: stream }),

  // UI state
  isMuted: false,
  isVideoOff: false,
  toggleMute: () => {
    const { localStream, isMuted } = get();
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = isMuted;
      });
    }
    set({ isMuted: !isMuted });
  },
  toggleVideo: () => {
    const { localStream, isVideoOff } = get();
    if (localStream) {
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = isVideoOff;
      });
    }
    set({ isVideoOff: !isVideoOff });
  },
}));
