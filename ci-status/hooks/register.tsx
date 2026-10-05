import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Check, CheckState, Snapshot } from '../types'
import {
  checkDuration,
  diagnosePrompt,
  failedRuns,
  formatAgo,
  isActive,
  pullRequestLabel,
  pullRequestState,
  sortChecks,
  statusText,
  summaryText,
  tally,
  tallyText,
  verdict,
} from './format'
import { detectProvider, firstLine, parse, parseJobs, parsePullRequest, parseRollup, parseRun, text } from './github'
import type { Json } from './github'

const PANE = 'ci-status'
const ACTIVE_POLL_MS = 3_000
const ACTIVE_RUNS_POLL_MS = 10_000
const IDLE_POLL_MS = 60_000
const BOOST_MS = 120_000
const BOOST_DELAY_MS = 3_000
const UPSTREAM_CHECK_MS = 5_000
const IDLE_REDRAW_MS = 30_000
const BAND_ROWS = 5
const DOCK_PADDING = 2
const MAX_RUNS = 10
const LISTED_RUNS = 40
const CODE_EVENTS = new Set(['push', 'pull_request', 'pull_request_target', 'merge_group', 'workflow_dispatch', 'workflow_run'])
const TRIGGERS = /\bgit\s+push\b|\bgh\s+pr\s+(create|ready|merge)\b|\bgh\s+(run\s+rerun|workflow\s+run)\b/

const EMPTY: Snapshot = {
  phase: 'loading',
  provider: null,
  branch: null,
  pullRequest: null,
  checks: [],
  fetchedAt: 0,
  problem: null,
}

const COLORS: Record<CheckState, string | undefined> = {
  failed: 'red',
  running: 'yellow',
  queued: undefined,
  passed: 'green',
  skipped: undefined,
}

const snapshot = atom({ plugin: 'ci-status', key: 'snapshot' } as const, EMPTY)
const clock = atom({ plugin: 'ci-status', key: 'now' } as const, 0)
const isBandHidden = atom({ plugin: 'ci-status', key: 'isBandHidden' } as const, false)

/**
 * A URL the Link element accepts (https, printable ASCII, no user part), or
 * null: a Link with any other href would make the engine refuse the whole tree.
 */
const safeHref = (url: string | null): string | null => {
  if (url === null) {
    return null
  }

  try {
    const parsed = new URL(url)
    const isPlain = /^[\x21-\x7e]{1,2048}$/.test(parsed.href) && !parsed.href.includes('@')

    return parsed.protocol === 'https:' && isPlain ? parsed.href : null
  } catch {
    return null
  }
}

/** One check as a row: its state, its name linked to the job page, and its duration. */
const checkRow = (ui: ElementTable, check: Check, now: number) => {
  const { Box, Link, Text } = ui
  const href = safeHref(check.url)
  const isQuiet = check.state === 'queued' || check.state === 'skipped'

  return (
    <Box gap={1}>
      <Text color={COLORS[check.state]} dimColor={isQuiet}>
        {check.state.padEnd(7)}
      </Text>
      <Text wrap="truncate-end" dimColor={isQuiet}>
        {href === null ? check.name : <Link href={href}>{check.name}</Link>}
      </Text>
      <Text dimColor>{checkDuration(check, now)}</Text>
    </Box>
  )
}

/** The pull request as a link, or its plain label when there is none. */
const pullRequestLine = (ui: ElementTable, current: Snapshot) => {
  const { Link, Text } = ui
  const href = safeHref(current.pullRequest?.url ?? null)
  const label = pullRequestLabel(current)

  return <Text bold>{href === null ? label : <Link href={href}>{label}</Link>}</Text>
}

const live = {
  latest: EMPTY,
  inFlight: null as Promise<void> | null,
  nextPollAt: 0,
  boostUntil: 0,
  lastRedrawAt: 0,
  finished: new Map<string, Check[]>(),
  pendingPrompt: null as string | null,
  upstream: null as string | null,
  nextUpstreamCheckAt: 0,
  isClaudesRun: false,
  isDiagnosingFailures: false,
}

/**
 * Opens the pane so Escape at an idle prompt closes it: a terminal outside
 * fullscreen reports no clicks, so the frame's close mark cannot be the only way.
 */
