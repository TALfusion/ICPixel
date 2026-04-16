//! Controller-only raw-state export endpoints.
//!
//! The goal is a **complete, restorable** JSON snapshot of the canister:
//! if the data ever gets wiped (canister deletion, bad migration, etc.),
//! a controller can re-mint a clean canister and replay this snapshot
//! back via companion import methods (or offline reconstruction).
//!
//! Every endpoint is a `#[query]` — query calls skip consensus and cost
//! orders of magnitude less than updates, so running a full export is
//! essentially free compared to any gameplay mutation. Controllers still
//! pay a tiny amount in compute + egress; typical full snapshot is < 1T
//! cycles on a ~500×500 map.
//!
//! Paging: maps iterate with `.iter().skip(offset).take(limit)`. That is
//! O(offset) on a stable BTreeMap, but for our scale (tens of thousands
//! of entries at most per map) it's fine and keeps the API uniform.
//! Single response stays well under the 2MB query-reply ceiling when
//! callers use reasonable `limit` values (≤ 1000 for small structs,
//! ≤ 100 for structs carrying large nested vecs like alliances).

use crate::alliance_types::{Alliance, AllianceId, AllianceIdList, AllianceRounds, MissionTileKey};
use crate::billing::{Billing, PendingOrder};
use crate::icp_price::IcpUsdCache;
use crate::state::{
    ALLIANCES, ALLIANCE_ROUNDS, BILLING, CHANGES, CLAIMABLE_TREASURY, GAME_STATE, ICP_USD_CACHE,
    LAST_PLACED, MISSION_TILE_INDEX, NEXT_ALLIANCE_ID, NEXT_VERSION, NFT_CANISTER_ID,
    PENDING_ORDERS, PIXELS, PIXEL_CREDITS, USER_ALLIANCE, USER_STATS, WALLET_PENDING_E8S,
};
use crate::types::{GameState, Pixel, PixelChange, PixelKey, UserStats};
use candid::{CandidType, Principal};
use ic_cdk::query;
use serde::{Deserialize, Serialize};

/// Allow either controllers or a designated "snapshot reader" principal
/// (set via `admin_set_snapshot_reader`). The snapshot reader has NO
/// other privileges — it exists so we can ship a scoped identity to CI
/// / GitHub Actions without giving it controller power.
fn assert_can_export() {
    let caller = ic_cdk::caller();
    if ic_cdk::api::is_controller(&caller) {
        return;
    }
    if let Some(reader) = crate::state::snapshot_reader() {
        if reader == caller {
            return;
        }
    }
    ic_cdk::trap("admin_export_*: caller is neither a controller nor the snapshot reader");
}

/// One-shot bundle of every `StableCell` / counter. All singletons are
/// small, so returning them in a single query keeps the client simple.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ExportSingletons {
    pub game_state: GameState,
    pub next_alliance_id: u64,
    pub next_version: u64,
    pub nft_canister: Option<Principal>,
    pub billing: Billing,
    pub wallet_pending_e8s: u64,
    pub icp_usd_cache: IcpUsdCache,
}

/// Sizes of every paginated collection. Client uses this to decide how
/// many chunks to fetch per category.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct ExportCounts {
    pub pixels: u64,
    pub alliances: u64,
    pub user_alliance: u64,
    pub changes: u64,
    pub last_placed: u64,
    pub pixel_credits: u64,
    pub alliance_rounds: u64,
    pub mission_tile_index: u64,
    pub user_stats: u64,
    pub claimable_treasury: u64,
    pub pending_orders: u64,
    /// Size in bytes of the flat pixel-color memory region. Export with
    /// `admin_export_pixel_colors(offset, len)`.
    pub pixel_colors_bytes: u64,
}

