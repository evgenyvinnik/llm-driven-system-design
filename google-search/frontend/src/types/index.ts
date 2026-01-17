export interface SearchResult {
  url: string;
  url_id: number;
  title: string;
  description: string;
  domain: string;
  page_rank: number;
  fetch_time: string;
  score: number;
  snippet?: string;
  highlight?: {
    content?: string[];
    title?: string[];
  };
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  totalPages: number;
  query: string;
  parsedQuery?: {
    original: string;
    terms: string[];
    phrases: string[];
    excluded: string[];
    site: string[];
  };
  duration: number;
  fromCache: boolean;
}

export interface AutocompleteResponse {
  suggestions: string[];
}

export interface PopularSearchesResponse {
  searches: Array<{
    query: string;
    frequency: number;
  }>;
}

export interface SystemStats {
  index: {
    urls: {
      total: string;
      pending: string;
      crawled: string;
      errors: string;
    };
    documents: {
      total: string;
      avg_content_length: string;
    };
    links: {
      total: string;
    };
  };
  pageRank: {
    stats: {
      total: string;
      avg_rank: string;
      max_rank: string;
      min_rank: string;
    };
    topPages: Array<{
      id: number;
      url: string;
      page_rank: string;
      title: string;
    }>;
  };
  queries: {
    total_queries: string;
    avg_duration: string;
    days_active: string;
  };
}
