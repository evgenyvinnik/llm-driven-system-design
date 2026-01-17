import { useEffect, useRef } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

interface CodeViewerProps {
  content: string;
  filename: string;
  language?: string;
}

export function CodeViewer({ content, filename, language }: CodeViewerProps) {
  const codeRef = useRef<HTMLElement>(null);

  // Detect language from filename if not provided
  const detectedLanguage = language || detectLanguage(filename);

  useEffect(() => {
    if (codeRef.current) {
      hljs.highlightElement(codeRef.current);
    }
  }, [content]);

  const lines = content.split('\n');

  return (
    <div className="border border-github-border rounded-md overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center justify-between">
        <span className="text-sm text-github-text">{filename}</span>
        <span className="text-xs text-github-muted">{lines.length} lines</span>
      </div>

      {/* Code */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="hover:bg-github-surface/50">
                <td className="px-4 py-0 text-right text-github-muted select-none text-xs border-r border-github-border w-12">
                  {index + 1}
                </td>
                <td className="px-4 py-0">
                  <pre className="text-sm">
                    <code
                      ref={index === 0 ? codeRef : undefined}
                      className={`language-${detectedLanguage}`}
                    >
                      {line || ' '}
                    </code>
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    dockerfile: 'dockerfile',
  };
  return languageMap[ext || ''] || 'plaintext';
}
