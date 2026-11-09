/**
 * The fixture catalog: the only source of workflow content in this project. Runners
 * execute these scripts as local child processes, so nothing a browser sends can add
 * to them: the fixture panel picks a scenario by name, and a signed webhook can only
 * refer to a commit that already exists in the fixture store.
 *
 * Each scenario is one tree (a commit's files, `.ci/workflow.yml` included).
 * @module fixtures/catalog
 */

export interface Scenario {
  name: string
  title: string
  description: string
  event: 'push' | 'pull_request'
  /** For pull requests: the head lives in a fork. */
  fork?: boolean
  branch?: string
  message: string
  files: Record<string, string>
  /** Offered in the panel as "kill the runner when this step starts". */
  killableStep?: string
  /** Hidden from the panel: used by the load script and the tests. */
  internal?: boolean
}

const WORKFLOW = '.ci/workflow.yml'

const app = { 'src/app.txt': 'hello from the fixture repository\n', 'README.md': '# Fixture repository\n' }

const diamond = `name: build-test-package
on: [push, pull_request]
jobs:
  build:
    name: Build
    runs-on: [linux]
    upload:
      - { name: app-bundle, path: dist/app.bundle, retention-days: 14 }
    steps:
      - name: Check out and verify
        run: |
          echo "commit $CI_COMMIT_SHA"
          cat src/app.txt
      - name: Compile
        run: |
          mkdir -p dist
          for i in 1 2 3; do echo "compile unit $i"; sleep 0.1; done
          echo "bundle of $CI_COMMIT_SHA" > dist/app.bundle
  test-unit:
    name: Unit tests
    needs: [build]
    runs-on: [linux]
    steps:
      - name: Read the build artifact
        run: |
          cat "$CI_ARTIFACTS_DIR/app-bundle"
      - name: Run
        run: |
          for i in 1 2 3 4; do echo "ok $i - unit"; sleep 0.1; done
  test-integration:
    name: Integration tests
    needs: [build]
    runs-on: [linux]
    steps:
      - name: Read the build artifact
        run: cat "$CI_ARTIFACTS_DIR/app-bundle"
      - name: Run
        run: |
          for i in 1 2 3; do echo "ok $i - integration"; sleep 0.15; done
  package:
    name: Package
    needs: [test-unit, test-integration]
    runs-on: [linux]
    steps:
      - name: Assemble
        run: echo "packaged after both test jobs, attempt $CI_ATTEMPT"
`

const failing = `name: lint-test-deploy
on: [push]
jobs:
  lint:
    name: Lint
    runs-on: [linux]
    steps:
      - name: Lint
        run: echo "0 problems"
  test:
    name: Tests
    runs-on: [linux]
    steps:
      - name: Run
        run: |
          echo "ok 1 - parses config"
          echo "not ok 2 - totals round correctly" >&2
          echo "expected 10.00, got 9.99" >&2
          exit 1
  package:
    name: Package
    needs: [test]
    runs-on: [linux]
    steps:
      - name: Assemble
        run: echo "should never run"
  publish:
    name: Publish
    needs: [package, lint]
    runs-on: [linux]
    steps:
      - name: Publish
        run: echo "should never run either"
`

const flaky = `name: flaky-tests
on: [push]
jobs:
  build:
    name: Build
    runs-on: [linux]
    upload:
      - { name: app-bundle, path: app.bundle }
    steps:
      - name: Compile
        run: |
          echo "compiled at attempt $CI_ATTEMPT"
          echo "bundle" > app.bundle
  test:
    name: Tests (flaky on attempt 1)
    needs: [build]
    runs-on: [linux]
    steps:
      - name: Run
        run: |
          echo "running attempt $CI_ATTEMPT of this job"
          if [ "$CI_ATTEMPT" = "1" ]; then echo "connection reset by test database" >&2; exit 1; fi
          echo "all tests passed"
  report:
    name: Report
    needs: [test]
    runs-on: [linux]
    steps:
      - name: Report
        run: echo "report for attempt $CI_ATTEMPT"
`

