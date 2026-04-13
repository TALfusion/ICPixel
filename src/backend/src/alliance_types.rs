//! Alliance / mission types.
//!
//! **Migration rule (see [MIGRATION.md](../../../../MIGRATION.md)):** `Alliance`
//! and `Mission` are candid-encoded into stable memory. New fields must be
//! `Option<T>`, existing ones must not be removed/renamed/retyped, or the
//! upgrade will trap on the first post-upgrade read. Verify with
//! `./scripts/test-upgrade.sh` before committing schema changes.

use candid::{CandidType, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

pub type AllianceId = u64;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Mission {
    /// Top-left corner in centered coordinates ((0,0) is map center).
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
    pub template: Vec<u32>, // row-major, length = width * height
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Alliance {
    pub id: AllianceId,
    pub name: String,
    pub description: String,
    pub leader: Principal,
    pub members: Vec<Principal>,
    pub mission: Mission,
    pub created_at: u64,
    pub pixels_captured: u64,

    // Some(token_id) once we've successfully minted the NFT for this
    // alliance's current mission. Reset to None on upgrade_mission
    // so the new mission is eligible for a fresh mint.
    #[serde(default)]
    pub nft_token_id: Option<u64>,

    // When the leader upgrades a mission, the old NFT id moves here.
    // maybe_mint_for_pixel checks if prev_nft_token_id is set and
    // the old NFT has NOT been burned yet, the new mint is blocked.
    // Once burned, the new NFT mints and this field is cleared.
    #[serde(default)]
    pub prev_nft_token_id: Option<u64>,

    // Sentinel set BEFORE the inter-canister mint call to prevent two
    // concurrent place_pixel invocations from both attempting a mint for
    // the same mission. Cleared after the call returns (success or fail).
    #[serde(default)]
    pub nft_mint_in_progress: bool,
}

/// Public view (no mission) — what non-members see in `list_alliances`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct AlliancePublic {
    pub id: AllianceId,
    pub name: String,
    pub description: String,
    pub leader: Principal,
    pub member_count: u32,
    pub created_at: u64,
    pub pixels_captured: u64,
    #[serde(default)]
    pub nft_token_id: Option<u64>,
}

impl Alliance {
    pub fn to_public(&self) -> AlliancePublic {
        AlliancePublic {
            id: self.id,
            name: self.name.clone(),
            description: self.description.clone(),
            leader: self.leader,
            member_count: self.members.len() as u32,
            created_at: self.created_at,
            pixels_captured: self.pixels_captured,
            nft_token_id: self.nft_token_id,
        }
    }
}

impl Storable for Alliance {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode Alliance"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode Alliance")
    }
    // Mission templates can be large; use unbounded storage.
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum AllianceError {
    Unauthorized,
    NotFound,
    AlreadyInAlliance,
    NotInAlliance,
    InvalidMission(String),
    NameEmpty,
    NameTooLong,
    DescriptionTooLong,
    NotLeader,
    MissionNotComplete,
    UpgradeMustContainOld,
    OldPixelsModified,
    // Mission area already painted at this percent — rejected to prevent free NFTs.
    MissionAreaAlreadyPainted(u8),
    // Backend not wired to the nft canister yet (call set_nft_canister).
    NftCanisterNotConfigured,
    // The nft canister rejected our mint call.
    NftMintFailed(String),
    // upgrade_mission requires the previous NFT to be burned first.
    NftNotBurned,
    // Alliance creation fee could not be charged.
    PaymentFailed(String),
    // Admin has paused the game.
    Paused,
    // Unexpected stable-memory write failure.
    InternalError(String),
    // Round index out of range for the alliance.
    RoundNotFound,
    // Round exists but has not crossed 95% yet.
    RoundNotCompleted,
    // Caller has no contribution to this round.
    NoContribution,
    // Caller has already claimed this round.
    AlreadyClaimed,
}

/// One entry in a leaderboard page. `rank` is 1-based, computed by sorting
/// all alliances by (pixels_captured desc, id asc) for a stable tie-break.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LeaderboardEntry {
    pub rank: u32,
    pub alliance: AlliancePublic,
}

