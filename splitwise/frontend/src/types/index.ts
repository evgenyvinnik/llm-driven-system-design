export interface User {
  id: string;
  username: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
}

export interface UserLite {
  id: string;
  username: string;
  name: string | null;
  avatar_url: string | null;
}

export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares';

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  groupType: string;
  avatarColor: string;
  memberCount: number;
  myBalanceCents: number; // + = you are owed, - = you owe
  createdAt: string;
}

export interface GroupMember {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  joinedAt: string;
}

export interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  groupType: string;
  avatarColor: string;
  createdBy: string;
  createdAt: string;
  myRole: string;
  members: GroupMember[];
}

export interface ExpenseListItem {
  id: string;
  description: string;
  amountCents: number;
  category: string;
  splitType: SplitType;
  note: string | null;
  paidBy: string;
  payerName: string | null;
  payerUsername: string;
  payerAvatar: string | null;
  iPaid: boolean;
  myNetCents: number; // + = you lent, - = you borrowed
  createdAt: string;
}

export interface ExpenseSplit {
  userId: string;
  name: string | null;
  username: string;
  avatarUrl: string | null;
  owedCents: number;
  shareUnits: number | null;
  percentage: number | null;
}

export interface ExpenseComment {
  id: string;
  content: string;
  name: string | null;
  username: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface ExpenseDetail {
  id: string;
  groupId: string;
  description: string;
  amountCents: number;
  category: string;
  splitType: SplitType;
  note: string | null;
  paidBy: string;
  payerName: string | null;
  payerUsername: string;
  payerAvatar: string | null;
  createdAt: string;
  splits: ExpenseSplit[];
  comments: ExpenseComment[];
}

export interface MemberNetBalance {
  userId: string;
  name: string | null;
  username: string;
  avatarUrl: string | null;
  netCents: number;
}

export interface SimplifiedTransfer {
  from: string;
  to: string;
  amountCents: number;
}

export interface GroupBalances {
  net: MemberNetBalance[];
  simplified: SimplifiedTransfer[];
}

export interface FriendBalance {
  userId: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  netCents: number; // + = they owe me, - = I owe them
}

export interface DashboardSummary {
  totalOwedCents: number;
  totalOweCents: number;
  netCents: number;
  friends: FriendBalance[];
}

export interface ActivityItem {
  id: string;
  type: string;
  summary: string;
  groupId?: string;
  groupName?: string;
  avatarColor?: string;
  expenseId: string | null;
  actorName: string | null;
  actorAvatar: string | null;
  createdAt: string;
}
