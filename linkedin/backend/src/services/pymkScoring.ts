/**
 * People You May Know scoring: explicit, explainable signals rather than a learned model.
 *
 * Candidate generation (who is considered) happens in SQL in pymkService; this module
 * decides how each candidate ranks and why, so the "why" strings shown on cards come
 * from the same arithmetic that ordered them. Pure functions, unit-tested.
 *
 * @module services/pymkScoring
 */

export const PYMK_WEIGHTS = {
  /** Per mutual connection: the strongest predictor of a real-world relationship */
  mutualConnection: 10,
  /** Both currently work at the same company */
  sameCurrentCompany: 8,
  /** Overlapping employer at some point (alumni effect); not added on top of current */
  sharedPastCompany: 5,
  sameSchool: 5,
  /** Per shared skill, capped so a long skill list can't outweigh a mutual connection */
  sharedSkill: 2,
  maxSharedSkills: 5,
  sameLocation: 2,
} as const;

/** What a member contributes to scoring, keyed by normalized name for matching. */
export interface MemberFeatures {
  /** normalized company name -> display name, current positions only */
  currentCompanies: Map<string, string>;
  /** normalized company name -> display name, every position */
  allCompanies: Map<string, string>;
  /** normalized school name -> display name */
  schools: Map<string, string>;
  skillIds: Set<number>;
  location: string | null;
}

export interface PymkScore {
  score: number;
  sameCompany: boolean;
  sameSchool: boolean;
  sharedSkills: number;
  sameLocation: boolean;
  /** Human-readable reasons, strongest first */
  reasons: string[];
}

/** Raw rows for one member, as loaded by pymkService. */
export interface MemberFeatureRows {
  experiences: { company_name: string; is_current: boolean }[];
  education: { school_name: string }[];
  skillIds: number[];
  location: string | null | undefined;
}

/**
 * Normalizes free-text names so "TechCorp " and "techcorp" match.
 *
 * @param value - Company, school or location text
 * @returns Lowercased, trimmed, single-spaced text
 */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds the feature sets used for scoring from a member's profile rows.
 *
 * @param rows - Experiences, education, skill ids and location
 * @returns Feature sets keyed by normalized name
 */
export function buildMemberFeatures(rows: MemberFeatureRows): MemberFeatures {
  const currentCompanies = new Map<string, string>();
  const allCompanies = new Map<string, string>();
  for (const exp of rows.experiences) {
    if (!exp.company_name) continue;
    const key = normalizeName(exp.company_name);
    allCompanies.set(key, exp.company_name.trim());
    if (exp.is_current) currentCompanies.set(key, exp.company_name.trim());
  }

  const schools = new Map<string, string>();
  for (const edu of rows.education) {
    if (edu.school_name) schools.set(normalizeName(edu.school_name), edu.school_name.trim());
  }

  return {
    currentCompanies,
    allCompanies,
    schools,
    skillIds: new Set(rows.skillIds),
    location: rows.location ? rows.location.trim() : null,
  };
}

function firstShared(a: Map<string, string>, b: Map<string, string>): string | null {
  for (const [key, name] of a) {
    if (b.has(key)) return name;
  }
  return null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Scores one candidate for one viewer.
 *
 * @param viewer - The member receiving suggestions
 * @param candidate - The suggested member
 * @param mutualCount - Number of mutual connections (from candidate generation)
 * @returns Score, the boolean signals the UI already understands, and reasons
 */
export function scorePymkCandidate(
  viewer: MemberFeatures,
  candidate: MemberFeatures,
  mutualCount: number
): PymkScore {
  const w = PYMK_WEIGHTS;
  const reasons: string[] = [];
  let score = 0;

  if (mutualCount > 0) {
    score += mutualCount * w.mutualConnection;
    reasons.push(plural(mutualCount, 'mutual connection'));
  }

  const currentCompany = firstShared(viewer.currentCompanies, candidate.currentCompanies);
  const pastCompany = currentCompany ? null : firstShared(viewer.allCompanies, candidate.allCompanies);
  if (currentCompany) {
    score += w.sameCurrentCompany;
    reasons.push(`Both work at ${currentCompany}`);
  } else if (pastCompany) {
    score += w.sharedPastCompany;
    reasons.push(`Both worked at ${pastCompany}`);
  }

  const school = firstShared(viewer.schools, candidate.schools);
  if (school) {
    score += w.sameSchool;
    reasons.push(`Both studied at ${school}`);
  }

  let sharedSkills = 0;
  for (const id of candidate.skillIds) {
    if (viewer.skillIds.has(id)) sharedSkills++;
  }
  if (sharedSkills > 0) {
    score += Math.min(sharedSkills, w.maxSharedSkills) * w.sharedSkill;
    reasons.push(plural(sharedSkills, 'shared skill'));
  }

  const sameLocation =
    !!viewer.location &&
    !!candidate.location &&
    normalizeName(viewer.location) === normalizeName(candidate.location);
  if (sameLocation) {
    score += w.sameLocation;
    reasons.push(`Also in ${candidate.location}`);
  }

  return {
    score,
    sameCompany: !!(currentCompany || pastCompany),
    sameSchool: !!school,
    sharedSkills,
    sameLocation,
    reasons,
  };
}

/**
 * Orders scored candidates: score, then mutual count, then id for a stable order.
 *
 * @param candidates - Scored candidates
 * @returns A new, sorted array
 */
export function rankPymkCandidates<T extends { score: number; mutual_connections: number; user: { id: number } }>(
  candidates: T[]
): T[] {
  return [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      b.mutual_connections - a.mutual_connections ||
      a.user.id - b.user.id
  );
}
