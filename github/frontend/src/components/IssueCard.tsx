import { Link } from '@tanstack/react-router';
import type { Label } from '../types';

interface LabelBadgeProps {
  label: Label;
  onClick?: () => void;
}

export function LabelBadge({ label, onClick }: LabelBadgeProps) {
  const isLight = isLightColor(label.color);

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        onClick ? 'cursor-pointer hover:opacity-80' : ''
      }`}
      style={{
        backgroundColor: label.color,
        color: isLight ? '#000' : '#fff',
      }}
      onClick={onClick}
      title={label.description}
    >
      {label.name}
    </span>
  );
}

function isLightColor(color: string): boolean {
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 128;
}

interface IssueCardProps {
  issue: {
    number: number;
    title: string;
    state: string;
    author_name: string;
    labels?: Label[];
    created_at: string;
  };
  owner: string;
  repo: string;
  type?: 'issue' | 'pr';
}

export function IssueCard({ issue, owner, repo, type = 'issue' }: IssueCardProps) {
  const basePath = type === 'pr' ? 'pull' : 'issues';

  return (
    <div className="px-4 py-3 border-b border-github-border hover:bg-github-surface/50">
      <div className="flex items-start space-x-3">
        <div
          className={`mt-1 w-4 h-4 rounded-full ${
            issue.state === 'open'
              ? 'bg-github-success'
              : issue.state === 'merged'
              ? 'bg-purple-500'
              : 'bg-github-danger'
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <Link
              to={`/${owner}/${repo}/${basePath}/${issue.number}`}
              className="text-github-text font-semibold hover:text-github-accent"
            >
              {issue.title}
            </Link>
            {issue.labels?.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
          </div>
          <p className="mt-1 text-xs text-github-muted">
            #{issue.number} opened {formatDate(issue.created_at)} by {issue.author_name}
          </p>
        </div>
      </div>
    </div>
  );
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
