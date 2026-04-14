mod alliance;
mod alliance_types;
mod billing;
mod http;
mod icp_ledger;
mod icp_price;
mod map;
mod nft_client;
mod state;
mod treasury;
mod types;

use crate::alliance::AllianceOrPublic;
use crate::alliance_types::{
    Alliance, AllianceError, AllianceId, AlliancePublic, ClaimResult, LeaderboardPage, Mission,
    MissionContributionView, MissionRoundPublic, MissionStatus,
};
use crate::types::{ChangesResponse, GameState, MapSnapshot, PlaceError, VersionInfo};
use ic_cdk::{query, update};

fn caller_or_anon() -> candid::Principal {
    ic_cdk::caller()
}

#[update]
async fn place_pixel(x: i16, y: i16, color: u32) -> Result<(), PlaceError> {
    let caller = caller_or_anon();
    // Reward attribution requires a real identity — anonymous callers
    // cannot accrue mission contributions, so we reject them outright.
    // Players must sign in with II before placing pixels.
    if caller == candid::Principal::anonymous() {
        return Err(PlaceError::Unauthorized);
    }
    map::place_pixel(x, y, color, Some(caller), ic_cdk::api::time())?;
    // Best-effort NFT mint check. Awaits an inter-canister call only on the
    // rare path where a mission just crossed 95%; the common path is one
    // cheap O(N) scan over alliances and an early return.
    alliance::maybe_mint_for_pixel(x, y).await;
    Ok(())
}

#[query]
fn get_map_chunk(tile_x: u16, tile_y: u16) -> MapSnapshot {
    map::get_map_chunk(tile_x, tile_y)
}

#[query]
fn chunk_size() -> u16 {
    map::CHUNK_SIZE
}

#[query]
fn get_game_state() -> GameState {
    state::game_state()
}

#[query]
fn get_changes_since(from_version: u64, max: Option<u64>) -> ChangesResponse {
    map::get_changes_since(from_version, max)
}

#[query]
fn get_version() -> VersionInfo {
    map::get_version()
}

// ───── Alliances ─────

#[update]
async fn create_alliance(
    name: String,
    description: String,
    mission: Mission,
    website: String,
) -> Result<AllianceId, AllianceError> {
    alliance::create_alliance(
        caller_or_anon(),
        name,
        description,
        mission,
        website,
        ic_cdk::api::time(),
    )
    .await
}

#[update]
fn join_alliance(id: AllianceId) -> Result<(), AllianceError> {
    alliance::join_alliance(caller_or_anon(), id)
}

#[update]
fn leave_alliance() -> Result<(), AllianceError> {
    alliance::leave_alliance(caller_or_anon())
}

#[query]
fn get_my_alliance() -> Option<Alliance> {
    alliance::get_my_alliance(caller_or_anon())
}

#[query]
fn get_alliance(id: AllianceId) -> Option<AllianceOrPublic> {
    alliance::get_alliance(caller_or_anon(), id)
}

#[query]
fn check_mission(id: AllianceId) -> Result<MissionStatus, AllianceError> {
    alliance::check_mission(id)
}

#[update]
fn upgrade_mission(id: AllianceId, new_mission: Mission) -> Result<(), AllianceError> {
    alliance::upgrade_mission(caller_or_anon(), id, new_mission)
}

#[query]
fn get_mission_rounds(id: AllianceId) -> Vec<MissionRoundPublic> {
    alliance::get_mission_rounds(id)
}

#[query]
fn my_mission_contribution(
    id: AllianceId,
    round_index: u32,
) -> Result<MissionContributionView, AllianceError> {
    alliance::my_mission_contribution(caller_or_anon(), id, round_index)
}

#[query]
fn get_treasury_balance() -> u64 {
    state::game_state().treasury_balance_e8s.unwrap_or(0)
}

