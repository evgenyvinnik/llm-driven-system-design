import { useCallback, useEffect, useRef, useState } from 'react';
import { wsClient } from '../services/websocket';
import * as api from '../services/api';
import { useMeetingStore } from '../stores/meetingStore';
import { useMediaStore } from '../stores/mediaStore';
import type { BreakoutRoom, ChatMessage, Participant, Role, WaitingParticipant } from '../types';

export type MeetingPhase = 'lobby' | 'joining' | 'waiting' | 'in-meeting' | 'closed';

type Msg = Record<string, unknown>;
type ProducerKind = 'audio' | 'video' | 'screen';

const toParticipant = (p: Msg): Participant => ({
  userId: p.userId as string,
  displayName: p.displayName as string,
  role: (p.role as Role) || 'participant',
  isMuted: p.isMuted === true,
  isVideoOn: p.isVideoOn !== false,
  isScreenSharing: p.isScreenSharing === true,
  isHandRaised: p.isHandRaised === true,
});

const CLOSE_MESSAGES: Record<number, string> = {
  4001: 'Your session has expired. Please sign in again.',
  4002: 'You joined this meeting from another window.',
  4003: 'The host removed you from this meeting.',
};

/**
 * Owns the signaling connection for one meeting page: registers every server
 * event handler once (and removes them on unmount, so re-joining no longer
 * stacks duplicate handlers), joins/leaves, and drives the simulated SFU
 * protocol — produce our tracks after joining, consume everyone else's.
 */
