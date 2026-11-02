export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: string;
}

/** The caller's role in a project; the backend enforces it, the UI only mirrors it. */
export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  createdBy: string;
  memberRole?: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: string;
  userId: string;
  username: string;
  email: string;
  displayName: string;
  role: ProjectRole;
  isCreator: boolean;
  joinedAt: string;
}

export interface SavedQuery {
  id: string;
  projectId: string;
  name: string;
  queryText: string;
  createdBy: string;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  projectId: string;
  email: string;
  emailConfirmed: boolean;
  role: string;
  rawUserMetadata: Record<string, unknown>;
  lastSignInAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TableInfo {
  tableName: string;
  schema: string;
  columns: ColumnInfo[];
  /** Planner estimate; null when the table has never been analyzed. */
  rowCount: number | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyRef?: string;
  ordinalPosition: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeID: number }[];
  rowCount: number;
  command?: string | null;
  /** More rows existed than the server returns (it caps results at 1000). */
  truncated?: boolean;
  /** The statement ran in a READ ONLY transaction (viewer role). */
  readOnly?: boolean;
}

export interface TableDataResponse {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeID: number }[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProjectSettings {
  id: string;
  name: string;
  description: string | null;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  createdAt: string;
  updatedAt: string;
}