/// Controller-only. Manually bump the treasury counter — used for testing
/// the reward-pool / claim flow without having to wire ICRC-2 first. On
/// mainnet this stays callable but should never be needed: real payments
/// will fill the treasury automatically.
#[update]
fn admin_credit_treasury(amount_e8s: u64) -> Result<u64, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can credit the treasury".into());
    }
    billing::credit_treasury(amount_e8s);
    Ok(state::game_state().treasury_balance_e8s.unwrap_or(0))
}

#[update]
async fn claim_mission_reward(
    id: AllianceId,
    round_index: u32,
) -> Result<ClaimResult, AllianceError> {
    alliance::claim_mission_reward(caller_or_anon(), id, round_index).await
}

#[update]
fn set_nft_canister(p: candid::Principal) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can set the nft canister".into());
    }
    state::set_nft_canister(p)
}

#[query]
fn get_nft_canister() -> Option<candid::Principal> {
    state::nft_canister()
}

// ───── Billing (alliance pricing) ─────
//
// All admin endpoints are controller-only. The query is open so frontends
// can read the current price and show it to players.

/// Debug: paint `percent`% of the current map with a sweep of palette
/// colors. Bypasses cooldown / billing / auth. Controller-only.
#[update]
fn debug_fill(percent: u8) -> u64 {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        ic_cdk::trap("only controllers can debug_fill");
    }
    map::debug_fill(percent.min(100))
}

/// Debug: force-set map size to a specific stage. Controller-only.
/// Used to test map growth without filling 250k pixels.
#[update]
fn admin_set_map_size(new_size: u16) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers".into());
    }
    state::update_game_state(|gs| {
        gs.map_size = new_size;
        gs.unique_pixels_set = (new_size as u64) * (new_size as u64);
    })
}

#[query]
fn get_alliance_billing() -> billing::Billing {
    billing::get()
}

/// Current alliance creation price in USD cents (tiered: 1st free, 2nd $3, etc.)
#[query]
fn get_alliance_price_usd_cents() -> u16 {
    let count = state::NEXT_ALLIANCE_ID.with(|c| *c.borrow().get()) - 1;
    billing::alliance_price_usd_cents(count)
}

#[update]
fn set_alliance_price(e8s: u64) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can set the alliance price".into());
    }
    billing::set_price(e8s)
}

#[update]
fn set_alliance_billing(b: billing::Billing) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can set billing config".into());
    }
    billing::set(b)
}

// ───── Pause / kill-switch ─────

/// Controller-only. Global pause flag. While paused, all state-mutating
/// gameplay endpoints (place_pixel, create/join/leave alliance,
/// upgrade_mission, ...) return `Paused`. Query endpoints stay open so
/// clients can still read state and display a maintenance banner.
#[update]
fn admin_set_paused(paused: bool) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can toggle pause".into());
    }
    state::update_game_state(|gs| gs.paused = paused)
}

// ───── Pixel billing + credits ─────

#[query]
fn get_pixel_credits(p: candid::Principal) -> u64 {
    state::PIXEL_CREDITS.with(|m| m.borrow().get(&p).unwrap_or(0))
}

#[query]
fn my_pixel_credits() -> u64 {
    state::PIXEL_CREDITS.with(|m| {
        m.borrow().get(&caller_or_anon()).unwrap_or(0)
    })
}

/// Controller-only. Grants free credits to a player — used during testing.
/// On mainnet with the real ledger wired, players will call `buy_pixels`
/// instead and this endpoint becomes dev-only.
#[update]
fn admin_grant_credits(to: candid::Principal, amount: u64) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can grant credits".into());
    }
    state::PIXEL_CREDITS.with(|m| {
        let cur = m.borrow().get(&to).unwrap_or(0);
        m.borrow_mut().insert(to, cur.saturating_add(amount));
    });
    Ok(())
}

