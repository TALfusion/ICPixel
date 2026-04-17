import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface AdminStats {
  'total_users' : bigint,
  'pixel_cooldown_seconds' : number,
  'total_pixels_placed' : bigint,
  'low_cycles_warning' : boolean,
  'season' : number,
  'cycles' : bigint,
  'unique_pixels_set' : bigint,
  'wallet_pending_e8s' : bigint,
  'stable_pages' : bigint,
  'total_nfts_minted' : bigint,
  'treasury_balance_e8s' : bigint,
  'total_alliances' : bigint,
  'map_size' : number,
  'paused' : boolean,
}
export interface Alliance {
  'id' : bigint,
  'members' : Array<Principal>,
  'nft_token_id' : [] | [bigint],
  'mission' : Mission,
  'name' : string,
  'description' : string,
  'created_at' : bigint,
  /**
   * Optional website URL for the alliance. Must start with "https://"
   * and be ≤ 200 chars if set. Option for upgrade-safety per MIGRATION.md.
   */
  'website' : [] | [string],
  'pixels_captured' : bigint,
  'prev_nft_token_id' : [] | [bigint],
  'leader' : Principal,
  'nft_mint_in_progress' : boolean,
}
export type AllianceError = { 'NameEmpty' : null } |
  { 'Paused' : null } |
  { 'DescriptionTooLong' : null } |
  { 'RoundNotFound' : null } |
  { 'NoContribution' : null } |
  { 'PaymentFailed' : string } |
  { 'NftCanisterNotConfigured' : null } |
  { 'RoundNotCompleted' : null } |
  { 'MissionAreaAlreadyPainted' : number } |
  { 'NotFound' : null } |
  { 'AlreadyClaimed' : null } |
  { 'NftNotBurned' : null } |
  { 'MissionNotComplete' : null } |
  { 'OldPixelsModified' : null } |
  { 'Unauthorized' : null } |
  { 'NotInAlliance' : null } |
  { 'InvalidMission' : string } |
  { 'NameTooLong' : null } |
  { 'NotLeader' : null } |
  { 'NftMintFailed' : string } |
  { 'UpgradeMustContainOld' : null } |
  { 'InvalidWebsite' : string } |
  { 'InternalError' : string } |
  { 'AlreadyInAlliance' : null };
export type AllianceOrPublic = { 'Full' : Alliance } |
  { 'Public' : AlliancePublic };
/**
 * Alliance creation cost: current price + next tier price (if any).
 */
export interface AlliancePriceInfo {
  'next' : [] | [bigint],
  'current' : bigint,
}
/**
 * Public view (no mission) — what non-members see in `list_alliances`.
 */
export interface AlliancePublic {
  'id' : bigint,
  'nft_token_id' : [] | [bigint],
  'name' : string,
  'description' : string,
  'created_at' : bigint,
  'website' : [] | [string],
  'pixels_captured' : bigint,
  'leader' : Principal,
  'member_count' : number,
}
/**
 * Mutable billing config. All fields can be changed at runtime by a
 * canister controller via the admin endpoints in `lib.rs`.
 */
export interface Billing {
  /**
   * Mission reward pool share, 0..=100.
   */
  'reward_pool_pct' : [] | [number],
  /**
   * Treasury share, 0..=100.
   */
  'treasury_pct' : number,
  /**
   * Legacy field kept for backward-compat decode. Ignored at runtime.
   */
  'pixel_price_e8s' : [] | [bigint],
  /**
   * Legacy field kept for backward-compat decode. Ignored at runtime.
   */
  'pixel_price_usd_cents' : number,
  /**
   * Per-player cooldown between pixel placements, in seconds. `0` disables.
   */
  'pixel_cooldown_seconds' : number,
  /**
   * Where the wallet share of the fee goes.
   */
  'wallet_principal' : Principal,
  /**
   * Wallet share, 0..=100. `wallet_pct + treasury_pct + reward_pool_pct` must equal 100.
   */
  'wallet_pct' : number,
  /**
   * Cost of `create_alliance` in e8s (1 ICP = 100_000_000 e8s).
   * `0` means alliances are free and no payment is attempted.
   */
  'alliance_price_e8s' : bigint,
  /**
   * ICP ledger canister. Required for all paid operations (packs,
   * alliances). Must be set via `set_alliance_billing` after deploy.
   */
  'ledger' : [] | [Principal],
  /**
   * Where the treasury share of the fee goes.
   */
  'treasury_principal' : Principal,
}
/**
 * Cheap health probe. Returns the canister's current cycle balance and
 * the size of stable memory in pages (1 page = 64 KiB). Open query so
 * the frontend can render an admin pill, and an external monitor can
 * poll without controller credentials.
 * 
 * Stable storage is a hard cap (~96 GiB on the IC); cycles run out
 * silently and brick the canister. Both are worth watching at the
 * same time.
 */
