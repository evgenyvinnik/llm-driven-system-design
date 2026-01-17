/**
 * App Component
 *
 * Root component for the FaceTime application.
 * Manages authentication flow, displays appropriate screens based on
 * login and call state, and coordinates between components.
 */

import { useState, useEffect, useCallback } from 'react';
import { useStore } from './stores/useStore';
import { signalingService } from './services/signaling';
import { fetchUsers, login } from './services/api';
import { useWebRTC } from './hooks/useWebRTC';
import { LoginScreen } from './components/LoginScreen';
import { ContactList } from './components/ContactList';
import { IncomingCall } from './components/IncomingCall';
import { ActiveCall } from './components/ActiveCall';
import type { User } from './types';

/**
 * Main application component.
 * Handles user authentication, contact management, and call routing.
 *
 * @returns The appropriate screen based on authentication and call state
 */
function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const {
    currentUser,
    isLoggedIn,
    setCurrentUser,
    contacts,
    setContacts,
    callState,
    setCallState,
  } = useStore();

  const { initiateCall, answerCall, declineCall, endCall } = useWebRTC();

  // Load users on mount
  useEffect(() => {
    fetchUsers()
      .then((data) => {
        setUsers(data);
        setContacts(data);
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [setContacts]);

  // Handle login
  const handleLogin = useCallback(async (username: string) => {
    try {
      const response = await login(username);
      if (response.success) {
        setCurrentUser(response.user);

        // Connect to signaling server
        await signalingService.connect(response.user.id);
      }
    } catch (error) {
      console.error('Login failed:', error);
    }
  }, [setCurrentUser]);

  // Handle logout
  const handleLogout = useCallback(() => {
    signalingService.disconnect();
    setCurrentUser(null);
  }, [setCurrentUser]);

  // Handle initiating a call
  const handleCall = useCallback((userId: string, callType: 'video' | 'audio') => {
    const callee = contacts.find((c) => c.id === userId);
    if (callee) {
      setCallState({
        callees: [callee],
        callType,
        direction: 'outgoing',
      });
      initiateCall([userId], callType);
    }
  }, [contacts, setCallState, initiateCall]);

  // Handle answering
  const handleAnswer = useCallback(() => {
    answerCall();
  }, [answerCall]);

  // Handle declining
  const handleDecline = useCallback(() => {
    declineCall();
  }, [declineCall]);

  // Handle ending call
  const handleEndCall = useCallback(() => {
    endCall();
  }, [endCall]);

  // Show login screen if not logged in
  if (!isLoggedIn) {
    return (
      <LoginScreen
        users={users}
        onLogin={handleLogin}
        isLoading={isLoading}
      />
    );
  }

  // Show incoming call screen
  if (callState.state === 'ringing' && callState.direction === 'incoming') {
    return (
      <IncomingCall
        onAnswer={handleAnswer}
        onDecline={handleDecline}
      />
    );
  }

  // Show active call screen
  if (callState.state !== 'idle') {
    return (
      <ActiveCall
        onEndCall={handleEndCall}
      />
    );
  }

  // Main screen
  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="px-6 py-4 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-white">FaceTime</h1>
          </div>

          {/* User info and logout */}
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-white text-sm font-medium">{currentUser?.display_name}</p>
              <p className="text-gray-400 text-xs">@{currentUser?.username}</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-gray-400 hover:text-white transition-colors"
              title="Logout"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-2xl mx-auto px-6 py-8">
        <h2 className="text-2xl font-semibold text-white mb-6">Contacts</h2>
        <ContactList
          contacts={contacts}
          currentUserId={currentUser?.id || ''}
          onCall={handleCall}
        />
      </main>

      {/* Connection status */}
      <div className="fixed bottom-4 left-4 text-xs text-gray-500">
        {signalingService.isConnected() ? (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-green-500 rounded-full" />
            Connected
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
            Connecting...
          </span>
        )}
      </div>
    </div>
  );
}

export default App;
