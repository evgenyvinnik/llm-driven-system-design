export interface SearchResult {
  id: string;
  type: 'files' | 'apps' | 'contacts' | 'web' | 'calculation' | 'conversion';
  name: string;
  score: number;
  path?: string;
  url?: string;
  email?: string;
  phone?: string;
  company?: string;
  bundle_id?: string;
  category?: string;
  content?: string;
  description?: string;
  icon?: string;
  value?: string | number;
  unit?: string;
  modified_at?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

export interface Suggestion {
  type: string;
  name: string;
  reason?: string;
  icon?: string;
  score: number;
  bundleId?: string;
  email?: string;
  phone?: string;
  path?: string;
  itemId?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedQuery {
  raw: string;
  type: 'search' | 'math' | 'conversion' | 'date_filter';
  expression?: string;
  value?: number;
  fromUnit?: string;
  toUnit?: string;
  dateFilter?: {
    startDate: Date;
    endDate: Date;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  query?: ParsedQuery;
}

export interface SuggestionsResponse {
  suggestions: Suggestion[];
}
