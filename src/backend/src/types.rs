//! Core persistent types for the backend canister.
//!
//! **Migration rule (see [MIGRATION.md](../../../../MIGRATION.md)):** every
//! Storable type here is candid-encoded into stable memory and must stay
//! backwards-compatible across upgrades. New fields must be `Option<T>`;
//! fields must never be removed, renamed, or retyped. `#[serde(default)]`
//! does NOT help here — candid ignores serde attributes. Test schema
//! changes with `./scripts/test-upgrade.sh` before committing.

use candid::{CandidType, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// A single pixel on the map.
/// `owner` is `None` until we add Internet Identity in a later phase.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Pixel {
    pub color: u32, // 0xRRGGBB
    pub owner: Option<Principal>,
    pub timestamp: u64, // ns since epoch
}

impl Storable for Pixel {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode Pixel"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode Pixel")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 128,
        is_fixed_size: false,
    };
}

/// Key into the pixel map: (x, y) in **centered** coordinates. (0,0) is the
/// geometric center of the map; valid range for size N is `[-(N/2)..(N+1)/2)`,
/// i.e. for N=5: `-2..=2`, for N=10: `-5..=4`.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PixelKey {
    pub x: i16,
    pub y: i16,
}

impl Storable for PixelKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = [0u8; 4];
        buf[0..2].copy_from_slice(&self.x.to_be_bytes());
        buf[2..4].copy_from_slice(&self.y.to_be_bytes());
        Cow::Owned(buf.to_vec())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let x = i16::from_be_bytes([bytes[0], bytes[1]]);
        let y = i16::from_be_bytes([bytes[2], bytes[3]]);
        PixelKey { x, y }
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 4,
        is_fixed_size: true,
    };
}

/// Returns true if (x, y) is inside a centered map of size `size`.
/// Valid range: x ∈ [-(size/2) .. (size+1)/2), same for y.
pub fn in_bounds(x: i16, y: i16, size: u16) -> bool {
    let half_neg = (size / 2) as i32;
    let half_pos = ((size as i32) + 1) / 2;
    let xi = x as i32;
    let yi = y as i32;
    xi >= -half_neg && xi < half_pos && yi >= -half_neg && yi < half_pos
}

/// Global game state. Single value, kept in a StableCell.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct GameState {
    pub map_size: u16,            // current map width = height
    pub season: u32,
    pub total_pixels_placed: u64,
    pub unique_pixels_set: u64,   // distinct cells ever painted (never decreases)
    /// Timestamp (ns) when the final stage (500x500) was reached.
    /// `None` until then. Once set, the season ends 7 days later.
    pub final_stage_reached_at: Option<u64>,
    /// Global kill-switch. When `true`, all state-mutating gameplay endpoints
    /// (place_pixel, create_alliance, join/leave, upgrade_mission, ...) return
    /// `Paused`. Toggled by `admin_set_paused`. Survives canister upgrades.
    #[serde(default)]
    pub paused: bool,

    /// Reward pool balance in e8s of ICP. Conceptually = treasury balance.
    /// Incremented by `billing::credit_treasury` whenever a player pays for
    /// a pixel or for an alliance creation (treasury_pct of the fee). Locked
    /// into a `MissionRound.reward_pool_e8s` when a round completes.
    ///
    /// In free mode (`pixel_price_usd_cents == 0` and no real ICRC-2 wiring)
    /// this stays at 0 — the contribution-tracking machinery is wired today
    /// but the pool will only fill once Phase 2 enables real payments.
    ///
    /// Stored as `Option<u64>` so existing GameState bytes (which lack this
    /// field) decode cleanly after upgrade. `None` is treated as 0.
    #[serde(default)]
    pub treasury_balance_e8s: Option<u64>,

    /// Last season for which `distribute_treasury` ran successfully. Acts
    /// as both the dedup guard (one distribution per season) and the
    /// in-progress sentinel — set at the start of distribution, never
    /// reset on success. `None` means no distribution has ever run.
    /// Option for upgrade-safety per MIGRATION.md.
    #[serde(default)]
    pub treasury_last_distributed_season: Option<u32>,

    /// Operational ICP buffer (e8s) the canister keeps on hand instead of
    /// distributing to NFT holders. `None` falls back to the default
    /// `DEFAULT_TREASURY_BUFFER_E8S` (20 ICP). Tunable at runtime by
    /// controllers via `admin_set_treasury_buffer`. Option per MIGRATION.md.
    #[serde(default)]
    pub treasury_operational_buffer_e8s: Option<u64>,

    /// Global reward pool balance in e8s. Accumulates the `reward_pool_pct`
    /// share of every payment. Money is distributed to completed missions
    /// on each incoming payment; this field holds only the undistributed
    /// remainder (e.g. when no missions are completed yet). Option for
    /// upgrade-safety per MIGRATION.md.
    #[serde(default)]
    pub reward_pool_balance_e8s: Option<u64>,

    /// Name of the last alliance whose mission was completed and NFT minted.
    /// Updated by `maybe_mint_for_pixel` on successful mint. Option per
    /// MIGRATION.md.
    #[serde(default)]
    pub last_completed_mission_name: Option<String>,

    /// Timestamp (ns) when the last mission was completed (NFT minted).
    /// Option per MIGRATION.md.
    #[serde(default)]
    pub last_completed_mission_at: Option<u64>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            map_size: 1,
            season: 1,
            total_pixels_placed: 0,
            unique_pixels_set: 0,
            final_stage_reached_at: None,
            paused: false,
            treasury_balance_e8s: None,
            treasury_last_distributed_season: None,
            treasury_operational_buffer_e8s: None,
            reward_pool_balance_e8s: None,
            last_completed_mission_name: None,
            last_completed_mission_at: None,
        }
    }
}