export interface CanisterHealth {
  'low_cycles_warning' : boolean,
  'cycles' : bigint,
  'stable_pages' : bigint,
}
/**
 * Returned by `get_changes_since`. If `map_size` differs from what the
 * client knows about, the client MUST do a full reload.
 * 
 * `min_version` is the lowest version still available in the change log.
 * If the caller's `from_version < min_version`, the caller has fallen
 * outside the trim window and MUST do a full reload — they've missed
 * changes that have been pruned from the log.
 * 
 * `next_version` tells the client where to resume. When
 * `next_version < current_version`, more data is available and the
 * client should call again with `from_version = next_version`. When
 * they're equal, the client is fully caught up. This is how clients
 * walk the full season history in chunks without blowing the query
 * response-size limit — `get_changes_since` caps each reply at
 * `GET_CHANGES_HARD_CAP` entries.
 */
export interface ChangesResponse {
  'min_version' : bigint,
  'next_version' : bigint,
  'current_version' : bigint,
  'changes' : Array<PixelChange>,
  'map_size' : number,
}
/**
 * Result of a successful `claim_mission_reward` call.
 */
export interface ClaimResult {
  /**
   * ICP ledger block index of the transfer, when `transferred == true`.
   * Frontend builds a dashboard.internetcomputer.org link from this.
   */
  'block_index' : [] | [bigint],
  /**
   * Whether the e8s were actually transferred to the caller's wallet.
   * `false` in free mode (share_e8s == 0 or ledger not wired); `true`
   * on a successful `drain_to_dest`.
   */
  'transferred' : boolean,
  'share_e8s' : bigint,
}
/**
 * Result returned by `distribute_treasury` so the admin can sanity-check
 * what just happened.
 */
export interface DistributeReport {
  'tokens_considered' : number,
  'season' : number,
  'owner_paid_e8s' : bigint,
  'holders_pool_e8s' : bigint,
  'holders_credited' : number,
  'total_distributable_e8s' : bigint,
}
/**
 * Sizes of every paginated collection. Client uses this to decide how
 * many chunks to fetch per category.
 */
export interface ExportCounts {
  'mission_tile_index' : bigint,
  'pixel_credits' : bigint,
  'user_stats' : bigint,
  'user_alliance' : bigint,
  'pending_orders' : bigint,
  'pixels' : bigint,
  'last_placed' : bigint,
  /**
   * Size in bytes of the flat pixel-color memory region. Export with
   * `admin_export_pixel_colors(offset, len)`.
   */
  'pixel_colors_bytes' : bigint,
  'alliances' : bigint,
  'alliance_rounds' : bigint,
  'changes' : bigint,
  'claimable_treasury' : bigint,
}
/**
 * One-shot bundle of every `StableCell` / counter. All singletons are
 * small, so returning them in a single query keeps the client simple.
 */
export interface ExportSingletons {
  'next_alliance_id' : bigint,
  'icp_usd_cache' : IcpUsdCache,
  'billing' : Billing,
  'next_version' : bigint,
  'game_state' : GameState,
  'nft_canister' : [] | [Principal],
  'wallet_pending_e8s' : bigint,
}
/**
 * Global game state. Single value, kept in a StableCell.
 */
