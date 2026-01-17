import { useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import type { Document, PresenceState } from '../types';
import EditorToolbar from './EditorToolbar';
import wsService from '../services/websocket';

interface Props {
  document: Document;
  presence: PresenceState[];
  readOnly?: boolean;
}

export default function Editor({ document, presence, readOnly = false }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: {
          depth: 100,
        },
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Placeholder.configure({
        placeholder: 'Start typing...',
      }),
    ],
    content: document.content,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose max-w-none p-12 min-h-full focus:outline-none',
      },
    },
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged && wsService.isConnected()) {
        // In a full implementation, we would:
        // 1. Calculate the operation from the transaction steps
        // 2. Send the operation via WebSocket
        // For this demo, we send a simplified version

        // Get the current document state
        const json = editor.getJSON();

        // Send a placeholder operation - in production this would be proper OT
        const operations = [{
          type: 'insert' as const,
          position: 0,
          text: JSON.stringify(json),
        }];

        // Note: Real OT would calculate actual insert/delete operations
        // from the ProseMirror transaction steps
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (wsService.isConnected()) {
        const { from, to } = editor.state.selection;

        if (from === to) {
          wsService.sendCursor(from);
        } else {
          wsService.sendSelection(from, to);
        }
      }
    },
  });

  // Update content when document changes
  useEffect(() => {
    if (editor && document.content) {
      const currentContent = JSON.stringify(editor.getJSON());
      const newContent = JSON.stringify(document.content);

      if (currentContent !== newContent) {
        editor.commands.setContent(document.content, false);
      }
    }
  }, [editor, document.content]);

  // Update editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [editor, readOnly]);

  if (!editor) {
    return (
      <div className="p-12 min-h-[1056px] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-docs-blue"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {!readOnly && <EditorToolbar editor={editor} />}

      {/* Remote cursors indicator */}
      {presence.length > 0 && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-white/90 px-2 py-1 rounded shadow-sm">
          {presence.map((user) => (
            <div
              key={user.user_id}
              className="flex items-center gap-1"
              title={`${user.name} is editing`}
            >
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: user.color }}
              />
              <span className="text-xs text-gray-600">{user.name}</span>
            </div>
          ))}
        </div>
      )}

      <EditorContent editor={editor} className="flex-1" />

      {readOnly && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-full text-sm">
          View only - you cannot edit this document
        </div>
      )}
    </div>
  );
}
