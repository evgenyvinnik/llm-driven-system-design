import {
  Search,
  FileText,
  AppWindow,
  User,
  Globe,
  Calculator,
  ArrowRightLeft,
  Music,
  Image,
  Code,
  FileSpreadsheet,
  Presentation,
  Clock,
  Mail,
  Calendar,
  MessageSquare,
  FolderOpen,
  LucideIcon,
} from 'lucide-react';

interface ResultIconProps {
  type: string;
  category?: string;
  className?: string;
}

const typeIcons: Record<string, LucideIcon> = {
  files: FileText,
  apps: AppWindow,
  contacts: User,
  web: Globe,
  calculation: Calculator,
  conversion: ArrowRightLeft,
  search: Search,
  app_suggestion: AppWindow,
  contact_suggestion: User,
  file_suggestion: FileText,
  url_suggestion: Globe,
};

const fileTypeIcons: Record<string, LucideIcon> = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  image: Image,
  music: Music,
  code: Code,
  folder: FolderOpen,
};

const appCategoryIcons: Record<string, LucideIcon> = {
  browser: Globe,
  productivity: FileText,
  developer: Code,
  communication: MessageSquare,
  music: Music,
};

const reasonIcons: Record<string, LucideIcon> = {
  'Based on your routine': Clock,
  'Recently accessed': Clock,
  'Frequently contacted': Mail,
};

export function ResultIcon({ type, category, className = '' }: ResultIconProps) {
  let Icon: LucideIcon;

  // Check for file type icons
  if (type === 'files' && category && fileTypeIcons[category]) {
    Icon = fileTypeIcons[category];
  }
  // Check for app category icons
  else if (type === 'apps' && category && appCategoryIcons[category]) {
    Icon = appCategoryIcons[category];
  }
  // Default type icons
  else {
    Icon = typeIcons[type] || FileText;
  }

  return <Icon className={className} />;
}

export function ReasonIcon({ reason, className = '' }: { reason?: string; className?: string }) {
  if (!reason) return null;

  const Icon = reasonIcons[reason] || Clock;
  return <Icon className={className} />;
}

export {
  Search,
  FileText,
  AppWindow,
  User,
  Globe,
  Calculator,
  ArrowRightLeft,
  Clock,
  Mail,
  Calendar,
  MessageSquare,
  Code,
  Music,
  Image,
  FileSpreadsheet,
  Presentation,
  FolderOpen,
};