export interface GameState {
  /**
   * Timestamp (ns) when the final stage (500x500) was reached.
   * `None` until then. Once set, the season ends 7 days later.
   */
  'final_stage_reached_at' : [] | [bigint],
  /**
   * Operational ICP buffer (e8s) the canister keeps on hand instead of
   * distributing to NFT holders. `None` falls back to the default
   * `DEFAULT_TREASURY_BUFFER_E8S` (20 ICP). Tunable at runtime by
   * controllers via `admin_set_treasury_buffer`. Option per MIGRATION.md.
   */
  'treasury_operational_buffer_e8s' : [] | [bigint],
  'total_pixels_placed' : bigint,
  'season' : number,
  /**
   * Last season for which `distribute_treasury` ran successfully. Acts
   * as both the dedup guard (one distribution per season) and the
   * in-progress sentinel — set at the start of distribution, never
   * reset on success. `None` means no distribution has ever run.
   * Option for upgrade-safety per MIGRATION.md.
   */
  'treasury_last_distributed_season' : [] | [number],
  /**
   * Name of the last alliance whose mission was completed and NFT minted.
   * Updated by `maybe_mint_for_pixel` on successful mint. Option per
   * MIGRATION.md.
   */
  'last_completed_mission_name' : [] | [string],
  'unique_pixels_set' : bigint,
  /**
   * Global reward pool balance in e8s. Accumulates the `reward_pool_pct`
   * share of every payment. Money is distributed to completed missions
   * on each incoming payment; this field holds only the undistributed
   * remainder (e.g. when no missions are completed yet). Option for
   * upgrade-safety per MIGRATION.md.
   */
  'reward_pool_balance_e8s' : [] | [bigint],
  /**
   * Reward pool balance in e8s of ICP. Conceptually = treasury balance.
   * Incremented by `billing::credit_treasury` whenever a player pays for
   * a pixel or for an alliance creation (treasury_pct of the fee). Locked
   * into a `MissionRound.reward_pool_e8s` when a round completes.
   * 
   * In free mode (`pixel_price_usd_cents == 0` and no real ICRC-2 wiring)
   * this stays at 0 — the contribution-tracking machinery is wired today
   * but the pool will only fill once Phase 2 enables real payments.
   * 
   * Stored as `Option<u64>` so existing GameState bytes (which lack this
   * field) decode cleanly after upgrade. `None` is treated as 0.
   */
  'treasury_balance_e8s' : [] | [bigint],
  'map_size' : number,
  /**
   * Global kill-switch. When `true`, all state-mutating gameplay endpoints
   * (place_pixel, create_alliance, join/leave, upgrade_mission, ...) return
   * `Paused`. Toggled by `admin_set_paused`. Survives canister upgrades.
   */
  'paused' : boolean,
  /**
   * Timestamp (ns) when the last mission was completed (NFT minted).
   * Option per MIGRATION.md.
   */
  'last_completed_mission_at' : [] | [bigint],
}
export interface HttpRequest {
  'url' : string,
  'method' : string,
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
}
export interface HttpResponse {
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
  'status_code' : number,
}
/**
 * USD per 1 ICP, scaled by 1e6 (so $6.4321 → 6_432_100). 0 means "never
 * fetched". Stored alongside the fetch timestamp.
 */
export interface IcpUsdCache {
  'last_fetched_ns' : bigint,
  'usd_per_icp_micro' : bigint,
}
/**
 * One entry in a leaderboard page. `rank` is 1-based, computed by sorting
 * all alliances by (pixels_captured desc, id asc) for a stable tie-break.
 */
export interface LeaderboardEntry {
  'alliance' : AlliancePublic,
  'rank' : number,
}
/**
 * Paginated leaderboard. `total` is the total alliance count (for pagination
 * UI). `top_pixels` is the #1 alliance's pixel count, used by the frontend
 * to render proportional bars. `my_entry` is the caller's own entry if they
 * are in an alliance — included even when outside the requested page so the
 * UI can always show "your rank".
 */
export interface LeaderboardPage {
  'total' : bigint,
  'my_entry' : [] | [LeaderboardEntry],
  'entries' : Array<LeaderboardEntry>,
  'top_pixels' : bigint,
}
export interface Mission {
  /**
   * Top-left corner in centered coordinates ((0,0) is map center).
   */
  'x' : number,
  'y' : number,
  'height' : number,
  'template' : Uint32Array | number[],
  'width' : number,
}
/**
 * Caller-scoped contribution view: how much I've contributed to a given
 * round and what my share is (or would be) when it closes.
 */
