export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: string;
}

export interface Account {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_country: string | null;
  annual_revenue_cents: number | null;
  employee_count: number | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  account_id: string | null;
  account_name: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  department: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  account_id: string | null;
  account_name: string | null;
  name: string;
  amount_cents: number | null;
  stage: string;
  probability: number;
  /** Calendar day, 'YYYY-MM-DD' (the API keeps DATE columns as text). */
  close_date: string | null;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  /** Set by the server when the deal entered Closed Won / Closed Lost. */
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  source: string | null;
  status: string;
  converted_account_id: string | null;
  converted_contact_id: string | null;
  converted_opportunity_id: string | null;
  converted_at: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Activity {
  id: string;
  type: string;
  subject: string;
  description: string | null;
  due_date: string | null;
  completed: boolean;
  related_type: string | null;
  related_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
}

export interface CustomField {
  id: string;
  entity_type: string;
  field_name: string;
  field_type: string;
  options: Record<string, unknown> | null;
  is_required: boolean;
  created_at: string;
}

export interface CustomFieldValue {
  id: string;
  field_id: string;
  entity_id: string;
  value: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardKPIs {
  totalRevenue: number;
  openOpportunities: number;
  wonOpportunities: number;
  newLeads: number;
  activitiesDue: number;
  pipelineValue: number;
  conversionRate: number;
  avgDealSize: number;
}

/** Whose records a report covers: the whole org (admins only) or the caller's own. */
export type ReportScope = 'org' | 'own';

export interface PipelineStage {
  stage: string;
  count: number;
  totalAmountCents: number;
}

export interface RevenueByMonth {
  month: string;
  totalAmountCents: number;
  count: number;
}

export interface LeadsBySource {
  source: string;
  count: number;
}

export const OPPORTUNITY_STAGES = [
  'Prospecting',
  'Qualification',
  'Needs Analysis',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;

export const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'] as const;

export const LEAD_SOURCES = [
  'Web', 'Phone', 'Email', 'Referral', 'Partner', 'Trade Show', 'Social Media', 'Other',
] as const;

export const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'] as const;