/// Buy `count` pixel credits. In **free mode** (`pixel_price_usd_cents == 0`)
/// this credits immediately without any ledger call. In **paid mode** the
/// caller must have pre-approved us on the ICP ledger via `icrc2_approve`
/// for at least `count × price_e8s + ledger_fee`; we then pull the ICP via
/// `icrc2_transfer_from` and internally split wallet/treasury before
/// handing out the credits.
///
/// Returns the new total credit balance on success, or an error string
/// describing what went wrong (e.g. ledger unreachable, insufficient
/// allowance, stale ICP/USD rate).
#[update]
async fn buy_pixels(count: u64) -> Result<u64, String> {
    if count == 0 {
        return Err("count must be > 0".into());
    }
    let caller = caller_or_anon();
    if caller == candid::Principal::anonymous() {
        return Err("login required".into());
    }
    // Charge the caller — no-op in free mode, real ICRC-2 in paid mode.
    // Any payment error propagates before we touch PIXEL_CREDITS, so a
    // failed charge leaves no credits handed out.
    billing::charge_pixel_fee(caller, count).await?;
    let new_total = state::PIXEL_CREDITS.with(|m| {
        let cur = m.borrow().get(&caller).unwrap_or(0);
        let next = cur.saturating_add(count);
        m.borrow_mut().insert(caller, next);
        next
    });
    Ok(new_total)
}

/// Controller-only. Drains the accumulated wallet share from
/// `WALLET_PENDING_E8S` via a single `icrc1_transfer` to
/// `billing.wallet_principal`. Batching drastically cuts ledger fee
/// waste — one drain call per day replaces ~N×10k e8s fees where N is
/// the number of purchases.
///
/// On ledger failure we leave the pending counter intact so the admin
/// can retry. On success we reset it to zero atomically.
#[update]
async fn admin_payout_wallet() -> Result<u64, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can payout the wallet".into());
    }
    let pending = state::wallet_pending_e8s();
    if pending == 0 {
        return Ok(0);
    }
    let cfg = billing::get();
    let ledger = cfg
        .ledger
        .ok_or_else(|| "ledger not configured".to_string())?;
    // `transfer_drain` handles fee subtraction and BadFee retry centrally;
    // returns the net amount actually transferred.
    let amount = icp_ledger::transfer_drain(ledger, cfg.wallet_principal, pending).await?;
    state::reset_wallet_pending()?;
    Ok(amount)
}

#[query]
fn get_wallet_pending_e8s() -> u64 {
    state::wallet_pending_e8s()
}

/// Test-only: inject e8s into the mission reward pool as if real payments
/// came in. Controller-only.
#[update]
fn admin_credit_reward_pool(e8s: u64) -> Result<u64, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers".into());
    }
    billing::credit_reward_pool(e8s);
    Ok(e8s)
}

// ───── End-of-season treasury distribution ─────

/// Controller-only. Splits the canister's spare ICP balance 40/60 between
/// the owner and the season's NFT holders. Holder shares are written to a
/// pull-claim map; the owner cut is pushed via `icrc1_transfer`. The
/// owner principal is `billing.wallet_principal` — that's where the
/// project's actual wallet lives. Idempotent per season.
#[update]
async fn distribute_treasury() -> Result<treasury::DistributeReport, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can distribute the treasury".into());
    }
    let owner = billing::get().wallet_principal;
    treasury::distribute_treasury(owner).await
}

/// User-facing pull. Drains the caller's claimable share from the
/// season distribution into their account via `icrc1_transfer`. The
/// ledger fee is taken from the credited amount.
#[update]
async fn claim_treasury() -> Result<u64, String> {
    treasury::claim_treasury(caller_or_anon()).await
}

#[query]
fn get_claimable_treasury(p: candid::Principal) -> u64 {
    treasury::claimable_for(p)
}

#[query]
fn my_claimable_treasury() -> u64 {
    treasury::claimable_for(caller_or_anon())
}

/// Controller-only. Clears the per-season distribution guard so a failed
/// distribution can be retried. Use with care: re-running for the same
/// season after partial success would double-credit holders.
#[update]
fn admin_reset_treasury_distribution() -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can reset treasury distribution".into());
    }
    state::update_game_state(|gs| gs.treasury_last_distributed_season = None)
}

/// Controller-only. Override the operational ICP buffer (e8s) the
/// canister keeps on hand instead of distributing.
#[update]
fn admin_set_treasury_buffer(e8s: u64) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can set the treasury buffer".into());
    }
    state::update_game_state(|gs| gs.treasury_operational_buffer_e8s = Some(e8s))
}