export interface MissionContributionView {
  'reward_pool_e8s' : bigint,
  /**
   * My weight in the round = `member_pixels * 2 + helper_pixels` (we keep
   * integer math by scaling everything ×2).
   */
  'my_weight' : bigint,
  'total_weight' : bigint,
  'completed' : boolean,
  'claimed' : boolean,
  'helper_pixels' : number,
  /**
   * Estimated share if the round completed right now. For an already-
   * completed round this is the actual share. 0 in free mode.
   */
  'estimated_share_e8s' : bigint,
  'round_index' : number,
  'member_pixels' : number,
}
export interface MissionRound {
  /**
   * Per-principal total e8s already claimed. Allows re-claiming the
   * delta since last claim as pool grows.
   */
  'claimed_amounts' : [] | [Array<[Principal, bigint]>],
  /**
   * Total e8s already claimed from `accumulated_pool_e8s`. Tracked so
   * players can re-claim as the pool grows (continuous flow model).
   */
  'total_claimed_e8s' : [] | [bigint],
  /**
   * Accumulated reward pool for this round, fed continuously by
   * `credit_reward_pool` proportional to this round's pixel_count
   * relative to all completed rounds. Players claim from this pool.
   * Replaces the old lump-sum `reward_pool_e8s` lock model.
   */
  'accumulated_pool_e8s' : [] | [bigint],
  /**
   * Reward pool locked from treasury at round completion. 0 until then.
   * Free mode (price = 0) yields 0 here too — the math is wired but
   * payouts are no-ops.
   */
  'reward_pool_e8s' : bigint,
  /**
   * Bitmap with `ceil(width*height / 8)` bytes. Bit i (row-major) = 1
   * means cell i has already been credited in this round → no further
   * placements can earn credit for it (first-correct-pixel-wins). This
   * makes overwrite a dead-loss for the saboteur.
   */
  'credited_cells' : Uint8Array | number[],
  /**
   * Sum of correct-placement counts per principal who is currently a
   * member of the alliance at the time the cell was credited. Each entry
   * counts at weight ×1.
   */
  'contributions' : Array<[Principal, number]>,
  /**
   * `Some(token_id)` once the NFT for this round was minted. Mirrors
   * the active-round NFT in `Alliance.nft_token_id` for read-side
   * convenience; closed rounds keep their original token id here.
   */
  'nft_token_id' : [] | [bigint],
  /**
   * Snapshot of the mission target this round was opened with. We don't
   * reach back into Alliance.mission so that closed rounds keep their
   * original (smaller) template even after upgrades enlarge the active
   * mission.
   */
  'mission' : Mission,
  /**
   * Maps cell_index → Principal who last placed the correct color.
   * Used for "last-correct-wins" credit model: when a cell is repaired
   * after sabotage, the repairer gets the credit and the original
   * placer's count is decremented. Option for upgrade-safety.
   */
  'cell_creditors' : [] | [Array<[number, Principal]>],
  /**
   * Principals who have already called `claim_mission_reward` for this
   * round. Idempotent guard.
   */
  'claimed_principals' : Array<Principal>,
  /**
   * 0-based index in the alliance's rounds vector. Round 0 is the
   * alliance's initial mission; each `upgrade_mission` appends one.
   */
  'round_index' : number,
  /**
   * Set the moment the round crosses 95% match. Stays `None` until then.
   */
  'completed_at' : [] | [bigint],
  'started_at' : bigint,
  /**
   * Same shape but for non-member helpers — counted at weight ×0.5 in
   * the share calculation.
   */
  'helper_contributions' : Array<[Principal, number]>,
}
/**
 * Public DTO returned by `get_mission_rounds`. Strips heavy fields
 * (template, bitmap, full contributions) so the response stays small for
 * list views. Detailed contribution data is fetched per-round via
 * `my_mission_contribution`.
 */