const deploy = `name: deploy-production
on: [push]
jobs:
  build:
    name: Build
    runs-on: [linux]
    secrets: [NPM_TOKEN]
    upload:
      - { name: release, path: release.tar, retention-days: 30 }
    steps:
      - name: Install with the registry token
        run: |
          echo "registry token is $NPM_TOKEN"
          echo "installed"
      - name: Compile
        run: echo "release of $CI_COMMIT_SHA" > release.tar
  deploy:
    name: Deploy to production
    needs: [build]
    runs-on: [linux, deploy]
    environment: production
    secrets: [DEPLOY_TOKEN]
    steps:
      - name: Prepare
        run: |
          cat "$CI_ARTIFACTS_DIR/release"
          echo "deploying with $DEPLOY_TOKEN"
      - name: Deploy
        idempotent: false
        timeout-seconds: 60
        run: |
          echo "pushing release to production..."
          sleep 3
          echo "production now serves $CI_COMMIT_SHA"
      - name: Post-deploy note
        run: echo "deploy finished"
  smoke:
    name: Smoke test production
    needs: [deploy]
    runs-on: [linux]
    steps:
      - name: Probe
        run: echo "production responded 200"
`

const forkPr = `name: pr-checks
on: [pull_request]
jobs:
  test:
    name: PR tests
    runs-on: [linux]
    secrets: [NPM_TOKEN]
    steps:
      - name: Try to read the token
        run: |
          echo "NPM_TOKEN is [\${NPM_TOKEN:-not set}]"
          echo "DEPLOY_TOKEN is [\${DEPLOY_TOKEN:-not set}]"
          env | sort
      - name: Run
        run: echo "ok 1 - contribution looks fine"
  sneak-deploy:
    name: Sneak into production
    needs: [test]
    runs-on: [linux, deploy]
    environment: production
    secrets: [DEPLOY_TOKEN]
    steps:
      - name: Exfiltrate
        run: echo "token is [\${DEPLOY_TOKEN:-not set}]"
  downstream:
    name: After the deploy
    needs: [sneak-deploy]
    runs-on: [linux]
    steps:
      - name: Never runs
        run: echo "should never run"
`

const slow = `name: slow-logs
on: [push]
jobs:
  chatty:
    name: Chatty job
    runs-on: [linux]
    steps:
      - name: Count slowly
        run: |
          i=1
          while [ $i -le 120 ]; do echo "log line $i of 120"; i=$((i+1)); sleep 0.1; done
`

const killable = `name: killable-build
on: [push]
jobs:
  long-build:
    name: Long idempotent build
    runs-on: [linux]
    steps:
      - name: Prepare
        run: echo "prepared on attempt $CI_ATTEMPT"
      - name: Compile for a while
        run: |
          echo "shell_pid=$$"
          if [ "$CI_ATTEMPT" = "1" ]; then
            i=1; while [ $i -le 40 ]; do echo "compiling $i"; i=$((i+1)); sleep 0.25; done
          fi
          echo "compiled on attempt $CI_ATTEMPT"
  after:
    name: After the build
    needs: [long-build]
    runs-on: [linux]
    steps:
      - name: Finish
        run: echo "ran after the retried build"
`

const secrets = `name: secret-masking
on: [push]
jobs:
  print:
    name: Print secrets carelessly
    runs-on: [linux]
    environment: staging
    secrets: [NPM_TOKEN, STAGING_KEY]
    steps:
      - name: Print whole
        run: |
          echo "whole: $NPM_TOKEN"
          echo "env-scoped: $STAGING_KEY"
      - name: Print split across two writes
        run: |
          half=\${#NPM_TOKEN}
          half=$((half / 2))
          first=$(printf '%s' "$NPM_TOKEN" | cut -c1-$half)
          rest=$(printf '%s' "$NPM_TOKEN" | cut -c$((half + 1))-)
          printf 'split: %s' "$first"
          sleep 1
          printf '%s end\\n' "$rest"
      - name: Print base64
        run: printf '%s' "$NPM_TOKEN" | base64
`

