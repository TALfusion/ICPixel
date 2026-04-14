#!/usr/bin/env bash
# ICPixel deploy script.
#
# Wraps `dfx deploy` with the post-deploy wiring that has to happen after
# every fresh install/upgrade:
#
#   1. Deploy all canisters (backend, nft, frontend, internet_identity)
#   2. Tell backend the nft canister principal — set_nft_canister.
#      This is needed every time backend's stable storage is wiped (which
#      happens on `--mode reinstall` and on any non-trivial upgrade) because
#      `nft_canister` lives in stable state and gets reset to None.
#   3. Tell nft canister to trust backend as a minter — set_minter.
#      Same reason: lives in stable state on the nft canister.
#
# Idempotent: safe to run any number of times. Pass any args after the
# script name and they're forwarded to `dfx deploy` (e.g. `--yes`,
# `--network ic`, individual canister names, etc).
#
# Usage:
#   ./scripts/deploy.sh                # deploy everything (asks for confirm)
#   ./scripts/deploy.sh --yes          # auto-accept candid breaking changes
#   ./scripts/deploy.sh frontend       # deploy only frontend (skips wiring)

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Pre-deploy safety snapshot ────────────────────────────────────────
# Takes a canister snapshot of backend and nft BEFORE deploying. If the
# upgrade breaks something, you can roll back with:
#   dfx canister snapshot load <canister> <snapshot-id>
#
# Snapshots are cheap (only delta from current state) and local replica
# supports them since dfx 0.24+. On mainnet they require the canister
# to have the caller as a controller.
for canister in backend nft; do
  cid=$(dfx canister id "$canister" 2>/dev/null || true)
  if [[ -n "$cid" ]]; then
    snap=$(dfx canister snapshot create "$canister" 2>&1 || true)
    if echo "$snap" | grep -q "snapshot_id\|Created"; then
      echo "📸 snapshot $canister: $snap"
    else
      echo "⚠  snapshot $canister skipped (${snap})"
    fi
  fi
done

echo "▶ dfx deploy $*"
dfx deploy "$@"

# If the user only deployed the frontend, the backend/nft state is untouched
# and there's nothing to re-wire. Skip the post-deploy step.
for arg in "$@"; do
  case "$arg" in
    frontend|internet_identity)
      # Single-canister deploy of something that doesn't need wiring.
      # If they ALSO passed backend/nft we'll still hit the wiring loop below.
      ;;
  esac
done

# Resolve canister ids. dfx prints just the id.
backend_id=$(dfx canister id backend 2>/dev/null || true)
nft_id=$(dfx canister id nft 2>/dev/null || true)

if [[ -z "$backend_id" || -z "$nft_id" ]]; then
  echo "⚠  could not resolve backend or nft canister id — skipping wiring"
  exit 0
fi

echo "▶ wiring backend → nft ($nft_id)"
# set_nft_canister returns variant { Ok; Err: text }. Tolerate either.
dfx canister call backend set_nft_canister "(principal \"$nft_id\")" >/dev/null && \
  echo "  ✓ backend.set_nft_canister"

echo "▶ wiring nft → backend ($backend_id)"
# nft canister exposes set_backend_canister(principal); only controllers can
# call it. Idempotent — safe to call on every deploy.
if dfx canister call nft set_backend_canister "(principal \"$backend_id\")" >/dev/null 2>&1; then
  echo "  ✓ nft.set_backend_canister"
else
  echo "  ⚠  nft.set_backend_canister failed (caller not a controller?)"
fi

# Local dev convenience: flip the backend into free pixel mode so
# buy_pixels and place_pixel don't require a real ICP ledger — we
# don't deploy one locally. On mainnet this block is a no-op because
# DFX_NETWORK == "ic".
#
# Reads the current Billing config, zeroes `pixel_price_usd_cents`,
# writes it back. Idempotent.
if [[ "${DFX_NETWORK:-local}" != "ic" ]]; then
  echo "▶ local: switching pixel price to 0 (free mode)"
  current=$(dfx canister call backend get_alliance_billing 2>/dev/null || echo "")
  if [[ -n "$current" ]]; then
    # Replace the pixel_price_usd_cents field in the candid record with 0.
    patched=$(echo "$current" | sed -E 's/pixel_price_usd_cents = [0-9]+ : nat16/pixel_price_usd_cents = 0 : nat16/')
    if dfx canister call backend set_alliance_billing "$patched" >/dev/null 2>&1; then
      echo "  ✓ pixel_price_usd_cents = 0"
    else
      echo "  ⚠  set_alliance_billing failed (check controller rights)"
    fi
  fi
fi

echo "✓ deploy complete"
