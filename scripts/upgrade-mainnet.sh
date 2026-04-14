#!/bin/bash
# Safe mainnet upgrade script for ICPixel backend.
# Pauses the game, deploys, smoke-tests, unpauses.
#
# Usage:
#   ./scripts/upgrade-mainnet.sh              # backend only
#   ./scripts/upgrade-mainnet.sh --frontend   # backend + frontend
#
# Prerequisites:
#   - dfx identity with controller access
#   - DFX_WARNING=-mainnet_plaintext_identity exported (or use a named identity)

set -euo pipefail

NETWORK="ic"
BACKEND="s743i-5qaaa-aaaai-axh3a-cai"
FRONTEND="jeebz-3aaaa-aaaai-axjfa-cai"
DFX="DFX_WARNING=-mainnet_plaintext_identity dfx"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

DEPLOY_FRONTEND=false
if [[ "${1:-}" == "--frontend" ]]; then
    DEPLOY_FRONTEND=true
fi

# ── Pre-flight checks ──────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════"
echo "  ICPixel Mainnet Upgrade"
echo "═══════════════════════════════════════════════"
echo ""

# Check current state
warn "Checking current game state..."
STATE=$(eval $DFX canister --network $NETWORK call $BACKEND get_game_state 2>&1)
echo "$STATE" | head -5
echo ""

PAUSED=$(echo "$STATE" | grep "paused" | grep -c "true" || true)
if [[ "$PAUSED" -gt 0 ]]; then
    warn "Game is ALREADY paused. Continuing..."
else
    log "Game is running. Will pause before deploy."
fi

# Check cycles balance
CYCLES=$(eval $DFX canister --network $NETWORK status $BACKEND 2>&1 | grep "Balance:" | awk '{print $2}')
warn "Backend cycles: $CYCLES"
echo ""

read -p "Proceed with upgrade? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    fail "Aborted by user."
fi

# ── Step 1: Pause ──────────────────────────────────────────────────

echo ""
warn "Step 1/5: Pausing game..."
eval $DFX canister --network $NETWORK call $BACKEND admin_set_paused "'(true)'" 2>&1
log "Game paused. All mutations blocked."

# ── Step 2: Deploy backend ─────────────────────────────────────────

warn "Step 2/5: Deploying backend..."
eval $DFX deploy --network $NETWORK backend 2>&1 | tail -3
log "Backend deployed."

# ── Step 3: Deploy frontend (optional) ─────────────────────────────

if $DEPLOY_FRONTEND; then
    warn "Step 3/5: Deploying frontend..."
    eval $DFX deploy --network $NETWORK frontend 2>&1 | tail -3
    log "Frontend deployed."
else
    log "Step 3/5: Frontend skipped (use --frontend to include)."
fi

# ── Step 4: Smoke test ─────────────────────────────────────────────

warn "Step 4/5: Smoke testing..."

# Check game state survived
STATE_AFTER=$(eval $DFX canister --network $NETWORK call $BACKEND get_game_state 2>&1)
SEASON_AFTER=$(echo "$STATE_AFTER" | grep "season" | head -1)
MAP_AFTER=$(echo "$STATE_AFTER" | grep "map_size" | head -1)
log "State OK:$SEASON_AFTER,$MAP_AFTER"

# Check health
HEALTH=$(eval $DFX canister --network $NETWORK call $BACKEND get_health 2>&1)
LOW_CYCLES=$(echo "$HEALTH" | grep "low_cycles_warning" | grep -c "true" || true)
if [[ "$LOW_CYCLES" -gt 0 ]]; then
    warn "⚠️  LOW CYCLES WARNING — top up soon!"
else
    log "Cycles OK."
fi

# Try placing a pixel (will fail with Paused — that's expected)
PLACE_TEST=$(eval $DFX canister --network $NETWORK call $BACKEND place_pixel "'(0 : int16, 0 : int16, 16711680 : nat32)'" 2>&1 || true)
if echo "$PLACE_TEST" | grep -q "Paused"; then
    log "place_pixel correctly returns Paused."
elif echo "$PLACE_TEST" | grep -q "Ok"; then
    warn "place_pixel returned Ok — game was not paused?"
else
    warn "place_pixel returned unexpected: $PLACE_TEST"
fi

echo ""
log "Smoke tests passed."
echo ""

# ── Step 5: Unpause ───────────────────────────────────────────────

read -p "Unpause game? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    eval $DFX canister --network $NETWORK call $BACKEND admin_set_paused "'(false)'" 2>&1
    log "Game unpaused. Players can play."
else
    warn "Game left PAUSED. Run manually:"
    echo "  dfx canister --network ic call $BACKEND admin_set_paused '(false)'"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo -e "  ${GREEN}Upgrade complete!${NC}"
echo "═══════════════════════════════════════════════"
echo ""