/// Paginated leaderboard. `total` is the total alliance count (for pagination
/// UI). `top_pixels` is the #1 alliance's pixel count, used by the frontend
/// to render proportional bars. `my_entry` is the caller's own entry if they
/// are in an alliance — included even when outside the requested page so the
/// UI can always show "your rank".
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LeaderboardPage {
    pub entries: Vec<LeaderboardEntry>,
    pub total: u64,
    pub top_pixels: u64,
    pub my_entry: Option<LeaderboardEntry>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MissionStatus {
    pub matched: u32,
    pub total: u32,
    pub percent: u8, // 0..=100, floor
    pub completed: bool,
}

// ───── Mission rounds & reward attribution ─────
//
// Each alliance has a list of mission rounds. Round 0 is the initial mission
// at alliance creation. Each `upgrade_mission` appends a new round. Within a
// round, the **first correct pixel placed in each cell** is credited to its
// placer (full weight for alliance members, half weight for non-member
// helpers — encoded by storing helpers in a separate vec). On completion of
// a round, a slice of the treasury is locked into `reward_pool_e8s` and
// players claim their proportional share via `claim_mission_reward`.

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MissionRound {
    /// 0-based index in the alliance's rounds vector. Round 0 is the
    /// alliance's initial mission; each `upgrade_mission` appends one.
    pub round_index: u32,

    /// Snapshot of the mission target this round was opened with. We don't
    /// reach back into Alliance.mission so that closed rounds keep their
    /// original (smaller) template even after upgrades enlarge the active
    /// mission.
    pub mission: Mission,

    pub started_at: u64,
    /// Set the moment the round crosses 95% match. Stays `None` until then.
    pub completed_at: Option<u64>,

    /// Sum of correct-placement counts per principal who is currently a
    /// member of the alliance at the time the cell was credited. Each entry
    /// counts at weight ×1.
    pub contributions: Vec<(Principal, u32)>,
    /// Same shape but for non-member helpers — counted at weight ×0.5 in
    /// the share calculation.
    pub helper_contributions: Vec<(Principal, u32)>,

    /// Bitmap with `ceil(width*height / 8)` bytes. Bit i (row-major) = 1
    /// means cell i has already been credited in this round → no further
    /// placements can earn credit for it (first-correct-pixel-wins). This
    /// makes overwrite a dead-loss for the saboteur.
    pub credited_cells: Vec<u8>,

    /// Reward pool locked from treasury at round completion. 0 until then.
    /// Free mode (price = 0) yields 0 here too — the math is wired but
    /// payouts are no-ops.
    pub reward_pool_e8s: u64,

    /// Principals who have already called `claim_mission_reward` for this
    /// round. Idempotent guard.
    pub claimed_principals: Vec<Principal>,

    /// `Some(token_id)` once the NFT for this round was minted. Mirrors
    /// the active-round NFT in `Alliance.nft_token_id` for read-side
    /// convenience; closed rounds keep their original token id here.
    pub nft_token_id: Option<u64>,

    /// Maps cell_index → Principal who last placed the correct color.
    /// Used for "last-correct-wins" credit model: when a cell is repaired
    /// after sabotage, the repairer gets the credit and the original
    /// placer's count is decremented. Option for upgrade-safety.
    #[serde(default)]
    pub cell_creditors: Option<Vec<(u32, Principal)>>,

    /// Accumulated reward pool for this round, fed continuously by
    /// `credit_reward_pool` proportional to this round's pixel_count
    /// relative to all completed rounds. Players claim from this pool.
    /// Replaces the old lump-sum `reward_pool_e8s` lock model.
    #[serde(default)]
    pub accumulated_pool_e8s: Option<u64>,

    /// Total e8s already claimed from `accumulated_pool_e8s`. Tracked so
    /// players can re-claim as the pool grows (continuous flow model).
    #[serde(default)]
    pub total_claimed_e8s: Option<u64>,

    /// Per-principal total e8s already claimed. Allows re-claiming the
    /// delta since last claim as pool grows.
    #[serde(default)]
    pub claimed_amounts: Option<Vec<(Principal, u64)>>,
}

impl MissionRound {
    pub fn new(round_index: u32, mission: Mission, now_ns: u64) -> Self {
        let cells = (mission.width as usize) * (mission.height as usize);
        let bitmap_len = (cells + 7) / 8;
        Self {
            round_index,
            mission,
            started_at: now_ns,
            completed_at: None,
            contributions: Vec::new(),
            helper_contributions: Vec::new(),
            credited_cells: vec![0u8; bitmap_len],
            reward_pool_e8s: 0,
            claimed_principals: Vec::new(),
            nft_token_id: None,
            cell_creditors: Some(Vec::new()),
            accumulated_pool_e8s: Some(0),
            total_claimed_e8s: Some(0),
            claimed_amounts: Some(Vec::new()),
        }
    }

    pub fn pixel_count(&self) -> u64 {
        (self.mission.width as u64) * (self.mission.height as u64)
    }
}

/// Newtype wrapper around `Vec<MissionRound>` so it can be a value in a
/// `StableBTreeMap`. Direct `Storable` impls on foreign types like `Vec<_>`
/// would violate orphan rules. Encoded with candid (Unbounded — round
/// templates can be large).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct AllianceRounds(pub Vec<MissionRound>);

impl Storable for AllianceRounds {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode AllianceRounds"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode AllianceRounds")
    }
    const BOUND: Bound = Bound::Unbounded;
}

