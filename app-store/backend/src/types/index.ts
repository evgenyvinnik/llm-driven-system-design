export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: 'user' | 'developer' | 'admin';
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Developer {
  id: string;
  userId: string | null;
  name: string;
  email: string;
  website: string | null;
  description: string | null;
  logoUrl: string | null;
  verified: boolean;
  revenueShare: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: Date;
  subcategories?: Category[];
}

export interface App {
  id: string;
  bundleId: string;
  name: string;
  developerId: string;
  categoryId: string | null;
  subcategoryId: string | null;
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
  ratingSum: number;
  ratingCount: number;
  averageRating: number;
  iconUrl: string | null;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'published' | 'suspended';
  rejectionReason: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Joined fields
  developer?: Developer;
  category?: Category;
  screenshots?: Screenshot[];
}

export interface Screenshot {
  id: string;
  appId: string;
  url: string;
  deviceType: string;
  sortOrder: number;
  createdAt: Date;
}

export interface AppVersion {
  id: string;
  appId: string;
  version: string;
  buildNumber: number | null;
  releaseNotes: string | null;
  packageUrl: string | null;
  sizeBytes: number | null;
  minOsVersion: string | null;
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface Purchase {
  id: string;
  userId: string;
  appId: string;
  amount: number;
  currency: string;
  paymentMethod: string | null;
  paymentStatus: string;
  receiptData: string | null;
  purchasedAt: Date;
  expiresAt: Date | null;
}

export interface UserApp {
  id: string;
  userId: string;
  appId: string;
  purchased: boolean;
  downloadCount: number;
  firstDownloadedAt: Date;
  lastDownloadedAt: Date;
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
  integrityScore: number;
  status: 'pending' | 'published' | 'rejected' | 'hidden';
  developerResponse: string | null;
  developerResponseAt: Date | null;
  appVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Joined fields
  user?: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
}

export interface Ranking {
  id: string;
  date: Date;
  categoryId: string | null;
  rankType: 'free' | 'paid' | 'grossing' | 'new';
  appId: string;
  rank: number;
  score: number | null;
  createdAt: Date;
}

export interface DownloadEvent {
  id: string;
  appId: string;
  userId: string | null;
  version: string | null;
  country: string | null;
  deviceType: string | null;
  downloadedAt: Date;
}

// API request/response types
export interface PaginationParams {
  page?: number;
  limit?: number;
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

export interface SearchParams extends PaginationParams {
  q?: string;
  category?: string;
  priceType?: 'free' | 'paid' | 'all';
  minRating?: number;
  sortBy?: 'relevance' | 'rating' | 'downloads' | 'date';
}

export interface AppSubmission {
  bundleId: string;
  name: string;
  description: string;
  shortDescription: string;
  keywords: string[];
  categoryId: string;
  subcategoryId?: string;
  isFree: boolean;
  price?: number;
  ageRating: string;
}

export interface ReviewSubmission {
  rating: number;
  title?: string;
  body?: string;
}
