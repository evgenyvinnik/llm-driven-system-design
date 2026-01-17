import type { User } from '../types';

interface ContactListProps {
  contacts: User[];
  currentUserId: string;
  onCall: (userId: string, callType: 'video' | 'audio') => void;
}

export function ContactList({ contacts, currentUserId, onCall }: ContactListProps) {
  const filteredContacts = contacts.filter((c) => c.id !== currentUserId);

  if (filteredContacts.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No contacts available
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-800">
      {filteredContacts.map((contact) => (
        <div
          key={contact.id}
          className="flex items-center justify-between py-4 px-2 hover:bg-gray-900/50 rounded-lg transition-colors"
        >
          <div className="flex items-center gap-4">
            {/* Avatar */}
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-lg font-semibold text-white">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={contact.display_name}
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                contact.display_name.charAt(0).toUpperCase()
              )}
            </div>

            {/* Name */}
            <div>
              <p className="text-white font-medium">{contact.display_name}</p>
              <p className="text-sm text-gray-400">@{contact.username}</p>
            </div>
          </div>

          {/* Call buttons */}
          <div className="flex gap-2">
            {/* Audio call */}
            <button
              onClick={() => onCall(contact.id, 'audio')}
              className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-facetime-green hover:bg-gray-700 transition-colors"
              title="Audio call"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
            </button>

            {/* Video call */}
            <button
              onClick={() => onCall(contact.id, 'video')}
              className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-facetime-green hover:bg-gray-700 transition-colors"
              title="Video call"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
