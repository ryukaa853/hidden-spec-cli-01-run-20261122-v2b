# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ryukaa853/hidden-spec-cli-01-run-20261122-v2b/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ryukaa853/hidden-spec-cli-01-run-20261122-v2b/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one written
contract: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Each edit names old lines that are found in the file at the first of three
matching tiers: exact, ignoring trailing whitespace, then ignoring leading
and trailing whitespace. Every file is changed or nothing is: a failed edit
changes nothing, the edits after it still run, and when any edit failed no
file is written.

## Exit codes

- `0` — the tree is written; one line per changed path, then `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; nothing is written.
- `2` — one line only: `error: usage`, `error: no-patch`, `error: format`,
  or `error: parse <N>`.

## Files

- `main.ts` — the tool (Node 22, standard library only).
- `SPEC.md` — the whole contract.
- `runner.ts` — the kit's trial runner, kept as handed out.
- `check.ts` — runs `main.ts` on the kit's 100 practice checks.

## License

MIT — see `LICENSE`.
