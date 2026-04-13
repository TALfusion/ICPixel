#!/usr/bin/env bash
# ICPixel pre-deploy state snapshot.
#
# Dumps every readable bit of canister state to a timestamped file under
# `snapshots/`. **Run this before every mainnet deploy.** If something
# goes wrong post-deploy (data loss, schema regression, accidental
# reinstall) the snapshot is your only recovery aid — without it, you
# can't even tell what was lost.
#
# Usage:
#   ./scripts/mainnet-snapshot.sh                # local replica
#   ./scripts/mainnet-snapshot.sh --network ic   # mainnet
#
# What it captures:
#   - get_game_state          (map size, season, treasury counters)
#   - get_alliance_billing    (prices, principals, ledger)
#   - get_health              (cycles, stable pages)
#   - get_treasury_balance    (reward pool counter)
#   - get_wallet_pending_e8s  (pending owner payout)
#   - list_alliances          (every alliance, public view)
#   - get_nft_canister        (wired NFT canister)
#   - get_icp_price           (cached rate + age)
#   - leaderboard 0 100       (top 100 by pixel capture)
#
# What it does NOT capture (too large for query response):
#   - the pixel grid (use the change-log via get_changes_since instead)
#   - per-alliance mission rounds (would balloon the snapshot for big games)
#
# Exit code: 0 on full snapshot, 1 if any single call trapped (the file
# is still written so you can see how far we got).

set -uo pipefail
cd "$(dirname "$0")/.."

NETWORK_ARG=""
NETWORK_LABEL="local"
if [[ "${1:-}" == "--network" ]] && [[ -n "${2:-}" ]]; then
  NETWORK_ARG="--network $2"
  NETWORK_LABEL="$2"
fi

mkdir -p snapshots
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="snapshots/snapshot-${NETWORK_LABEL}-${TS}.txt"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

EXIT_CODE=0

dump() {
  local label="$1"
  local method="$2"
  local args="${3:-()}"
  echo "" >> "$OUT"
  echo "═══════════════════════════════════════════════════════" >> "$OUT"
  echo "  ${label}    (${method})" >> "$OUT"
  echo "═══════════════════════════════════════════════════════" >> "$OUT"
  if ! dfx canister call ${NETWORK_ARG} backend "$method" "$args" >> "$OUT" 2>&1; then
    red "  ✗ ${method} failed"
    EXIT_CODE=1
  else
    blue "  ✓ ${label}"
  fi
}

{
  echo "ICPixel state snapshot"
  echo "  network:     ${NETWORK_LABEL}"
  echo "  taken:       ${TS}"
  echo "  caller:      $(dfx identity whoami 2>/dev/null || echo unknown)"
  echo "  principal:   $(dfx identity get-principal 2>/dev/null || echo unknown)"
  echo "  git:         $(git rev-parse HEAD 2>/dev/null || echo not-a-git-repo)"
  echo "  git-status:  $(git status --porcelain 2>/dev/null | wc -l) modified files"
} > "$OUT"

blue "▶ snapshot → ${OUT}"

dump "game state"               get_game_state
dump "billing config"           get_alliance_billing
dump "canister health"          get_health
dump "treasury balance"         get_treasury_balance
dump "wallet pending"           get_wallet_pending_e8s
dump "nft canister principal"   get_nft_canister
dump "icp/usd rate"             get_icp_price
dump "alliances (all)"          list_alliances
dump "leaderboard top 100"      leaderboard       "(0 : nat64, 100 : nat64)"

SIZE=$(wc -c < "$OUT")
if [[ "$EXIT_CODE" -eq 0 ]]; then
  green "✓ snapshot complete (${SIZE} bytes)"
else
  red "✗ snapshot incomplete (${SIZE} bytes) — see $OUT for failures"
fi
exit "$EXIT_CODE"
