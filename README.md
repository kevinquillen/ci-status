# ci-status

A mod for Claude Code that shows the GitHub Actions status of the branch you
are working on, without leaving the session.

The mod is named `ci-status`. The command it adds is `/ci`.

## What it shows

- **Footer entry.** A `CI:` entry at the right of the prompt footer with the
  linked pull request, a tally such as `2/3 passed, 1 running`, and a timer.
  It is red when any check has failed, yellow while checks are running or
  queued, and green once they have passed. It hides itself when there is
  nothing to report. With a pull request it ends with where the pull request
  stands, such as `approved, ready to merge` or `changes requested, merge
  blocked`.
- **Band above the prompt.** While a run is active, the running and failed
  checks are listed above the prompt. `Hide` dismisses it until the next run.
- **Pane.** `/ci` opens a pane listing every check with its state and duration,
  each linked to its job page.
- **Toasts.** One when a check newly fails, and one when the run finishes.
- **Diagnose.** When checks have failed, a `Diagnose` button in the band and
  the pane (or `/ci diagnose`) asks Claude to read the failing job logs and
  report the cause and a proposed fix. Claude changes nothing until you agree.

## Requirements

- Claude Code with mod support.
- The [GitHub CLI](https://cli.github.com/) (`gh`), installed and logged in
  with `gh auth login`. The mod reads everything through it.
- A repository whose `origin` remote is on GitHub.

GitLab and Bitbucket remotes are detected but not supported yet. On those the
mod stays hidden and `/ci` reports that the host is not supported.

## Install

```
claude plugin marketplace add kevinquillen/github-mod
claude plugin install ci-status@github-mod
```

To try it from a clone without installing:

```
git clone git@github.com:kevinquillen/github-mod.git
claude --plugin-dir ./github-mod/ci-status
```

## Commands

| Command | What it does |
| --- | --- |
| `/ci` | Fetches the latest status, opens the pane and prints a text summary |
| `/ci refresh` | Fetches the latest status and prints the summary |
| `/ci open` | Opens the pull request in the browser |
| `/ci diagnose` | Asks Claude to read the logs of the failed checks and report the cause |
| `/ci rerun` | Re-runs the failed jobs of the GitHub Actions runs that have one |
| `/ci close` | Closes the pane |

The pane's buttons and its close mark are clickable in the fullscreen layout
(`/tui fullscreen`). In the default layout, use the commands above.

The pane also has `Diagnose` and `Re-run failed` buttons while checks have
failed.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `diagnoseOnFailure` | off | When a run fails after Claude pushed, asks Claude to diagnose it without being asked. Uses tokens. |

Change it in the config menu (`/config`), or with
`claude plugin configure ci-status`.

## How often it refreshes

| Situation | Interval |
| --- | --- |
| Checks active on a branch with an open pull request | 3 seconds |
| Checks active on a branch without a pull request | 10 seconds |
| Nothing running | 60 seconds |

After Claude runs `git push`, `gh pr create`, `gh pr ready`, `gh pr merge`,
`gh run rerun` or `gh workflow run`, the mod refetches within a few seconds and
keeps the active pace for two minutes so the new run is picked up as it starts.
A push from your own terminal is noticed the same way within about five
seconds, by watching the local upstream ref.

Refreshing calls the GitHub API through `gh` and counts against your API rate
limit. It never calls the model, so it uses no tokens. Diagnose is the one
exception: it starts a normal Claude turn, and only when you ask for it or
have turned on `diagnoseOnFailure`.

## Development

```
claude plugin validate ./ci-status
claude plugin test ./ci-status
```

Run a session with `claude --plugin-dir ./ci-status` to load the mod from the
working copy. It reloads when a file is saved.

## License

MIT. See [LICENSE](LICENSE).
