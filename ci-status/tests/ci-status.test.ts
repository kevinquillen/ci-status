import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import { diagnosePrompt, formatElapsed, statusText, tally, verdict } from '../hooks/format'
import { detectProvider, parsePullRequest, parseRollup, toState } from '../hooks/github'
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
 * whose open pull request #42 reports whatever rollup `github.rollup` holds,
 * and whose upstream points at `github.upstream` when that is set.
 * `github.branch` checks another branch out, or with null leaves the
 * directory outside any repository; `github.head` is the commit checked out,
 * and `github.rerunError` makes `gh run rerun` fail with that message.
 * `github.runs` is what `gh run list` reports for the commit, and
 * `github.jobs` the jobs `gh run view` reports for each run id.
 * Returns the toasts the mod raised, the panes it opened and closed, the
 * prompts it submitted and the commands it ran. `github.standing` adds fields
 * to the pull request, such as its merge state. The footer's own drawing is the
 * engine's: the mode labels it is handed, dim and joined by ` & `, or the
 * text `github.footer` when another mod is to draw it instead.
 */
const fakeSession = (
  on: On,
  github: {
    rollup: unknown[] | null
    remote?: string
    upstream?: string
    standing?: object
    branch?: string | null
    head?: string
    rerunError?: string
    runs?: unknown[]
    jobs?: Record<string, unknown[]>
    footer?: string
  },
) => {
  const seen = {
    toasts: [] as string[],
    opened: [] as unknown[],
    closed: [] as string[],
    prompts: [] as string[],
    commands: [] as string[],
  }
  const ok = (stdout: string) => ({
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    seen.opened.push(e)

    return { value: { isPlaced: true as const } }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)

    return { text: e.text }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.render', { component: 'SessionMode' }, ($: EngineInterface, e) => h($.ui.resolve(e).Text, { dimColor: true }, github.footer ?? e.props.modes.join(' & ')) as RenderElement)
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const command = e.argv.join(' ')

    seen.commands.push(command)

    if (command.startsWith('gh run rerun')) {
      return { value: github.rerunError === undefined ? ok('') : { ...ok(''), exitCode: 1, stderr: github.rerunError } }
    }

    if (command.startsWith('git rev-parse --verify') && github.upstream !== undefined) {
      return { value: ok(`${github.upstream}\n`) }
    }

    if (command.startsWith('git rev-parse') && github.branch === null) {
      return { value: { ...ok(''), exitCode: 128, stderr: 'fatal: not a git repository' } }
    }

    if (command === 'git rev-parse HEAD') {
      return { value: ok(`${github.head ?? 'abc'}\n`) }
    }

    if (command.startsWith('gh run list') && github.runs !== undefined) {
      return { value: ok(JSON.stringify(github.runs)) }
    }

    const viewed = /^gh run view (\d+) --json jobs$/.exec(command)?.[1]
    const jobs = viewed === undefined ? undefined : github.jobs?.[viewed]

    if (jobs !== undefined) {
      return { value: ok(JSON.stringify({ jobs })) }
    }

    if (command === 'git rev-parse HEAD --abbrev-ref HEAD') {
      return { value: ok(`${github.head ?? 'abc'}\n${github.branch ?? 'feature'}\n`) }
    }

    if (command.startsWith('git rev-parse --abbrev-ref')) {
      return { value: ok(`${github.branch ?? 'feature'}\n`) }
    }

    if (command.startsWith('git remote get-url')) {
      return { value: ok(`${github.remote ?? 'git@github.com:acme/app.git'}\n`) }
    }

    if (command.startsWith('gh pr view --json') && github.rollup !== null) {
      const pullRequest = {
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
        title: 'Add the thing',
        isDraft: true,
        state: 'OPEN',
        statusCheckRollup: github.rollup,
        ...github.standing,
      }

      return { value: ok(JSON.stringify(pullRequest)) }
    }

    return { value: { ...ok(''), exitCode: 1, stderr: 'no pull requests found for branch "feature"' } }
  })

  return seen
}

