/** API shapes, mirroring the backend responses. */

export type Role = 'admin' | 'editor' | 'viewer'
export const ROLES: Role[] = ['admin', 'editor', 'viewer']

export type Permission =
  | 'org.read'
  | 'agents.read'
  | 'agents.write'
  | 'agents.delete'
  | 'knowledge.read'
  | 'knowledge.write'
  | 'conversations.read'
  | 'conversations.export'
  | 'analytics.read'
  | 'analytics.cost'
  | 'prompts.read'
  | 'prompts.write'
  | 'prompts.share'
  | 'billing.read'
  | 'members.read'
  | 'members.manage'
  | 'links.manage'
  | 'audit.read'
  | 'features.manage'

export interface Branding {
  accent: string
  initials: string
}

export interface User {
  id: string
  email: string
  displayName: string
}

export interface OrgSummary {
  id: string
  name: string
  plan: 'starter' | 'pro'
  branding: Branding
  role: Role
}

export interface Entitlements {
  exports: boolean
  costAnalytics: boolean
  seats: number
  auditRetentionDays: number
}
export type EntitlementFlag = 'exports' | 'costAnalytics'

export interface ProjectRef {
  id: string
  name: string
  restricted: boolean
}

/** The one permission source for the client: route guards, sidebar and buttons all read it. */
export interface Manifest {
  org: { id: string; name: string; plan: 'starter' | 'pro'; branding: Branding }
  role: Role
  actualRole: Role
  readOnly: boolean
  permissions: Permission[]
  entitlements: Entitlements
  flags: Record<string, boolean>
  projects: ProjectRef[]
  version: number
}

export interface Overview {
  stats: { agents: number; liveAgents: number; docs: number; conversations7d: number; escalated7d: number }
  recent: Array<{ id: string; subject: string; status: ConversationStatus; startedAt: string; agentName: string }>
}

export interface Agent {
  id: string
  name: string
  model: string
  status: 'draft' | 'live' | 'paused'
  instructions: string
  projectId: string
  projectName: string
  ownerName: string | null
  conversations7d: number
  updatedAt: string
}

export interface KnowledgeDoc {
  id: string
  title: string
  source: 'upload' | 'url' | 'helpdesk'
  chunks: number
  status: string
  createdAt: string
  projectName: string
  ownerName: string | null
}

export type ConversationStatus = 'open' | 'resolved' | 'escalated'
export type Channel = 'chat' | 'email' | 'voice'

export interface Conversation {
  id: string
  subject: string
  customerName: string
  channel: Channel
  status: ConversationStatus
  csat: number | null
  messageCount: number
  startedAt: string
  endedAt: string | null
  agentId: string
  agentName: string
  projectId: string
  projectName: string
}

export interface ConversationDetail extends Conversation {
  costCents?: number
  messages: Array<{ id: string; author: 'customer' | 'agent' | 'human'; body: string; createdAt: string }>
}

export interface ConversationFilters {
  status?: ConversationStatus
  channel?: Channel
  agentId?: string
  q?: string
  from?: string
  to?: string
}

export interface ConversationPage {
  items: Conversation[]
  nextCursor: string | null
  total?: { count: number; capped: boolean }
}

export interface AnalyticsPoint {
  day: string
  total: number
  resolved: number
  escalated: number
  csat: number | null
  costCents?: number
}

export interface Analytics {
  days: number
  costVisible: boolean
  series: AnalyticsPoint[]
}

export interface ShareLink {
  id: string
  tokenHint: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  createdByName: string | null
}

export interface Prompt {
  id: string
  title: string
  body: string
  sharedRoles: Role[]
  activeLinks: number
  projectId: string
  projectName: string
  ownerId: string
  ownerName: string | null
  isOwner: boolean
  updatedAt: string
}

export interface PromptDetail extends Prompt {
  links: ShareLink[]
}

export interface Member {
  id: string
  displayName: string
  email?: string
  role: Role
  joinedAt: string
  isYou: boolean
}

export interface Invitation {
  id: string
  email: string
  role: Role
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
  createdAt: string
  invitedByName: string | null
}

export interface OrgShareLink {
  id: string
  resourceType: 'prompt'
  resourceId: string
  resourceTitle: string | null
  tokenHint: string
  status: 'active' | 'revoked' | 'expired'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
  createdByName: string | null
}

export interface AuditEvent {
  id: string
  actorName: string
  action: string
  targetType: string
  targetId: string | null
  targetName: string | null
  before: unknown
  after: unknown
  createdAt: string
}

export interface FeatureFlag {
  key: string
  description: string
  defaultEnabled: boolean
  rule: { enabled: boolean; roles: Role[]; updatedAt: string } | null
}

export interface Billing {
  plan: 'starter' | 'pro'
  entitlements: Entitlements
  seats: { used: number; members: number; limit: number }
  usage: { conversationsMonthToDate: number; costMonthToDateCents: number }
  invoices: Array<{ id: string; period: string; amountCents: number; status: string }>
}

export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ExportJob {
  id: string
  kind: 'conversations'
  query: ConversationFilters
  status: ExportStatus
  totalRows: number | null
  processedRows: number
  fileBytes: number | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  finishedAt: string | null
  createdByName: string
}

export interface SharedPrompt {
  title: string
  body: string
  updatedAt: string
  orgName: string
  ownerName: string | null
  expiresAt: string | null
}

export interface InvitationView {
  orgName: string
  role: Role
  email: string
  invitedByName: string | null
  expiresAt: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
}
