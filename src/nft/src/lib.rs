//! ICPixel Missions — ICRC-7 NFT canister.
//!
//! Mints one token per completed alliance mission, on demand from the backend
//! canister via inter-canister call. Tokens are immutable post-mint and burn
//! preserves metadata for historical queries.

mod icrc7;
mod png_render;
mod state;
mod types;

use crate::state::{backend_principal, next_token_id, set_backend_principal, TOKENS};
use crate::types::{
    Account, BurnError, HttpRequest, HttpResponse, MintArgs, MintError, Token, TokenId, TokenInfo,
    TransferArg, TransferResult, Value,
};
use candid::Principal;
use ic_cdk::{query, update};

// ───── Authorization ─────

/// Only the configured backend canister may mint. Until `set_backend_canister`
/// is called, mint is closed.
fn require_backend(caller: Principal) -> Result<(), MintError> {
    match backend_principal() {
        Some(p) if p == caller => Ok(()),
        _ => Err(MintError::Unauthorized),
    }
}

// ───── Admin ─────

#[update]
fn set_backend_canister(p: Principal) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::caller()) {
        return Err("only controllers can set the backend canister".into());
    }
    set_backend_principal(p)
}

#[query]
fn get_backend_canister() -> Option<Principal> {
    backend_principal()
}

// ───── Custom mint / burn ─────

#[update]
fn mint(args: MintArgs) -> Result<TokenId, MintError> {
    require_backend(ic_cdk::caller())?;
    // Light validation: template length must match w*h, dimensions non-zero.
    let MintArgs { to, metadata } = args;
    if metadata.width == 0 || metadata.height == 0 {
        return Err(MintError::InvalidMetadata("zero dimension".into()));
    }
    let expected = (metadata.width as usize) * (metadata.height as usize);
    if metadata.template.len() != expected {
        return Err(MintError::InvalidMetadata(format!(
            "template length {} != width*height {}",
            metadata.template.len(),
            expected
        )));
    }

    let id = next_token_id().map_err(MintError::InternalError)?;
    let mut metadata = metadata;
    // Stamp the canonical token id into the metadata.
    metadata.global_nft_number = id;

    let now = ic_cdk::api::time();
    let token = Token {
        id,
        owner: Some(to.clone()),
        minted_at: now,
        metadata,
    };
    TOKENS.with(|t| t.borrow_mut().insert(id, token));
    state::log_tx(types::TxRecord {
        kind: types::TxKind::Mint,
        timestamp: now,
        token_id: id,
        from: None,
        to: Some(to),
        memo: None,
    });
    Ok(id)
}

#[update]
fn burn(token_id: TokenId) -> Result<(), BurnError> {
    let caller = ic_cdk::caller();
    let prev_owner = TOKENS.with(|t| {
        let mut map = t.borrow_mut();
        let mut tok = map.get(&token_id).ok_or(BurnError::NotFound)?;
        let owner_acc = match &tok.owner {
            None => return Err(BurnError::AlreadyBurned),
            Some(acc) if acc.owner != caller => return Err(BurnError::NotOwner),
            Some(acc) => {
                let owner_sub = acc.subaccount.unwrap_or([0u8; 32]);
                if owner_sub != [0u8; 32] {
                    return Err(BurnError::NotOwner);
                }
                acc.clone()
            }
        };
        tok.owner = None;
        map.insert(token_id, tok);
        Ok(owner_acc)
    })?;
    state::log_tx(types::TxRecord {
        kind: types::TxKind::Burn,
        timestamp: ic_cdk::api::time(),
        token_id,
        from: Some(prev_owner),
        to: None,
        memo: None,
    });
    Ok(())
}

// ───── ICRC-7 surface ─────

