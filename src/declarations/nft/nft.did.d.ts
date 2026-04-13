import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface Account {
  'owner' : Principal,
  'subaccount' : [] | [Subaccount],
}
export type BurnError = { 'NotFound' : null } |
  { 'NotOwner' : null } |
  { 'AlreadyBurned' : null };
export type BurnResult = { 'Ok' : null } |
  { 'Err' : BurnError };
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
export interface MintArgs { 'to' : Account, 'metadata' : TokenMetadata }
export type MintError = { 'Unauthorized' : null } |
  { 'InternalError' : string } |
  { 'InvalidMetadata' : string };
export type MintResult = { 'Ok' : bigint } |
  { 'Err' : MintError };
export type SetBackendResult = { 'Ok' : null } |
  { 'Err' : string };
export type Subaccount = Uint8Array | number[];
export interface TokenInfo {
  'token_id' : bigint,
  'owner' : Account,
  'pixel_count' : bigint,
  'minted_at' : bigint,
}
export interface TokenMetadata {
  'x' : number,
  'y' : number,
  'height' : number,
  'name' : string,
  'alliance_name' : string,
  'description' : string,
  'season' : number,
  'alliance_id' : bigint,
  'global_nft_number' : bigint,
  'pixel_count' : bigint,
  'template' : Uint32Array | number[],
  'match_percent' : number,
  'width' : number,
  'completed_at' : bigint,
}
export interface TransferArg {
  'to' : Account,
  'token_id' : bigint,
  'memo' : [] | [Uint8Array | number[]],
  'from_subaccount' : [] | [Subaccount],
  'created_at_time' : [] | [bigint],
}
export type TransferError = {
    'GenericError' : { 'message' : string, 'error_code' : bigint }
  } |
  { 'Duplicate' : { 'duplicate_of' : bigint } } |
  { 'NonExistingTokenId' : null } |
  { 'Unauthorized' : null } |
  { 'CreatedInFuture' : { 'ledger_time' : bigint } } |
  { 'InvalidRecipient' : null } |
  { 'TooOld' : null };
export type TransferResult = { 'Ok' : bigint } |
  { 'Err' : TransferError };
export type Value = { 'Int' : bigint } |
  { 'Nat' : bigint } |
  { 'Blob' : Uint8Array | number[] } |
  { 'Text' : string };
export interface _SERVICE {
  'burn' : ActorMethod<[bigint], BurnResult>,
  'get_backend_canister' : ActorMethod<[], [] | [Principal]>,
  /**
   * ─── HTTP gateway ───
   */
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'icrc7_atomic_batch_transfers' : ActorMethod<[], [] | [boolean]>,
  'icrc7_balance_of' : ActorMethod<[Array<Account>], Array<bigint>>,
  'icrc7_collection_metadata' : ActorMethod<[], Array<[string, Value]>>,
  'icrc7_default_take_value' : ActorMethod<[], [] | [bigint]>,
  'icrc7_description' : ActorMethod<[], [] | [string]>,
  'icrc7_logo' : ActorMethod<[], [] | [string]>,
  'icrc7_max_memo_size' : ActorMethod<[], [] | [bigint]>,
  'icrc7_max_query_batch_size' : ActorMethod<[], [] | [bigint]>,
  'icrc7_max_take_value' : ActorMethod<[], [] | [bigint]>,
  'icrc7_max_update_batch_size' : ActorMethod<[], [] | [bigint]>,
  /**
   * ─── ICRC-7 ───
   */
  'icrc7_name' : ActorMethod<[], string>,
  'icrc7_owner_of' : ActorMethod<
    [BigUint64Array | bigint[]],
    Array<[] | [Account]>
  >,
  'icrc7_supply_cap' : ActorMethod<[], [] | [bigint]>,
  'icrc7_symbol' : ActorMethod<[], string>,
  'icrc7_token_metadata' : ActorMethod<
    [BigUint64Array | bigint[]],
    Array<[] | [Array<[string, Value]>]>
  >,
  'icrc7_tokens' : ActorMethod<
    [[] | [bigint], [] | [bigint]],
    BigUint64Array | bigint[]
  >,
  'icrc7_tokens_of' : ActorMethod<
    [Account, [] | [bigint], [] | [bigint]],
    BigUint64Array | bigint[]
  >,
  'icrc7_total_supply' : ActorMethod<[], bigint>,
  'icrc7_transfer' : ActorMethod<
    [Array<TransferArg>],
    Array<[] | [TransferResult]>
  >,
  /**
   * ─── Treasury distribution support (called by backend) ───
   */
  'list_season_tokens' : ActorMethod<
    [number, [] | [bigint], [] | [bigint]],
    Array<TokenInfo>
  >,
  /**
   * ─── Custom mint / burn ───
   */
  'mint' : ActorMethod<[MintArgs], MintResult>,
  /**
   * ─── Admin (controllers only) ───
   */
  'set_backend_canister' : ActorMethod<[Principal], SetBackendResult>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
