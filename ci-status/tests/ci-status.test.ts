import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatElapsed, statusText, tally } from '../hooks/format'
import { parseRollup, toState } from '../hooks/github'
import type { Snapshot } from '../types'

const T0 = Date.parse('2026-10-05T12:00:00Z')
const SESSION = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const checkRun = (name: string, status: string, conclusion: string, startedAt: string) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  startedAt,
  completedAt: status === 'COMPLETED' ? '2026-10-05T11:59:00Z' : '0001-01-01T00:00:00Z',
  detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${name}`,
  workflowName: 'CI',
})

const RUNNING = [
  checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z'),
  checkRun('unit', 'COMPLETED', 'FAILURE', '2026-10-05T11:57:00Z'),
  checkRun('e2e', 'IN_PROGRESS', '', '2026-10-05T11:57:55Z'),
]

const FINISHED = RUNNING.map(node =>
  node.name === 'e2e' ? checkRun('e2e', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:55Z') : node,
)

/**
 * Stands in for the engine, `git` and `gh`: a repository on branch `feature`
 * whose open pull request #42 reports whatever rollup `github.rollup` holds.
 * Returns the status line texts and toasts the mod raised.
 */
const fakeSession = (on: On, github: { rollup: unknown[] | null }) => {
  const seen = { lines: [] as (string | undefined)[], toasts: [] as string[] }
  const ok = (stdout: string) => ({
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', ($, e) => {
    seen.lines.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const command = e.argv.join(' ')

    if (command.startsWith('git rev-parse --abbrev-ref')) {
      return { value: ok('feature\n') }
    }

    if (command.startsWith('gh pr view --json') && github.rollup !== null) {
      const pullRequest = {
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
        title: 'Add the thing',
        isDraft: true,
        state: 'OPEN',
        statusCheckRollup: github.rollup,
      }

      return { value: ok(JSON.stringify(pullRequest)) }
    }

    return { value: { ...ok(''), exitCode: 1, stderr: 'no pull requests found for branch "feature"' } }
  })

  return seen
}

describe('formatting', () => {
  test('maps GitHub statuses onto check states', async () => {
    expect(toState('IN_PROGRESS', '')).toBe('running')
    expect(toState('queued', null)).toBe('queued')
    expect(toState('completed', 'success')).toBe('passed')
    expect(toState('COMPLETED', 'CANCELLED')).toBe('failed')
    expect(toState('COMPLETED', 'SKIPPED')).toBe('skipped')
    expect(toState('PENDING', '')).toBe('running')
  })

  test('counts checks and formats elapsed time', async () => {
    expect(tally(parseRollup(RUNNING))).toMatchObject({ passed: 1, failed: 1, running: 1, total: 3 })
    expect(formatElapsed(192_000)).toBe('03:12')
    expect(formatElapsed(3_792_000)).toBe('1:03:12')
  })

  test('shows nothing outside a GitHub repository', async () => {
    const snapshot: Snapshot = {
      phase: 'unavailable',
      branch: null,
      pullRequest: null,
      checks: [],
      fetchedAt: T0,
      problem: 'not a git repository',
    }

    expect(statusText(snapshot, T0)).toBe(undefined)
  })
})

describe('status line', () => {
  test('shows the pull request, the tally and a ticking elapsed time', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { lines } = fakeSession(on, { rollup: RUNNING })

    await $.session.start(SESSION)
    await clock.advance(2000)
    expect(lines.at(-1)).toBe('PR #42 (draft)  CI 1/3 passed, 1 failed, 1 running 02:07')

    await clock.advance(1000)
    expect(lines.at(-1)).toBe('PR #42 (draft)  CI 1/3 passed, 1 failed, 1 running 02:08')
  })

  test('toasts once when the run finishes', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: RUNNING as unknown[] | null }
    const { lines, toasts } = fakeSession(on, github)

    await $.session.start(SESSION)
    await clock.advance(2000)
    github.rollup = FINISHED
    await clock.advance(15_000)

    expect(toasts).toEqual(['CI finished: 1 of 3 checks failed'])
    expect(lines.at(-1)).toMatch(/^PR #42 \(draft\)  CI 2\/3 passed, 1 failed/)
  })

  test('shows nothing when gh cannot list runs for the commit', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { lines } = fakeSession(on, { rollup: null })

    await $.session.start(SESSION)
    await clock.advance(3000)

    expect(lines.filter(line => line !== undefined)).toEqual([])
  })
})

describe('drawing', () => {
  test('the band shows running and failed checks while a run is active', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: RUNNING })
    await $.session.start(SESSION)
    await clock.advance(2000)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'ci-status',
        surface,
        component: 'AbovePrompt',
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 10,
          bodyColumns: 100,
          scroll: { offset: 0, bodyRows: 10 },
          view: {},
        },
      })

      expect(await ui.find({ type: 'Link', text: 'PR #42 (draft)' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'e2e' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'unit' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'lint' })).toBe(undefined)
      await ui.unmount()
    }
  })

  test('/ci answers with a text summary and lists every check in the pane', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: RUNNING })
    await $.session.start(SESSION)
    await clock.advance(2000)

    const { text } = await $.command.run({
      command: 'ci',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    expect(text).toContain('feature: PR #42 (draft) https://github.com/acme/app/pull/42')
    expect(text).toContain('failed  unit')

    const ui = await $.ui.mount({
      plugin: 'ci-status',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'ci-status',
      props: {
        title: 'CI',
        isFocused: false,
        bodyColumns: 64,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })

    expect(await ui.findAll({ type: 'Link' })).toHaveLength(4)
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  })
})
