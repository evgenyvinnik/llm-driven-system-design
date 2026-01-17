interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const lines = diff.split('\n');

  return (
    <div className="border border-github-border rounded-md overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-sm">
          <tbody>
            {lines.map((line, index) => {
              let className = 'diff-line diff-context';
              let prefix = ' ';

              if (line.startsWith('+++') || line.startsWith('---')) {
                className = 'diff-line diff-header';
                prefix = '';
              } else if (line.startsWith('@@')) {
                className = 'diff-line diff-header';
                prefix = '';
              } else if (line.startsWith('+')) {
                className = 'diff-line diff-add';
                prefix = '+';
              } else if (line.startsWith('-')) {
                className = 'diff-line diff-remove';
                prefix = '-';
              }

              return (
                <tr key={index} className={className}>
                  <td className="px-2 py-0.5 text-github-muted select-none text-right w-12 border-r border-github-border">
                    {index + 1}
                  </td>
                  <td className="px-4 py-0.5 whitespace-pre-wrap break-all">
                    {line || ' '}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FileDiffProps {
  file: {
    path: string;
    additions: number;
    deletions: number;
    changes: number;
  };
}

export function FileDiffSummary({ file }: FileDiffProps) {
  const total = file.additions + file.deletions;
  const addPercent = total > 0 ? (file.additions / total) * 100 : 0;

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-github-border hover:bg-github-surface/50">
      <span className="text-sm text-github-text truncate flex-1">{file.path}</span>
      <div className="flex items-center space-x-2 ml-4">
        <span className="text-xs text-github-success">+{file.additions}</span>
        <span className="text-xs text-github-danger">-{file.deletions}</span>
        <div className="w-20 h-2 bg-github-border rounded-full overflow-hidden">
          <div
            className="h-full bg-github-success"
            style={{ width: `${addPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