// ───── Health / monitoring ─────

/// Cheap health probe. Returns the canister's current cycle balance and
/// the size of stable memory in pages (1 page = 64 KiB). Open query so
/// the frontend can render an admin pill, and an external monitor can
/// poll without controller credentials.
///
/// Stable storage is a hard cap (~96 GiB on the IC); cycles run out
/// silently and brick the canister. Both are worth watching at the
/// same time.
#[derive(candid::CandidType, serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CanisterHealth {
    pub cycles: u64,
    pub stable_pages: u64,
    pub low_cycles_warning: bool,
}

/// Threshold below which we flip `low_cycles_warning = true` and
/// `ic_cdk::println!` a warning. 5T cycles ≈ a few weeks of headroom
/// at typical query+update load. Tune via `admin_set_*` if needed.
const LOW_CYCLES_THRESHOLD: u64 = 5_000_000_000_000;
/// Below this: auto-pause the game to preserve remaining cycles for
/// admin recovery. Without this the canister burns its last cycles on
/// player traffic and becomes unrecoverable.
/// ~2 hours of runway at 100 active players (~7B cycles).
const CRITICAL_CYCLES_THRESHOLD: u64 = 10_000_000_000; // 10B

#[query]
fn get_health() -> CanisterHealth {
    let cycles = ic_cdk::api::canister_balance();
    let stable_pages = ic_cdk::api::stable::stable_size();
    CanisterHealth {
        cycles,
        stable_pages,
        low_cycles_warning: cycles < LOW_CYCLES_THRESHOLD,
    }
}

/// Background poll for low cycles. Logs once per low-cycles tick — there
/// is no auto-pause: an automatic pause based on cycles would be too
/// dangerous (a stuck price feed or transient rate spike could lock
/// players out for hours). Operator must react manually to the log.
fn check_cycles_and_log() {
    let cycles = ic_cdk::api::canister_balance();
    if cycles < CRITICAL_CYCLES_THRESHOLD {
        // Auto-pause to preserve remaining cycles for admin recovery.
        let gs = state::game_state();
        if !gs.paused {
            let _ = state::update_game_state(|gs| gs.paused = true);
            ic_cdk::println!(
                "🛑 CRITICAL: cycles {} < {}. Game AUTO-PAUSED to prevent canister death. \
                 Top up cycles and call admin_set_paused(false) to resume.",
                cycles, CRITICAL_CYCLES_THRESHOLD
            );
        }
    } else if cycles < LOW_CYCLES_THRESHOLD {
        ic_cdk::println!(
            "⚠ low cycles: {} (threshold {}). top up via `dfx ledger top-up`.",
            cycles,
            LOW_CYCLES_THRESHOLD
        );
    }
}

// ───── Admin stats ─────

#[query]
fn am_i_controller() -> bool {
    ic_cdk::api::is_controller(&ic_cdk::caller())
}

#[derive(candid::CandidType, serde::Serialize)]
struct AdminStats {
    // Canister health
    cycles: u64,
    stable_pages: u64,
    low_cycles_warning: bool,
    // Game state
    season: u32,
    map_size: u16,
    total_pixels_placed: u64,
    unique_pixels_set: u64,
    paused: bool,
    // Economy
    pixel_price_usd_cents: u16,
    pixel_cooldown_seconds: u32,
    treasury_balance_e8s: u64,
    wallet_pending_e8s: u64,
    icp_usd_micro: u64,
    icp_usd_last_fetched_ns: u64,
    // Counts
    total_alliances: u64,
    total_users: u64,
    total_nfts_minted: u64,
}