/// Public DTO returned by `get_mission_rounds`. Strips heavy fields
/// (template, bitmap, full contributions) so the response stays small for
/// list views. Detailed contribution data is fetched per-round via
/// `my_mission_contribution`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MissionRoundPublic {
    pub round_index: u32,
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub pixel_count: u64,
    pub member_contributor_count: u32,
    pub helper_contributor_count: u32,
    pub credited_cells_count: u64,
    pub reward_pool_e8s: u64,
    pub claimed_count: u32,
    pub nft_token_id: Option<u64>,
}

/// Caller-scoped contribution view: how much I've contributed to a given
/// round and what my share is (or would be) when it closes.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MissionContributionView {
    pub round_index: u32,
    pub completed: bool,
    pub member_pixels: u32,
    pub helper_pixels: u32,
    /// My weight in the round = `member_pixels * 2 + helper_pixels` (we keep
    /// integer math by scaling everything ×2).
    pub my_weight: u64,
    pub total_weight: u64,
    pub reward_pool_e8s: u64,
    /// Estimated share if the round completed right now. For an already-
    /// completed round this is the actual share. 0 in free mode.
    pub estimated_share_e8s: u64,
    pub claimed: bool,
}

/// Result of a successful `claim_mission_reward` call.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ClaimResult {
    pub share_e8s: u64,
    /// Whether the e8s were actually transferred to the caller's wallet.
    /// Currently always `false` — Phase 1 implements bookkeeping only;
    /// real ICRC-1 transfers ship in Phase 2 alongside the rest of the
    /// payment plumbing.
    pub transferred: bool,
}

// ───── Mission tile-bucket spatial index ─────
//
// `MissionTileKey` is the key into MISSION_TILE_INDEX. We bucket the world
// into MISSION_TILE_SIZE×MISSION_TILE_SIZE cells; each entry holds the
// alliance ids whose mission overlaps that bucket. `place_pixel` does one
// lookup per pixel and iterates a typically tiny list, replacing the
// previous O(N alliances) linear scan.

/// Tile size in cells. 64×64 fits an 8×8 grid into the final 500×500
/// stage. With average mission size ~20×20, most missions land in 1-4
/// buckets.
pub const MISSION_TILE_SIZE: i32 = 64;

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct MissionTileKey {
    pub tx: i16,
    pub ty: i16,
}

impl Storable for MissionTileKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = [0u8; 4];
        buf[0..2].copy_from_slice(&self.tx.to_be_bytes());
        buf[2..4].copy_from_slice(&self.ty.to_be_bytes());
        Cow::Owned(buf.to_vec())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let tx = i16::from_be_bytes([bytes[0], bytes[1]]);
        let ty = i16::from_be_bytes([bytes[2], bytes[3]]);
        Self { tx, ty }
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 4,
        is_fixed_size: true,
    };
}

/// Wrapper around `Vec<AllianceId>` so we can `impl Storable` (orphan
/// rule blocks the impl on `Vec` directly). Newtype = same migration
/// rules as the rest of the file (see MIGRATION.md): treat the wire format
/// as immutable.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct AllianceIdList(pub Vec<AllianceId>);

impl Storable for AllianceIdList {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode AllianceIdList"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode AllianceIdList")
    }
    const BOUND: Bound = Bound::Unbounded;
}
