import type { Check, CheckState, Snapshot } from '../types'

export type Tally = Record<CheckState, number> & { total: number }

const RECENT_MS = 30 * 60_000
const ORDER: readonly CheckState[] = ['failed', 'running', 'queued', 'passed', 'skipped']

/**
 * Counts checks by state. Skipped checks are counted but left out of `total`,
 * so "4/7 passed" is measured against the checks that actually ran or will run.
 */
export const tally = (checks: readonly Check[]): Tally => {
  const counts: Tally = { queued: 0, running: 0, passed: 0, failed: 0, skipped: 0, total: 0 }

  for (const check of checks) {
    counts[check.state] += 1
  }

  counts.total = checks.length - counts.skipped

  return counts
}

/** True while any check is still queued or running. */
export const isActive = (checks: readonly Check[]): boolean =>
  checks.some(check => check.state === 'running' || check.state === 'queued')

/** Formats a duration as mm:ss, or h:mm:ss from one hour up. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const rest = String(seconds % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`
}

/** Formats how long ago something happened, to the minute. */
export const formatAgo = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/**
 * When the current run began: the earliest start among running checks, or
 * among all started checks while everything left is still queued.
 */
export const runStartedAt = (checks: readonly Check[]): number | null => {
  const starts = (list: readonly Check[]) =>
    list.flatMap(check => (check.startedAt === null ? [] : [check.startedAt]))
  const running = starts(checks.filter(check => check.state === 'running'))
  const known = running.length > 0 ? running : starts(checks)

  return known.length > 0 ? Math.min(...known) : null
}

/** How long a check has run so far, or took in total; empty when unknown. */
export const checkDuration = (check: Check, now: number): string => {
  if (check.startedAt === null) {
    return ''
  }

  if (check.state === 'running') {
    return formatElapsed(now - check.startedAt)
  }

  return check.completedAt === null ? '' : formatElapsed(check.completedAt - check.startedAt)
}

/** Orders checks for display: failures first, then running, queued, passed, skipped. */
export const sortChecks = (checks: readonly Check[]): Check[] =>
  [...checks].sort(
    (a, b) =>
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
      a.workflow.localeCompare(b.workflow) ||
      a.name.localeCompare(b.name),
  )

/** The check counts as one phrase, such as "4/7 passed, 1 failed, 2 running". */
export const tallyText = (checks: readonly Check[]): string => {
  const counts = tally(checks)
  const parts = [`${counts.passed}/${counts.total} passed`]

  if (counts.failed > 0) {
    parts.push(`${counts.failed} failed`)
  }

  if (counts.running > 0) {
    parts.push(`${counts.running} running`)
  }

  if (counts.queued > 0) {
    parts.push(`${counts.queued} queued`)
  }

  return parts.join(', ')
}

/** The pull request as a short label, such as "PR #42 (draft)" or "no PR". */
export const pullRequestLabel = (snapshot: Snapshot): string => {
  if (snapshot.pullRequest === null) {
    return 'no PR'
  }

  const draft = snapshot.pullRequest.isDraft ? ' (draft)' : ''

  return `PR #${snapshot.pullRequest.number}${draft}`
}

/**
 * The footer entry for a snapshot as text, or undefined when there is nothing
 * worth pinning: no supported repository, or no pull request and no checks
 * that are running or finished within the last half hour.
 */
export const statusText = (snapshot: Snapshot, now: number): string | undefined => {
  if (snapshot.phase !== 'ready') {
    return undefined
  }

  const provider = snapshot.provider ?? 'GitHub'
  const label = snapshot.pullRequest === null ? provider : `${provider} ${pullRequestLabel(snapshot)}`

  if (snapshot.checks.length === 0) {
    return snapshot.pullRequest === null ? undefined : label
  }

  if (isActive(snapshot.checks)) {
    const startedAt = runStartedAt(snapshot.checks)
    const elapsed = startedAt === null ? '' : ` ${formatElapsed(now - startedAt)}`

    return `${label}  ${tallyText(snapshot.checks)}${elapsed}`
  }

  const finishes = snapshot.checks.flatMap(check =>
    check.completedAt === null ? [] : [check.completedAt],
  )
  const finishedAt = finishes.length > 0 ? Math.max(...finishes) : null
  const ago = finishedAt === null ? '' : ` ${formatAgo(now - finishedAt)}`
  const isStale = finishedAt === null || now - finishedAt > RECENT_MS

  if (snapshot.pullRequest === null && isStale) {
    return undefined
  }

  return `${label}  ${tallyText(snapshot.checks)}${ago}`
}

/** The snapshot as plain text lines, for the /ci reply and surfaces that draw no pane. */
export const summaryText = (snapshot: Snapshot, now: number): string => {
  if (snapshot.phase === 'loading') {
    return 'CI status is still loading.'
  }

  if (snapshot.phase === 'unavailable') {
    return `CI status unavailable: ${snapshot.problem ?? 'unknown reason'}`
  }

  const pullRequest = snapshot.pullRequest
  const head = pullRequest === null ? 'no PR' : `${pullRequestLabel(snapshot)} ${pullRequest.url}`
  const lines = [`${snapshot.branch ?? 'detached HEAD'}: ${head}`]

  if (snapshot.checks.length === 0) {
    return [...lines, 'No checks found for this commit.'].join('\n')
  }

  lines.push(tallyText(snapshot.checks))

  for (const check of sortChecks(snapshot.checks)) {
    const duration = checkDuration(check, now)

    if (check.state !== 'skipped') {
      lines.push(`  ${check.state.padEnd(7)} ${check.name}${duration === '' ? '' : ` (${duration})`}`)
    }
  }

  const skipped = tally(snapshot.checks).skipped

  if (skipped > 0) {
    lines.push(`  ${skipped} skipped`)
  }

  return lines.join('\n')
}
