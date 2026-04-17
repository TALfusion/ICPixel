//! ICRC-7 standard endpoint implementations.
//!
//! Scope is the marketplace-listing subset: read methods + transfer. Approval
//! flows (ICRC-37) are intentionally omitted — see plan.

use crate::state::TOKENS;
use crate::types::{
    Account, TokenId, TokenInfo, TokenMetadata, TransferArg, TransferError, TransferResult, Value,
};

pub const COLLECTION_NAME: &str = "ICPixel Missions";
pub const COLLECTION_SYMBOL: &str = "ICPM";
pub const COLLECTION_DESCRIPTION: &str =
    "On-chain NFTs awarded to alliance leaders for completed pixel-art missions in ICPixel.";

pub fn name() -> String {
    COLLECTION_NAME.into()
}
pub fn symbol() -> String {
    COLLECTION_SYMBOL.into()
}
pub fn description() -> Option<String> {
    Some(COLLECTION_DESCRIPTION.into())
}
pub fn logo() -> Option<String> {
    None
}

pub fn total_supply() -> candid::Nat {
    TOKENS.with(|t| {
        let count = t.borrow().iter().filter(|(_, tok)| tok.owner.is_some()).count();
        candid::Nat::from(count as u64)
    })
}

pub fn supply_cap() -> Option<candid::Nat> {
    None
}

pub fn max_query_batch_size() -> Option<candid::Nat> {
    Some(candid::Nat::from(100u64))
}
pub fn max_update_batch_size() -> Option<candid::Nat> {
    Some(candid::Nat::from(100u64))
}
pub fn default_take_value() -> Option<candid::Nat> {
    Some(candid::Nat::from(100u64))
}
pub fn max_take_value() -> Option<candid::Nat> {
    Some(candid::Nat::from(1000u64))
}
pub fn max_memo_size() -> Option<candid::Nat> {
    Some(candid::Nat::from(32u64))
}
pub fn atomic_batch_transfers() -> Option<bool> {
    Some(false)
}

pub fn collection_metadata() -> Vec<(String, Value)> {
    vec![
        ("icrc7:name".into(), Value::Text(COLLECTION_NAME.into())),
        ("icrc7:symbol".into(), Value::Text(COLLECTION_SYMBOL.into())),
        (
            "icrc7:description".into(),
            Value::Text(COLLECTION_DESCRIPTION.into()),
        ),
        ("icrc7:total_supply".into(), Value::Nat(total_supply())),
    ]
}

pub fn owner_of(ids: Vec<TokenId>) -> Vec<Option<Account>> {
    let ids = &ids[..ids.len().min(100)];
    TOKENS.with(|t| {
        let map = t.borrow();
        ids.iter()
            .map(|id| map.get(id).and_then(|tok| tok.owner))
            .collect()
    })
}

pub fn balance_of(accounts: Vec<Account>) -> Vec<candid::Nat> {
    let accounts = &accounts[..accounts.len().min(100)];
    TOKENS.with(|t| {
        let map = t.borrow();
        accounts
            .iter()
            .map(|acc| {
                let n = map
                    .iter()
                    .filter(|(_, tok)| tok.owner.as_ref() == Some(acc))
                    .count();
                candid::Nat::from(n as u64)
            })
            .collect()
    })
}

pub fn tokens(prev: Option<TokenId>, take: Option<candid::Nat>) -> Vec<TokenId> {
    let take_n = take
        .and_then(|n| n.0.try_into().ok())
        .unwrap_or(100usize)
        .min(1000);
    TOKENS.with(|t| {
        let map = t.borrow();
        let start_after = prev.unwrap_or(0);
        map.iter()
            .filter(|(_, tok)| tok.owner.is_some())
            .map(|(id, _)| id)
            .filter(|id| *id > start_after)
            .take(take_n)
            .collect()
    })
}

pub fn tokens_of(
    account: Account,
    prev: Option<TokenId>,
    take: Option<candid::Nat>,
) -> Vec<TokenId> {
    let take_n = take
        .and_then(|n| n.0.try_into().ok())
        .unwrap_or(100usize)
        .min(1000);
    TOKENS.with(|t| {
        let map = t.borrow();
        let start_after = prev.unwrap_or(0);
        map.iter()
            .filter(|(_, tok)| tok.owner.as_ref() == Some(&account))
            .map(|(id, _)| id)
            .filter(|id| *id > start_after)
            .take(take_n)
            .collect()
    })
}

/// Returns the metadata fields as ICRC-7 record entries. Burned tokens still
/// return their metadata (history is preserved).
pub fn token_metadata(ids: Vec<TokenId>) -> Vec<Option<Vec<(String, Value)>>> {
    let ids = &ids[..ids.len().min(100)];
    TOKENS.with(|t| {
        let map = t.borrow();
        ids.iter()
            .map(|id| map.get(id).map(|tok| metadata_to_pairs(&tok.metadata)))
            .collect()
    })
}

