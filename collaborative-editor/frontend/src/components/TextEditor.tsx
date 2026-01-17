import { useRef, useEffect, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { TextOperation } from '../services/TextOperation';

interface TextEditorProps {
  readOnly?: boolean;
}

export function TextEditor({ readOnly = false }: TextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastContentRef = useRef<string>('');
  const isComposingRef = useRef(false);

  const { content, connected, applyLocalChange, updateCursor, setContent } = useEditorStore();

  // Sync content to textarea
  useEffect(() => {
    if (textareaRef.current && lastContentRef.current !== content) {
      const textarea = textareaRef.current;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;

      // Store the current scroll position
      const scrollTop = textarea.scrollTop;

      // Update the value
      textarea.value = content;
      lastContentRef.current = content;

      // Restore cursor position (this is a simple approach)
      textarea.selectionStart = Math.min(selectionStart, content.length);
      textarea.selectionEnd = Math.min(selectionEnd, content.length);
      textarea.scrollTop = scrollTop;
    }
  }, [content]);

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;

    const textarea = e.currentTarget;
    const newValue = textarea.value;
    const oldValue = lastContentRef.current;

    if (newValue === oldValue) return;

    // Create operation from diff
    const op = createOperationFromDiff(oldValue, newValue, textarea.selectionStart);

    if (!op.isNoop()) {
      lastContentRef.current = newValue;
      setContent(newValue);
      applyLocalChange(op);
    }
  }, [applyLocalChange, setContent]);

  const handleSelect = useCallback(() => {
    if (!textareaRef.current) return;

    const textarea = textareaRef.current;
    updateCursor({
      index: textarea.selectionStart,
      length: textarea.selectionEnd - textarea.selectionStart,
    });
  }, [updateCursor]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    handleInput(e as unknown as React.FormEvent<HTMLTextAreaElement>);
  }, [handleInput]);

  return (
    <div className="flex-1 flex flex-col">
      <textarea
        ref={textareaRef}
        className={`flex-1 w-full p-4 font-mono text-base leading-relaxed resize-none border-0 outline-none ${
          connected ? 'bg-white' : 'bg-gray-100'
        }`}
        placeholder={connected ? 'Start typing...' : 'Connecting...'}
        disabled={!connected || readOnly}
        onInput={handleInput}
        onSelect={handleSelect}
        onClick={handleSelect}
        onKeyUp={handleSelect}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        defaultValue={content}
      />
    </div>
  );
}

/**
 * Create an operation from the diff between old and new values
 */
function createOperationFromDiff(
  oldValue: string,
  newValue: string,
  cursorPos: number
): TextOperation {
  const op = new TextOperation();

  // Find common prefix
  let commonPrefixLen = 0;
  const minLen = Math.min(oldValue.length, newValue.length);
  while (commonPrefixLen < minLen && oldValue[commonPrefixLen] === newValue[commonPrefixLen]) {
    commonPrefixLen++;
  }

  // Find common suffix (but don't overlap with prefix)
  let commonSuffixLen = 0;
  while (
    commonSuffixLen < minLen - commonPrefixLen &&
    oldValue[oldValue.length - 1 - commonSuffixLen] === newValue[newValue.length - 1 - commonSuffixLen]
  ) {
    commonSuffixLen++;
  }

  // Calculate the changed region
  const deleteLen = oldValue.length - commonPrefixLen - commonSuffixLen;
  const insertStr = newValue.slice(commonPrefixLen, newValue.length - commonSuffixLen);

  // Build operation
  if (commonPrefixLen > 0) {
    op.retain(commonPrefixLen);
  }

  if (deleteLen > 0) {
    op.delete(deleteLen);
  }

  if (insertStr.length > 0) {
    op.insert(insertStr);
  }

  if (commonSuffixLen > 0) {
    op.retain(commonSuffixLen);
  }

  return op;
}