/** What the prompt footer shows: its text, and the link inside it if any. */
const footer = async ($: Engine, modes: readonly string[] = ['focus']) => {
  const ui = await $.ui.mount({ plugin: 'ci-status', surface: 'terminal', component: 'SessionMode', props: { modes } })
  const whole = (await ui.find({ type: 'Box' })) ?? (await ui.find({ type: 'Text' }))
  const shown = { text: whole?.text, link: await ui.find({ type: 'Link' }) }

  await ui.unmount()

  return shown
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

  test('colors by the worst state: failed, then running, then passed', async () => {
    const lint = checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z')
    const e2e = checkRun('e2e', 'QUEUED', '', '2026-10-05T11:57:55Z')

    expect(verdict(parseRollup(RUNNING))).toBe('failed')
    expect(verdict(parseRollup([lint, e2e]))).toBe('running')
    expect(verdict(parseRollup([lint]))).toBe('passed')
    expect(verdict([])).toBe(null)
  })

  test('shows nothing outside a GitHub repository', async () => {
    const snapshot: Snapshot = {
      phase: 'unavailable',
      provider: null,
      branch: null,
      pullRequest: null,
      checks: [],
      fetchedAt: T0,
      problem: 'not a git repository',
    }

    expect(statusText(snapshot, T0)).toBe(undefined)
  })
})

describe('footer entry', () => {
  test('shows the linked pull request, the tally and a ticking elapsed time', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: RUNNING })

    await $.session.start(SESSION)
    await clock.advance(2000)

    const first = await footer($)

    expect(first.text).toMatch(/^focus & Branch: feature {2}.*PR #42 \(draft\)  CI: 1\/3 passed, 1 failed, 1 running 02:07$/)
    expect(first.link?.text).toContain('PR #42 (draft)')

    await clock.advance(1000)
    expect((await footer($)).text).toContain('1 running 02:08')
  })

  test('toasts once when the run finishes', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: RUNNING as unknown[] | null }
    const { toasts } = fakeSession(on, github)

    await $.session.start(SESSION)
    await clock.advance(2000)
    github.rollup = FINISHED
    await clock.advance(15_000)

    expect(toasts).toEqual(['CI finished: 1 failed check, /ci diagnose to investigate'])
    expect((await footer($)).text).toContain('PR #42 (draft)  CI: 2/3 passed, 1 failed')
  })

  test('lights the entry red, yellow or green and leaves the mode labels dim', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: RUNNING as unknown[] | null }
    const drawn = async () => {
      const ui = await $.ui.mount({ plugin: 'ci-status', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
      const entry = await ui.find({ type: 'Text', text: /PR #42/ })
      const modes = await ui.find({ type: 'Text', text: /^focus & Branch: feature$/ })

      await ui.unmount()

      return { color: entry?.props.color, isDim: entry?.props.dimColor, areModesDim: modes?.props.dimColor }
    }

    fakeSession(on, github)
    await $.session.start(SESSION)
    await clock.advance(2000)
    expect(await drawn()).toEqual({ color: 'red', isDim: false, areModesDim: true })

    github.rollup = RUNNING.filter(node => node.name !== 'unit')
    await clock.advance(15_000)
    expect((await drawn()).color).toBe('yellow')

    github.rollup = [checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z')]
    await clock.advance(15_000)
    expect((await drawn()).color).toBe('green')

    github.rollup = []
    await clock.advance(60_000)
    expect(await drawn()).toEqual({ color: undefined, isDim: true, areModesDim: true })
  })

  test('picks up a push made outside the session within seconds', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: [] as unknown[] | null, upstream: 'aaa' }

    fakeSession(on, github)
    await $.session.start(SESSION)
    await clock.advance(10_000)
    expect((await footer($)).text).toMatch(/PR #42 \(draft\)$/)

    github.upstream = 'bbb'
    await clock.advance(6000)
    github.rollup = RUNNING
    await clock.advance(4000)
    expect((await footer($)).text).toContain('1 running')
  })

  test('words the finishing toast by how many checks there were', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const lint = (status: string) => checkRun('lint', status, status === 'COMPLETED' ? 'SUCCESS' : '', '2026-10-05T11:57:00Z')
    const unit = (status: string) => checkRun('unit', status, status === 'COMPLETED' ? 'SUCCESS' : '', '2026-10-05T11:57:00Z')
    const github = { rollup: [lint('IN_PROGRESS')] as unknown[] | null }
    const { toasts } = fakeSession(on, github)

    await $.session.start(SESSION)
    await clock.advance(2000)
    github.rollup = [lint('COMPLETED')]
    await clock.advance(15_000)
    expect(toasts.at(-1)).toBe('CI finished: all checks passed')

    github.rollup = [lint('IN_PROGRESS'), unit('IN_PROGRESS')]
    await clock.advance(70_000)
    github.rollup = [lint('COMPLETED'), unit('COMPLETED')]
    await clock.advance(15_000)
    expect(toasts.at(-1)).toBe('CI finished: all 2 checks passed')
  })

  test('follows a checkout made outside the session and passes outside a repository', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: null as unknown[] | null, branch: 'feature' as string | null }

    fakeSession(on, github)
    await $.session.start(SESSION)
    await clock.advance(10_000)
    expect((await footer($)).text).toBe('focus & Branch: feature')

    github.branch = 'hotfix'
    await clock.advance(7000)
    expect((await footer($)).text).toBe('focus & Branch: hotfix')

    github.branch = null
    await clock.advance(7000)
    expect((await footer($)).text).toBe('focus')
  })

  test('picks up the first push of a branch that had no remote yet', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: [] as unknown[] | null, upstream: undefined as string | undefined }
    const { commands } = fakeSession(on, github)

    await $.session.start(SESSION)
    await clock.advance(10_000)
    expect(commands).toContain('git rev-parse --verify --quiet refs/remotes/origin/feature')

    github.upstream = 'aaa'
    await clock.advance(6000)
    github.rollup = RUNNING
    await clock.advance(4000)
    expect((await footer($)).text).toContain('1 running')
  })

  test('fetches again at once after a commit made outside the session', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: [] as unknown[] | null, head: 'abc' }

    fakeSession(on, github)
    await $.session.start(SESSION)
    await clock.advance(10_000)
    expect((await footer($)).text).not.toContain('running')

    github.head = 'def'
    github.rollup = RUNNING
    await clock.advance(7000)
    expect((await footer($)).text).toContain('1 running')
  })

  test('stands alone with no mode labels and drops the branch on a detached HEAD', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: FINISHED as unknown[] | null, branch: 'feature' as string | null }

    fakeSession(on, github)
    await $.session.start(SESSION)
    await clock.advance(2000)
    expect((await footer($, [])).text).toMatch(/^Branch: feature {2}.*CI: /)

    github.branch = 'HEAD'
    await clock.advance(7000)
    expect((await footer($, [])).text).toMatch(/^(?!Branch: ).*CI: /)
  })

  test('shows only the branch when gh cannot list runs for the commit', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: null })
    await $.session.start(SESSION)
    await clock.advance(3000)

    expect((await footer($)).text).toBe('focus & Branch: feature')
  })

  test('draws after another mod that draws the footer itself', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: FINISHED, footer: 'weather: sunny' })
    await $.session.start(SESSION)
    await clock.advance(2000)

    expect((await footer($)).text).toMatch(/^weather: sunny {2}.*CI: 2\/3 passed, 1 failed/)
  })

  test('draws beside the footer the engine draws itself', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: FINISHED })
    on('ui.render', { component: 'SessionMode' }, () => ({ type: 'engine', ref: 0 }) as RenderElement)
    await $.session.start(SESSION)
    await clock.advance(2000)

    const ui = await $.ui.mount({ plugin: 'ci-status', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })

    expect((await ui.find({ type: 'Text', text: /CI: / }))?.text).toContain('2/3 passed, 1 failed')
    await ui.unmount()
  })
})