fn metadata_to_pairs(m: &TokenMetadata) -> Vec<(String, Value)> {
    vec![
        ("icrc7:name".into(), Value::Text(m.name.clone())),
        ("icrc7:description".into(), Value::Text(m.description.clone())),
        // Custom namespaced fields. Marketplaces ignore unknown keys.
        (
            "icpixel:alliance_id".into(),
            Value::Nat(candid::Nat::from(m.alliance_id)),
        ),
        (
            "icpixel:alliance_name".into(),
            Value::Text(m.alliance_name.clone()),
        ),
        (
            "icpixel:season".into(),
            Value::Nat(candid::Nat::from(m.season)),
        ),
        (
            "icpixel:nft_number".into(),
            Value::Nat(candid::Nat::from(m.global_nft_number)),
        ),
        (
            "icpixel:pixel_count".into(),
            Value::Nat(candid::Nat::from(m.pixel_count)),
        ),
        (
            "icpixel:width".into(),
            Value::Nat(candid::Nat::from(m.width as u64)),
        ),
        (
            "icpixel:height".into(),
            Value::Nat(candid::Nat::from(m.height as u64)),
        ),
        // `icpixel:x`, `icpixel:y` and `icpixel:match_percent` were
        // previously emitted here. Removed from the public metadata
        // surface — the fields stay in the stored struct for backward
        // compat with already-minted tokens, but marketplaces and the
        // in-app gallery no longer see them.
        (
            "icpixel:completed_at".into(),
            Value::Nat(candid::Nat::from(m.completed_at)),
        ),
    ]
}

/// Paginated walk of all live tokens minted in `season`. Used by the
/// backend's end-of-season treasury distribution. Pagination is by
/// `token_id > prev`, same convention as `icrc7_tokens`. Burned tokens
/// (`owner = None`) and tokens from other seasons are filtered out.
pub fn list_season_tokens(
    season: u32,
    prev: Option<TokenId>,
    take: Option<candid::Nat>,
) -> Vec<TokenInfo> {
    let take_n = take
        .and_then(|n| n.0.try_into().ok())
        .unwrap_or(100usize)
        .min(1000);
    TOKENS.with(|t| {
        let map = t.borrow();
        let start_after = prev.unwrap_or(0);
        map.iter()
            .filter(|(id, _)| *id > start_after)
            .filter_map(|(id, tok)| {
                let owner = tok.owner.clone()?;
                if tok.metadata.season != season {
                    return None;
                }
                Some(TokenInfo {
                    token_id: id,
                    owner,
                    pixel_count: tok.metadata.pixel_count,
                    minted_at: tok.minted_at,
                })
            })
            .take(take_n)
            .collect()
    })
}

/// ICRC-7 transfer with ICRC-3 transaction logging.
pub fn transfer(caller: candid::Principal, args: Vec<TransferArg>) -> Vec<Option<TransferResult>> {
    args.into_iter()
        .map(|arg| Some(transfer_one(caller, arg)))
        .collect()
}

fn transfer_one(caller: candid::Principal, arg: TransferArg) -> TransferResult {
    if let Some(ref memo) = arg.memo {
        if memo.len() > 32 {
            return TransferResult::Err(TransferError::GenericError {
                error_code: 1,
                message: "memo exceeds max_memo_size of 32 bytes".into(),
            });
        }
    }
    let result = TOKENS.with(|t| {
        let mut map = t.borrow_mut();
        let mut tok = match map.get(&arg.token_id) {
            Some(tok) => tok,
            None => return Err(TransferError::NonExistingTokenId),
        };
        let owner = match &tok.owner {
            Some(o) => o.clone(),
            None => return Err(TransferError::Unauthorized),
        };
        if owner.owner != caller {
            return Err(TransferError::Unauthorized);
        }
        let caller_sub = arg.from_subaccount.unwrap_or([0u8; 32]);
        let owner_sub = owner.subaccount.unwrap_or([0u8; 32]);
        if caller_sub != owner_sub {
            return Err(TransferError::Unauthorized);
        }
        tok.owner = Some(arg.to.clone());
        map.insert(arg.token_id, tok);
        Ok((owner, arg.to.clone()))
    });
    match result {
        Ok((from, to)) => {
            let idx = crate::state::log_tx(crate::types::TxRecord {
                kind: crate::types::TxKind::Transfer,
                timestamp: ic_cdk::api::time(),
                token_id: arg.token_id,
                from: Some(from),
                to: Some(to),
                memo: arg.memo.map(|m| serde_bytes::ByteBuf::from(m.to_vec())),
            });
            TransferResult::Ok(idx)
        }
        Err(e) => TransferResult::Err(e),
    }
}
