# Sentinel

Terminal PR reviewer for Bitbucket Server. Type `sentinel`, pick a PR you're tagged on, review the whole thing in one go with Juspay-hosted models, approve each finding, and only then post.

```
brew install <org>/tap/sentinel     # see "Publishing" below
sentinel                            # first launch walks you through setup
```

## What it does (the same logic as Claude Code's `/code-review`)

1. **Eligibility first.** Warns on closed/merged (blocked), draft, trivial, or "you already posted on this exact commit".
2. **Fetches the PR description and commits** and judges the code against the stated intent; behaviour the description says it does is not a bug.
3. **Reads the repo's guideline files** (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, …) from the root and from every directory above a changed file, and flags a violation only when a rule explicitly says so.
4. **Compares the diff against the real code.** The PR head and base are fetched shallowly into `workspaceRoot/WS/repo` (Bearer token, never written to disk), analysis gets a caller scan for removed/redefined symbols, and bugs are verified with `git grep`.
5. **Reports only what Claude Code reports:** the false-positive list is built in (pre-existing issues, lines the PR didn't change, linter/compiler-catchable, nitpicks, intentional changes). Bugs and breaking changes must carry a concrete *failure scenario*, and must sit on a changed line, or they are dropped for free.
6. **Scores every finding 0-100** with Claude Code's rubric, with a separate cheap-model scorer, and drops anything below the bar (80 at medium effort; suggestions 65).
7. **Vets each comment for appropriateness before you see it:** supported by the code, not a duplicate of another finding or an existing PR comment, no labels/headings, no speculation. Anything withdrawn stays visible in the Withdrawn tab with the reason.
8. **You approve every comment.** Nothing is posted until you press `p` and confirm. Each one posts as a plain comment or a Bitbucket task (your choice, `t`). Comments are two short paragraphs of prose with no "Bug:"/"Suggestion:" labels; `e` edits in your `$EDITOR`.

**Effort levels** (`e` on the PR list or estimate screen): `low` (score ≥85, 6 findings), `medium` (≥80, 15), `high` (≥70, 25, plus an independent second reader that checks intent, guidelines and regressions).

## Keys

| Screen | Keys |
|---|---|
| PR list | `↑↓` select · `↵` review · `u` paste PR link · `tab` switch list · `/` filter · `c` checks · `m` models · `r` refresh · `h` history · `s` settings · `q` quit |
| Estimate | `↵` start · `m` change models (estimate updates) · `esc` back |
| Findings | `↑↓` move · `a` approve · `x` reject · `e` edit · `t` task/comment · `A` approve all verified · `f`/`tab` filter · `d`/`u` scroll · `p` post · `esc` back |

## Changing models

Press `m` on the PR list or the estimate screen. Two columns: **Analysis** (strong) and **Verify + summary** (cheap). `↑↓` move, `tab` switch column, `↵` use (saved immediately), `n` type any model name. The list comes live from your gateway (`/models`, no tokens). Defaults live in `~/.pr-sentinel/config.json` (`llm.model`, `llm.fastModel`).

## Token optimization

- Skips generated, binary, lockfile, docs and localisation files; trims huge file diffs to 500 lines; sends 3 context lines.
- Strong model only for analysis. **Verification and summary use a cheaper model** (`fastModel`, default `glm-flash-experimental`).
- Verifies only the top `maxVerify` (12) findings by severity × confidence; suggestions aren't verified; low-confidence leftovers are dropped for free.
- Verifier gets a ±30-line window, ≤2 evidence requests, ≤2 model calls per finding.
- A clean PR gets its summary without a model call.
- **Cache**: identical chunks / findings (same diff, model, checks) cost 0 tokens on re-review.
- Hard **token budget** per review (default 400k). Riskiest files go first; when the cap is hit the rest is skipped and you're told.
- Live token meter in the header; every number comes from the gateway's reported usage.

## Config

`~/.pr-sentinel/config.json` (mode 600) is written by the setup screen; `s` on the PR list reopens it. It can import Bitbucket and Juspay settings from `~/.config/opencode/opencode.json`.
Code is fetched on first review into `workspaceRoot` (default `~/.pr-sentinel/repos`); `sentinel clone WS/repo` makes a full clone instead.
The fetch URL is `<bitbucket>/scm/<ws>/<repo>.git` over HTTPS with your token; override with `cloneUrlTemplate` if yours differs.

**Theme**: near-black background fading to dark burnt orange, with an orange→amber gradient accent (truecolor). iTerm2, Ghostty, kitty, WezTerm and VS Code get the gradient background; macOS Terminal.app keeps your own background and approximates the colours in 256 colours.

Other commands: `sentinel doctor` (uses no model tokens), `sentinel config`, `sentinel --version`.

## Install it with brew (and share it)

**Friends run, once:**

```
brew tap <you>/sentinel <TAP-GIT-URL>     # e.g. https://bitbucket.example.net/scm/proj/homebrew-sentinel.git
brew install sentinel
sentinel                                  # first launch walks through setup
```
They need their own Bitbucket HTTP access token and Juspay model key (setup asks for them) and git access to the two repos below. Update later: `brew update && brew upgrade sentinel`.

**You publish, once:**

1. Commit this repo (`git add -A && git commit -m "Sentinel 0.1.0"`).
2. `scripts/make-tap.sh --app-repo <git url of this repo>` writes a tap folder (`../homebrew-sentinel`) with the formula pinned to this exact commit and tag.
3. Push this repo and the `v0.1.0` tag to your Git host; push the tap folder as a repo named **`homebrew-sentinel`**.

For a new version: bump `version` in `package.json`, commit, run the script again, push both repos. The tap repo name must start with `homebrew-`. Hosting it on GitHub works the same (then friends can run just `brew tap <user>/sentinel`).

Nothing secret is in the package: tokens live in each person's `~/.pr-sentinel/config.json`. The default model-gateway URL and a Bitbucket URL hint are Juspay-internal, so keep the repos internal.

## Develop

```
npm install && npm link        # `sentinel` now runs your working copy
node tests/smoke.mjs           # renders every screen with stub data; no network, no tokens
```

## Using Claude Code or Codex instead of the gateway

No API key needed: Sentinel can call the CLIs you are already logged into.

- In setup choose provider `claude` or `codex` (or set `SENTINEL_PROVIDER=claude`). The gateway URL and key fields are then skipped.
- `claude` uses the aliases `sonnet` (analysis) and `haiku` (verification); change them with `m`.
- `codex` uses the model from your `~/.codex/config.toml` (`default`).
- The CLI runs in an empty temp folder with tools disabled, so it only answers; it never reads or edits your files.
- `sentinel doctor` checks the CLI is on your PATH.
