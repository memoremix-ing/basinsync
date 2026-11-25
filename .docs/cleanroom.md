[development]: <development.md>
[docs]: <../docs/README.md>
[srt]: <https://github.com/anthropic-experimental/sandbox-runtime>

# Clean-room rebuilds

A clean-room rebuild gives an agent the *documentation*[~][docs] alone and asks
it to rebuild basinsync: Quint specifications for the protocols, a Rust server,
and `quint-connect` model-based tests, starting from the codec kit. Its gap log
measures how complete and correct `docs/` is; comparing its build with this
repository's measures the rest. Rebuilds are meant to be repeated, by different
agents and against later documentation.

```sh
scripts/cleanroom/setup.sh [--ref REF] [--brief full|codec] NAME  # docs/ + brief at REF
scripts/cleanroom/run.sh --check NAME           # probe the sandbox only
CLAUDE_CODE_OAUTH_TOKEN=... scripts/cleanroom/run.sh NAME   # starts unit cleanroom-NAME
scripts/cleanroom/wait.sh NAME                  # block; repeat while it exits 3
scripts/cleanroom/status.sh NAME                # progress, memory, actions, errors, blockers
scripts/cleanroom/run.sh --continue NAME        # resume an unfinished claude run
scripts/cleanroom/run.sh --agent codex NAME     # with OPENAI_API_KEY
scripts/cleanroom/run.sh --command 'CMD' NAME   # any other agent
scripts/cleanroom/collect.sh NAME               # fetch as orphan branch cleanroom/NAME
```

Finished runs are archived as branches of the private
[basinsync-cleanrooms](https://github.com/memoremix-ing/basinsync-cleanrooms)
repository, one per run: the rebuild's history plus `cleanroom-run/` with its
logs, oracle results and full transcript. Its `main` README lists the scores.

```sh
scripts/cleanroom/archive.sh git@github.com:memoremix-ing/basinsync-cleanrooms.git NAME...
```

## Codec kit and codec-only rooms

Full rebuilds (`--brief full`, the default) get `scripts/cleanroom/kit/codec`
read-only in `vendor/basinsync-codec`: codecs, the oracle CLI, and Kani proofs
from an earlier clean room (`KIT.md` records which). By round four every
rebuild proved the same codec properties and Kani stopped finding anything, so
re-deriving them cost 15–25% of a run for no new information. Run a codec-only
room (`--brief codec`: codecs, Kani, oracle CLI, gaps; no server) when codec
docs change. If its vectors oracle passes every case, `kit-import.sh NAME`
replaces the kit; review the diff and `KANI.md`, then commit.

```sh
scripts/cleanroom/setup.sh --brief codec NAME
CLAUDE_CODE_OAUTH_TOKEN=... scripts/cleanroom/run.sh NAME
scripts/cleanroom/oracle.sh vectors --cli 'cargo run -q --release --bin basinsync-oracle' NAME
scripts/cleanroom/kit-import.sh NAME
```

An agent that starts a run must not end its turn while the run is in flight:
call `wait.sh` until it exits 0, 1, or 4, then report the outcome, `STATUS.md`
blockers, and anything `status.sh` flags.

`status.sh` classifies each run's outcome: in progress, finished, throttled
(still retrying after HTTP 429/529), usage-limit, or error. A usage-limit stop
makes `wait.sh` exit 4; once the allowance resets, `run.sh --continue NAME`
resumes the same agent session from its last state, with its uncommitted work
still in the workspace.

## Resources and observability

Each run is a systemd user unit capped at `--memory` (default 40% of RAM),
without swap, at reduced CPU priority. An out-of-memory kill takes the largest
process in the unit, usually a model checker, and the agent continues; the
first run exhausted the whole machine when CBMC grew past 54 GB. Without
systemd (as on macOS), pass `--foreground`, which runs uncapped.

`status.sh` reads the unit's memory use and peak, out-of-memory events, the
transcript's activity (flagging more than twenty idle minutes as a possible
stall), commits, the agent's `STATUS.md` with its `BLOCKED:` lines, recent
actions, and recent tool errors. `wait.sh` prints a brief status every five
minutes.

Runs live in `~/cleanroom/NAME` (override with `CLEANROOM_ROOT`). The brief is
`scripts/cleanroom/brief.md`, copied into each workspace as `AGENTS.md`, with a
`CLAUDE.md` that points to it.

## Isolation

`run.sh` wraps the agent in *srt*[~][srt] (bubblewrap on Linux, Seatbelt on
macOS) and refuses to start unless a probe confirms the sandbox:

- reads: the workspace, the agent's own config home, its TMPDIR and caches,
  and read-only toolchains; all of `/home`, `/root`, `/run/user`, and this
  user's agent scratch space under `/tmp` are hidden;
- writes: the workspace, the agent home, caches, and the Quint cache;
- network: the agent's API, crates.io, npm, the Go module proxy, and tool
  documentation; GitHub is unreachable, since basinsync's repositories are
  public;
- environment: cleared, then a curated set exported, so no host variables or
  git identity leak in.

Never run a clean room as an in-process subagent: the agent's file tools would
bypass a sandbox around its shell. Never copy your own agent login into the
sandbox; pass a dedicated token (`claude setup-token`) or API key instead.
On Ubuntu, AppArmor refuses srt's nested user namespace for Unix-socket
filtering, so runs allow Unix sockets and hide `/run/user` instead.

Prerequisites beyond the *development tools*[~][development]: `srt`,
`bubblewrap`, `socat`, `ripgrep`, Quint (with Apalache and the Rust evaluator
cached in `~/.quint` by one `quint verify` and one `quint run` outside the
sandbox, since both download from GitHub), Java, Kani, a C toolchain, and
VersityGW on `PATH`.

## Oracles

The integration oracle ends by validating every stored message the suites left
in S3 against the docs' CDDL schemas (`examples/schema-check`). Test fixtures
contribute a few deliberate failures (corrupt roots, legacy events without
coordinates); compare a rebuild's counts with the reference run's.
The cddl crate rejects one-element arrays such as `frames: [bstr]`, so the
checker validates `[+ bstr]` and counts Turso frames itself.

Suites must assert only what `docs/` requires: observable responses, bucket
contents, and documented metrics, never log text or incidental request
counts. Scenarios for behavior outside the docs, such as legacy single-tuple
events, run only when `BASINSYNC_SERVER` is unset, so the oracle skips them.

Agents never see these; apply them to a collected branch:

1. its `GAPS.md`, reviewed against `docs/`;
2. the codec vectors in `tests/vectors/`;
3. the TypeScript integration suites, pointed at the clean-room server;
4. a `quint-connect` driver for this implementation, replaying the clean-room
   specifications' traces.