const cancellable = `name: cancellable
on: [push]
jobs:
  sleeper:
    name: Sleeps with children
    runs-on: [linux]
    steps:
      - name: Spawn a process tree
        timeout-seconds: 120
        run: |
          sleep 300 &
          echo "child_pid=$!"
          echo "shell_pid=$$"
          sh -c 'sleep 300 & echo "grandchild_pid=$!"; wait'
  after:
    name: After the sleeper
    needs: [sleeper]
    runs-on: [linux]
    steps:
      - name: Never runs
        run: echo "should never run"
`

const boundaries = `name: execution-boundary
on: [push]
jobs:
  inspect:
    name: Inspect the sandbox
    runs-on: [linux]
    steps:
      - name: Environment
        run: |
          echo "workspace=$PWD"
          echo "home=$HOME"
          env | sort
          if [ -e leftover.txt ]; then echo "found a file from an earlier attempt"; fi
          touch leftover.txt
      - name: Second step shares the workspace
        run: ls leftover.txt
  over-limit:
    name: Writes past the file size limit
    runs-on: [linux]
    steps:
      - name: Write a large file
        run: |
          dd if=/dev/zero of=big.bin bs=1048576 count=200
          echo "wrote all of it"
  too-slow:
    name: Exceeds its step timeout
    runs-on: [linux]
    steps:
      - name: Sleeps past the timeout
        timeout-seconds: 1
        run: |
          echo "timeout_shell_pid=$$"
          sleep 300
`

const timedOutDeploy = `name: deploy-timeout
on: [push]
jobs:
  deploy:
    name: Deploy that hangs
    runs-on: [linux]
    steps:
      - name: Deploy
        idempotent: false
        timeout-seconds: 1
        run: |
          echo "deploying..."
          sleep 300
`

const burstJob = `name: burst
on: [push]
jobs:
  quick:
    name: Quick job
    runs-on: [linux]
    steps:
      - name: Work
        run: |
          echo "working"
          sleep 1
`

const pinned = (version: string) => `name: pinned-${version}
on: [push]
jobs:
  print:
    name: Print the workflow version
    runs-on: [linux]
    steps:
      - name: Print
        run: |
          echo "workflow version ${version}"
          echo "file version: $(cat version.txt)"
          echo "attempt $CI_ATTEMPT"
`