#[query]
pub fn admin_export_counts() -> ExportCounts {
    assert_can_export();
    ExportCounts {
        pixels: PIXELS.with(|m| m.borrow().len()),
        alliances: ALLIANCES.with(|m| m.borrow().len()),
        user_alliance: USER_ALLIANCE.with(|m| m.borrow().len()),
        changes: CHANGES.with(|m| m.borrow().len()),
        last_placed: LAST_PLACED.with(|m| m.borrow().len()),
        pixel_credits: PIXEL_CREDITS.with(|m| m.borrow().len()),
        alliance_rounds: ALLIANCE_ROUNDS.with(|m| m.borrow().len()),
        mission_tile_index: MISSION_TILE_INDEX.with(|m| m.borrow().len()),
        user_stats: USER_STATS.with(|m| m.borrow().len()),
        claimable_treasury: CLAIMABLE_TREASURY.with(|m| m.borrow().len()),
        pending_orders: PENDING_ORDERS.with(|m| m.borrow().len()),
        pixel_colors_bytes: crate::state::pixel_colors_region_bytes(),
    }
}

#[query]
pub fn admin_export_singletons() -> ExportSingletons {
    assert_can_export();
    ExportSingletons {
        game_state: GAME_STATE.with(|c| c.borrow().get().clone()),
        next_alliance_id: NEXT_ALLIANCE_ID.with(|c| *c.borrow().get()),
        next_version: NEXT_VERSION.with(|c| *c.borrow().get()),
        nft_canister: NFT_CANISTER_ID.with(|c| c.borrow().get().0),
        billing: BILLING.with(|c| c.borrow().get().clone()),
        wallet_pending_e8s: WALLET_PENDING_E8S.with(|c| *c.borrow().get()),
        icp_usd_cache: ICP_USD_CACHE.with(|c| c.borrow().get().clone()),
    }
}

/// Raw flat pixel-color region as bytes. Each pixel is a little-endian
/// u32: bit 24 = painted flag, low 24 bits = 0xRRGGBB. Unpainted cells
/// read as 0. See `state::write_pixel_color` for the stored layout.
#[query]
pub fn admin_export_pixel_colors(offset: u64, len: u64) -> Vec<u8> {
    assert_can_export();
    crate::state::read_pixel_colors_raw(offset, len)
}

// ───── Paginated collection exports ─────
//
// Every collection uses the same pattern: iter → skip → take → collect.
// The client drives pagination by calling with increasing offsets until
// it receives a short chunk.

#[query]
pub fn admin_export_pixels(offset: u64, limit: u64) -> Vec<(PixelKey, Pixel)> {
    assert_can_export();
    PIXELS.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_alliances(offset: u64, limit: u64) -> Vec<(AllianceId, Alliance)> {
    assert_can_export();
    ALLIANCES.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_user_alliance(offset: u64, limit: u64) -> Vec<(Principal, AllianceId)> {
    assert_can_export();
    USER_ALLIANCE.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_changes(offset: u64, limit: u64) -> Vec<(u64, PixelChange)> {
    assert_can_export();
    CHANGES.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_last_placed(offset: u64, limit: u64) -> Vec<(Principal, u64)> {
    assert_can_export();
    LAST_PLACED.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_pixel_credits(offset: u64, limit: u64) -> Vec<(Principal, u64)> {
    assert_can_export();
    PIXEL_CREDITS.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_alliance_rounds(offset: u64, limit: u64) -> Vec<(AllianceId, AllianceRounds)> {
    assert_can_export();
    ALLIANCE_ROUNDS.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_mission_tile_index(
    offset: u64,
    limit: u64,
) -> Vec<(MissionTileKey, AllianceIdList)> {
    assert_can_export();
    MISSION_TILE_INDEX.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_user_stats(offset: u64, limit: u64) -> Vec<(Principal, UserStats)> {
    assert_can_export();
    USER_STATS.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_claimable_treasury(offset: u64, limit: u64) -> Vec<(Principal, u64)> {
    assert_can_export();
    CLAIMABLE_TREASURY.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    })
}

#[query]
pub fn admin_export_pending_orders(offset: u64, limit: u64) -> Vec<(Vec<u8>, PendingOrder)> {
    assert_can_export();
    PENDING_ORDERS.with(|m| {
        m.borrow()
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .map(|(k, v)| (k.0.to_vec(), v))
            .collect()
    })
}
