export interface CrawlStats {
  pagesCrawled: number;
  pagesFailed: number;
  bytesDownloaded: number;
  linksDiscovered: number;
  duplicatesSkipped: number;

  frontierPending: number;
  frontierInProgress: number;
  frontierCompleted: number;
  frontierFailed: number;
  totalDomains: number;

  activeWorkers: string[];
  workerHeartbeats: WorkerHeartbeat[];

  recentPages: RecentPage[];
  topDomains: DomainStats[];
}

export interface WorkerHeartbeat {
  workerId: string;
  lastHeartbeat: number;
}

export interface RecentPage {
  url: string;
  domain: string;
  title: string;
  statusCode: number;
  crawledAt: string;
  durationMs: number;
}

export interface DomainStats {
  domain: string;
  pageCount: number;
  crawlDelay: number;
}

export interface FrontierUrl {
  id: number;
  url: string;
  urlHash: string;
  domain: string;
  priority: number;
  depth: number;
  status: string;
  scheduledAt: string;
}

export interface CrawledPage {
  id: number;
  url: string;
  domain: string;
  title: string;
  description: string;
  statusCode: number;
  contentType: string;
  contentLength: number;
  linksCount: number;
  crawledAt: string;
  crawlDurationMs: number;
}

export interface Domain {
  domain: string;
  pageCount: number;
  crawlDelay: number;
  isAllowed: boolean;
  robotsFetchedAt: string | null;
  createdAt: string;
}

export interface FrontierStats {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  totalDomains: number;
}