export const SCENARIOS: Scenario[] = [
  { name: 'diamond', title: 'Push: diamond DAG', description: 'Build fans out to two test jobs that fan back into Package. Artifacts flow through needs.', event: 'push', message: 'Add the release bundle', files: { ...app, [WORKFLOW]: diamond } },
  { name: 'failing', title: 'Push: failing test', description: 'Tests fail; Package and Publish are skipped with the reason.', event: 'push', message: 'Fix rounding in totals', files: { ...app, [WORKFLOW]: failing } },
  { name: 'flaky', title: 'Push: flaky test', description: 'Fails on attempt 1 and passes on a re-run, so attempt history has something to show.', event: 'push', message: 'Add a database-backed test', files: { ...app, [WORKFLOW]: flaky } },
  {
    name: 'deploy',
    title: 'Push: deploy to production',
    description: 'A protected environment holds the job for approval. The Deploy step is non-idempotent: kill the runner during it to see needs_attention.',
    event: 'push',
    message: 'Release the new checkout flow',
    files: { ...app, [WORKFLOW]: deploy },
    killableStep: 'Deploy',
  },
  {
    name: 'killable',
    title: 'Push: long idempotent build',
    description: 'No non-idempotent steps. Kill the runner mid-build: the lease expires and a new attempt runs elsewhere.',
    event: 'push',
    message: 'Upgrade the compiler',
    files: { ...app, [WORKFLOW]: killable },
    killableStep: 'Compile for a while',
  },
  { name: 'fork-pr', title: 'Fork pull request', description: 'From a fork: no secrets, and its deploy job cannot enter the protected environment.', event: 'pull_request', fork: true, branch: 'patch-1', message: 'Fix a typo (and try to read the tokens)', files: { ...app, [WORKFLOW]: forkPr } },
  { name: 'same-repo-pr', title: 'Same-repository pull request', description: 'Same workflow as the fork, from a branch in the repository: repository secrets are released, the production branch rule still applies.', event: 'pull_request', branch: 'feature/checkout', message: 'Add checkout', files: { ...app, [WORKFLOW]: forkPr } },
  { name: 'slow-logs', title: 'Push: slow logs', description: 'Twelve seconds of log lines. Drop the connection in the log view and watch it resume.', event: 'push', message: 'Add verbose logging', files: { ...app, [WORKFLOW]: slow } },
  { name: 'secrets', title: 'Push: careless secret printing', description: 'Prints secrets whole, split across two writes, and in base64. All masked.', event: 'push', message: 'Debug the registry login', files: { ...app, [WORKFLOW]: secrets } },
  { name: 'cancellable', title: 'Push: long sleeper', description: 'A step with a process tree. Cancel the run and the whole process group dies.', event: 'push', message: 'Add a long integration suite', files: { ...app, [WORKFLOW]: cancellable } },
  { name: 'boundaries', title: 'Push: execution boundary', description: 'Shows the scrubbed environment and hits the file size limit and a step timeout.', event: 'push', message: 'Probe the sandbox', files: { ...app, [WORKFLOW]: boundaries } },
  { name: 'cycle', title: 'Push: dependency cycle', description: 'Rejected at intake, with the cycle recorded on the run.', event: 'push', message: 'Rearrange the pipeline', files: { ...app, [WORKFLOW]: `on: [push]\njobs:\n  a: { runs-on: [linux], needs: [c], steps: [{ name: s, run: echo a }] }\n  b: { runs-on: [linux], needs: [a], steps: [{ name: s, run: echo b }] }\n  c: { runs-on: [linux], needs: [b], steps: [{ name: s, run: echo c }] }\n` } },
  { name: 'unknown-need', title: 'Push: unknown need', description: 'Rejected at intake: a job needs one that does not exist.', event: 'push', message: 'Rename the build job', files: { ...app, [WORKFLOW]: `on: [push]\njobs:\n  test: { runs-on: [linux], needs: [buld], steps: [{ name: s, run: echo t }] }\n` } },
  { name: 'unknown-field', title: 'Push: unknown field', description: 'Rejected at intake: a typo in idempotent: false would otherwise silently disable the protection.', event: 'push', message: 'Mark the deploy as unsafe', files: { ...app, [WORKFLOW]: `on: [push]\njobs:\n  deploy:\n    runs-on: [linux]\n    steps:\n      - { name: Deploy, run: echo d, idempotnet: false }\n` } },
  { name: 'pinned-v1', title: 'Push: workflow v1', description: 'Prints "workflow version v1". Push v2 afterwards, then re-run this: it still prints v1.', event: 'push', message: 'Workflow v1', files: { ...app, 'version.txt': 'file-v1\n', [WORKFLOW]: pinned('v1') } },
  { name: 'pinned-v2', title: 'Push: workflow v2', description: 'The later change that must not alter a run of v1.', event: 'push', message: 'Workflow v2', files: { ...app, 'version.txt': 'file-v2\n', [WORKFLOW]: pinned('v2') } },
  { name: 'burst', title: 'Push: one quick job', description: 'What the burst load uses.', event: 'push', message: 'Quick change', files: { ...app, [WORKFLOW]: burstJob } },
  { name: 'deploy-timeout', title: 'Push: hanging deploy', description: 'A non-idempotent step times out: outcome unknown.', event: 'push', message: 'Deploy with a bad network', files: { ...app, [WORKFLOW]: timedOutDeploy }, internal: true },
  { name: 'feature-deploy', title: 'Push to a feature branch: deploy', description: 'Same deploy workflow from a branch the environment rule does not allow.', event: 'push', branch: 'feature/hotfix', message: 'Try a deploy from a branch', files: { ...app, [WORKFLOW]: deploy } },
]

export function scenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name)
}