const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'CI', columns: 64, closeOnEscape: true })

/**
 * Queues the failed checks as a prompt for Claude, a turn of its own, and
 * answers with what was done as a line for the person.
 *
 * The next tick submits it: a command's hook holds the turn a prompt would
 * wait on, so it cannot submit one itself.
 */
const diagnose = ($: EngineInterface): string => {
  const prompt = diagnosePrompt(live.latest)

  if (prompt === undefined) {
    return 'No failed checks to diagnose.'
  }

  live.pendingPrompt = prompt

  const failed = tally(live.latest.checks).failed

  return `Asked Claude to diagnose ${failed} failed ${failed === 1 ? 'check' : 'checks'}.`
}

/**
 * Re-runs the failed jobs of every GitHub Actions run that has one, and
 * answers with what was done as a line for the person.
 */
const rerun = async ($: EngineInterface): Promise<string> => {
  const runs = failedRuns(live.latest.checks)

  if (runs.length === 0) {
    return 'No failed GitHub Actions jobs to re-run.'
  }

  const results = await Promise.all(runs.map(id => run($, ['gh', 'run', 'rerun', id, '--failed'])))
  const refused = results.find(result => result.exitCode !== 0)

  if (refused !== undefined) {
    return `Re-run refused: ${firstLine(refused.stderr)}`
  }

  const now = await $.clock.now()

  live.boostUntil = now + BOOST_MS
  live.nextPollAt = now + BOOST_DELAY_MS

  return `Re-running the failed jobs of ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}.`
}

const run = async ($: EngineInterface, argv: readonly string[]) => {
  try {
    return await $.process.run(argv, { timeoutMs: 20000, env: { GH_PROMPT_DISABLED: '1' } })
  } catch {
    return { exitCode: 1, stdout: '', stderr: `${argv[0]} could not run` }
  }
}

/** The jobs of one workflow run as checks; finished runs are fetched once and kept. */
const jobsOf = async ($: EngineInterface, workflowRun: Json): Promise<Check[]> => {
  const id = String(workflowRun.databaseId)
  const key = `${id}:${text(workflowRun.updatedAt)}`
  const kept = live.finished.get(key)

  if (kept !== undefined) {
    return kept
  }

  const viewed = await run($, ['gh', 'run', 'view', id, '--json', 'jobs'])
  const jobs = viewed.exitCode === 0 ? parseJobs(parseRun(workflowRun).workflow, (parse(viewed.stdout) as Json | null)?.jobs) : []
  const checks = jobs.length > 0 ? jobs : [parseRun(workflowRun)]

  if (viewed.exitCode === 0 && text(workflowRun.status).toUpperCase() === 'COMPLETED') {
    live.finished.set(key, checks)
  }

  return checks
}

/**
 * Fetches CI state for the session's branch through `git` and `gh`.
 *
 * Only GitHub is read: a remote on another known host answers unavailable.
 * With an open pull request, its check rollup is the source (third-party
 * checks included). Without one, the jobs of the workflow runs on the head
 * commit are.
 */