#[query]
fn icrc7_name() -> String {
    icrc7::name()
}
#[query]
fn icrc7_symbol() -> String {
    icrc7::symbol()
}
#[query]
fn icrc7_description() -> Option<String> {
    icrc7::description()
}
#[query]
fn icrc7_logo() -> Option<String> {
    icrc7::logo()
}
#[query]
fn icrc7_total_supply() -> candid::Nat {
    icrc7::total_supply()
}
#[query]
fn icrc7_supply_cap() -> Option<candid::Nat> {
    icrc7::supply_cap()
}
#[query]
fn icrc7_max_query_batch_size() -> Option<candid::Nat> {
    icrc7::max_query_batch_size()
}
#[query]
fn icrc7_max_update_batch_size() -> Option<candid::Nat> {
    icrc7::max_update_batch_size()
}
#[query]
fn icrc7_default_take_value() -> Option<candid::Nat> {
    icrc7::default_take_value()
}
#[query]
fn icrc7_max_take_value() -> Option<candid::Nat> {
    icrc7::max_take_value()
}
#[query]
fn icrc7_max_memo_size() -> Option<candid::Nat> {
    icrc7::max_memo_size()
}
#[query]
fn icrc7_atomic_batch_transfers() -> Option<bool> {
    icrc7::atomic_batch_transfers()
}
#[query]
fn icrc7_collection_metadata() -> Vec<(String, Value)> {
    icrc7::collection_metadata()
}
#[query]
fn icrc7_owner_of(ids: Vec<TokenId>) -> Vec<Option<Account>> {
    icrc7::owner_of(ids)
}
#[query]
fn icrc7_balance_of(accounts: Vec<Account>) -> Vec<candid::Nat> {
    icrc7::balance_of(accounts)
}
#[query]
fn icrc7_tokens(prev: Option<TokenId>, take: Option<candid::Nat>) -> Vec<TokenId> {
    icrc7::tokens(prev, take)
}
#[query]
fn icrc7_tokens_of(
    account: Account,
    prev: Option<TokenId>,
    take: Option<candid::Nat>,
) -> Vec<TokenId> {
    icrc7::tokens_of(account, prev, take)
}
#[query]
fn icrc7_token_metadata(ids: Vec<TokenId>) -> Vec<Option<Vec<(String, Value)>>> {
    icrc7::token_metadata(ids)
}
#[update]
fn icrc7_transfer(args: Vec<TransferArg>) -> Vec<Option<TransferResult>> {
    icrc7::transfer(ic_cdk::caller(), args)
}

// ───── ICRC-10: Supported Standards ─────
//
// Wallets like Oisy use this endpoint to auto-detect that our canister
// speaks ICRC-7 (and optionally ICRC-37 for approvals). Without it,
// the "Import NFT collection" flow fails with "can't detect standard".

#[derive(candid::CandidType, serde::Serialize)]
struct SupportedStandard {
    name: String,
    url: String,
}

#[query]
fn icrc10_supported_standards() -> Vec<SupportedStandard> {
    supported_standards()
}

/// ICRC-7 mandates this as part of the base standard. Some wallets
/// (Oisy) check this instead of ICRC-10.
#[query]
fn icrc7_supported_standards() -> Vec<SupportedStandard> {
    supported_standards()
}

fn supported_standards() -> Vec<SupportedStandard> {
    vec![
        SupportedStandard {
            name: "ICRC-7".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-7/ICRC-7.md".into(),
        },
        SupportedStandard {
            name: "ICRC-3".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-3/ICRC-3.md".into(),
        },
        SupportedStandard {
            name: "ICRC-10".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-10/ICRC-10.md".into(),
        },
    ]
}

// ───── ICRC-3: Transaction log ─────

use crate::types::{GetTransactionsResponse, Icrc3Transaction, SupportedBlockType};

