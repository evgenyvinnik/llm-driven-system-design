import { describe, it, expect } from 'vitest';
import {
  buildMemberFeatures,
  scorePymkCandidate,
  rankPymkCandidates,
  PYMK_WEIGHTS,
} from './pymkScoring.js';

const alice = buildMemberFeatures({
  experiences: [
    { company_name: 'TechCorp', is_current: true },
    { company_name: 'DataFlow Inc.', is_current: false },
  ],
  education: [{ school_name: 'University of California, Berkeley' }],
  skillIds: [1, 2, 4, 5, 6, 7, 8, 9],
  location: 'San Francisco, CA',
});

describe('scorePymkCandidate', () => {
  it('weights mutual connections, current company, school, capped skills and location', () => {
    const fiona = buildMemberFeatures({
      experiences: [{ company_name: ' techcorp ', is_current: true }],
      education: [{ school_name: 'university of california, berkeley' }],
      skillIds: [1, 2, 4, 5, 6, 7, 8],
      location: 'San Francisco, CA',
    });
    const result = scorePymkCandidate(alice, fiona, 1);
    const w = PYMK_WEIGHTS;
    expect(result.score).toBe(
      w.mutualConnection + w.sameCurrentCompany + w.sameSchool + w.maxSharedSkills * w.sharedSkill + w.sameLocation
    );
    expect(result.sharedSkills).toBe(7);
    expect(result.reasons).toEqual([
      '1 mutual connection',
      'Both work at TechCorp',
      'Both studied at University of California, Berkeley',
      '7 shared skills',
      'Also in San Francisco, CA',
    ]);
  });

  it('gives the smaller past-company weight when the overlap is not current for both', () => {
    const ethan = buildMemberFeatures({
      experiences: [
        { company_name: 'CloudNine Systems', is_current: true },
        { company_name: 'DataFlow Inc.', is_current: false },
      ],
      education: [],
      skillIds: [],
      location: 'Austin, TX',
    });
    const result = scorePymkCandidate(alice, ethan, 2);
    expect(result.score).toBe(2 * PYMK_WEIGHTS.mutualConnection + PYMK_WEIGHTS.sharedPastCompany);
    expect(result.sameCompany).toBe(true);
    expect(result.reasons).toEqual(['2 mutual connections', 'Both worked at DataFlow Inc.']);
  });

  it('scores a stranger zero with no reasons', () => {
    const stranger = buildMemberFeatures({ experiences: [], education: [], skillIds: [], location: null });
    expect(scorePymkCandidate(alice, stranger, 0)).toMatchObject({ score: 0, reasons: [] });
  });
});

describe('rankPymkCandidates', () => {
  it('orders by score, then mutual count, then id', () => {
    const make = (id: number, score: number, mutual: number) => ({ user: { id }, score, mutual_connections: mutual });
    const ranked = rankPymkCandidates([make(3, 10, 1), make(2, 20, 0), make(5, 10, 2), make(4, 10, 2)]);
    expect(ranked.map((c) => c.user.id)).toEqual([2, 4, 5, 3]);
  });
});
