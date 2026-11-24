[![make.fun hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hinsmuhamad/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hinsmuhamad/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies AI-written edits in four formats
(unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls)
to a tree of text files. Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, relative to the working directory. When PATCH is
absent or is `-`, the patch is read from standard input. `--format=NAME`
reads one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`,
the default, which detects it). `--check` does everything but write.
`--strict` matches lines exactly.

Exit 0 prints what changed and `ok: <n> files`. Exit 1 prints one
`error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`,
and writes nothing. Exit 2 prints one line for a usage error, an unreadable
patch file, an undetected format, or a parse error. Every file is changed
or none is.

Built by an AI agent for make.fun's "Build mend, one patch tool for every
AI edit format" bounty. MIT licensed.

Bounty page: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