const fetchSnapshot = async ($: EngineInterface, now: number): Promise<Snapshot> => {
  const head = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'])
  const provider = remote.exitCode === 0 ? detectProvider(remote.stdout) : null
  const base = { provider, pullRequest: null, checks: [], fetchedAt: now, problem: null }

  if (head.exitCode !== 0) {
    return { ...base, phase: 'unavailable', branch: null, problem: 'not a git repository' }
  }

  const name = head.stdout.trim()
  const branch = name === 'HEAD' ? null : name

  if (provider !== null && provider !== 'GitHub') {
    return { ...base, phase: 'unavailable', branch, problem: `${provider} is not supported yet` }
  }
  const viewed = await run($, ['gh', 'pr', 'view', '--json', 'number,url,title,isDraft,state,statusCheckRollup,mergeStateStatus,mergeable,reviewDecision'])
  const pullRequest = viewed.exitCode === 0 ? (parse(viewed.stdout) as Json | null) : null

  if (pullRequest !== null && pullRequest.state === 'OPEN') {
    return {
      ...base,
      phase: 'ready',
      branch,
      pullRequest: parsePullRequest(pullRequest),
      checks: parseRollup(pullRequest.statusCheckRollup),
    }
  }

  const commit = await run($, ['git', 'rev-parse', 'HEAD'])

  if (commit.exitCode !== 0) {
    return { ...base, phase: 'unavailable', branch, problem: 'no commits yet' }
  }

  const listed = await run($, [
    'gh',
    'run',
    'list',
    '--commit',
    commit.stdout.trim(),
    '--limit',
    String(LISTED_RUNS),
    '--json',
    'databaseId,workflowName,event,status,conclusion,startedAt,updatedAt,url',
  ])
  const runs = listed.exitCode === 0 ? parse(listed.stdout) : null

  if (!Array.isArray(runs)) {
    return { ...base, phase: 'unavailable', branch, problem: firstLine(listed.stderr) }
  }

  const relevant = runs.filter((one: Json) => CODE_EVENTS.has(text(one.event))).slice(0, MAX_RUNS)
  const checks = await Promise.all(relevant.map((one: Json) => jobsOf($, one)))

  return { ...base, phase: 'ready', branch, checks: checks.flat() }
}

/**
 * Toasts when a check newly fails mid-run and when the whole run finishes.
 *
 * A run that fails after Claude pushed is also handed to Claude to diagnose,
 * when the person turned that on.
 */
const announce = ($: EngineInterface, before: Snapshot, after: Snapshot) => {
  if (before.phase !== 'ready' || after.phase !== 'ready' || before.branch !== after.branch) {
    return
  }

  const counts = tally(after.checks)

  if (isActive(before.checks) && !isActive(after.checks) && after.checks.length > 0) {
    const isDiagnosing = counts.failed > 0 && live.isClaudesRun && live.isDiagnosingFailures
    const followUp = isDiagnosing ? 'asking Claude to diagnose' : '/ci diagnose to investigate'
    const failures = `${counts.failed} failed ${counts.failed === 1 ? 'check' : 'checks'}, ${followUp}`
    const successes = counts.total === 1 ? 'all checks passed' : `all ${counts.total} checks passed`
    const verdict = counts.failed > 0 ? failures : successes

    live.isClaudesRun = false
    live.pendingPrompt = isDiagnosing ? (diagnosePrompt(after) ?? null) : live.pendingPrompt
    $.ui.toast(`CI finished: ${verdict}`, { timeoutMs: 8000 })

    return
  }

  const earlier = new Map(before.checks.map(check => [`${check.workflow}/${check.name}`, check.state]))
  const broken = after.checks.filter(check => {
    const was = earlier.get(`${check.workflow}/${check.name}`)

    return check.state === 'failed' && was !== undefined && was !== 'failed'
  })

  if (broken.length > 0) {
    const what = broken.length === 1 ? broken[0]?.name : `${broken.length} checks`

    $.ui.toast(`CI check failed: ${what}`, { timeoutMs: 8000 })
  }
}

const refresh = async ($: EngineInterface) => {
  const fresh = await fetchSnapshot($, await $.clock.now())
  const before = live.latest

  live.latest = fresh
  announce($, before, fresh)
  await update($, snapshot, () => fresh)

  if (!isActive(before.checks) && isActive(fresh.checks)) {
    await update($, isBandHidden, () => false)
  }

  const now = await $.clock.now()
  const isBusy = isActive(fresh.checks) || now < live.boostUntil
  const activePace = fresh.pullRequest === null ? ACTIVE_RUNS_POLL_MS : ACTIVE_POLL_MS

  live.nextPollAt = now + (isBusy ? activePace : IDLE_POLL_MS)
}

