use crate::alliance_types::{
    Alliance, AllianceId, AllianceIdList, AllianceRounds, MissionRound, MissionTileKey,
};
use crate::billing::Billing;
use crate::icp_price::IcpUsdCache;
use crate::types::{GameState, Pixel, PixelChange, PixelKey, UserStats};
use candid::Principal;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Memory as _};
use std::cell::RefCell;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

const MEM_GAME_STATE: MemoryId = MemoryId::new(0);
const MEM_PIXELS: MemoryId = MemoryId::new(1);
const MEM_ALLIANCES: MemoryId = MemoryId::new(2);
const MEM_USER_ALLIANCE: MemoryId = MemoryId::new(3);
const MEM_NEXT_ALLIANCE_ID: MemoryId = MemoryId::new(4);
const MEM_CHANGES: MemoryId = MemoryId::new(5);
const MEM_NEXT_VERSION: MemoryId = MemoryId::new(6);
const MEM_LAST_PLACED: MemoryId = MemoryId::new(7);
const MEM_NFT_CANISTER: MemoryId = MemoryId::new(8);
const MEM_BILLING: MemoryId = MemoryId::new(9);
const MEM_ICP_USD: MemoryId = MemoryId::new(10);
const MEM_PIXEL_CREDITS: MemoryId = MemoryId::new(11);
/// Per-alliance mission round history (`Vec<MissionRound>`). Lazy-initialised
/// on first access for alliances that pre-date this feature. New alliances
/// get a Round 0 inserted at creation time.
const MEM_ALLIANCE_ROUNDS: MemoryId = MemoryId::new(12);
/// Accumulated wallet share (in e8s) waiting to be paid out to
/// `billing.wallet_principal`. Batched payouts instead of a per-purchase
/// transfer: saves ~10k e8s fee per buy and survives transient ledger
/// failures (we can retry the single drain later without losing money).
const MEM_WALLET_PENDING: MemoryId = MemoryId::new(13);
/// End-of-season treasury claims, populated by `distribute_treasury`.
/// Pull-style: holders call `claim_treasury` to drain their entry.
const MEM_CLAIMABLE_TREASURY: MemoryId = MemoryId::new(14);
/// Spatial index for `mintable_missions_covering`. Buckets the world
/// into MISSION_TILE×MISSION_TILE cells; each entry holds the alliance
/// ids whose mission rect overlaps that tile. Lets `place_pixel` skip
/// the linear scan over all alliances and instead do a single O(log K)
/// tile lookup, where K is the number of populated tiles. Maintained
/// by `alliance::tile_index::*` on create / upgrade / delete.
const MEM_MISSION_TILE_INDEX: MemoryId = MemoryId::new(15);
const MEM_USER_STATS: MemoryId = MemoryId::new(16);
/// Flat pixel color array: 512×512×4 = 1MB. Direct stable memory
/// reads/writes at fixed offsets — ~200× cheaper than BTreeMap per pixel.
/// Sized for MAX_SIZE=512 (covers 500×500 final stage with padding).
const MEM_PIXEL_COLORS: MemoryId = MemoryId::new(17);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    pub static GAME_STATE: RefCell<StableCell<GameState, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_GAME_STATE)),
            GameState::default(),
        ).expect("init GAME_STATE"),
    );

    pub static PIXELS: RefCell<StableBTreeMap<PixelKey, Pixel, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_PIXELS)),
        ),
    );

    pub static ALLIANCES: RefCell<StableBTreeMap<AllianceId, Alliance, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_ALLIANCES)),
        ),
    );

    pub static USER_ALLIANCE: RefCell<StableBTreeMap<Principal, AllianceId, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_USER_ALLIANCE)),
        ),
    );

    pub static NEXT_ALLIANCE_ID: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_NEXT_ALLIANCE_ID)),
            1u64,
        ).expect("init NEXT_ALLIANCE_ID"),
    );

    pub static CHANGES: RefCell<StableBTreeMap<u64, PixelChange, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_CHANGES)),
        ),
    );

    pub static LAST_PLACED: RefCell<StableBTreeMap<Principal, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_LAST_PLACED)),
        ),
    );

    pub static NEXT_VERSION: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_NEXT_VERSION)),
            1u64,
        ).expect("init NEXT_VERSION"),
    );

    /// The principal of the `nft` canister. Set once via `set_nft_canister`
    /// after first deploy. None means NFT minting is disabled.
    pub static NFT_CANISTER_ID: RefCell<StableCell<NftCanisterCell, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_NFT_CANISTER)),
            NftCanisterCell(None),
        ).expect("init NFT_CANISTER_ID"),
    );

    /// Alliance pricing & payout config. Mutable at runtime by controllers.
    pub static BILLING: RefCell<StableCell<Billing, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_BILLING)),
            Billing::default_for_canister(ic_cdk::api::id()),
        ).expect("init BILLING"),
    );

    /// Cached ICP/USD rate fetched from CoinGecko via HTTPS outcall.
    pub static ICP_USD_CACHE: RefCell<StableCell<IcpUsdCache, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_ICP_USD)),
            IcpUsdCache::default(),
        ).expect("init ICP_USD_CACHE"),
    );

    /// Prepaid pixel credits per player. Decremented on `place_pixel` when
    /// billing is on; topped up via `buy_pixels`. Only consulted when
    /// `billing.pixel_price_usd_cents > 0` — in free mode this map stays empty.
    pub static PIXEL_CREDITS: RefCell<StableBTreeMap<Principal, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_PIXEL_CREDITS)),
        ),
    );

    /// Mission round history per alliance. See [`MissionRound`] for the
    /// reward-attribution model. Round 0 is created at `create_alliance`;
    /// every `upgrade_mission` appends a new round. Pre-existing alliances
    /// (created before this feature shipped) get round 0 lazily on first
    /// access via [`init_rounds_if_missing`].
    pub static ALLIANCE_ROUNDS: RefCell<StableBTreeMap<AllianceId, AllianceRounds, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_ALLIANCE_ROUNDS)),
        ));

    /// Accumulated wallet share in e8s. Drained by `admin_payout_wallet`.
    /// See `MEM_WALLET_PENDING` comment for rationale (batched payouts).
    /// Per-principal claimable treasury share in e8s. Written by
    /// `distribute_treasury`, drained by `claim_treasury`. New entries
    /// add to existing balance so re-distribution (across future seasons)
    /// stacks instead of overwriting.
    pub static CLAIMABLE_TREASURY: RefCell<StableBTreeMap<Principal, u64, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_CLAIMABLE_TREASURY)),
        ),
    );

    pub static WALLET_PENDING_E8S: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_WALLET_PENDING)),
            0u64,
        ).expect("init WALLET_PENDING_E8S"),
    );

    /// Spatial index for `mintable_missions_covering`. See module-level
    /// `MEM_MISSION_TILE_INDEX` doc and `alliance::tile_index`.
    pub static MISSION_TILE_INDEX: RefCell<StableBTreeMap<MissionTileKey, AllianceIdList, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_MISSION_TILE_INDEX)),
        ));

    /// Per-user stats: streak, max_streak, total_pixels. Updated on every
    /// `place_pixel`. Used for the streak leaderboard in the dashboard.
    pub static USER_STATS: RefCell<StableBTreeMap<Principal, UserStats, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_USER_STATS)),
        ));
}