export interface MissionRoundPublic {
  'x' : number,
  'y' : number,
  'height' : number,
  'reward_pool_e8s' : bigint,
  'member_contributor_count' : number,
  'nft_token_id' : [] | [bigint],
  'helper_contributor_count' : number,
  'claimed_count' : number,
  'pixel_count' : bigint,
  'credited_cells_count' : bigint,
  'round_index' : number,
  'width' : number,
  'completed_at' : [] | [bigint],
  'started_at' : bigint,
}
export interface MissionStatus {
  'total' : number,
  'completed' : boolean,
  'percent' : number,
  'matched' : number,
}
export interface MissionTileKey { 'tx' : number, 'ty' : number }
export interface OrderCreated {
  /**
   * 32-byte subaccount as lowercase hex (paste into ICRC-1 wallet).
   */
  'subaccount_hex' : string,
  'pack_id' : number,
  /**
   * Legacy AccountIdentifier (64-char hex) — for NNS dapp / old wallets.
   */
  'account_identifier_hex' : string,
  'pack_pixels' : bigint,
  'tolerance_below_e8s' : bigint,
  /**
   * Canister principal that owns the subaccount (paste into ICRC-1 wallet).
   */
  'owner_principal' : Principal,
  'expected_e8s' : bigint,
  'expires_at_ns' : bigint,
  'order_id_hex' : string,
}
/**
 * State machine for a pixel-pack deposit order.
 */
export type OrderStatus = {
    /**
     * A controller manually swept this order's subaccount out to a
     * different principal (support / refund flow).
     */
    'Rescued' : {
      'to' : Principal,
      'block_index' : bigint,
      'amount_e8s' : bigint,
    }
  } |
  {
    /**
     * Balance on the subaccount reached the expected amount (within
     * tolerance); funds have been swept to the canister's main account,
     * pixels credited, and split done.
     */
    'Paid' : {
      'settled_e8s' : bigint,
      'block_index' : bigint,
      'pixels_credited' : bigint,
    }
  } |
  {
    /**
     * TTL window elapsed before enough ICP arrived. Any funds still on
     * the subaccount are salvageable only via `admin_rescue_order`.
     */
    'Expired' : null
  } |
  {
    /**
     * Waiting for the player to send ICP to the deposit subaccount.
     */
    'Pending' : null
  };
export interface OrderView {
  'status' : OrderStatus,
  'pack_id' : number,
  'created_at_ns' : bigint,
  'current_balance_e8s' : bigint,
  'buyer' : Principal,
  'expected_e8s' : bigint,
  'expires_at_ns' : bigint,
  'order_id_hex' : string,
}
/**
 * Frontend-facing payout destination. The typed ICRC-1 variant carries
 * subaccount as a hex string for ergonomics (JS has no 32-byte array
 * literal); backend parses it before calling the ledger.
 */
export type PayoutDestArg = {
    /**
     * ICRC-1 destination. `subaccount_hex` optional; when given must be
     * exactly 64 hex chars (32 bytes).
     */
    'Icrc1' : { 'subaccount_hex' : [] | [string], 'owner' : Principal }
  } |
  {
    /**
     * Send to the caller's Internet Identity principal, default subaccount.
     */
    'Default' : null
  } |
  {
    /**
     * Legacy 32-byte AccountIdentifier as a 64-char hex string.
     */
    'AccountId' : { 'hex' : string }
  };
export interface PendingOrder {
  'status' : OrderStatus,
  'principal' : Principal,
  'pack_id' : number,
  'created_at_ns' : bigint,
  'order_id' : Uint8Array | number[],
  'expected_e8s' : bigint,
  'expires_at_ns' : bigint,
}
/**
 * A single pixel on the map.
 * `owner` is `None` until we add Internet Identity in a later phase.
 */
export interface Pixel {
  'owner' : [] | [Principal],
  'color' : number,
  'timestamp' : bigint,
}
/**
 * A single change in the change log. Coordinates are centered (signed).
 */
export interface PixelChange { 'x' : number, 'y' : number, 'color' : number }
/**
 * Key into the pixel map: (x, y) in **centered** coordinates. (0,0) is the
 * geometric center of the map; valid range for size N is `[-(N/2)..(N+1)/2)`,
 * i.e. for N=5: `-2..=2`, for N=10: `-5..=4`.
 */
export interface PixelKey { 'x' : number, 'y' : number }
/**
 * A fixed-price pixel pack.
 */