export function useMeetingConnection(meetingCode: string, myUserId: string | undefined) {
  const [phase, setPhase] = useState<MeetingPhase>('lobby');
  const [closedMessage, setClosedMessage] = useState('');
  const producers = useRef<Partial<Record<ProducerKind, string>>>({});
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const close = useCallback((message: string) => {
    wsClient.forgetMeeting();
    setClosedMessage(message);
    setPhase('closed');
    useMeetingStore.getState().setIsInMeeting(false);
  }, []);

  useEffect(() => {
    const meeting = useMeetingStore.getState;
    const media = useMediaStore.getState;

    const handlers: Record<string, (msg: Msg) => void> = {
      joined: (msg) => {
        const self = toParticipant(msg.self as Msg);
        meeting().setParticipants((msg.participants as Msg[]).map(toParticipant));
        meeting().setMyRole(self.role);
        meeting().setLocked(msg.locked === true);
        meeting().setWaiting((msg.waiting as WaitingParticipant[]) ?? []);
        meeting().setIsInMeeting(true);
        // The server is authoritative (mute-on-entry may have muted us).
        media().setIsMuted(self.isMuted);
        media().setIsVideoOn(self.isVideoOn);
        media().setIsScreenSharing(false);
        media().setIsHandRaised(false);
        setPhase('in-meeting');

        // A (re)join starts from fresh transports: register our tracks and
        // subscribe to everything already being produced in the room.
        producers.current = {};
        wsClient.produce('audio');
        wsClient.produce('video');
        for (const p of (msg.existingProducers as Msg[]) ?? []) wsClient.consume(p.producerId as string);

        api
          .getChatMessages(msg.meetingId as string)
          .then(({ messages }) => meeting().mergeChatHistory(messages))
          .catch((err) => console.error('Failed to load chat history:', err));
        api
          .getBreakoutRooms(msg.meetingId as string)
          .then(({ rooms }) => meeting().setBreakoutRooms(rooms, rooms.some((r) => r.isActive)))
          .catch(() => undefined);
      },
      waiting: () => setPhase('waiting'),
      'join-rejected': (msg) => close(msg.message as string),
      denied: (msg) => close(msg.message as string),
      removed: (msg) => close(msg.message as string),
      'session-replaced': (msg) => close(msg.message as string),
      'meeting-ended': (msg) =>
        close(msg.reason === 'empty' ? 'The meeting ended because everyone left.' : 'The host ended this meeting.'),
      'connection-closed': (msg) => {
        const text = CLOSE_MESSAGES[msg.code as number];
        if (text && phaseRef.current !== 'closed') close(text);
      },

      'participant-joined': (msg) => {
        // Older servers sent the fields flat; current ones nest them.
        meeting().addParticipant(toParticipant((msg.participant as Msg) ?? msg));
      },
      'participant-left': (msg) => meeting().removeParticipant(msg.userId as string),
      'participant-update': (msg) => {
        const updates: Partial<Participant> = {};
        if (msg.isMuted !== undefined) updates.isMuted = msg.isMuted as boolean;
        if (msg.isVideoOn !== undefined) updates.isVideoOn = msg.isVideoOn as boolean;
        if (msg.isScreenSharing !== undefined) updates.isScreenSharing = msg.isScreenSharing as boolean;
        if (msg.isHandRaised !== undefined) updates.isHandRaised = msg.isHandRaised as boolean;
        meeting().updateParticipant(msg.userId as string, updates);

        if (msg.userId !== myUserId) return;
        // Our own state as the server accepted it.
        if (updates.isMuted !== undefined) media().setIsMuted(updates.isMuted);
        if (updates.isHandRaised !== undefined) media().setIsHandRaised(updates.isHandRaised);
        if (updates.isScreenSharing !== undefined) {
          media().setIsScreenSharing(updates.isScreenSharing);
          if (updates.isScreenSharing && !producers.current.screen) wsClient.produce('screen');
          if (!updates.isScreenSharing) delete producers.current.screen; // the server closed it
        }
      },
      'role-changed': (msg) => {
        meeting().updateParticipant(msg.userId as string, { role: msg.role as Role });
        if (msg.userId === myUserId) {
          meeting().setMyRole(msg.role as Role);
          if (msg.role === 'participant') meeting().setWaiting([]);
          if (msg.role === 'host') meeting().setNotice('You are now the host.');
        }
      },
      'waiting-room-update': (msg) => meeting().setWaiting(msg.waiting as WaitingParticipant[]),
      'meeting-locked': (msg) => {
        meeting().setLocked(msg.locked === true);
        meeting().setNotice(msg.locked ? 'The meeting is now locked.' : 'The meeting is now unlocked.');
      },
      'muted-by-host': (msg) => {
        media().setIsMuted(true);
        meeting().setNotice(`${msg.by as string} muted you.`);
      },
      'chat-message': (msg) => {
        meeting().addChatMessage({
          id: msg.id as string,
          senderId: msg.senderId as string,
          senderName: msg.senderName as string,
          content: msg.content as string,
          recipientId: (msg.recipientId as string) || null,
          createdAt: msg.createdAt as string,
        } satisfies ChatMessage);
      },

      produced: (msg) => {
        producers.current[msg.kind as ProducerKind] = msg.producerId as string;
      },
      'new-producer': (msg) => wsClient.consume(msg.producerId as string),
      'consume-response': () => {
        // A real client would attach the Consumer's track to the tile here.
      },
      'producer-closed': () => {
        // ...and detach it here. The simulated SFU carries no media.
      },

      'breakout-rooms-updated': (msg) => meeting().setBreakoutRooms(msg.rooms as BreakoutRoom[]),
      'breakout-rooms-opened': (msg) => {
        const rooms = msg.rooms as BreakoutRoom[];
        meeting().setBreakoutRooms(rooms, true);
        const mine = rooms.find((r) => r.participants.some((p) => p.userId === myUserId));
        meeting().setNotice(mine ? `Breakout rooms are open: you are in ${mine.name}.` : 'Breakout rooms are open.');
      },
      'breakout-rooms-closed': () => {
        // Closing returns everyone to the main room; the rooms remain for reuse.
        meeting().setBreakoutRooms(
          meeting().breakoutRooms.map((r) => ({ ...r, isActive: false, participants: [] })),
          false
        );
        meeting().setNotice('Breakout rooms have closed.');
      },

      error: (msg) => {
        console.error('Signaling error:', msg);
        if (msg.requestType === 'produce' || msg.requestType === 'consume') return;
        meeting().setNotice(msg.message as string);
      },
    };

    for (const [type, handler] of Object.entries(handlers)) wsClient.on(type, handler);

    // Closing the tab: tell the server we left rather than leaving our seat held
    // for the reconnect grace window.
    const onPageHide = () => {
      if (wsClient.isConnected) wsClient.leaveMeeting();
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      for (const [type, handler] of Object.entries(handlers)) wsClient.off(type, handler);
      if (wsClient.isConnected) wsClient.leaveMeeting();
      wsClient.disconnect();
    };
  }, [meetingCode, myUserId, close]);

  const join = useCallback(
    async (displayName: string) => {
      setPhase('joining');
      try {
        await wsClient.connect();
        const { isMuted, isVideoOn } = useMediaStore.getState();
        wsClient.joinMeeting(meetingCode, displayName, isMuted, isVideoOn);
      } catch (err) {
        console.error('Failed to join meeting:', err);
        close('Could not connect to the meeting server.');
      }
    },
    [meetingCode, close]
  );

  const leave = useCallback(() => {
    wsClient.leaveMeeting();
    wsClient.disconnect();
  }, []);

  return { phase, closedMessage, join, leave };
}