#[query]
fn get_admin_stats() -> AdminStats {
    let gs = state::game_state();
    let billing = billing::get();
    let price = icp_price::raw();
    let health = get_health();

    let total_alliances = state::ALLIANCES.with(|a| a.borrow().len());
    let total_users = state::LAST_PLACED.with(|l| l.borrow().len());

    // Count alliances that have an NFT minted
    let total_nfts_minted = state::ALLIANCES.with(|a| {
        a.borrow()
            .iter()
            .filter(|(_, al)| al.nft_token_id.is_some())
            .count() as u64
    });

    AdminStats {
        cycles: health.cycles,
        stable_pages: health.stable_pages,
        low_cycles_warning: health.low_cycles_warning,
        season: gs.season,
        map_size: gs.map_size,
        total_pixels_placed: gs.total_pixels_placed,
        unique_pixels_set: gs.unique_pixels_set,
        paused: gs.paused,
        pixel_price_usd_cents: billing.pixel_price_usd_cents,
        pixel_cooldown_seconds: billing.pixel_cooldown_seconds,
        treasury_balance_e8s: gs.treasury_balance_e8s.unwrap_or(0),
        wallet_pending_e8s: state::wallet_pending_e8s(),
        icp_usd_micro: price.usd_per_icp_micro,
        icp_usd_last_fetched_ns: price.last_fetched_ns,
        total_alliances,
        total_users,
        total_nfts_minted,
    }
}

// ───── Streak leaderboard ─────

#[derive(candid::CandidType, serde::Serialize)]
struct StreakEntry {
    user: candid::Principal,
    current_streak: u32,
    max_streak: u32,
    total_pixels: u64,
}

#[query]
fn get_top_streaks(limit: u64) -> Vec<StreakEntry> {
    let limit = limit.min(50) as usize;
    let mut all: Vec<_> = state::USER_STATS.with(|m| {
        m.borrow()
            .iter()
            .map(|(p, s)| StreakEntry {
                user: p,
                current_streak: s.current_streak,
                max_streak: s.max_streak,
                total_pixels: s.total_pixels,
            })
            .collect()
    });
    all.sort_by(|a, b| b.current_streak.cmp(&a.current_streak).then(b.total_pixels.cmp(&a.total_pixels)));
    all.truncate(limit);
    all
}

#[query]
fn my_stats() -> types::UserStats {
    let caller = ic_cdk::caller();
    state::USER_STATS.with(|m| m.borrow().get(&caller).unwrap_or_default())
}

// ───── ICP/USD rate (XRC) ─────

#[update]
async fn refresh_icp_price() -> Result<icp_price::IcpUsdCache, String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can refresh the ICP price".into());
    }
    icp_price::refresh().await
}

/// Emergency override for ICP/USD rate when XRC is down.
/// Accepts micro-USD (e.g. 12_500_000 = $12.50 per ICP).
#[update]
fn admin_set_icp_price_override(usd_per_icp_micro: u64) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers".into());
    }
    if usd_per_icp_micro == 0 {
        return Err("rate must be > 0".into());
    }
    icp_price::admin_set_override(usd_per_icp_micro);
    Ok(())
}

#[query]
fn get_icp_price() -> icp_price::IcpUsdCache {
    icp_price::raw()
}

/// HTTP gateway entry point. Serves the `/og.png` Open Graph preview image
/// used by Twitter/Discord/Telegram link cards. All other paths 404.
#[query]
fn http_request(req: http::HttpRequest) -> http::HttpResponse {
    http::handle(req)
}

#[query]
fn list_alliances() -> Vec<AlliancePublic> {
    alliance::list_alliances()
}

#[query]
fn leaderboard(offset: u64, limit: u64) -> LeaderboardPage {
    alliance::leaderboard(caller_or_anon(), offset, limit)
}

// ───── Upgrade hooks ─────
//
// All persistent data lives in `ic_stable_structures` (StableBTreeMap +
// StableCell behind a MemoryManager), so it auto-survives upgrades and there
// is nothing to serialize in `pre_upgrade`. The hooks exist as a safety net:
//
// `post_upgrade` touches every stable structure once. If any of them fails to
// deserialize after a Storable layout change, the panic happens *inside the
// upgrade transaction* and dfx rolls the upgrade back, instead of bricking
// the canister at the first real user call.

#[ic_cdk::init]
fn init() {
    state::init_pixel_colors();
    arm_icp_price_timer();
}

