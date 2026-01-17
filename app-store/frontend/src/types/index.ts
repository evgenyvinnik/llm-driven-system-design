export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: 'user' | 'developer' | 'admin';
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Developer {
  id: string;
  name: string;
  verified: boolean;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  subcategories?: Category[];
}

export interface App {
  id: string;
  bundleId: string;
  name: string;
  developerId: string;
  developer?: Developer;
  categoryId: string | null;
  category?: Category;
  description: string | null;
  shortDescription: string | null;
  keywords: string[];
  releaseNotes: string | null;
  version: string | null;
  sizeBytes: number | null;
  ageRating: string;
  isFree: boolean;
  price: number;
  currency: string;
  downloadCount: number;
  averageRating: number;
  ratingCount: number;
  iconUrl: string | null;
  screenshots?: Screenshot[];
  similarApps?: Partial<App>[];
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'published' | 'suspended';
}

export interface Screenshot {
  id: string;
  url: string;
  deviceType: string;
  sortOrder: number;
}

export interface Review {
  id: string;
  userId: string;
  appId: string;
  rating: number;
  title: string | null;
  body: string | null;
  helpfulCount: number;
  notHelpfulCount: number;
  status: string;
  developerResponse: string | null;
  developerResponseAt: string | null;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface RatingSummary {
  averageRating: number;
  totalRatings: number;
  distribution: Record<number, number>;
}