impl Storable for GameState {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode GameState"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode GameState")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 1024,
        is_fixed_size: false,
    };
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum PlaceError {
    OutOfBounds,
    InvalidColor,
    SeasonEnded,
    Unauthorized,
    Cooldown { remaining_ns: u64 },
    /// Billing is on and the caller has zero pixel credits — they need to
    /// buy more via `buy_pixels` before placing again.
    NoCredits,
    /// Admin has paused the game (maintenance / incident response).
    Paused,
    /// Unexpected stable-memory write failure. Transaction rolls back.
    /// Caller should retry; if persistent, it's a bug worth investigating.
    InternalError(String),
}

/// Returned by `get_map`: a flat row-major array of colors of length map_size*map_size.
/// Pixels never set are returned as 0xFFFFFF (white).
pub type MapSnapshot = Vec<u32>;

/// A single change in the change log. Coordinates are centered (signed).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug)]
pub struct PixelChange {
    pub x: i16,
    pub y: i16,
    pub color: u32,
}

impl Storable for PixelChange {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = [0u8; 8];
        buf[0..2].copy_from_slice(&self.x.to_be_bytes());
        buf[2..4].copy_from_slice(&self.y.to_be_bytes());
        buf[4..8].copy_from_slice(&self.color.to_be_bytes());
        Cow::Owned(buf.to_vec())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        Self {
            x: i16::from_be_bytes([bytes[0], bytes[1]]),
            y: i16::from_be_bytes([bytes[2], bytes[3]]),
            color: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        }
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 8,
        is_fixed_size: true,
    };
}

/// Returned by `get_changes_since`. If `map_size` differs from what the
/// client knows about, the client MUST do a full reload.
///
/// `min_version` is the lowest version still available in the change log.
/// If the caller's `from_version < min_version`, the caller has fallen
/// outside the trim window and MUST do a full reload — they've missed
/// changes that have been pruned from the log.
///
/// `next_version` tells the client where to resume. When
/// `next_version < current_version`, more data is available and the
/// client should call again with `from_version = next_version`. When
/// they're equal, the client is fully caught up. This is how clients
/// walk the full season history in chunks without blowing the query
/// response-size limit — `get_changes_since` caps each reply at
/// `GET_CHANGES_HARD_CAP` entries.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ChangesResponse {
    pub changes: Vec<PixelChange>,
    pub current_version: u64,
    pub min_version: u64,
    pub map_size: u16,
    pub next_version: u64,
}

/// Tiny version probe — used for cheap polling. Total ~10 bytes on the wire.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug)]
pub struct VersionInfo {
    pub version: u64,
    pub map_size: u16,
}

/// Per-user streak stats. Stored in `USER_STATS` stable map (MemoryId 16).
/// Updated on every `place_pixel`: if the player placed yesterday →
/// current_streak += 1; if they skipped a day → reset to 1.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct UserStats {
    /// Current consecutive-day streak.
    pub current_streak: u32,
    /// Highest streak this user ever achieved.
    pub max_streak: u32,
    /// Day number (days since epoch) of the last pixel placement.
    /// Used to detect "yesterday" vs "gap".
    pub last_day: u32,
    /// Total pixels this user has ever placed.
    pub total_pixels: u64,
}

impl Storable for UserStats {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode UserStats"))
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode UserStats")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 64,
        is_fixed_size: false,
    };
}
