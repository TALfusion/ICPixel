import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface AdminStats {
  'icp_usd_micro' : bigint,
  'pixel_price_usd_cents' : number,
  'total_users' : bigint,
  'pixel_cooldown_seconds' : number,
  'total_pixels_placed' : bigint,
  'low_cycles_warning' : boolean,
  'season' : number,
  'cycles' : bigint,
  'unique_pixels_set' : bigint,
  'wallet_pending_e8s' : bigint,
  'icp_usd_last_fetched_ns' : bigint,
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
  { 'InternalError' : string } |
  { 'AlreadyInAlliance' : null };
export type AllianceOrPublic = { 'Full' : Alliance } |
  { 'Public' : AlliancePublic };
export interface AlliancePublic {
  'id' : bigint,
  'nft_token_id' : [] | [bigint],
  'name' : string,
  'description' : string,
  'created_at' : bigint,
  'pixels_captured' : bigint,
  'leader' : Principal,
  'member_count' : number,
}
export type AllianceUnitResult = { 'Ok' : null } |
  { 'Err' : AllianceError };
export interface Billing {
  'reward_pool_pct' : [] | [number],
  'treasury_pct' : number,
  'pixel_price_usd_cents' : number,
  'pixel_cooldown_seconds' : number,
  'wallet_principal' : Principal,
  'wallet_pct' : number,
  'alliance_price_e8s' : bigint,
  'ledger' : [] | [Principal],
  'treasury_principal' : Principal,
}
export type BuyPixelsResult = { 'Ok' : bigint } |
  { 'Err' : string };
export interface ChangesResponse {
  'min_version' : bigint,
  'next_version' : bigint,
  'current_version' : bigint,
  'changes' : Array<PixelChange>,
  'map_size' : number,
}
export type CheckMissionResult = { 'Ok' : MissionStatus } |
  { 'Err' : AllianceError };
export type ClaimMissionRewardResult = { 'Ok' : ClaimResult } |
  { 'Err' : AllianceError };
export interface ClaimResult { 'transferred' : boolean, 'share_e8s' : bigint }
export type ClaimTreasuryResult = { 'Ok' : bigint } |
  { 'Err' : string };
export type CreateAllianceResult = { 'Ok' : bigint } |
  { 'Err' : AllianceError };
export interface DistributeReport {
  'tokens_considered' : number,
  'season' : number,
  'owner_paid_e8s' : bigint,
  'holders_pool_e8s' : bigint,
  'holders_credited' : number,
  'total_distributable_e8s' : bigint,
}
export type DistributeTreasuryResult = { 'Ok' : DistributeReport } |
  { 'Err' : string };
export interface GameState {
  'final_stage_reached_at' : [] | [bigint],
  'treasury_operational_buffer_e8s' : [] | [bigint],
  'total_pixels_placed' : bigint,
  'season' : number,
  'treasury_last_distributed_season' : [] | [number],
  'unique_pixels_set' : bigint,
  'reward_pool_balance_e8s' : [] | [bigint],
  'treasury_balance_e8s' : [] | [bigint],
  'map_size' : number,
  'paused' : boolean,
}
/**
 * HTTP gateway (certified-HTTP) request/response. Different shape than the
 * TransformHttpResponse above — these match the IC HTTP gateway spec, used
 * for serving content like /og.png via boundary-node URLs.
 */
export interface HttpGatewayRequest {
  'url' : string,
  'method' : string,
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
}
export interface HttpGatewayResponse {
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
  'status_code' : number,
}
export interface IcpUsdCache {
  'last_fetched_ns' : bigint,
  'usd_per_icp_micro' : bigint,
}
export interface LeaderboardEntry {
  'alliance' : AlliancePublic,
  'rank' : number,
}
export interface LeaderboardPage {
  'total' : bigint,
  'my_entry' : [] | [LeaderboardEntry],
  'entries' : Array<LeaderboardEntry>,
  'top_pixels' : bigint,
}
export interface Mission {
  'x' : number,
  'y' : number,
  'height' : number,
  'template' : Uint32Array | number[],
  'width' : number,
}
export type MissionContributionResult = { 'Ok' : MissionContributionView } |
  { 'Err' : AllianceError };
export interface MissionContributionView {
  'reward_pool_e8s' : bigint,
  'my_weight' : bigint,
  'total_weight' : bigint,
  'completed' : boolean,
  'claimed' : boolean,
  'helper_pixels' : number,
  'estimated_share_e8s' : bigint,
  'round_index' : number,
  'member_pixels' : number,
}
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
export interface PixelChange { 'x' : number, 'y' : number, 'color' : number }
export type PlaceError = { 'OutOfBounds' : null } |
  { 'Paused' : null } |
  { 'SeasonEnded' : null } |
  { 'Unauthorized' : null } |
  { 'InvalidColor' : null } |
  { 'Cooldown' : { 'remaining_ns' : bigint } } |
  { 'InternalError' : string } |
  { 'NoCredits' : null };
export type PlaceResult = { 'Ok' : null } |
  { 'Err' : PlaceError };
export type RefreshIcpPriceResult = { 'Ok' : IcpUsdCache } |
  { 'Err' : string };
export type SetBillingResult = { 'Ok' : null } |
  { 'Err' : string };
export type SetNftCanisterResult = { 'Ok' : null } |
  { 'Err' : string };
export interface StreakEntry {
  'max_streak' : number,
  'user' : Principal,
  'current_streak' : number,
  'total_pixels' : bigint,
}
export interface UserStats {
  'max_streak' : number,
  'current_streak' : number,
  'total_pixels' : bigint,
  'last_day' : number,
}
export interface VersionInfo { 'version' : bigint, 'map_size' : number }
export interface _SERVICE {
  'admin_credit_treasury' : ActorMethod<
    [bigint],
    { 'Ok' : bigint } |
      { 'Err' : string }
  >,
  'admin_grant_credits' : ActorMethod<[Principal, bigint], SetBillingResult>,
  /**
   * Batched wallet payout. Drains WALLET_PENDING_E8S via one icrc1_transfer
   * to billing.wallet_principal. Returns the amount actually paid out
   * (minus the ledger fee) or an error.
   */
  'admin_payout_wallet' : ActorMethod<
    [],
    { 'Ok' : bigint } |
      { 'Err' : string }
  >,
  'admin_reset_treasury_distribution' : ActorMethod<[], SetBillingResult>,
  'admin_set_paused' : ActorMethod<[boolean], SetBillingResult>,
  'admin_set_treasury_buffer' : ActorMethod<[bigint], SetBillingResult>,
  'am_i_controller' : ActorMethod<[], boolean>,
  'buy_pixels' : ActorMethod<[bigint], BuyPixelsResult>,
  'check_mission' : ActorMethod<[bigint], CheckMissionResult>,
  'chunk_size' : ActorMethod<[], number>,
  'claim_mission_reward' : ActorMethod<
    [bigint, number],
    ClaimMissionRewardResult
  >,
  'claim_treasury' : ActorMethod<[], ClaimTreasuryResult>,
  'create_alliance' : ActorMethod<
    [string, string, Mission],
    CreateAllianceResult
  >,
  'debug_fill' : ActorMethod<[number], bigint>,
  /**
   * End-of-season treasury distribution.
   */
  'distribute_treasury' : ActorMethod<[], DistributeTreasuryResult>,
  'get_admin_stats' : ActorMethod<[], AdminStats>,
  'get_alliance' : ActorMethod<[bigint], [] | [AllianceOrPublic]>,
  'get_alliance_billing' : ActorMethod<[], Billing>,
  'get_alliance_price_usd_cents' : ActorMethod<[], number>,
  'get_changes_since' : ActorMethod<[bigint, [] | [bigint]], ChangesResponse>,
  'get_claimable_treasury' : ActorMethod<[Principal], bigint>,
  'get_game_state' : ActorMethod<[], GameState>,
  /**
   * Health probe — open query, used by frontend admin badge and any
   * external uptime monitor. cycles is the canister's current cycle
   * balance; stable_pages is in 64KiB pages.
   */
  'get_health' : ActorMethod<
    [],
    {
      'low_cycles_warning' : boolean,
      'cycles' : bigint,
      'stable_pages' : bigint,
    }
  >,
  'get_icp_price' : ActorMethod<[], IcpUsdCache>,
  'get_map_chunk' : ActorMethod<[number, number], Uint32Array | number[]>,
  /**
   * Mission rounds & rewards.
   */
  'get_mission_rounds' : ActorMethod<[bigint], Array<MissionRoundPublic>>,
  'get_my_alliance' : ActorMethod<[], [] | [Alliance]>,
  'get_nft_canister' : ActorMethod<[], [] | [Principal]>,
  'get_pixel_credits' : ActorMethod<[Principal], bigint>,
  'get_top_streaks' : ActorMethod<[bigint], Array<StreakEntry>>,
  'get_treasury_balance' : ActorMethod<[], bigint>,
  'get_version' : ActorMethod<[], VersionInfo>,
  'get_wallet_pending_e8s' : ActorMethod<[], bigint>,
  /**
   * HTTP gateway endpoint — serves /og.png for link previews.
   */
  'http_request' : ActorMethod<[HttpGatewayRequest], HttpGatewayResponse>,
  'join_alliance' : ActorMethod<[bigint], AllianceUnitResult>,
  'leaderboard' : ActorMethod<[bigint, bigint], LeaderboardPage>,
  'leave_alliance' : ActorMethod<[], AllianceUnitResult>,
  'list_alliances' : ActorMethod<[], Array<AlliancePublic>>,
  'my_claimable_treasury' : ActorMethod<[], bigint>,
  'my_mission_contribution' : ActorMethod<
    [bigint, number],
    MissionContributionResult
  >,
  'my_pixel_credits' : ActorMethod<[], bigint>,
  'my_stats' : ActorMethod<[], UserStats>,
  'place_pixel' : ActorMethod<[number, number, number], PlaceResult>,
  'refresh_icp_price' : ActorMethod<[], RefreshIcpPriceResult>,
  'set_alliance_billing' : ActorMethod<[Billing], SetBillingResult>,
  'set_alliance_price' : ActorMethod<[bigint], SetBillingResult>,
  'set_nft_canister' : ActorMethod<[Principal], SetNftCanisterResult>,
  'upgrade_mission' : ActorMethod<[bigint, Mission], AllianceUnitResult>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
