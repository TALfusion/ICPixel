//! Thin inter-canister client for the `nft` canister.
//!
//! Mirrors the Candid types of the nft canister. Kept locally (rather than
//! sharing a crate) so the two canisters stay independently deployable —
//! the only contract between them is wire format, not Rust types.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Account {
    pub owner: Principal,
    pub subaccount: Option<[u8; 32]>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadata {
    pub name: String,
    pub description: String,
    pub alliance_id: u64,
    pub alliance_name: String,
    pub season: u32,
    pub global_nft_number: u64,
    pub pixel_count: u64,
    pub width: u16,
    pub height: u16,
    pub x: i16,
    pub y: i16,
    pub template: Vec<u32>,
    pub completed_at: u64,
    pub match_percent: u8,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MintArgs {
    pub to: Account,
    pub metadata: TokenMetadata,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum MintError {
    Unauthorized,
    InvalidMetadata(String),
}

pub type MintResult = Result<u64, MintError>;

/// Calls `nft.mint(args)`. Returns the new token id on success.
pub async fn mint(nft_canister: Principal, args: MintArgs) -> Result<u64, String> {
    let res: Result<(MintResult,), _> = ic_cdk::api::call::call(nft_canister, "mint", (args,)).await;
    match res {
        Ok((Ok(id),)) => Ok(id),
        Ok((Err(e),)) => Err(format!("nft rejected mint: {e:?}")),
        Err((code, msg)) => Err(format!("call to nft failed: {code:?} {msg}")),
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TokenInfo {
    pub token_id: u64,
    pub owner: Account,
    pub pixel_count: u64,
    pub minted_at: u64,
}

/// Calls `nft.list_season_tokens(season, prev, take)`. Pagination is by
/// `token_id > prev`. Caller loops until the returned page is empty.
pub async fn list_season_tokens(
    nft_canister: Principal,
    season: u32,
    prev: Option<u64>,
    take: u64,
) -> Result<Vec<TokenInfo>, String> {
    let res: Result<(Vec<TokenInfo>,), _> = ic_cdk::api::call::call(
        nft_canister,
        "list_season_tokens",
        (season, prev, Some(candid::Nat::from(take))),
    )
    .await;
    match res {
        Ok((v,)) => Ok(v),
        Err((code, msg)) => Err(format!("call to nft list_season_tokens failed: {code:?} {msg}")),
    }
}

/// Calls `nft.icrc7_owner_of(vec { id })`. Returns Some(owner) if the token
/// still has an owner, None if it's burned (or never existed).
pub async fn owner_of(nft_canister: Principal, token_id: u64) -> Result<Option<Account>, String> {
    let res: Result<(Vec<Option<Account>>,), _> =
        ic_cdk::api::call::call(nft_canister, "icrc7_owner_of", (vec![token_id],)).await;
    match res {
        Ok((mut v,)) if !v.is_empty() => Ok(v.remove(0)),
        Ok(_) => Ok(None),
        Err((code, msg)) => Err(format!("call to nft failed: {code:?} {msg}")),
    }
}
