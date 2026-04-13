#!/usr/bin/env bash
# ICPixel upgrade smoke test.
#
# Verifies that `dfx deploy backend` (an *upgrade*, not reinstall) preserves
# stable memory. This catches the #1 risk for the project: a schema change
# to a Storable type that breaks candid decode and bricks the canister on
# mainnet. See MIGRATION.md § "Storable / stable-memory migration rules".
#
# Flow:
#   1. Snapshot game state via get_game_state + list_alliances.
#   2. Place a pixel at a fresh coordinate so we have a mutation to verify.
#   3. Create an alliance (unique name via timestamp) so we have an
#      Alliance row to verify.
#   4. Re-snapshot state.
#   5. Run `dfx deploy backend` (upgrade mode).
#   6. Re-snapshot again.
#   7. Assert post-upgrade snapshot matches pre-upgrade snapshot.
#
# On pass: prints "✓ upgrade preserved state" and exits 0.
# On fail: prints a diff and exits 1.
#
# Prereqs: local dfx replica running, backend already deployed once.

set -euo pipefail
cd "$(dirname "$0")/.."

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

fail() {
  red "✗ $*"
  exit 1
}

blue "▶ 1/6 snapshotting pre-test state"
PRE_GAME_STATE="$(dfx canister call backend get_game_state 2>&1)"
PRE_ALLIANCES="$(dfx canister call backend list_alliances 2>&1)"

# Use timestamp to keep the test data unique across runs. Pixel at a
# coordinate that's inside the tiniest map stage (0,0), so this works even
# on a freshly-installed canister.
TS="$(date +%s)"
NAME="upgrade-test-${TS}"

blue "▶ 2/6 placing a pixel at (0,0)"
if ! dfx canister call backend place_pixel "(0 : int16, 0 : int16, 0x00ff00 : nat32)" >/dev/null 2>&1; then
  echo "  (place_pixel failed — cooldown or bounds; test continues anyway)"
fi

blue "▶ 3/6 creating alliance '${NAME}'"
# Mission is a 1x1 at (0,0). Template is a single green pixel. This is the
# smallest valid mission and works on every map size ≥ 1.
MISSION="(record {
  x = 0 : int16;
  y = 0 : int16;
  width = 1 : nat16;
  height = 1 : nat16;
  template = vec { 0x00ff00 : nat32 };
})"
# Alliance creation may fail if caller is already in an alliance — that's
# fine, we're primarily testing that *existing* state survives, not that
# we can add new state.
if ! dfx canister call backend create_alliance \
  "(\"${NAME}\", \"test alliance created by test-upgrade.sh\", ${MISSION})" >/dev/null 2>&1; then
  echo "  (create_alliance failed — probably already in one; continuing)"
fi

blue "▶ 4/6 snapshotting mid-test state (before upgrade)"
MID_GAME_STATE="$(dfx canister call backend get_game_state 2>&1)"
MID_ALLIANCES="$(dfx canister call backend list_alliances 2>&1)"

blue "▶ 5/6 running dfx deploy backend (upgrade mode)"
if ! dfx deploy backend --yes 2>&1 | tail -5; then
  fail "dfx deploy backend failed — upgrade broken"
fi

blue "▶ 6/6 snapshotting post-upgrade state + diffing"
POST_GAME_STATE="$(dfx canister call backend get_game_state 2>&1)" || \
  fail "get_game_state trapped post-upgrade — stable memory decode broken"
POST_ALLIANCES="$(dfx canister call backend list_alliances 2>&1)" || \
  fail "list_alliances trapped post-upgrade — alliance decode broken"

# Diff. We use set-comparison-ish logic via plain string compare, since
# candid output is deterministic for query results.
if [[ "$MID_GAME_STATE" != "$POST_GAME_STATE" ]]; then
  red "game_state drifted across upgrade:"
  diff <(echo "$MID_GAME_STATE") <(echo "$POST_GAME_STATE") || true
  fail "state did not survive upgrade"
fi

if [[ "$MID_ALLIANCES" != "$POST_ALLIANCES" ]]; then
  red "list_alliances drifted across upgrade:"
  diff <(echo "$MID_ALLIANCES") <(echo "$POST_ALLIANCES") || true
  fail "alliances did not survive upgrade"
fi

green "✓ upgrade preserved state (game_state + ${#POST_ALLIANCES} bytes of alliance data)"