describe('hiding', () => {
  const quiet: Snapshot = {
    phase: 'ready',
    provider: 'GitHub',
    branch: 'feature',
    pullRequest: null,
    checks: [],
    fetchedAt: T0,
    problem: null,
  }
  const pullRequest = { number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Fix', isDraft: false, merge: null, review: null }
  const passed = parseRollup([checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z')])

  test('names the hosting service from the remote URL', async () => {
    expect(detectProvider('git@github.com:acme/app.git')).toBe('GitHub')
    expect(detectProvider('https://gitlab.example.com/acme/app.git')).toBe('GitLab')
    expect(detectProvider('ssh://git@bitbucket.org/acme/app.git')).toBe('Bitbucket')
    expect(detectProvider('https://git.example.com/github/app.git')).toBe(null)
  })

  test('shows nothing without a pull request or recent checks', async () => {
    expect(statusText(quiet, T0)).toBe(undefined)
    expect(statusText({ ...quiet, checks: passed }, T0 + 5 * 60_000)).toBe('CI: 1/1 passed 6m ago')
    expect(statusText({ ...quiet, checks: passed }, T0 + 60 * 60_000)).toBe(undefined)
  })

  test('adds the review and merge standing of the pull request', async () => {
    const standing = (fields: object) => parsePullRequest({ number: 7, url: pullRequest.url, title: 'Fix', ...fields })

    expect(standing({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' })).toMatchObject({ merge: 'ready', review: 'approved' })
    expect(standing({ mergeStateStatus: 'BLOCKED', mergeable: 'CONFLICTING' }).merge).toBe('conflicts')
    expect(standing({ mergeStateStatus: 'UNKNOWN', reviewDecision: '' })).toMatchObject({ merge: null, review: null })

    const approved = { ...quiet, pullRequest: { ...pullRequest, merge: 'ready', review: 'approved' } } as const
    const blocked = { ...quiet, pullRequest: { ...pullRequest, merge: 'blocked', review: 'changes requested' }, checks: passed } as const

    expect(statusText(approved, T0)).toBe('PR #7  approved, ready to merge')
    expect(statusText(blocked, T0 + 60 * 60_000)).toBe('PR #7  CI: 1/1 passed 1h ago  changes requested, merge blocked')
  })

  test('keeps a pull request pinned even with no checks', async () => {
    expect(statusText({ ...quiet, pullRequest }, T0)).toBe('PR #7')
    expect(statusText({ ...quiet, pullRequest, checks: passed }, T0 + 60 * 60_000)).toBe('PR #7  CI: 1/1 passed 1h ago')
  })

  test('shows only the branch for a repository hosted elsewhere', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: RUNNING, remote: 'git@gitlab.com:acme/app.git' })
    await $.session.start(SESSION)
    await clock.advance(3000)

    expect((await footer($)).text).toBe('focus & Branch: feature')
  })
})

describe('drawing', () => {
  test('/ci answers with a text summary and lists every check in the pane', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    const { opened, closed } = fakeSession(on, { rollup: RUNNING })

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
    expect(await ui.find({ type: 'Text', text: 'Esc closes. Also /ci refresh, /ci open, /ci diagnose, /ci rerun. Buttons are clickable in /tui fullscreen.' })).toBeDefined()
    expect(opened).toEqual([{ id: 'ci-status', title: 'CI', columns: 64, closeOnEscape: true }])

    await ui.press({ key: 'close' })
    expect(closed).toEqual(['ci-status'])
    await ui.unmount()
  })

  test('/ci diagnose and the Diagnose button hand the failed checks to Claude', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: RUNNING as unknown[] | null }
    const { prompts, toasts } = fakeSession(on, github)
    const command = { command: 'ci', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
    const pane = () =>
      $.ui.mount({
        plugin: 'ci-status',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'ci-status',
        props: { title: 'CI', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })

    await $.session.start(SESSION)
    await clock.advance(2000)

    expect((await $.command.run({ ...command, args: 'diagnose' })).text).toBe('Asked Claude to diagnose 1 failed check.')
    await clock.advance(1000)
    expect(prompts).toEqual([
      [
        'CI failed on branch feature for PR #42 (https://github.com/acme/app/pull/42). Failed checks:',
        '- "unit" in workflow "CI": https://github.com/acme/app/actions/runs/1/job/unit',
        'Read the log of each failed check, work out why it failed, and report the cause and the fix you propose.',
        'Do not change any files until I agree to the fix.',
      ].join('\n'),
    ])

    const failing = await pane()

    await failing.press({ key: 'diagnose' })
    await clock.advance(1000)
    expect(prompts).toHaveLength(2)
    expect(toasts).toContain('Asked Claude to diagnose 1 failed check.')
    await failing.unmount()

    github.rollup = [checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z')]
    expect((await $.command.run({ ...command, args: 'diagnose' })).text).toBe('No failed checks to diagnose.')
    await clock.advance(1000)

    const passing = await pane()

    expect(await passing.find({ key: 'diagnose' })).toBe(undefined)
    expect(prompts).toHaveLength(2)
    await passing.unmount()
  })

  test('/ci rerun re-runs the failed jobs and says when there are none', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: FINISHED as unknown[] | null, standing: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' } }
    const { commands } = fakeSession(on, github)
    const command = { command: 'ci', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

    await $.session.start(SESSION)
    await clock.advance(2000)

    const summary = await $.command.run({ ...command, args: 'refresh' })

    expect(summary.text).toContain('review required, merge blocked')
    expect((await $.command.run({ ...command, args: 'rerun' })).text).toBe('Re-running the failed jobs of 1 run.')
    expect(commands).toContain('gh run rerun 1 --failed')

    github.rollup = [checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z')]
    expect((await $.command.run({ ...command, args: 'rerun' })).text).toBe('No failed GitHub Actions jobs to re-run.')
  })

  test('diagnoses a failed run by itself only after a push Claude made, when turned on', { options: { diagnoseOnFailure: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: RUNNING as unknown[] | null }
    const { prompts, toasts } = fakeSession(on, github)

    on('tool.call', () => ({ result: '', text: '' }))
    await $.session.start(SESSION)
    await clock.advance(2000)
    github.rollup = FINISHED
    await clock.advance(15_000)
    expect(prompts).toHaveLength(0)

    github.rollup = RUNNING
    await $.tool.call({ tool: 'Bash', command: 'git push origin feature' })
    await clock.advance(15_000)
    github.rollup = FINISHED
    await clock.advance(15_000)

    expect(toasts.at(-1)).toBe('CI finished: 1 failed check, asking Claude to diagnose')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('- "unit" in workflow "CI"')
  })

  test('the Re-run failed button re-runs and reports a refusal', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: FINISHED as unknown[] | null, rerunError: undefined as string | undefined }
    const { commands, toasts } = fakeSession(on, github)

    await $.session.start(SESSION)
    await clock.advance(2000)

    const ui = await $.ui.mount({
      plugin: 'ci-status',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'ci-status',
      props: { title: 'CI', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })

    await ui.press({ key: 'rerun' })
    expect(commands).toContain('gh run rerun 1 --failed')
    expect(toasts.at(-1)).toBe('Re-running the failed jobs of 1 run.')

    github.rerunError = 'run 1 cannot be rerun; its workflow file may be broken\nmore detail'
    await ui.press({ key: 'rerun' })
    expect(toasts.at(-1)).toBe('Re-run refused: run 1 cannot be rerun; its workflow file may be broken')
    await ui.unmount()
  })

  test('/ci open, close and an unknown argument answer for themselves', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const github = { rollup: FINISHED as unknown[] | null }
    const { commands, closed } = fakeSession(on, github)
    const command = { command: 'ci', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
    const answer = async (args: string) => (await $.command.run({ ...command, args })).text

    await $.session.start(SESSION)
    await clock.advance(2000)

    expect(await answer('open')).toBe('Opened PR #42: https://github.com/acme/app/pull/42')
    expect(commands).toContain('gh pr view 42 --web')
    expect(await answer('close')).toBe('CI pane closed.')
    expect(closed).toEqual(['ci-status'])
    expect(await answer('merge')).toBe('Usage: /ci [open|refresh|diagnose|rerun|close]')

    github.rollup = null
    expect(await answer('open')).toBe('No open pull request for feature.')
  })

  test('reads the jobs of the commit\'s workflow runs when there is no pull request', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const workflowRun = (databaseId: number, workflowName: string, event: string, status: string) => ({
      databaseId,
      workflowName,
      event,
      status,
      conclusion: status === 'completed' ? 'success' : '',
      startedAt: '2026-10-05T11:57:00Z',
      updatedAt: status === 'completed' ? '2026-10-05T11:59:00Z' : '2026-10-05T11:58:00Z',
      url: `https://github.com/acme/app/actions/runs/${databaseId}`,
    })
    const job = (name: string, status: string) => ({
      name,
      status,
      conclusion: status === 'completed' ? 'success' : '',
      startedAt: '2026-10-05T11:57:00Z',
      completedAt: status === 'completed' ? '2026-10-05T11:59:00Z' : '0001-01-01T00:00:00Z',
      url: `https://github.com/acme/app/actions/runs/7/job/${name}`,
    })
    const github = {
      rollup: null as unknown[] | null,
      runs: [workflowRun(7, 'CI', 'push', 'in_progress'), workflowRun(8, 'Deploy', 'push', 'in_progress'), workflowRun(9, 'Nightly', 'schedule', 'in_progress')],
      jobs: { '7': [job('build', 'completed'), job('test', 'in_progress')] } as Record<string, unknown[]>,
    }
    const { commands, toasts } = fakeSession(on, github)
    const views = () => commands.filter(command => command === 'gh run view 7 --json jobs').length

    await $.session.start(SESSION)
    await clock.advance(2000)

    const shown = await footer($)

    expect(shown.text).toMatch(/^focus & Branch: feature {2}CI: 1\/3 passed, 2 running /)
    expect(shown.link).toBe(undefined)
    expect(commands).toContain('gh run list --commit abc --limit 40 --json databaseId,workflowName,event,status,conclusion,startedAt,updatedAt,url')
    expect(commands).not.toContain('gh run view 9 --json jobs')

    const summary = await $.command.run({
      command: 'ci',
      args: 'refresh',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    expect(summary.text).toContain('feature: no PR')
    expect(summary.text).toContain('running Deploy')

    github.runs = [workflowRun(7, 'CI', 'push', 'completed'), workflowRun(9, 'Nightly', 'schedule', 'in_progress')]
    github.jobs = { '7': [job('build', 'completed'), job('test', 'completed')] }
    await clock.advance(15_000)
    expect(toasts.at(-1)).toBe('CI finished: all 2 checks passed')

    const seen = views()

    await clock.advance(130_000)
    expect(views()).toBe(seen)
  })

  test('counts checks reported by other services and links to them', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const status = (context: string, state: string) => ({
      __typename: 'StatusContext',
      context,
      state,
      startedAt: '2026-10-05T11:57:00Z',
      targetUrl: `https://ci.example.com/acme/app/${state.toLowerCase()}`,
    })
    const github = {
      rollup: [
        checkRun('lint', 'COMPLETED', 'SUCCESS', '2026-10-05T11:57:00Z'),
        status('ci/external: build', 'FAILURE'),
        status('deploy/preview', 'PENDING'),
      ] as unknown[] | null,
    }
    const { prompts } = fakeSession(on, github)
    const command = { command: 'ci', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

    await $.session.start(SESSION)
    await clock.advance(2000)
    expect((await footer($)).text).toContain('1/3 passed, 1 failed, 1 running')

    const ui = await $.ui.mount({
      plugin: 'ci-status',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'ci-status',
      props: { title: 'CI', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })

    expect((await ui.find({ type: 'Link', text: 'ci/external: build' }))?.props.href).toBe('https://ci.example.com/acme/app/failure')
    expect(await ui.find({ key: 'diagnose' })).toBeDefined()
    expect(await ui.find({ key: 'rerun' })).toBe(undefined)
    await ui.unmount()

    expect((await $.command.run({ ...command, args: 'rerun' })).text).toBe('No failed GitHub Actions jobs to re-run.')
    await $.command.run({ ...command, args: 'diagnose' })
    await clock.advance(1000)
    expect(prompts[0]).toContain('- "ci/external: build": https://ci.example.com/acme/app/failure')
  })

  test('names the log command for a job of GitHub Actions', async () => {
    const [failed] = parseRollup([checkRun('unit', 'COMPLETED', 'FAILURE', '2026-10-05T11:57:00Z')])
    const snapshot: Snapshot = {
      phase: 'ready',
      provider: 'GitHub',
      branch: 'feature',
      pullRequest: null,
      checks: failed === undefined ? [] : [{ ...failed, url: 'https://github.com/acme/app/actions/runs/7/job/99' }],
      fetchedAt: T0,
      problem: null,
    }

    expect(diagnosePrompt(snapshot)).toContain('- "unit" in workflow "CI": gh run view --job 99 --log-failed')
    expect(diagnosePrompt({ ...snapshot, checks: [] })).toBe(undefined)
  })

  test('pads the pane on both sides when it is docked beside the transcript', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    fakeSession(on, { rollup: RUNNING })
    await $.session.start(SESSION)
    await clock.advance(2000)

    for (const [placement, padding] of [['dock', 2], ['inline', 0]] as const) {
      const ui = await $.ui.mount({
        plugin: 'ci-status',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'ci-status',
        props: { title: 'CI', isFocused: false, bodyColumns: 64, placement, scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })

      expect((await ui.find({ type: 'Box' }))?.props.paddingX).toBe(padding)
      expect((await ui.findAll({ type: 'Text', text: 'Esc closes' })).length).toBe(placement === 'inline' ? 1 : 0)
      await ui.unmount()
    }
  })
})
