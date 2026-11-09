/**
 * The environment a step sees: built from nothing, never inherited. The runner's own
 * environment holds its token and whatever else the host has, and none of it is any
 * step's business. Platform variables go after the workflow's own, so a workflow can't
 * spoof CI_ATTEMPT, and secrets go last.
 * @module runner/env
 */
import { join } from 'node:path'
import type { ClaimedJob } from '../scheduling/claim.js'

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

export interface Paths {
  workspace: string
  artifacts: string
}

export function buildStepEnv(job: ClaimedJob, stepEnv: Record<string, string>, paths: Paths): Record<string, string> {
  return {
    ...job.env,
    ...stepEnv,
    PATH: SAFE_PATH,
    HOME: paths.workspace,
    TMPDIR: join(paths.workspace, '.tmp'),
    LANG: 'C',
    CI: 'true',
    CI_REPOSITORY: job.repository,
    CI_COMMIT_SHA: job.commitSha,
    CI_REF: job.ref,
    CI_BRANCH: job.branch,
    CI_EVENT: job.eventType,
    CI_RUN_ID: job.runId,
    CI_JOB: job.jobKey,
    CI_ATTEMPT: String(job.attempt),
    CI_WORKSPACE: paths.workspace,
    CI_ARTIFACTS_DIR: paths.artifacts,
    ...job.secrets,
  }
}

export interface ResourceLimits {
  cpuSeconds: number
  fileSizeMb: number
  openFiles: number
}

/**
 * What a child process can be limited to without a container. `ulimit -f` counts
 * 512-byte blocks in POSIX sh. `ulimit -v` isn't supported on macOS, so memory isn't
 * limited there: the README says this is not a security boundary, and it means it.
 */
export function limitsPrefix(limits: ResourceLimits): string {
  return [`ulimit -c 0`, `ulimit -t ${limits.cpuSeconds} 2>/dev/null`, `ulimit -f ${limits.fileSizeMb * 2048} 2>/dev/null`, `ulimit -n ${limits.openFiles} 2>/dev/null`, `exec /bin/sh -e "$0"`].join('; ')
}