// ───── Flat pixel color array ─────
//
// 512×512 cells × 4 bytes (u32 color) = 1,048,576 bytes (1MB).
// Centered coordinates: cell (x, y) maps to array index
// `(y + MAX_HALF) * MAX_SIZE + (x + MAX_HALF)`.
// Unset cells read as DEFAULT_COLOR (0x2A2A33).
// MAX_SIZE=512 covers the 500×500 final stage with 6px padding per side.

const MAX_SIZE: u32 = 512;
const MAX_HALF: i32 = (MAX_SIZE / 2) as i32;
const FLAT_PIXEL_BYTES: u64 = (MAX_SIZE as u64) * (MAX_SIZE as u64) * 4;
const DEFAULT_PIXEL_COLOR: u32 = 0x2A2A33;

fn flat_offset(x: i16, y: i16) -> u64 {
    let ax = (x as i32 + MAX_HALF) as u64;
    let ay = (y as i32 + MAX_HALF) as u64;
    (ay * MAX_SIZE as u64 + ax) * 4
}

/// Ensure the flat pixel memory region is grown to at least 16MB.
/// Called once in init/post_upgrade.
pub fn init_pixel_colors() {
    MEMORY_MANAGER.with(|mm| {
        let mem = mm.borrow().get(MEM_PIXEL_COLORS);
        let needed_pages = (FLAT_PIXEL_BYTES + 65535) / 65536;
        let current = mem.size();
        if current < needed_pages {
            let prev = mem.grow(needed_pages - current);
            if prev == -1 {
                ic_cdk::trap("init_pixel_colors: failed to grow stable memory");
            }
        }
    });
}