#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    // Flush in-memory batched GameState counters to stable before upgrade.
    map::flush_game_state_delta();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Force a read on every stable container so any decoding error surfaces
    // here and aborts the upgrade.
    let _ = state::game_state();
    state::PIXELS.with(|m| m.borrow().len());
    state::ALLIANCES.with(|m| m.borrow().len());
    state::USER_ALLIANCE.with(|m| m.borrow().len());
    state::CHANGES.with(|m| m.borrow().len());
    state::LAST_PLACED.with(|m| m.borrow().len());
    state::NEXT_ALLIANCE_ID.with(|c| *c.borrow().get());
    state::NEXT_VERSION.with(|c| *c.borrow().get());
    let _ = state::nft_canister();
    state::BILLING.with(|c| c.borrow().get().clone());
    state::ICP_USD_CACHE.with(|c| c.borrow().get().clone());
    state::PIXEL_CREDITS.with(|m| m.borrow().len());
    state::ALLIANCE_ROUNDS.with(|m| m.borrow().len());
    state::WALLET_PENDING_E8S.with(|c| *c.borrow().get());
    state::CLAIMABLE_TREASURY.with(|m| m.borrow().len());
    state::MISSION_TILE_INDEX.with(|m| m.borrow().len());
    // Initialize flat pixel color array (grow stable memory to 16MB if needed).
    state::init_pixel_colors();
    // Migrate pixels from old BTreeMap to flat array (idempotent).
    // At 200k pixels × ~10k instructions = ~2B — well within the 200B
    // post_upgrade instruction limit. Only runs once (BTreeMap is empty
    // after first migration since new code never writes to it).
    let pixel_count = state::PIXELS.with(|m| m.borrow().len());
    if pixel_count > 0 {
        state::migrate_pixels_to_flat();
    }
    // Rebuild the spatial index from scratch on every upgrade.
    alliance::rebuild_tile_index();
    arm_icp_price_timer();
}

/// Register a repeating timer that refreshes the cached ICP/USD rate
/// from the IC Exchange Rate Canister (XRC). Dropping the returned
/// TimerId means the runtime owns it for the canister's lifetime.
/// Called from both `init` and `post_upgrade`.
///
/// Interval is 6 hours: 4 calls/day × 10B cycles ≈ $0.05/day ≈ $20/year.
/// ICP/USD doesn't move enough intra-day to warrant anything tighter,
/// and the frontend's 10% approve buffer absorbs short-term drift.
///
/// We also piggyback `check_cycles_and_log` here — fires a separate
/// 5-minute fast timer for cycles monitoring, decoupled from the
/// expensive XRC refresh.
fn arm_icp_price_timer() {
    use std::time::Duration;
    // Immediate one-shot: refresh ICP price + ledger fee on startup so the
    // cache isn't stale right after an upgrade.
    ic_cdk_timers::set_timer(Duration::ZERO, || {
        ic_cdk::spawn(async {
            let _ = icp_price::refresh().await;
            let cfg = billing::get();
            if let Some(ledger) = cfg.ledger {
                let _ = icp_ledger::refresh_ledger_fee(ledger).await;
            }
        });
    });
    // XRC refresh — every 6 hours.
    ic_cdk_timers::set_timer_interval(Duration::from_secs(12 * 60 * 60), || {
        ic_cdk::spawn(async {
            if let Err(e) = icp_price::refresh().await {
                ic_cdk::println!("scheduled icp_price::refresh failed: {e}");
            }
            // Piggyback: refresh ICP ledger fee cache so transfers don't
            // fail if governance changes the fee between restarts.
            let cfg = billing::get();
            if let Some(ledger) = cfg.ledger {
                let _ = icp_ledger::refresh_ledger_fee(ledger).await;
            }
        });
    });
    // Cycles health log — every 5 minutes. Cheap (no inter-canister calls).
    ic_cdk_timers::set_timer_interval(Duration::from_secs(300), || {
        check_cycles_and_log();
    });
}

ic_cdk::export_candid!();
