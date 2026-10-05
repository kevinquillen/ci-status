export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'

export type Check = {
  name: string
  workflow: string
  state: CheckState
  startedAt: number | null
  completedAt: number | null
  url: string | null
}

export type PullRequest = {
  number: number
  url: string
  title: string
  isDraft: boolean
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
