import { create } from 'zustand';
import type { Participant, ChatMessage, BreakoutRoom, Meeting, Role, WaitingParticipant } from '../types';

interface MeetingState {
  meeting: Meeting | null;
  participants: Participant[];
  chatMessages: ChatMessage[];
  breakoutRooms: BreakoutRoom[];
  /** Breakout rooms are open (participants have been told where to go). */
  breakoutOpen: boolean;
  isInMeeting: boolean;
  isChatOpen: boolean;
  isParticipantListOpen: boolean;
  isBreakoutOpen: boolean;
  screenSharingUserId: string | null;
  /** The local user's live role, as the server last reported it. */
  myRole: Role;
  locked: boolean;
  waiting: WaitingParticipant[];
  /** Transient banner text (muted by host, errors from the server). */
  notice: string | null;

  setMeeting: (meeting: Meeting | null) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (userId: string) => void;
  updateParticipant: (userId: string, updates: Partial<Participant>) => void;
  addChatMessage: (message: ChatMessage) => void;
  mergeChatHistory: (messages: ChatMessage[]) => void;
  setBreakoutRooms: (rooms: BreakoutRoom[], open?: boolean) => void;
  setIsInMeeting: (val: boolean) => void;
  setMyRole: (role: Role) => void;
  setLocked: (locked: boolean) => void;
  setWaiting: (waiting: WaitingParticipant[]) => void;
  setNotice: (notice: string | null) => void;
  toggleChat: () => void;
  toggleParticipantList: () => void;
  toggleBreakout: () => void;
  reset: () => void;
}

const initialState = {
  meeting: null,
  participants: [],
  chatMessages: [],
  breakoutRooms: [],
  breakoutOpen: false,
  isInMeeting: false,
  isChatOpen: false,
  isParticipantListOpen: false,
  isBreakoutOpen: false,
  screenSharingUserId: null,
  myRole: 'participant' as Role,
  locked: false,
  waiting: [],
  notice: null,
};

/** Meeting room state with participant list, chat messages, and breakout room management. */
export const useMeetingStore = create<MeetingState>((set) => ({
  ...initialState,

  setMeeting: (meeting) => set({ meeting }),

  setParticipants: (participants) =>
    set({
      participants,
      screenSharingUserId: participants.find((p) => p.isScreenSharing)?.userId ?? null,
    }),

  addParticipant: (participant) =>
    set((state) => ({
      participants: [...state.participants.filter((p) => p.userId !== participant.userId), participant],
    })),

  removeParticipant: (userId) =>
    set((state) => ({
      participants: state.participants.filter((p) => p.userId !== userId),
      screenSharingUserId: state.screenSharingUserId === userId ? null : state.screenSharingUserId,
    })),

  updateParticipant: (userId, updates) =>
    set((state) => {
      const newParticipants = state.participants.map((p) =>
        p.userId === userId ? { ...p, ...updates } : p
      );
      let screenSharingUserId = state.screenSharingUserId;
      if (updates.isScreenSharing === true) {
        screenSharingUserId = userId;
      } else if (updates.isScreenSharing === false && screenSharingUserId === userId) {
        screenSharingUserId = null;
      }
      return { participants: newParticipants, screenSharingUserId };
    }),

  // Deduplicated by id: a reconnect re-loads history that overlaps live messages.
  addChatMessage: (message) =>
    set((state) =>
      state.chatMessages.some((m) => m.id === message.id)
        ? state
        : { chatMessages: [...state.chatMessages, message] }
    ),

  mergeChatHistory: (messages) =>
    set((state) => {
      const byId = new Map(state.chatMessages.map((m) => [m.id, m]));
      for (const m of messages) byId.set(m.id, m);
      return {
        chatMessages: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    }),

  setBreakoutRooms: (rooms, open) =>
    set((state) => ({ breakoutRooms: rooms, breakoutOpen: open ?? state.breakoutOpen })),

  setIsInMeeting: (val) => set({ isInMeeting: val }),

  setMyRole: (myRole) => set({ myRole }),

  setLocked: (locked) => set({ locked }),

  setWaiting: (waiting) => set({ waiting }),

  setNotice: (notice) => set({ notice }),

  toggleChat: () => set((state) => ({ isChatOpen: !state.isChatOpen, isParticipantListOpen: false, isBreakoutOpen: false })),

  toggleParticipantList: () =>
    set((state) => ({ isParticipantListOpen: !state.isParticipantListOpen, isChatOpen: false, isBreakoutOpen: false })),

  toggleBreakout: () =>
    set((state) => ({ isBreakoutOpen: !state.isBreakoutOpen, isChatOpen: false, isParticipantListOpen: false })),

  reset: () => set(initialState),
}));
