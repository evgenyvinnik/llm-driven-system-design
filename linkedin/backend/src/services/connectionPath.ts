/**
 * Degree of separation and the "how you're connected" path between two members.
 *
 * The search is bidirectional: it expands one hop from each side (both first-degree
 * sets come from cache) and looks for where they meet, instead of enumerating the
 * viewer's whole second-degree network (~250K people at 500 connections each).
 *
 * - 1st degree: the target is in the viewer's set.
 * - 2nd degree: the two sets intersect; every member of the intersection is a mutual.
 * - 3rd degree: some edge joins a member of one set to a member of the other; one
 *   indexed probe over the connections table (`findBridge`) answers that.
 *
 * Pure apart from the injected bridge lookup, so it is unit-tested without a database.
 *
 * @module services/connectionPath
 */

export interface ConnectionPathResult {
  /** 1, 2 or 3, or null when the target is outside the viewer's 3-degree network */
  degree: 1 | 2 | 3 | null;
  /** Mutual connections (only for 2nd degree; empty otherwise) */
  mutualIds: number[];
  /** Member ids from viewer to target inclusive; empty when out of network */
  pathIds: number[];
}

/**
 * Looks for one edge between the two sets. Returns it oriented as
 * [memberOfFirstSet, memberOfSecondSet], or null when no edge exists.
 */
export type BridgeFinder = (
  viewerFirstDegree: number[],
  targetFirstDegree: number[]
) => Promise<[number, number] | null>;

/**
 * Computes the degree of separation and one shortest path.
 *
 * @param viewerId - The member looking at a profile
 * @param targetId - The member being looked at (must differ from viewerId)
 * @param viewerFirstDegree - Viewer's first-degree connection ids
 * @param targetFirstDegree - Target's first-degree connection ids
 * @param findBridge - Edge probe used only when the sets do not intersect
 * @returns Degree, mutual ids and the path
 */
export async function findConnectionPath(
  viewerId: number,
  targetId: number,
  viewerFirstDegree: number[],
  targetFirstDegree: number[],
  findBridge: BridgeFinder
): Promise<ConnectionPathResult> {
  const viewerSet = new Set(viewerFirstDegree);

  if (viewerSet.has(targetId)) {
    return { degree: 1, mutualIds: [], pathIds: [viewerId, targetId] };
  }

  const mutualIds = targetFirstDegree.filter((id) => viewerSet.has(id)).sort((a, b) => a - b);
  if (mutualIds.length > 0) {
    return { degree: 2, mutualIds, pathIds: [viewerId, mutualIds[0], targetId] };
  }

  if (viewerFirstDegree.length === 0 || targetFirstDegree.length === 0) {
    return { degree: null, mutualIds: [], pathIds: [] };
  }

  const bridge = await findBridge(viewerFirstDegree, targetFirstDegree);
  if (bridge) {
    const [nearViewer, nearTarget] = bridge;
    return { degree: 3, mutualIds: [], pathIds: [viewerId, nearViewer, nearTarget, targetId] };
  }

  return { degree: null, mutualIds: [], pathIds: [] };
}