/// Paginated transaction history. `start` is the first tx index to return,
/// `length` is max number of entries. Returns newest-first within the window.
#[query]
fn icrc3_get_transactions(start: u64, length: u64) -> GetTransactionsResponse {
    let total = state::tx_count();
    let capped = length.min(2000); // cap per-request
    let mut txs = Vec::new();
    state::TX_LOG.with(|m| {
        let map = m.borrow();
        for i in start..start.saturating_add(capped) {
            if i >= total { break; }
            if let Some(rec) = map.get(&i) {
                txs.push(Icrc3Transaction {
                    id: i,
                    kind: rec.kind,
                    timestamp: rec.timestamp,
                    token_id: rec.token_id,
                    from: rec.from,
                    to: rec.to,
                    memo: rec.memo,
                });
            }
        }
    });
    GetTransactionsResponse {
        log_length: total,
        transactions: txs,
    }
}

/// Block types we emit in the log.
#[query]
fn icrc3_supported_block_types() -> Vec<SupportedBlockType> {
    vec![
        SupportedBlockType {
            block_type: "7mint".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-7/ICRC-7.md".into(),
        },
        SupportedBlockType {
            block_type: "7xfer".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-7/ICRC-7.md".into(),
        },
        SupportedBlockType {
            block_type: "7burn".into(),
            url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-7/ICRC-7.md".into(),
        },
    ]
}

// ───── Treasury distribution support ─────

/// Backend-facing paginated query: walks all live tokens of `season` and
/// returns the data needed to compute end-of-season treasury weights
/// (token id, owner, pixel_count, minted_at). Burned tokens skipped.
#[query]
fn list_season_tokens(
    season: u32,
    prev: Option<TokenId>,
    take: Option<candid::Nat>,
) -> Vec<TokenInfo> {
    icrc7::list_season_tokens(season, prev, take)
}

// ───── HTTP image endpoint ─────
//
// `GET /token/<id>.png` returns the rendered template as a PNG. Boundary
// nodes cache aggressively (1 year, immutable) so the canister is hit at
// most once per token after the first request — effectively free.
//
// Burned tokens still serve their image (per spec: metadata is preserved).

#[query]
fn http_request(req: HttpRequest) -> HttpResponse {
    if req.method.to_uppercase() != "GET" {
        return HttpResponse {
            status_code: 405,
            headers: vec![],
            body: b"method not allowed".to_vec(),
        };
    }
    // Strip query string + leading slash.
    let path = req.url.split('?').next().unwrap_or("");
    let path = path.trim_start_matches('/');

    if let Some(rest) = path.strip_prefix("token/") {
        if let Some(id_str) = rest.strip_suffix(".png") {
            if let Ok(id) = id_str.parse::<TokenId>() {
                if let Some(meta) = TOKENS.with(|t| t.borrow().get(&id).map(|t| t.metadata)) {
                    match png_render::render(&meta) {
                        Ok(png) => {
                            return HttpResponse {
                                status_code: 200,
                                headers: vec![
                                    ("Content-Type".into(), "image/png".into()),
                                    (
                                        "Cache-Control".into(),
                                        "public, max-age=31536000, immutable".into(),
                                    ),
                                ],
                                body: png,
                            };
                        }
                        Err(e) => {
                            ic_cdk::println!("http_request: png encode failed: {e}");
                            return HttpResponse {
                                status_code: 500,
                                headers: vec![("Content-Type".into(), "text/plain".into())],
                                body: b"png encode failed".to_vec(),
                            };
                        }
                    }
                }
            }
        }
    }

    HttpResponse {
        status_code: 404,
        headers: vec![("Content-Type".into(), "text/plain".into())],
        body: b"not found".to_vec(),
    }
}

// ───── Upgrade hooks ─────

#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    // Stable structures persist on their own.
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Touch every container so any decoding error aborts the upgrade
    // transaction instead of bricking the canister.
    TOKENS.with(|t| t.borrow().len());
    state::NEXT_TOKEN_ID.with(|c| *c.borrow().get());
    let _ = backend_principal();
    state::TX_LOG.with(|m| m.borrow().len());
    state::NEXT_TX_ID.with(|c| *c.borrow().get());
}

// Hand-written did is the source of truth — see `nft.did`.
// We still emit one for tooling sanity, but the file under version control
// wins on disagreement.
ic_cdk::export_candid!();
