export const idlFactory = ({ IDL }) => {
  const BurnError = IDL.Variant({
    'NotFound' : IDL.Null,
    'NotOwner' : IDL.Null,
    'AlreadyBurned' : IDL.Null,
  });
  const BurnResult = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : BurnError });
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
  const Subaccount = IDL.Vec(IDL.Nat8);
  const Account = IDL.Record({
    'owner' : IDL.Principal,
    'subaccount' : IDL.Opt(Subaccount),
  });
  const Value = IDL.Variant({
    'Int' : IDL.Int,
    'Nat' : IDL.Nat,
    'Blob' : IDL.Vec(IDL.Nat8),
    'Text' : IDL.Text,
  });
  const TransferArg = IDL.Record({
    'to' : Account,
    'token_id' : IDL.Nat64,
    'memo' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'from_subaccount' : IDL.Opt(Subaccount),
    'created_at_time' : IDL.Opt(IDL.Nat64),
  });
  const TransferError = IDL.Variant({
    'GenericError' : IDL.Record({
      'message' : IDL.Text,
      'error_code' : IDL.Nat64,
    }),
    'Duplicate' : IDL.Record({ 'duplicate_of' : IDL.Nat64 }),
    'NonExistingTokenId' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'CreatedInFuture' : IDL.Record({ 'ledger_time' : IDL.Nat64 }),
    'InvalidRecipient' : IDL.Null,
    'TooOld' : IDL.Null,
  });
  const TransferResult = IDL.Variant({
    'Ok' : IDL.Nat64,
    'Err' : TransferError,
  });
  const TokenInfo = IDL.Record({
    'token_id' : IDL.Nat64,
    'owner' : Account,
    'pixel_count' : IDL.Nat64,
    'minted_at' : IDL.Nat64,
  });
  const TokenMetadata = IDL.Record({
    'x' : IDL.Int16,
    'y' : IDL.Int16,
    'height' : IDL.Nat16,
    'name' : IDL.Text,
    'alliance_name' : IDL.Text,
    'description' : IDL.Text,
    'season' : IDL.Nat32,
    'alliance_id' : IDL.Nat64,
    'global_nft_number' : IDL.Nat64,
    'pixel_count' : IDL.Nat64,
    'template' : IDL.Vec(IDL.Nat32),
    'match_percent' : IDL.Nat8,
    'width' : IDL.Nat16,
    'completed_at' : IDL.Nat64,
  });
  const MintArgs = IDL.Record({ 'to' : Account, 'metadata' : TokenMetadata });
  const MintError = IDL.Variant({
    'Unauthorized' : IDL.Null,
    'InternalError' : IDL.Text,
    'InvalidMetadata' : IDL.Text,
  });
  const MintResult = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : MintError });
  const SetBackendResult = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : IDL.Text });
  return IDL.Service({
    'burn' : IDL.Func([IDL.Nat64], [BurnResult], []),
    'get_backend_canister' : IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'icrc7_atomic_batch_transfers' : IDL.Func(
        [],
        [IDL.Opt(IDL.Bool)],
        ['query'],
      ),
    'icrc7_balance_of' : IDL.Func(
        [IDL.Vec(Account)],
        [IDL.Vec(IDL.Nat)],
        ['query'],
      ),
    'icrc7_collection_metadata' : IDL.Func(
        [],
        [IDL.Vec(IDL.Tuple(IDL.Text, Value))],
        ['query'],
      ),
    'icrc7_default_take_value' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_description' : IDL.Func([], [IDL.Opt(IDL.Text)], ['query']),
    'icrc7_logo' : IDL.Func([], [IDL.Opt(IDL.Text)], ['query']),
    'icrc7_max_memo_size' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_max_query_batch_size' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_max_take_value' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_max_update_batch_size' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_name' : IDL.Func([], [IDL.Text], ['query']),
    'icrc7_owner_of' : IDL.Func(
        [IDL.Vec(IDL.Nat64)],
        [IDL.Vec(IDL.Opt(Account))],
        ['query'],
      ),
    'icrc7_supply_cap' : IDL.Func([], [IDL.Opt(IDL.Nat)], ['query']),
    'icrc7_symbol' : IDL.Func([], [IDL.Text], ['query']),
    'icrc7_token_metadata' : IDL.Func(
        [IDL.Vec(IDL.Nat64)],
        [IDL.Vec(IDL.Opt(IDL.Vec(IDL.Tuple(IDL.Text, Value))))],
        ['query'],
      ),
    'icrc7_tokens' : IDL.Func(
        [IDL.Opt(IDL.Nat64), IDL.Opt(IDL.Nat)],
        [IDL.Vec(IDL.Nat64)],
        ['query'],
      ),
    'icrc7_tokens_of' : IDL.Func(
        [Account, IDL.Opt(IDL.Nat64), IDL.Opt(IDL.Nat)],
        [IDL.Vec(IDL.Nat64)],
        ['query'],
      ),
    'icrc7_total_supply' : IDL.Func([], [IDL.Nat], ['query']),
    'icrc7_transfer' : IDL.Func(
        [IDL.Vec(TransferArg)],
        [IDL.Vec(IDL.Opt(TransferResult))],
        [],
      ),
    'list_season_tokens' : IDL.Func(
        [IDL.Nat32, IDL.Opt(IDL.Nat64), IDL.Opt(IDL.Nat)],
        [IDL.Vec(TokenInfo)],
        ['query'],
      ),
    'mint' : IDL.Func([MintArgs], [MintResult], []),
    'set_backend_canister' : IDL.Func([IDL.Principal], [SetBackendResult], []),
  });
};
export const init = ({ IDL }) => { return []; };