/** Refetches from GitHub; callers during a fetch share the one in flight. */
const poll = ($: EngineInterface): Promise<void> => {
  live.inFlight ??= refresh($)
    .catch(error => $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' }))
    .finally(() => {
      live.inFlight = null
    })

  return live.inFlight
}

/**
 * Notices a push made outside the session by watching the commit the branch's
 * upstream points at, a local read that costs no API request.
 *
 * When it moves, a new run is about to start: polls now and holds the active
 * pace, so the checks show as GitHub creates them, not a minute later.
 */
const watchUpstream = async ($: EngineInterface, now: number) => {
  const read = await run($, ['git', 'rev-parse', '--verify', '--quiet', '@{upstream}'])
  const upstream = read.exitCode === 0 ? read.stdout.trim() : null
  const hasMoved = upstream !== null && live.upstream !== null && upstream !== live.upstream

  live.upstream = upstream

  if (hasMoved) {
    live.boostUntil = now + BOOST_MS
    live.nextPollAt = now
  }
}

/**
 * Runs every second: moves the clock the footer entry, band and pane draw
 * from, submits a queued prompt, watches for a push, and starts a poll when
 * one is due.
 */
const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()

  if (live.pendingPrompt !== null) {
    const text = live.pendingPrompt

    live.pendingPrompt = null
    void $.prompt.submit({ text }).catch(error => $.ui.log(`diagnose failed: ${String(error)}`, { to: 'debug' }))
  }

  if (now >= live.nextUpstreamCheckAt) {
    live.nextUpstreamCheckAt = now + UPSTREAM_CHECK_MS
    await watchUpstream($, now)
  }

  if (now >= live.nextPollAt) {
    live.nextPollAt = now + ACTIVE_POLL_MS
    void poll($)
  }

  const redrawEvery = isActive(live.latest.checks) ? 1000 : IDLE_REDRAW_MS

  if (now - live.lastRedrawAt >= redrawEvery) {
    live.lastRedrawAt = now
    await update($, clock, () => now)
  }
}

