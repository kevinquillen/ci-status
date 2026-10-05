export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'

export type Check = {
  name: string
  workflow: string
  state: CheckState
  startedAt: number | null
  completedAt: number | null
  url: string | null
}

export type MergeState = 'ready' | 'unstable' | 'blocked' | 'behind' | 'conflicts'

export type ReviewState = 'approved' | 'changes requested' | 'review required'

export type PullRequest = {
  number: number
  url: string
  title: string
  isDraft: boolean
  merge: MergeState | null
  review: ReviewState | null
}

export type Snapshot = {
  phase: 'loading' | 'ready' | 'unavailable'
  provider: string | null
  branch: string | null
  pullRequest: PullRequest | null
  checks: Check[]
  fetchedAt: number
  problem: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'ci-status': { snapshot: Snapshot; now: number; isBandHidden: boolean }
  }
}
