export const idlFactory = ({ IDL }) => {
  const SetBillingResult = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : IDL.Text });
  const BuyPixelsResult = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : IDL.Text });
  const MissionStatus = IDL.Record({
    'total' : IDL.Nat32,
    'completed' : IDL.Bool,
    'percent' : IDL.Nat8,
    'matched' : IDL.Nat32,
  });
  const AllianceError = IDL.Variant({
    'NameEmpty' : IDL.Null,
    'Paused' : IDL.Null,
    'DescriptionTooLong' : IDL.Null,
    'RoundNotFound' : IDL.Null,
    'NoContribution' : IDL.Null,
    'PaymentFailed' : IDL.Text,
    'NftCanisterNotConfigured' : IDL.Null,
    'RoundNotCompleted' : IDL.Null,
    'MissionAreaAlreadyPainted' : IDL.Nat8,
    'NotFound' : IDL.Null,
    'AlreadyClaimed' : IDL.Null,
    'NftNotBurned' : IDL.Null,
    'MissionNotComplete' : IDL.Null,
    'OldPixelsModified' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'NotInAlliance' : IDL.Null,
    'InvalidMission' : IDL.Text,
    'NameTooLong' : IDL.Null,
    'NotLeader' : IDL.Null,
    'NftMintFailed' : IDL.Text,
    'UpgradeMustContainOld' : IDL.Null,
    'InvalidWebsite' : IDL.Text,
    'InternalError' : IDL.Text,
    'AlreadyInAlliance' : IDL.Null,
  });
  const CheckMissionResult = IDL.Variant({
    'Ok' : MissionStatus,
    'Err' : AllianceError,
  });
  const ClaimResult = IDL.Record({
    'transferred' : IDL.Bool,
    'share_e8s' : IDL.Nat64,
  });
  const ClaimMissionRewardResult = IDL.Variant({
    'Ok' : ClaimResult,
    'Err' : AllianceError,
  });
  const ClaimTreasuryResult = IDL.Variant({
    'Ok' : IDL.Nat64,
    'Err' : IDL.Text,
  });
  const Mission = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'height' : IDL.Nat16,
    'template' : IDL.Vec(IDL.Nat32),
    'width' : IDL.Nat16,
  });
  const CreateAllianceResult = IDL.Variant({
    'Ok' : IDL.Nat64,
    'Err' : AllianceError,
  });
  const DistributeReport = IDL.Record({
    'tokens_considered' : IDL.Nat32,
    'season' : IDL.Nat32,
    'owner_paid_e8s' : IDL.Nat64,
    'holders_pool_e8s' : IDL.Nat64,
    'holders_credited' : IDL.Nat32,
    'total_distributable_e8s' : IDL.Nat64,
  });
  const DistributeTreasuryResult = IDL.Variant({
    'Ok' : DistributeReport,
    'Err' : IDL.Text,
  });
  const AdminStats = IDL.Record({
    'icp_usd_micro' : IDL.Nat64,
    'pixel_price_usd_cents' : IDL.Nat16,
    'total_users' : IDL.Nat64,
    'pixel_cooldown_seconds' : IDL.Nat32,
    'total_pixels_placed' : IDL.Nat64,
    'low_cycles_warning' : IDL.Bool,
    'season' : IDL.Nat32,
    'cycles' : IDL.Nat64,
    'unique_pixels_set' : IDL.Nat64,
    'wallet_pending_e8s' : IDL.Nat64,
    'icp_usd_last_fetched_ns' : IDL.Nat64,
    'stable_pages' : IDL.Nat64,
    'total_nfts_minted' : IDL.Nat64,
    'treasury_balance_e8s' : IDL.Nat64,
    'total_alliances' : IDL.Nat64,
    'map_size' : IDL.Nat16,
    'paused' : IDL.Bool,
  });
  const Alliance = IDL.Record({
    'id' : IDL.Nat64,
    'members' : IDL.Vec(IDL.Principal),
    'nft_token_id' : IDL.Opt(IDL.Nat64),
    'mission' : Mission,
    'name' : IDL.Text,
    'description' : IDL.Text,
    'created_at' : IDL.Nat64,
    'pixels_captured' : IDL.Nat64,
    'prev_nft_token_id' : IDL.Opt(IDL.Nat64),
    'leader' : IDL.Principal,
    'nft_mint_in_progress' : IDL.Bool,
  });
  const AlliancePublic = IDL.Record({
    'id' : IDL.Nat64,
    'nft_token_id' : IDL.Opt(IDL.Nat64),
    'name' : IDL.Text,
    'description' : IDL.Text,
    'created_at' : IDL.Nat64,
    'website' : IDL.Opt(IDL.Text),
    'pixels_captured' : IDL.Nat64,
    'leader' : IDL.Principal,
    'member_count' : IDL.Nat32,
  });
  const AllianceOrPublic = IDL.Variant({
    'Full' : Alliance,
    'Public' : AlliancePublic,
  });
  const Billing = IDL.Record({
    'reward_pool_pct' : IDL.Opt(IDL.Nat8),
    'treasury_pct' : IDL.Nat8,
    'pixel_price_usd_cents' : IDL.Nat16,
    'pixel_cooldown_seconds' : IDL.Nat32,
    'wallet_principal' : IDL.Principal,
    'wallet_pct' : IDL.Nat8,
    'alliance_price_e8s' : IDL.Nat64,
    'ledger' : IDL.Opt(IDL.Principal),
    'treasury_principal' : IDL.Principal,
  });
  const PixelChange = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'color' : IDL.Nat32,
  });
  const ChangesResponse = IDL.Record({
    'min_version' : IDL.Nat64,
    'next_version' : IDL.Nat64,
    'current_version' : IDL.Nat64,
    'changes' : IDL.Vec(PixelChange),
    'map_size' : IDL.Nat16,
  });
  const GameState = IDL.Record({
    'final_stage_reached_at' : IDL.Opt(IDL.Nat64),
    'treasury_operational_buffer_e8s' : IDL.Opt(IDL.Nat64),
    'test_radical_field' : IDL.Opt(IDL.Text),
    'total_pixels_placed' : IDL.Nat64,
    'season' : IDL.Nat32,
    'treasury_last_distributed_season' : IDL.Opt(IDL.Nat32),
    'last_completed_mission_name' : IDL.Opt(IDL.Text),
    'test_big_number' : IDL.Opt(IDL.Nat64),
    'unique_pixels_set' : IDL.Nat64,
    'reward_pool_balance_e8s' : IDL.Opt(IDL.Nat64),
    'treasury_balance_e8s' : IDL.Opt(IDL.Nat64),
    'map_size' : IDL.Nat16,
    'paused' : IDL.Bool,
    'last_completed_mission_at' : IDL.Opt(IDL.Nat64),
  });
  const IcpUsdCache = IDL.Record({
    'last_fetched_ns' : IDL.Nat64,
    'usd_per_icp_micro' : IDL.Nat64,
  });
  const MissionRoundPublic = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'height' : IDL.Nat16,
    'reward_pool_e8s' : IDL.Nat64,
    'member_contributor_count' : IDL.Nat32,
    'nft_token_id' : IDL.Opt(IDL.Nat64),
    'helper_contributor_count' : IDL.Nat32,
    'claimed_count' : IDL.Nat32,
    'pixel_count' : IDL.Nat64,
    'credited_cells_count' : IDL.Nat64,
    'round_index' : IDL.Nat32,
    'width' : IDL.Nat16,
    'completed_at' : IDL.Opt(IDL.Nat64),
    'started_at' : IDL.Nat64,
  });
  const StreakEntry = IDL.Record({
    'max_streak' : IDL.Nat32,
    'user' : IDL.Principal,
    'current_streak' : IDL.Nat32,
    'total_pixels' : IDL.Nat64,
  });
  const VersionInfo = IDL.Record({
    'version' : IDL.Nat64,
    'map_size' : IDL.Nat16,
  });
  const HttpGatewayRequest = IDL.Record({
    'url' : IDL.Text,
    'method' : IDL.Text,
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  });
  const HttpGatewayResponse = IDL.Record({
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    'status_code' : IDL.Nat16,
  });
  const AllianceUnitResult = IDL.Variant({
    'Ok' : IDL.Null,
    'Err' : AllianceError,
  });
  const LeaderboardEntry = IDL.Record({
    'alliance' : AlliancePublic,
    'rank' : IDL.Nat32,
  });
  const LeaderboardPage = IDL.Record({
    'total' : IDL.Nat64,
    'my_entry' : IDL.Opt(LeaderboardEntry),
    'entries' : IDL.Vec(LeaderboardEntry),
    'top_pixels' : IDL.Nat64,
  });
  const MissionContributionView = IDL.Record({
    'reward_pool_e8s' : IDL.Nat64,
    'my_weight' : IDL.Nat64,
    'total_weight' : IDL.Nat64,
    'completed' : IDL.Bool,
    'claimed' : IDL.Bool,
    'helper_pixels' : IDL.Nat32,
    'estimated_share_e8s' : IDL.Nat64,
    'round_index' : IDL.Nat32,
    'member_pixels' : IDL.Nat32,
  });
  const MissionContributionResult = IDL.Variant({
    'Ok' : MissionContributionView,
    'Err' : AllianceError,
  });
  const UserStats = IDL.Record({
    'max_streak' : IDL.Nat32,
    'current_streak' : IDL.Nat32,
    'total_pixels' : IDL.Nat64,
    'last_day' : IDL.Nat32,
  });
  const PlaceError = IDL.Variant({
    'OutOfBounds' : IDL.Null,
    'Paused' : IDL.Null,
    'SeasonEnded' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'InvalidColor' : IDL.Null,
    'Cooldown' : IDL.Record({ 'remaining_ns' : IDL.Nat64 }),
    'InternalError' : IDL.Text,
    'NoCredits' : IDL.Null,
  });
  const PlaceResult = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : PlaceError });
  const RefreshIcpPriceResult = IDL.Variant({
    'Ok' : IcpUsdCache,
    'Err' : IDL.Text,
  });
  const SetNftCanisterResult = IDL.Variant({
    'Ok' : IDL.Null,
    'Err' : IDL.Text,
  });
  return IDL.Service({
    'admin_credit_treasury' : IDL.Func(
        [IDL.Nat64],
        [IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : IDL.Text })],
        [],
      ),
    'admin_grant_credits' : IDL.Func(
        [IDL.Principal, IDL.Nat64],
        [SetBillingResult],
        [],
      ),
    'admin_payout_wallet' : IDL.Func(
        [],
        [IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : IDL.Text })],
        [],
      ),
    'admin_reset_treasury_distribution' : IDL.Func([], [SetBillingResult], []),
    'admin_set_paused' : IDL.Func([IDL.Bool], [SetBillingResult], []),
    'admin_set_treasury_buffer' : IDL.Func([IDL.Nat64], [SetBillingResult], []),
    'am_i_controller' : IDL.Func([], [IDL.Bool], ['query']),
    'buy_pixels' : IDL.Func([IDL.Nat64], [BuyPixelsResult], []),
    'check_mission' : IDL.Func([IDL.Nat64], [CheckMissionResult], ['query']),
    'chunk_size' : IDL.Func([], [IDL.Nat16], ['query']),
    'claim_mission_reward' : IDL.Func(
        [IDL.Nat64, IDL.Nat32],
        [ClaimMissionRewardResult],
        [],
      ),
    'claim_treasury' : IDL.Func([], [ClaimTreasuryResult], []),
    'create_alliance' : IDL.Func(
        [IDL.Text, IDL.Text, Mission, IDL.Text],
        [CreateAllianceResult],
        [],
      ),
    'debug_fill' : IDL.Func([IDL.Nat8], [IDL.Nat64], []),
    'distribute_treasury' : IDL.Func([], [DistributeTreasuryResult], []),
    'get_admin_stats' : IDL.Func([], [AdminStats], ['query']),
    'get_alliance' : IDL.Func(
        [IDL.Nat64],
        [IDL.Opt(AllianceOrPublic)],
        ['query'],
      ),
    'get_alliance_billing' : IDL.Func([], [Billing], ['query']),
    'get_alliance_price_usd_cents' : IDL.Func([], [IDL.Nat16], ['query']),
    'get_changes_since' : IDL.Func(
        [IDL.Nat64, IDL.Opt(IDL.Nat64)],
        [ChangesResponse],
        ['query'],
      ),
    'get_claimable_treasury' : IDL.Func(
        [IDL.Principal],
        [IDL.Nat64],
        ['query'],
      ),
    'get_game_state' : IDL.Func([], [GameState], ['query']),
    'get_health' : IDL.Func(
        [],
        [
          IDL.Record({
            'low_cycles_warning' : IDL.Bool,
            'cycles' : IDL.Nat64,
            'stable_pages' : IDL.Nat64,
          }),
        ],
        ['query'],
      ),
    'get_icp_price' : IDL.Func([], [IcpUsdCache], ['query']),
    'get_map_chunk' : IDL.Func(
        [IDL.Nat16, IDL.Nat16],
        [IDL.Vec(IDL.Nat32)],
        ['query'],
      ),
    'get_mission_rounds' : IDL.Func(
        [IDL.Nat64],
        [IDL.Vec(MissionRoundPublic)],
        ['query'],
      ),
    'get_my_alliance' : IDL.Func([], [IDL.Opt(Alliance)], ['query']),
    'get_nft_canister' : IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    'get_pixel_credits' : IDL.Func([IDL.Principal], [IDL.Nat64], ['query']),
    'get_top_streaks' : IDL.Func(
        [IDL.Nat64],
        [IDL.Vec(StreakEntry)],
        ['query'],
      ),
    'get_treasury_balance' : IDL.Func([], [IDL.Nat64], ['query']),
    'get_version' : IDL.Func([], [VersionInfo], ['query']),
    'get_wallet_pending_e8s' : IDL.Func([], [IDL.Nat64], ['query']),
    'http_request' : IDL.Func(
        [HttpGatewayRequest],
        [HttpGatewayResponse],
        ['query'],
      ),
    'join_alliance' : IDL.Func([IDL.Nat64], [AllianceUnitResult], []),
    'leaderboard' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [LeaderboardPage],
        ['query'],
      ),
    'leave_alliance' : IDL.Func([], [AllianceUnitResult], []),
    'list_alliances' : IDL.Func([], [IDL.Vec(AlliancePublic)], ['query']),
    'my_claimable_treasury' : IDL.Func([], [IDL.Nat64], ['query']),
    'my_mission_contribution' : IDL.Func(
        [IDL.Nat64, IDL.Nat32],
        [MissionContributionResult],
        ['query'],
      ),
    'my_pixel_credits' : IDL.Func([], [IDL.Nat64], ['query']),
    'my_stats' : IDL.Func([], [UserStats], ['query']),
    'place_pixel' : IDL.Func(
        [IDL.Int16, IDL.Int16, IDL.Nat32],
        [PlaceResult],
        [],
      ),
    'refresh_icp_price' : IDL.Func([], [RefreshIcpPriceResult], []),
    'set_alliance_billing' : IDL.Func([Billing], [SetBillingResult], []),
    'set_alliance_price' : IDL.Func([IDL.Nat64], [SetBillingResult], []),
    'set_nft_canister' : IDL.Func([IDL.Principal], [SetNftCanisterResult], []),
    'upgrade_mission' : IDL.Func(
        [IDL.Nat64, Mission],
        [AllianceUnitResult],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