export const register: Register = (on, options) => {
  live.isDiagnosingFailures = options.diagnoseOnFailure === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci',
      description: 'Show GitHub Actions checks for the current branch',
      argumentHint: '[open|refresh|diagnose|rerun|close]',
      immediate: true,
    })

    if (e.isInteractive) {
      live.latest = await read($, snapshot)
      $.clock.every(1000, () => void tick($).catch(() => undefined))
    }

    return next(e)
  })

  on('command.run', { command: 'ci' }, async ($, e) => {
    const action = e.args.trim()

    if (action === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'CI pane closed.' }
    }

    if (!['', 'open', 'refresh', 'diagnose', 'rerun'].includes(action)) {
      return { text: 'Usage: /ci [open|refresh|diagnose|rerun|close]' }
    }

    await poll($)

    if (action === 'diagnose') {
      return { text: diagnose($) }
    }

    if (action === 'rerun') {
      return { text: await rerun($) }
    }

    const now = await $.clock.now()

    if (action === 'open') {
      const pullRequest = live.latest.pullRequest

      if (pullRequest === null) {
        return { text: `No open pull request for ${live.latest.branch ?? 'this commit'}.` }
      }

      await $.process.run(['gh', 'pr', 'view', String(pullRequest.number), '--web'])

      return { text: `Opened PR #${pullRequest.number}: ${pullRequest.url}` }
    }

    if (action === '') {
      await openPane($)
    }

    return { text: summaryText(live.latest, now) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (TRIGGERS.test(e.command)) {
      const now = await $.clock.now()

      live.boostUntil = now + BOOST_MS
      live.nextPollAt = now + BOOST_DELAY_MS
      live.isClaudesRun = true
    }

    return ran
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const current = await read($, snapshot)
    const now = Math.max(await read($, clock), current.fetchedAt)
    const line = statusText(current, now)

    if (line === undefined) {
      return next(e)
    }

    const { Link, Text } = $.ui.resolve(e)
    const href = safeHref(current.pullRequest?.url ?? null)
    const label = pullRequestLabel(current)
    const cut = href === null ? -1 : line.indexOf(label)
    const modes = e.props.modes.map(mode => `${mode} & `).join('')
    const state = verdict(current.checks)
    const color = state === null ? undefined : COLORS[state]
    const entry =
      cut < 0
        ? [`CI: ${line}`]
        : [`CI: ${line.slice(0, cut)}`, <Link href={href ?? ''}>{label}</Link>, line.slice(cut + label.length)]

    return (
      <Text wrap="truncate-end">
        {modes !== '' && <Text dimColor>{modes}</Text>}
        <Text color={color} dimColor={color === undefined}>
          {entry}
        </Text>
      </Text>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, snapshot)
    const isQuiet = e.props.hasSurvey || !isActive(current.checks) || (await read($, isBandHidden))

    if (isQuiet) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const now = Math.max(await read($, clock), current.fetchedAt)
    const room = Math.max(1, Math.min(BAND_ROWS, e.props.maxRows - 2))
    const rows = sortChecks(current.checks).filter(check => check.state === 'failed' || check.state === 'running')
    const hidden = rows.length - room

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          {pullRequestLine(ui, current)}
          <Text>CI {tallyText(current.checks)}</Text>
          <Button key="details" label="Details" onPress={() => void openPane($)} />
          {tally(current.checks).failed > 0 && (
            <Button key="diagnose" label="Diagnose" onPress={() => void $.ui.toast(diagnose($))} />
          )}
          <Button key="hide" label="Hide" onPress={() => void update($, isBandHidden, () => true)} />
        </Box>
        {rows.slice(0, room).map(check => checkRow(ui, check, now))}
        {hidden > 0 && <Text dimColor>{hidden} more in /ci</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const current = await read($, snapshot)
    const now = Math.max(await read($, clock), current.fetchedAt)
    const refreshButton = <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void poll($)} />
    const diagnoseButton = tally(current.checks).failed > 0 && (
      <Button key="diagnose" label="Diagnose" hotkey="d" variant="primary" onPress={() => void $.ui.toast(diagnose($))} />
    )
    const rerunButton = failedRuns(current.checks).length > 0 && (
      <Button key="rerun" label="Re-run failed" hotkey="f" onPress={() => void rerun($).then(text => $.ui.toast(text))} />
    )
    const closeButton = <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    const isUnclickable = e.surface === 'terminal' && e.props.placement === 'inline'
    const openCommand = current.pullRequest === null ? '' : ', /ci open'
    const diagnoseCommand = tally(current.checks).failed > 0 ? ', /ci diagnose, /ci rerun' : ''
    const paddingX = e.props.placement === 'dock' ? DOCK_PADDING : 0
    const layoutHint = isUnclickable && (
      <Text dimColor>Esc closes. Also /ci refresh{openCommand}{diagnoseCommand}. Buttons are clickable in /tui fullscreen.</Text>
    )

    if (current.phase !== 'ready') {
      const note = current.phase === 'loading' ? 'Loading CI status...' : `CI status unavailable: ${current.problem}`

      return (
        <Box flexDirection="column" gap={1} paddingX={paddingX}>
          <Text dimColor>{note}</Text>
          <Box gap={2}>
            {refreshButton}
            {closeButton}
          </Box>
          {layoutHint}
        </Box>
      )
    }

    const skipped = tally(current.checks).skipped

    return (
      <Box flexDirection="column" paddingX={paddingX}>
        <Box gap={2}>
          <Text dimColor>
            {current.provider ?? 'GitHub'} {current.branch ?? 'detached HEAD'}
          </Text>
          {pullRequestLine(ui, current)}
        </Box>
        {current.pullRequest !== null && <Text wrap="truncate-end">{current.pullRequest.title}</Text>}
        {pullRequestState(current) !== '' && <Text dimColor>{pullRequestState(current)}</Text>}
        <Box gap={2} marginY={1}>
          <Text>{current.checks.length === 0 ? 'No checks for this commit.' : tallyText(current.checks)}</Text>
          <Text dimColor>updated {formatAgo(now - current.fetchedAt)}</Text>
        </Box>
        {sortChecks(current.checks)
          .filter(check => check.state !== 'skipped')
          .map(check => checkRow(ui, check, now))}
        {skipped > 0 && <Text dimColor>{skipped} skipped</Text>}
        <Box gap={2} marginTop={1}>
          {refreshButton}
          {current.pullRequest !== null && (
            <Button
              key="open"
              label="Open PR"
              hotkey="o"
              onPress={() => void $.process.run(['gh', 'pr', 'view', String(current.pullRequest?.number), '--web'])}
            />
          )}
          {diagnoseButton}
          {rerunButton}
          {closeButton}
        </Box>
        {layoutHint}
      </Box>
    )
  })
}
