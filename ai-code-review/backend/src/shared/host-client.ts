/**
 * HTTP implementation of HostReader. It carries the read-only token, so even a
 * bug here cannot post: the host refuses writes for this credential.
 * @module shared/host-client
 */
import { config } from './config.js'
import { HostUnavailable, type HostCheck, type HostComment, type HostCommit, type HostFile, type HostPull, type HostReader, type HostReview, type PullSnapshot } from './host-types.js'

async function hostGet<T>(path: string, timeoutMs = 5000): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${config.gitHostUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.readerToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new HostUnavailable(`Host unreachable: ${(err as Error).message}`)
  }
  if (!res.ok) throw new HostUnavailable(`Host returned ${res.status} for ${path}`, res.status)
  return (await res.json()) as T
}

export const httpHostReader: HostReader = {
  getPull: (fullName, number) => hostGet<HostPull>(`/repos/${fullName}/pulls/${number}`),

  async listOpenPulls(fullName) {
    return hostGet<HostPull[]>(`/repos/${fullName}/pulls?state=open`)
  },

  async readFile(fullName, path, sha) {
    try {
      const data = await hostGet<{ content: string }>(`/repos/${fullName}/contents?path=${encodeURIComponent(path)}&ref=${sha}`)
      return data.content
    } catch (err) {
      if (err instanceof HostUnavailable && err.status === 404) return null
      throw err
    }
  },

  listReviews: (fullName, number) => hostGet<HostReview[]>(`/repos/${fullName}/pulls/${number}/reviews`),

  async mergeBlockers(fullName, number) {
    return (await hostGet<{ blockers: string[] }>(`/repos/${fullName}/pulls/${number}/merge`)).blockers
  },

  async getSnapshot(fullName, number): Promise<PullSnapshot> {
    const pull = await hostGet<HostPull>(`/repos/${fullName}/pulls/${number}`)
    const [page, commits, comments, reviews, checks] = await Promise.all([
      hostGet<{ files: HostFile[]; truncated: boolean }>(`/repos/${fullName}/pulls/${number}/files?ref=${pull.head.sha}`),
      hostGet<HostCommit[]>(`/repos/${fullName}/pulls/${number}/commits`),
      hostGet<HostComment[]>(`/repos/${fullName}/pulls/${number}/comments`),
      hostGet<HostReview[]>(`/repos/${fullName}/pulls/${number}/reviews`).catch(() => null),
      hostGet<HostCheck[]>(`/repos/${fullName}/commits/${pull.head.sha}/check-runs`).catch(() => null),
    ])
    return { pull, files: page.files, filesTruncated: page.truncated, commits, comments, reviews, checks }
  },
}