export interface PixelPack {
  'id' : number,
  'pixels' : bigint,
  /**
   * Total pack price in e8s (1 ICP = 100_000_000 e8s).
   */
  'price_e8s' : bigint,
}
export type PlaceError = { 'OutOfBounds' : null } |
  {
    /**
     * Admin has paused the game (maintenance / incident response).
     */
    'Paused' : null
  } |
  { 'SeasonEnded' : null } |
  { 'Unauthorized' : null } |
  { 'InvalidColor' : null } |
  { 'Cooldown' : { 'remaining_ns' : bigint } } |
  {
    /**
     * Unexpected stable-memory write failure. Transaction rolls back.
     * Caller should retry; if persistent, it's a bug worth investigating.
     */
    'InternalError' : string
  } |
  {
    /**
     * Billing is on and the caller has zero pixel credits — they need to
     * buy more via `buy_pixels` before placing again.
     */
    'NoCredits' : null
  };
export type Result = { 'Ok' : bigint } |
  { 'Err' : string };
export type Result_1 = { 'Ok' : null } |
  { 'Err' : string };
export type Result_10 = { 'Ok' : null } |
  { 'Err' : PlaceError };
export type Result_2 = { 'Ok' : MissionStatus } |
  { 'Err' : AllianceError };
export type Result_3 = { 'Ok' : OrderView } |
  { 'Err' : string };
export type Result_4 = { 'Ok' : ClaimResult } |
  { 'Err' : AllianceError };
export type Result_5 = { 'Ok' : bigint } |
  { 'Err' : AllianceError };
export type Result_6 = { 'Ok' : OrderCreated } |
  { 'Err' : string };
export type Result_7 = { 'Ok' : DistributeReport } |
  { 'Err' : string };
export type Result_8 = { 'Ok' : null } |
  { 'Err' : AllianceError };
export type Result_9 = { 'Ok' : MissionContributionView } |
  { 'Err' : AllianceError };
/**
 * Public view of the treasury's deposit address in all three formats.
 * Open query so admins can display it and anyone who wants to donate
 * directly to treasury can use it. The destination is
 * `billing.treasury_principal`'s default subaccount.
 */
export interface TreasuryAddress {
  'subaccount_hex' : string,
  'account_identifier_hex' : string,
  'owner_principal' : Principal,
}
/**
 * Per-user streak stats. Stored in `USER_STATS` stable map (MemoryId 16).
 * Updated on every `place_pixel`: if the player placed yesterday →
 * current_streak += 1; if they skipped a day → reset to 1.
 */
export interface UserStats {
  /**
   * Highest streak this user ever achieved.
   */
  'max_streak' : number,
  /**
   * Current consecutive-day streak.
   */
  'current_streak' : number,
  /**
   * Total pixels this user has ever placed.
   */
  'total_pixels' : bigint,
  /**
   * Day number (days since epoch) of the last pixel placement.
   * Used to detect "yesterday" vs "gap".
   */
  'last_day' : number,
}
/**
 * Tiny version probe — used for cheap polling. Total ~10 bytes on the wire.
 */
