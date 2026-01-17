import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/authStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useChatStore } from '@/stores/chatStore';
import { ConversationList } from '@/components/ConversationList';
import { ChatView } from '@/components/ChatView';
import { AuthForm } from '@/components/AuthForm';

function IndexPage() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const currentConversationId = useChatStore((state) => state.currentConversationId);
  const conversations = useChatStore((state) => state.conversations);

  // Setup WebSocket message handling
  useWebSocket();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-imessage-blue"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthForm />;
  }

  const currentConversation = conversations.find((c) => c.id === currentConversationId);

  return (
    <div className="h-screen flex bg-white">
      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 hidden md:block">
        <ConversationList />
      </div>

      {/* Mobile sidebar */}
      <div className={`w-full md:hidden ${currentConversationId ? 'hidden' : 'block'}`}>
        <ConversationList />
      </div>

      {/* Main chat area */}
      <div className={`flex-1 ${!currentConversationId ? 'hidden md:flex' : 'flex'} flex-col`}>
        {currentConversation ? (
          <>
            {/* Mobile back button */}
            <div className="md:hidden flex items-center px-4 py-2 border-b border-gray-200 bg-gray-50">
              <button
                onClick={() => useChatStore.getState().selectConversation(null)}
                className="p-2 -ml-2 rounded-full hover:bg-gray-200"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5 text-imessage-blue"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
            <ChatView conversation={currentConversation} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center text-gray-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-16 w-16 mx-auto mb-4 opacity-50"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z" />
                <path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h2a2 2 0 002-2V9a2 2 0 00-2-2h-1z" />
              </svg>
              <p className="text-lg">Select a conversation</p>
              <p className="text-sm">or start a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
