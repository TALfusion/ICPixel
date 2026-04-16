export const idlFactory = ({ IDL }) => {
  const Result = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : IDL.Text });
  const Mission = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'height' : IDL.Nat16,
    'template' : IDL.Vec(IDL.Nat32),
    'width' : IDL.Nat16,
  });
  const MissionRound = IDL.Record({
    'claimed_amounts' : IDL.Opt(IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat64))),
    'total_claimed_e8s' : IDL.Opt(IDL.Nat64),
    'accumulated_pool_e8s' : IDL.Opt(IDL.Nat64),
    'reward_pool_e8s' : IDL.Nat64,
    'credited_cells' : IDL.Vec(IDL.Nat8),
    'contributions' : IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat32)),
    'nft_token_id' : IDL.Opt(IDL.Nat64),
    'mission' : Mission,
    'cell_creditors' : IDL.Opt(IDL.Vec(IDL.Tuple(IDL.Nat32, IDL.Principal))),
    'claimed_principals' : IDL.Vec(IDL.Principal),
    'round_index' : IDL.Nat32,
    'completed_at' : IDL.Opt(IDL.Nat64),
    'started_at' : IDL.Nat64,
    'helper_contributions' : IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat32)),
  });
  const Alliance = IDL.Record({
    'id' : IDL.Nat64,
    'members' : IDL.Vec(IDL.Principal),
    'nft_token_id' : IDL.Opt(IDL.Nat64),
    'mission' : Mission,
    'name' : IDL.Text,
    'description' : IDL.Text,
    'created_at' : IDL.Nat64,
    'website' : IDL.Opt(IDL.Text),
    'pixels_captured' : IDL.Nat64,
    'prev_nft_token_id' : IDL.Opt(IDL.Nat64),
    'leader' : IDL.Principal,
    'nft_mint_in_progress' : IDL.Bool,
  });
  const PixelChange = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'color' : IDL.Nat32,
  });
  const ExportCounts = IDL.Record({
    'mission_tile_index' : IDL.Nat64,
    'pixel_credits' : IDL.Nat64,
    'user_stats' : IDL.Nat64,
    'user_alliance' : IDL.Nat64,
    'pending_orders' : IDL.Nat64,
    'pixels' : IDL.Nat64,
    'last_placed' : IDL.Nat64,
    'pixel_colors_bytes' : IDL.Nat64,
    'alliances' : IDL.Nat64,
    'alliance_rounds' : IDL.Nat64,
    'changes' : IDL.Nat64,
    'claimable_treasury' : IDL.Nat64,
  });
  const MissionTileKey = IDL.Record({ 'tx' : IDL.Int16, 'ty' : IDL.Int16 });
  const OrderStatus = IDL.Variant({
    'Rescued' : IDL.Record({
      'to' : IDL.Principal,
      'block_index' : IDL.Nat64,
      'amount_e8s' : IDL.Nat64,
    }),
    'Paid' : IDL.Record({
      'settled_e8s' : IDL.Nat64,
      'block_index' : IDL.Nat64,
      'pixels_credited' : IDL.Nat64,
    }),
    'Expired' : IDL.Null,
    'Pending' : IDL.Null,
  });
  const PendingOrder = IDL.Record({
    'status' : OrderStatus,
    'principal' : IDL.Principal,
    'pack_id' : IDL.Nat8,
    'created_at_ns' : IDL.Nat64,
    'order_id' : IDL.Vec(IDL.Nat8),
    'expected_e8s' : IDL.Nat64,
    'expires_at_ns' : IDL.Nat64,
  });
  const PixelKey = IDL.Record({ 'x' : IDL.Int16, 'y' : IDL.Int16 });
  const Pixel = IDL.Record({
    'owner' : IDL.Opt(IDL.Principal),
    'color' : IDL.Nat32,
    'timestamp' : IDL.Nat64,
  });
  const IcpUsdCache = IDL.Record({
    'last_fetched_ns' : IDL.Nat64,
    'usd_per_icp_micro' : IDL.Nat64,
  });
  const Billing = IDL.Record({
    'reward_pool_pct' : IDL.Opt(IDL.Nat8),
    'treasury_pct' : IDL.Nat8,
    'pixel_price_e8s' : IDL.Opt(IDL.Nat64),
    'pixel_price_usd_cents' : IDL.Nat16,
    'pixel_cooldown_seconds' : IDL.Nat32,
    'wallet_principal' : IDL.Principal,
    'wallet_pct' : IDL.Nat8,
    'alliance_price_e8s' : IDL.Nat64,
    'ledger' : IDL.Opt(IDL.Principal),
    'treasury_principal' : IDL.Principal,
  });
  const GameState = IDL.Record({
    'final_stage_reached_at' : IDL.Opt(IDL.Nat64),
    'treasury_operational_buffer_e8s' : IDL.Opt(IDL.Nat64),
    'total_pixels_placed' : IDL.Nat64,
    'season' : IDL.Nat32,
    'treasury_last_distributed_season' : IDL.Opt(IDL.Nat32),
    'last_completed_mission_name' : IDL.Opt(IDL.Text),
    'unique_pixels_set' : IDL.Nat64,
    'reward_pool_balance_e8s' : IDL.Opt(IDL.Nat64),
    'treasury_balance_e8s' : IDL.Opt(IDL.Nat64),
    'map_size' : IDL.Nat16,
    'paused' : IDL.Bool,
    'last_completed_mission_at' : IDL.Opt(IDL.Nat64),
  });
  const ExportSingletons = IDL.Record({
    'next_alliance_id' : IDL.Nat64,
    'icp_usd_cache' : IcpUsdCache,
    'billing' : Billing,
    'next_version' : IDL.Nat64,
    'game_state' : GameState,
    'nft_canister' : IDL.Opt(IDL.Principal),
    'wallet_pending_e8s' : IDL.Nat64,
  });
  const UserStats = IDL.Record({
    'max_streak' : IDL.Nat32,
    'current_streak' : IDL.Nat32,
    'total_pixels' : IDL.Nat64,
    'last_day' : IDL.Nat32,
  });
  const Result_1 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : IDL.Text });
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
  const Result_2 = IDL.Variant({ 'Ok' : MissionStatus, 'Err' : AllianceError });
  const OrderView = IDL.Record({
    'status' : OrderStatus,
    'pack_id' : IDL.Nat8,
    'created_at_ns' : IDL.Nat64,
    'current_balance_e8s' : IDL.Nat64,
    'buyer' : IDL.Principal,
    'expected_e8s' : IDL.Nat64,
    'expires_at_ns' : IDL.Nat64,
    'order_id_hex' : IDL.Text,
  });
  const Result_3 = IDL.Variant({ 'Ok' : OrderView, 'Err' : IDL.Text });
  const ClaimResult = IDL.Record({
    'transferred' : IDL.Bool,
    'share_e8s' : IDL.Nat64,
  });
  const Result_4 = IDL.Variant({ 'Ok' : ClaimResult, 'Err' : AllianceError });
  const Result_5 = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : AllianceError });
  const OrderCreated = IDL.Record({
    'subaccount_hex' : IDL.Text,
    'pack_id' : IDL.Nat8,
    'account_identifier_hex' : IDL.Text,
    'pack_pixels' : IDL.Nat64,
    'tolerance_below_e8s' : IDL.Nat64,
    'owner_principal' : IDL.Principal,
    'expected_e8s' : IDL.Nat64,
    'expires_at_ns' : IDL.Nat64,
    'order_id_hex' : IDL.Text,
  });
  const Result_6 = IDL.Variant({ 'Ok' : OrderCreated, 'Err' : IDL.Text });
  const DistributeReport = IDL.Record({
    'tokens_considered' : IDL.Nat32,
    'season' : IDL.Nat32,
    'owner_paid_e8s' : IDL.Nat64,
    'holders_pool_e8s' : IDL.Nat64,
    'holders_credited' : IDL.Nat32,
    'total_distributable_e8s' : IDL.Nat64,
  });
  const Result_7 = IDL.Variant({ 'Ok' : DistributeReport, 'Err' : IDL.Text });
  const AdminStats = IDL.Record({
    'total_users' : IDL.Nat64,
    'pixel_cooldown_seconds' : IDL.Nat32,
    'total_pixels_placed' : IDL.Nat64,
    'low_cycles_warning' : IDL.Bool,
    'season' : IDL.Nat32,
    'cycles' : IDL.Nat64,
    'unique_pixels_set' : IDL.Nat64,
    'wallet_pending_e8s' : IDL.Nat64,
    'stable_pages' : IDL.Nat64,
    'total_nfts_minted' : IDL.Nat64,
    'treasury_balance_e8s' : IDL.Nat64,
    'total_alliances' : IDL.Nat64,
    'map_size' : IDL.Nat16,
    'paused' : IDL.Bool,
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
  const ChangesResponse = IDL.Record({
    'min_version' : IDL.Nat64,
    'next_version' : IDL.Nat64,
    'current_version' : IDL.Nat64,
    'changes' : IDL.Vec(PixelChange),
    'map_size' : IDL.Nat16,
  });
  const CanisterHealth = IDL.Record({
    'low_cycles_warning' : IDL.Bool,
    'cycles' : IDL.Nat64,
    'stable_pages' : IDL.Nat64,
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
  const PixelPack = IDL.Record({
    'id' : IDL.Nat8,
    'pixels' : IDL.Nat64,
    'price_e8s' : IDL.Nat64,
  });
  const VersionInfo = IDL.Record({
    'version' : IDL.Nat64,
    'map_size' : IDL.Nat16,
  });
  const HttpRequest = IDL.Record({
    'url' : IDL.Text,
    'method' : IDL.Text,
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  });
  const HttpResponse = IDL.Record({
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    'status_code' : IDL.Nat16,
  });
  const Result_8 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : AllianceError });
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
  const Result_9 = IDL.Variant({
    'Ok' : MissionContributionView,
    'Err' : AllianceError,
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
  const Result_10 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : PlaceError });
  return IDL.Service({
    'admin_credit_reward_pool' : IDL.Func([IDL.Nat64], [Result], []),
    'admin_credit_treasury' : IDL.Func([IDL.Nat64], [Result], []),
    'admin_export_alliance_rounds' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Nat64, IDL.Vec(MissionRound)))],
        ['query'],
      ),
    'admin_export_alliances' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Nat64, Alliance))],
        ['query'],
      ),
    'admin_export_changes' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Nat64, PixelChange))],
        ['query'],
      ),
    'admin_export_claimable_treasury' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat64))],
        ['query'],
      ),
    'admin_export_counts' : IDL.Func([], [ExportCounts], ['query']),
    'admin_export_last_placed' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat64))],
        ['query'],
      ),
    'admin_export_mission_tile_index' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(MissionTileKey, IDL.Vec(IDL.Nat64)))],
        ['query'],
      ),
    'admin_export_pending_orders' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Vec(IDL.Nat8), PendingOrder))],
        ['query'],
      ),
    'admin_export_pixel_colors' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Nat8)],
        ['query'],
      ),
    'admin_export_pixel_credits' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat64))],
        ['query'],
      ),
    'admin_export_pixels' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(PixelKey, Pixel))],
        ['query'],
      ),
    'admin_export_singletons' : IDL.Func([], [ExportSingletons], ['query']),
    'admin_export_user_alliance' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Nat64))],
        ['query'],
      ),
    'admin_export_user_stats' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [IDL.Vec(IDL.Tuple(IDL.Principal, UserStats))],
        ['query'],
      ),
    'admin_grant_credits' : IDL.Func(
        [IDL.Principal, IDL.Nat64],
        [Result_1],
        [],
      ),
    'admin_payout_wallet' : IDL.Func([], [Result], []),
    'admin_rescue_order' : IDL.Func([IDL.Text, IDL.Principal], [Result], []),
    'admin_reset_treasury_distribution' : IDL.Func([], [Result_1], []),
    'admin_set_map_size' : IDL.Func([IDL.Nat16], [Result_1], []),
    'admin_set_paused' : IDL.Func([IDL.Bool], [Result_1], []),
    'admin_set_snapshot_reader' : IDL.Func(
        [IDL.Opt(IDL.Principal)],
        [Result_1],
        [],
      ),
    'admin_set_treasury_buffer' : IDL.Func([IDL.Nat64], [Result_1], []),
    'am_i_controller' : IDL.Func([], [IDL.Bool], ['query']),
    'check_mission' : IDL.Func([IDL.Nat64], [Result_2], ['query']),
    'check_order' : IDL.Func([IDL.Text], [Result_3], []),
    'chunk_size' : IDL.Func([], [IDL.Nat16], ['query']),
    'claim_mission_reward' : IDL.Func([IDL.Nat64, IDL.Nat32], [Result_4], []),
    'claim_treasury' : IDL.Func([], [Result], []),
    'create_alliance' : IDL.Func(
        [IDL.Text, IDL.Text, Mission, IDL.Text],
        [Result_5],
        [],
      ),
    'create_order' : IDL.Func([IDL.Nat8], [Result_6], []),
    'debug_fill' : IDL.Func([IDL.Nat8], [IDL.Nat64], []),
    'distribute_treasury' : IDL.Func([], [Result_7], []),
    'get_admin_stats' : IDL.Func([], [AdminStats], ['query']),
    'get_alliance' : IDL.Func(
        [IDL.Nat64],
        [IDL.Opt(AllianceOrPublic)],
        ['query'],
      ),
    'get_alliance_billing' : IDL.Func([], [Billing], ['query']),
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
    'get_health' : IDL.Func([], [CanisterHealth], ['query']),
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
    'get_packs' : IDL.Func([], [IDL.Vec(PixelPack)], ['query']),
    'get_pixel_credits' : IDL.Func([IDL.Principal], [IDL.Nat64], ['query']),
    'get_snapshot_reader' : IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    'get_treasury_balance' : IDL.Func([], [IDL.Nat64], ['query']),
    'get_version' : IDL.Func([], [VersionInfo], ['query']),
    'get_wallet_pending_e8s' : IDL.Func([], [IDL.Nat64], ['query']),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'join_alliance' : IDL.Func([IDL.Nat64], [Result_8], []),
    'leaderboard' : IDL.Func(
        [IDL.Nat64, IDL.Nat64],
        [LeaderboardPage],
        ['query'],
      ),
    'leave_alliance' : IDL.Func([], [Result_8], []),
    'list_alliances' : IDL.Func([], [IDL.Vec(AlliancePublic)], ['query']),
    'my_claimable_treasury' : IDL.Func([], [IDL.Nat64], ['query']),
    'my_mission_contribution' : IDL.Func(
        [IDL.Nat64, IDL.Nat32],
        [Result_9],
        ['query'],
      ),
    'my_orders' : IDL.Func([], [IDL.Vec(OrderView)], ['query']),
    'my_pixel_credits' : IDL.Func([], [IDL.Nat64], ['query']),
    'place_pixel' : IDL.Func(
        [IDL.Int16, IDL.Int16, IDL.Nat32],
        [Result_10],
        [],
      ),
    'set_alliance_billing' : IDL.Func([Billing], [Result_1], []),
    'set_alliance_price' : IDL.Func([IDL.Nat64], [Result_1], []),
    'set_nft_canister' : IDL.Func([IDL.Principal], [Result_1], []),
    'upgrade_mission' : IDL.Func([IDL.Nat64, Mission], [Result_8], []),
  });
};
export const init = ({ IDL }) => { return []; };