/// Bit 24 marks a cell as "painted". Stored value = color | PAINTED_BIT.
/// Raw 0x00000000 in memory = never painted → reads as DEFAULT_PIXEL_COLOR.
/// This lets players use color 0x000000 (pure black) without ambiguity.
const PAINTED_BIT: u32 = 1 << 24;

/// Write a pixel color to the flat array. ~10k cycles vs ~2M for BTreeMap.
pub fn write_pixel_color(x: i16, y: i16, color: u32) {
    let off = flat_offset(x, y);
    let stored = (color & 0xFFFFFF) | PAINTED_BIT;
    MEMORY_MANAGER.with(|mm| {
        let mem = mm.borrow().get(MEM_PIXEL_COLORS);
        mem.write(off, &stored.to_le_bytes());
    });
}

/// Read a pixel color from the flat array. Returns DEFAULT_PIXEL_COLOR
/// for cells that were never painted (raw 0 in memory).
pub fn read_pixel_color(x: i16, y: i16) -> u32 {
    let off = flat_offset(x, y);
    let raw = MEMORY_MANAGER.with(|mm| {
        let mem = mm.borrow().get(MEM_PIXEL_COLORS);
        let mut buf = [0u8; 4];
        mem.read(off, &mut buf);
        u32::from_le_bytes(buf)
    });
    if raw == 0 { DEFAULT_PIXEL_COLOR } else { raw & 0xFFFFFF }
}

/// Read a rectangular region from the flat array. Much cheaper than
/// BTreeMap range scans for chunk delivery. Out-of-bounds cells return
/// DEFAULT_PIXEL_COLOR (the row is simply skipped).
pub fn read_pixel_region(x: i16, y: i16, w: u16, h: u16) -> Vec<u32> {
    let mut out = vec![DEFAULT_PIXEL_COLOR; (w as usize) * (h as usize)];
    MEMORY_MANAGER.with(|mm| {
        let mem = mm.borrow().get(MEM_PIXEL_COLORS);
        for row in 0..h as i16 {
            let cy = y + row;
            let cx_end = x as i32 + w as i32 - 1;
            // Skip rows entirely outside the valid coordinate range.
            if (cy as i32 + MAX_HALF) < 0
                || (cy as i32 + MAX_HALF) >= MAX_SIZE as i32
                || (x as i32 + MAX_HALF) < 0
                || cx_end + MAX_HALF as i32 >= MAX_SIZE as i32
            {
                continue;
            }
            let off = flat_offset(x, cy);
            let row_bytes = w as usize * 4;
            let mut buf = vec![0u8; row_bytes];
            mem.read(off, &mut buf);
            for col in 0..w as usize {
                let c = u32::from_le_bytes([
                    buf[col * 4],
                    buf[col * 4 + 1],
                    buf[col * 4 + 2],
                    buf[col * 4 + 3],
                ]);
                out[row as usize * w as usize + col] =
                    if c == 0 { DEFAULT_PIXEL_COLOR } else { c & 0xFFFFFF };
            }
        }
    });
    out
}

/// Migrate pixel colors from the old PIXELS BTreeMap into the flat array.
/// Idempotent — writing the same color twice is harmless.
///
/// WARNING: At 4M pixels this costs ~60T cycles (12,000× the 5B update
/// limit). NEVER call from post_upgrade or any update method on a live
/// canister with >50k pixels. Use the paginated admin approach instead:
/// call with a (start, count) range from an external script.
pub fn migrate_pixels_to_flat() {
    PIXELS.with(|p| {
        let map = p.borrow();
        for (key, pixel) in map.iter() {
            write_pixel_color(key.x, key.y, pixel.color);
        }
    });
    ic_cdk::println!(
        "migrate_pixels_to_flat: copied {} pixels",
        PIXELS.with(|p| p.borrow().len())
    );
}

/// Read current accumulated wallet-share balance (pending payout).
pub fn wallet_pending_e8s() -> u64 {
    WALLET_PENDING_E8S.with(|c| *c.borrow().get())
}

/// Add to the wallet-pending counter. Used by billing charge paths.
pub fn credit_wallet_pending(e8s: u64) -> Result<(), String> {
    if e8s == 0 {
        return Ok(());
    }
    WALLET_PENDING_E8S.with(|c| {
        let cur = *c.borrow().get();
        c.borrow_mut()
            .set(cur.saturating_add(e8s))
            .map(|_| ())
            .map_err(|e| format!("set WALLET_PENDING_E8S: {e:?}"))
    })
}

