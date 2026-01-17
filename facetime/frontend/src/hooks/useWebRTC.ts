import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../stores/useStore';
import { signalingService } from '../services/signaling';
import { fetchTurnCredentials } from '../services/api';
import type { WebSocketMessage, ICEServer } from '../types';

export function useWebRTC() {
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const iceServersRef = useRef<ICEServer[]>([]);

  const {
    callState,
    setCallState,
    resetCallState,
    localStream,
    setLocalStream,
    setRemoteStream,
    currentUser,
  } = useStore();

  // Initialize ICE servers
  useEffect(() => {
    fetchTurnCredentials()
      .then((creds) => {
        iceServersRef.current = creds.iceServers;
      })
      .catch(console.error);
  }, []);

  // Get user media
  const getLocalStream = useCallback(async (callType: 'video' | 'audio') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: callType === 'video' ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        } : false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setLocalStream(stream);
      return stream;
    } catch (error) {
      console.error('Failed to get local stream:', error);
      throw error;
    }
  }, [setLocalStream]);

  // Create peer connection
  const createPeerConnection = useCallback(() => {
    const config: RTCConfiguration = {
      iceServers: iceServersRef.current.length > 0
        ? iceServersRef.current
        : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
      iceCandidatePoolSize: 10,
    };

    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate && callState.callId) {
        signalingService.sendIceCandidate(callState.callId, event.candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        setCallState({ state: 'connected', startTime: Date.now() });
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.error('ICE connection failed');
      }
    };

    pc.ontrack = (event) => {
      console.log('Remote track received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    pc.onnegotiationneeded = async () => {
      console.log('Negotiation needed');
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [callState.callId, setCallState, setRemoteStream]);

  // Initiate call
  const initiateCall = useCallback(async (calleeIds: string[], callType: 'video' | 'audio') => {
    try {
      setCallState({
        callType,
        callees: [],
        direction: 'outgoing',
        state: 'initiating',
        isGroup: calleeIds.length > 1,
      });

      const stream = await getLocalStream(callType);
      const pc = createPeerConnection();

      // Add local tracks
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Create and send offer
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: callType === 'video',
      });
      await pc.setLocalDescription(offer);

      // Send call initiation to signaling server
      signalingService.initiateCall(calleeIds, callType);
    } catch (error) {
      console.error('Failed to initiate call:', error);
      resetCallState();
    }
  }, [setCallState, getLocalStream, createPeerConnection, resetCallState]);

  // Answer call
  const answerCall = useCallback(async () => {
    try {
      setCallState({ state: 'connecting' });

      const stream = await getLocalStream(callState.callType);
      const pc = createPeerConnection();

      // Add local tracks
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Signal that we're answering
      signalingService.answerCall(callState.callId);
    } catch (error) {
      console.error('Failed to answer call:', error);
      resetCallState();
    }
  }, [callState.callId, callState.callType, setCallState, getLocalStream, createPeerConnection, resetCallState]);

  // Decline call
  const declineCall = useCallback(() => {
    if (callState.callId) {
      signalingService.declineCall(callState.callId);
    }
    resetCallState();
  }, [callState.callId, resetCallState]);

  // End call
  const endCall = useCallback(() => {
    if (callState.callId) {
      signalingService.endCall(callState.callId);
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    resetCallState();
  }, [callState.callId, resetCallState]);

  // Handle incoming signaling messages
  useEffect(() => {
    const unsubscribe = signalingService.onMessage(async (message: WebSocketMessage) => {
      switch (message.type) {
        case 'call_initiate':
          // Our call initiation was confirmed
          if (message.callId) {
            setCallState({ callId: message.callId, state: 'ringing' });
          }
          break;

        case 'call_ring':
          // Incoming call
          const ringData = message.data as {
            caller: { id: string; username: string; display_name: string; avatar_url: string | null };
            callType: 'video' | 'audio';
            isGroup: boolean;
          };
          setCallState({
            callId: message.callId!,
            caller: ringData.caller,
            callType: ringData.callType,
            direction: 'incoming',
            state: 'ringing',
            isGroup: ringData.isGroup,
          });
          break;

        case 'call_answer':
          // Call was answered
          if (callState.direction === 'outgoing' && peerConnectionRef.current) {
            setCallState({ state: 'connecting' });
            // Send our offer now
            const offer = await peerConnectionRef.current.createOffer();
            await peerConnectionRef.current.setLocalDescription(offer);
            signalingService.sendOffer(callState.callId, offer);
          }
          break;

        case 'call_decline':
          // Call was declined
          const declineData = message.data as { allDeclined?: boolean };
          if (declineData.allDeclined) {
            endCall();
          }
          break;

        case 'call_end':
          // Call ended
          if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
            peerConnectionRef.current = null;
          }
          resetCallState();
          break;

        case 'offer':
          // Received offer from peer
          if (peerConnectionRef.current) {
            const offerData = message.data as RTCSessionDescriptionInit;
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offerData));

            // Process queued ICE candidates
            while (iceCandidatesQueue.current.length > 0) {
              const candidate = iceCandidatesQueue.current.shift()!;
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            }

            // Create and send answer
            const answer = await peerConnectionRef.current.createAnswer();
            await peerConnectionRef.current.setLocalDescription(answer);
            signalingService.sendAnswer(message.callId!, answer);
          }
          break;

        case 'answer':
          // Received answer from peer
          if (peerConnectionRef.current) {
            const answerData = message.data as RTCSessionDescriptionInit;
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData));

            // Process queued ICE candidates
            while (iceCandidatesQueue.current.length > 0) {
              const candidate = iceCandidatesQueue.current.shift()!;
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            }
          }
          break;

        case 'ice_candidate':
          // Received ICE candidate
          const candidateData = message.data as RTCIceCandidateInit;
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidateData));
          } else {
            // Queue until remote description is set
            iceCandidatesQueue.current.push(candidateData);
          }
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [callState.callId, callState.direction, setCallState, resetCallState, endCall]);

  return {
    initiateCall,
    answerCall,
    declineCall,
    endCall,
    localStream,
    peerConnection: peerConnectionRef.current,
  };
}