export interface VersionInfo { 'version' : bigint, 'map_size' : number }
export interface _SERVICE {
  /**
   * Test-only: inject e8s into the mission reward pool as if real payments
   * came in. Controller-only.
   */
  'admin_credit_reward_pool' : ActorMethod<[bigint], Result>,
  /**
   * Controller-only. Manually bump the treasury counter — used for testing
   * the reward-pool / claim flow without having to wire ICRC-2 first. On
   * mainnet this stays callable but should never be needed: real payments
   * will fill the treasury automatically.
   */
  'admin_credit_treasury' : ActorMethod<[bigint], Result>,
  'admin_export_alliance_rounds' : ActorMethod<
    [bigint, bigint],
    Array<[bigint, Array<MissionRound>]>
  >,
  'admin_export_alliances' : ActorMethod<
    [bigint, bigint],
    Array<[bigint, Alliance]>
  >,
  'admin_export_changes' : ActorMethod<
    [bigint, bigint],
    Array<[bigint, PixelChange]>
  >,
  'admin_export_claimable_treasury' : ActorMethod<
    [bigint, bigint],
    Array<[Principal, bigint]>
  >,
  'admin_export_counts' : ActorMethod<[], ExportCounts>,
  'admin_export_last_placed' : ActorMethod<
    [bigint, bigint],
    Array<[Principal, bigint]>
  >,
  'admin_export_mission_tile_index' : ActorMethod<
    [bigint, bigint],
    Array<[MissionTileKey, BigUint64Array | bigint[]]>
  >,
  'admin_export_pending_orders' : ActorMethod<
    [bigint, bigint],
    Array<[Uint8Array | number[], PendingOrder]>
  >,
  /**
   * Raw flat pixel-color region as bytes. Each pixel is a little-endian
   * u32: bit 24 = painted flag, low 24 bits = 0xRRGGBB. Unpainted cells
   * read as 0. See `state::write_pixel_color` for the stored layout.
   */
  'admin_export_pixel_colors' : ActorMethod<
    [bigint, bigint],
    Uint8Array | number[]
  >,
  'admin_export_pixel_credits' : ActorMethod<
    [bigint, bigint],
    Array<[Principal, bigint]>
  >,
  'admin_export_pixels' : ActorMethod<
    [bigint, bigint],
    Array<[PixelKey, Pixel]>
  >,
  'admin_export_singletons' : ActorMethod<[], ExportSingletons>,
  'admin_export_user_alliance' : ActorMethod<
    [bigint, bigint],
    Array<[Principal, bigint]>
  >,
  'admin_export_user_stats' : ActorMethod<
    [bigint, bigint],
    Array<[Principal, UserStats]>
  >,
  /**
   * Controller-only. Grants free credits to a player — used during testing.
   * On mainnet with the real ledger wired, players will call `buy_pixels`
   * instead and this endpoint becomes dev-only.
   */
  'admin_grant_credits' : ActorMethod<[Principal, bigint], Result_1>,
  /**
   * Controller-only. Drains the accumulated wallet share from
   * `WALLET_PENDING_E8S` via a single `icrc1_transfer` to
   * `billing.wallet_principal`. Batching drastically cuts ledger fee
   * waste — one drain call per day replaces ~N×10k e8s fees where N is
   * the number of purchases.
   * 
   * On ledger failure we leave the pending counter intact so the admin
   * can retry. On success we reset it to zero atomically.
   */
  'admin_payout_wallet' : ActorMethod<[], Result>,
  /**
   * Controller-only. Sweep the subaccount of a (typically Expired or stuck)
   * order to an arbitrary target principal. Used for manual support when
   * a player sent the wrong amount or after the TTL window. Marks the
   * order `Rescued` so it can't be double-claimed.
   */
  'admin_rescue_order' : ActorMethod<[string, Principal], Result>,
  /**
   * Controller-only. Clears the per-season distribution guard so a failed
   * distribution can be retried. Use with care: re-running for the same
   * season after partial success would double-credit holders.
   */
  'admin_reset_treasury_distribution' : ActorMethod<[], Result_1>,
  /**
   * Debug: force-set map size to a specific stage. Controller-only.
   * Used to test map growth without filling 250k pixels.
   */
  'admin_set_map_size' : ActorMethod<[number], Result_1>,
  /**
   * Controller-only. Global pause flag. While paused, all state-mutating
   * gameplay endpoints (place_pixel, create/join/leave alliance,
   * upgrade_mission, ...) return `Paused`. Query endpoints stay open so
   * clients can still read state and display a maintenance banner.
   */
  'admin_set_paused' : ActorMethod<[boolean], Result_1>,
  'admin_set_snapshot_reader' : ActorMethod<[[] | [Principal]], Result_1>,
  /**
   * Controller-only. Override the operational ICP buffer (e8s) the
   * canister keeps on hand instead of distributing.
   */
  'admin_set_treasury_buffer' : ActorMethod<[bigint], Result_1>,
  'am_i_controller' : ActorMethod<[], boolean>,
  'check_mission' : ActorMethod<[bigint], Result_2>,
  /**
   * Poll the status of an order. Called repeatedly by the frontend while
   * the purchase modal is open. Does a live balance read; if funds have
   * arrived it sweeps + settles + credits pixels in this call. Safe to
   * call from any caller (order_id is an unguessable 128-bit capability).
   */
  'check_order' : ActorMethod<[string], Result_3>,
  'chunk_size' : ActorMethod<[], number>,
  'claim_mission_reward' : ActorMethod<
    [bigint, number, PayoutDestArg],
    Result_4
  >,
  /**
   * User-facing pull. Drains the caller's claimable share from the
   * season distribution into their account via `icrc1_transfer`. The
   * ledger fee is taken from the credited amount.
   */
  'claim_treasury' : ActorMethod<[PayoutDestArg], Result>,
  'create_alliance' : ActorMethod<[string, string, Mission, string], Result_5>,
  /**
   * Create a deposit order for the given pack. Rejects anonymous callers.
   * Returns the deposit address (owner + subaccount in both ICRC-1 and
   * legacy AccountIdentifier form) plus the expected amount.
   */
  'create_order' : ActorMethod<[number], Result_6>,
  /**
   * Debug: paint `percent`% of the current map with a sweep of palette
   * colors. Bypasses cooldown / billing / auth. Controller-only.
   */
  'debug_fill' : ActorMethod<[number], bigint>,
  /**
   * Controller-only. Splits the canister's spare ICP balance 40/60 between
   * the owner and the season's NFT holders. Holder shares are written to a
   * pull-claim map; the owner cut is pushed via `icrc1_transfer`. The
   * owner principal is `billing.wallet_principal` — that's where the
   * project's actual wallet lives. Idempotent per season.
   */
  'distribute_treasury' : ActorMethod<[], Result_7>,
  'get_admin_stats' : ActorMethod<[], AdminStats>,
  'get_alliance' : ActorMethod<[bigint], [] | [AllianceOrPublic]>,
  'get_alliance_billing' : ActorMethod<[], Billing>,
  'get_alliance_price_pixels' : ActorMethod<[], AlliancePriceInfo>,
  'get_changes_since' : ActorMethod<[bigint, [] | [bigint]], ChangesResponse>,
  'get_claimable_treasury' : ActorMethod<[Principal], bigint>,
  'get_game_state' : ActorMethod<[], GameState>,
  'get_health' : ActorMethod<[], CanisterHealth>,
  'get_map_chunk' : ActorMethod<[number, number], Uint32Array | number[]>,
  'get_mission_rounds' : ActorMethod<[bigint], Array<MissionRoundPublic>>,
  'get_my_alliance' : ActorMethod<[], [] | [Alliance]>,
  'get_nft_canister' : ActorMethod<[], [] | [Principal]>,
  /**
   * Query the available pixel packs and their prices.
   */
  'get_packs' : ActorMethod<[], Array<PixelPack>>,
  'get_pixel_credits' : ActorMethod<[Principal], bigint>,
  'get_snapshot_reader' : ActorMethod<[], [] | [Principal]>,
  'get_treasury_address' : ActorMethod<[], TreasuryAddress>,
  'get_treasury_balance' : ActorMethod<[], bigint>,
  'get_version' : ActorMethod<[], VersionInfo>,
  'get_wallet_pending_e8s' : ActorMethod<[], bigint>,
  /**
   * HTTP gateway entry point. Serves the `/og.png` Open Graph preview image
   * used by Twitter/Discord/Telegram link cards. All other paths 404.
   */
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'join_alliance' : ActorMethod<[bigint], Result_8>,
  'leaderboard' : ActorMethod<[bigint, bigint], LeaderboardPage>,
  'leave_alliance' : ActorMethod<[], Result_8>,
  'list_alliances' : ActorMethod<[], Array<AlliancePublic>>,
  'my_claimable_treasury' : ActorMethod<[], bigint>,
  'my_mission_contribution' : ActorMethod<[bigint, number], Result_9>,
  /**
   * List all orders created by the caller (most recent first). Queries are
   * capped at 50 to avoid unbounded scans; terminal orders beyond that can
   * be fetched individually via `check_order`.
   */
  'my_orders' : ActorMethod<[], Array<OrderView>>,
  'my_pixel_credits' : ActorMethod<[], bigint>,
  'place_pixel' : ActorMethod<[number, number, number], Result_10>,
  'set_alliance_billing' : ActorMethod<[Billing], Result_1>,
  'set_alliance_price' : ActorMethod<[bigint], Result_1>,
  'set_nft_canister' : ActorMethod<[Principal], Result_1>,
  'upgrade_mission' : ActorMethod<[bigint, Mission], Result_8>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
