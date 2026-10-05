import type { Check, CheckState, PullRequest } from '../types'

export type Json = Record<string, unknown>

const PASSED = new Set(['SUCCESS'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL'])
const RUNNING = new Set(['IN_PROGRESS', 'PENDING', 'EXPECTED'])
const QUEUED = new Set(['QUEUED', 'WAITING', 'REQUESTED'])

export const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const clean = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

const time = (value: unknown): number | null => {
  const parsed = Date.parse(text(value))

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Parses JSON output, or null when it is not JSON. */
export const parse = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/** The first line of a command's error output, made safe to draw. */
export const firstLine = (output: string): string => clean(output.split('\n')[0]) || 'gh failed'

/**
 * Maps GitHub's status and conclusion (check runs, commit statuses and
 * `gh run view` jobs alike, in either letter case) onto one check state.
 */
export const toState = (status: unknown, conclusion: unknown): CheckState => {
  const phase = text(status).toUpperCase()
  const result = text(conclusion).toUpperCase()

  if (QUEUED.has(phase)) {
    return 'queued'
  }

  if (RUNNING.has(phase)) {
    return 'running'
  }

  const outcome = result === '' ? phase : result

  if (PASSED.has(outcome)) {
    return 'passed'
  }

  return SKIPPED.has(outcome) ? 'skipped' : 'failed'
}

/** Reads the checks out of a pull request's `statusCheckRollup`. */
export const parseRollup = (rollup: unknown): Check[] => {
  if (!Array.isArray(rollup)) {
    return []
  }

  return rollup.map((node: Json) => {
    if (node.__typename === 'StatusContext') {
      return {
        name: clean(node.context) || 'status',
        workflow: '',
        state: toState(node.state, ''),
        startedAt: time(node.startedAt),
        completedAt: null,
        url: text(node.targetUrl) || null,
      }
    }

    return {
      name: clean(node.name) || 'check',
      workflow: clean(node.workflowName),
      state: toState(node.status, node.conclusion),
      startedAt: time(node.startedAt),
      completedAt: time(node.completedAt),
      url: text(node.detailsUrl) || null,
    }
  })
}

/** Reads the checks out of one workflow run's jobs, as `gh run view --json jobs` lists them. */
export const parseJobs = (workflow: string, jobs: unknown): Check[] => {
  if (!Array.isArray(jobs)) {
    return []
  }

  return jobs.map((job: Json) => ({
    name: clean(job.name) || 'job',
    workflow,
    state: toState(job.status, job.conclusion),
    startedAt: time(job.startedAt),
    completedAt: time(job.completedAt),
    url: text(job.url) || null,
  }))
}

/** Reads the pull request fields out of `gh pr view --json`. */
export const parsePullRequest = (data: Json): PullRequest => ({
  number: Number(data.number),
  url: text(data.url),
  title: clean(data.title),
  isDraft: data.isDraft === true,
})

/**
 * One workflow run as a single check, for when its jobs cannot be listed.
 */
export const parseRun = (workflowRun: Json): Check => ({
  name: clean(workflowRun.workflowName) || 'workflow',
  workflow: clean(workflowRun.workflowName),
  state: toState(workflowRun.status, workflowRun.conclusion),
  startedAt: time(workflowRun.startedAt),
  completedAt: null,
  url: text(workflowRun.url) || null,
})