/// Reset wallet-pending to zero. Called by `admin_payout_wallet` after
/// a successful ledger transfer out.
pub fn reset_wallet_pending() -> Result<(), String> {
    WALLET_PENDING_E8S.with(|c| {
        c.borrow_mut()
            .set(0u64)
            .map(|_| ())
            .map_err(|e| format!("reset WALLET_PENDING_E8S: {e:?}"))
    })
}

// ───── Mission round accessors ─────
//
// All reads/writes to ALLIANCE_ROUNDS go through these helpers so callers
// don't need to worry about lazy-init or about cloning the entire vec.

/// Read all rounds for an alliance. Returns `None` if no entry exists yet
/// (caller should `init_rounds_if_missing` first if they need to mutate).
pub fn rounds_of(id: AllianceId) -> Option<Vec<MissionRound>> {
    ALLIANCE_ROUNDS.with(|r| r.borrow().get(&id).map(|ar| ar.0))
}

/// Lazy-init: if the alliance has no rounds entry yet, create one with a
/// single Round 0 built from the alliance's current mission. Used on first
/// place_pixel hit / first read for alliances created before rounds shipped.
/// Idempotent.
pub fn init_rounds_if_missing(alliance: &Alliance, now_ns: u64) {
    ALLIANCE_ROUNDS.with(|r| {
        let mut map = r.borrow_mut();
        if map.contains_key(&alliance.id) {
            return;
        }
        let round0 = MissionRound::new(0, alliance.mission.clone(), now_ns);
        map.insert(alliance.id, AllianceRounds(vec![round0]));
    });
}

/// Mutate the rounds vector for an alliance under a closure. Caller must
/// ensure rounds were initialised; for safety this is a no-op if the
/// entry is missing. Returns `Ok(())` on success, error string on stable
/// write failure.
pub fn mutate_rounds<F: FnOnce(&mut Vec<MissionRound>)>(
    id: AllianceId,
    f: F,
) -> Result<(), String> {
    ALLIANCE_ROUNDS.with(|r| {
        let mut map = r.borrow_mut();
        let current = map.get(&id);
        if let Some(ar) = current {
            let mut v = ar.0;
            f(&mut v);
            map.insert(id, AllianceRounds(v));
            Ok(())
        } else {
            Err(format!("rounds not initialised for alliance {id}"))
        }
    })
}

/// Wrapper that gives `Option<Principal>` a `Storable` impl. Cannot impl
/// `Storable` directly on `Option<Principal>` because of orphan rules.
#[derive(Clone, Debug, candid::CandidType, serde::Serialize, serde::Deserialize)]
pub struct NftCanisterCell(pub Option<Principal>);

impl ic_stable_structures::Storable for NftCanisterCell {
    fn to_bytes(&self) -> std::borrow::Cow<'_, [u8]> {
        std::borrow::Cow::Owned(candid::encode_one(self).expect("encode NftCanisterCell"))
    }
    fn from_bytes(bytes: std::borrow::Cow<[u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode NftCanisterCell")
    }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 64,
            is_fixed_size: false,
        };
}

pub fn nft_canister() -> Option<Principal> {
    NFT_CANISTER_ID.with(|c| c.borrow().get().0)
}

/// Set the NFT canister id. Returns an error string if the stable write
/// fails (e.g. ValueTooLarge — would indicate a schema bug). Callers that
/// already return `Result<_, String>` can propagate with `?`.
pub fn set_nft_canister(p: Principal) -> Result<(), String> {
    NFT_CANISTER_ID.with(|c| {
        c.borrow_mut()
            .set(NftCanisterCell(Some(p)))
            .map(|_| ())
            .map_err(|e| format!("set NFT_CANISTER_ID: {e:?}"))
    })
}

/// Read the current game state.
pub fn game_state() -> GameState {
    GAME_STATE.with(|s| s.borrow().get().clone())
}

/// Mutate the game state. Returns an error string if the stable write fails;
/// callers inside update-methods should propagate via `PlaceError::InternalError`
/// / `AllianceError::InternalError` so the client gets a structured error
/// instead of a canister trap.
pub fn update_game_state<F: FnOnce(&mut GameState)>(f: F) -> Result<(), String> {
    GAME_STATE.with(|s| {
        let mut current = s.borrow().get().clone();
        f(&mut current);
        s.borrow_mut()
            .set(current)
            .map(|_| ())
            .map_err(|e| format!("set GameState: {e:?}"))
    })
}
