//! Thin ICRC-1 / ICRC-2 client for talking to the ICP ledger canister.
//!
//! Only the two calls we actually use are implemented:
//!
//! * [`transfer_from`] — move ICP *from* a user's account to this canister
//!   after they've approved us via `icrc2_approve`. Used by `buy_pixels`
//!   and `charge_alliance_fee` to collect payment.
//! * [`transfer`]      — move ICP *from* this canister to somewhere else.
//!   Used by `admin_payout_wallet` to drain accumulated wallet share and
//!   by `claim_mission_reward` to pay out reward shares from the treasury.
//!
//! Both functions return `Result<u64, String>` with:
//!   * `Ok(block_index)` — the ledger's transaction index (for logs/audit)
//!   * `Err(msg)`        — human-readable error suitable for propagation
//!
//! We do NOT import `ic-ledger-types` to avoid pulling in the whole
//! AccountIdentifier legacy surface — the ICP ledger on mainnet speaks
//! ICRC-1/2 natively and that's all we need.

use candid::{CandidType, Nat, Principal};
use serde::{Deserialize, Serialize};
use std::cell::Cell;

// ───── Ledger fee cache ─────
//
// ICP ledger fee is currently 10_000 e8s but has changed historically and
// could change again. We cache it in thread-local memory (re-fetched on
// canister start / first transfer) and self-heal on `BadFee` errors:
// every transfer wraps the ledger call in a one-shot retry that, on
// `BadFee`, refreshes the cache from `icrc1_fee` and retries once.
//
// In-memory (not stable) cache is fine — fee value is recoverable from
// the ledger at any time, and starting with the historical default is
// strictly better than failing on first call after upgrade.

const DEFAULT_LEDGER_FEE_E8S: u64 = 10_000;

thread_local! {
    static LEDGER_FEE_CACHE: Cell<u64> = const { Cell::new(DEFAULT_LEDGER_FEE_E8S) };
}

pub fn cached_ledger_fee() -> u64 {
    LEDGER_FEE_CACHE.with(|c| c.get())
}

fn set_ledger_fee(fee: u64) {
    LEDGER_FEE_CACHE.with(|c| c.set(fee));
}

/// Query the ledger for its current `icrc1_fee` and update the cache.
/// Used by the BadFee retry path and (optionally) by warm-up callers.
pub async fn refresh_ledger_fee(ledger: Principal) -> Result<u64, String> {
    let (res,): (Nat,) = ic_cdk::call(ledger, "icrc1_fee", ())
        .await
        .map_err(|(code, msg)| format!("ledger icrc1_fee: {code:?} {msg}"))?;
    let fee = nat_to_u64(&res);
    set_ledger_fee(fee);
    Ok(fee)
}

// ───── Wire types ─────

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
pub struct Account {
    pub owner: Principal,
    pub subaccount: Option<serde_bytes::ByteBuf>,
}

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
struct TransferArg {
    from_subaccount: Option<serde_bytes::ByteBuf>,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<serde_bytes::ByteBuf>,
    created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
struct TransferFromArg {
    spender_subaccount: Option<serde_bytes::ByteBuf>,
    from: Account,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<serde_bytes::ByteBuf>,
    created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
enum TransferError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}

#[derive(CandidType, Deserialize, Debug)]
enum TransferFromError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}

type TransferResult = Result<Nat, TransferError>;
type TransferFromResult = Result<Nat, TransferFromError>;

// ───── Helpers ─────

fn nat_to_u64(n: &Nat) -> u64 {
    // Ledger block indices are u64 on ICP — any value that fits will round-trip.
    n.0.iter_u64_digits().next().unwrap_or(0)
}

/// Move `amount` e8s from `from` to this canister. Caller must have
/// previously approved us on the ledger via `icrc2_approve`. Returns the
/// ledger block index on success.
pub async fn transfer_from(
    ledger: Principal,
    from: Principal,
    to: Principal,
    amount: u64,
) -> Result<u64, String> {
    let arg = TransferFromArg {
        spender_subaccount: None,
        from: Account { owner: from, subaccount: None },
        to: Account { owner: to, subaccount: None },
        amount: Nat::from(amount),
        // Let the ledger charge its configured fee (10_000 e8s on ICP).
        fee: None,
        memo: None,
        created_at_time: None,
    };
    let (res,): (TransferFromResult,) =
        ic_cdk::call(ledger, "icrc2_transfer_from", (arg,))
            .await
            .map_err(|(code, msg)| format!("ledger icrc2_transfer_from: {code:?} {msg}"))?;
    match res {
        Ok(idx) => Ok(nat_to_u64(&idx)),
        Err(e) => Err(format!("icrc2_transfer_from rejected: {e:?}")),
    }
}

/// Query this canister's own ICP balance via `icrc1_balance_of`. Returns
/// e8s. Used by treasury distribution to size the holders' pool against
/// the real on-chain balance, not just the bookkeeping counter.
pub async fn balance_of(ledger: Principal, owner: Principal) -> Result<u64, String> {
    let arg = Account { owner, subaccount: None };
    let (res,): (Nat,) = ic_cdk::call(ledger, "icrc1_balance_of", (arg,))
        .await
        .map_err(|(code, msg)| format!("ledger icrc1_balance_of: {code:?} {msg}"))?;
    Ok(nat_to_u64(&res))
}

/// Query the balance of a specific subaccount of `owner`. Used by the
/// deposit-order flow to poll whether a player has funded their order.
pub async fn balance_of_subaccount(
    ledger: Principal,
    owner: Principal,
    subaccount: [u8; 32],
) -> Result<u64, String> {
    let arg = Account {
        owner,
        subaccount: Some(serde_bytes::ByteBuf::from(subaccount.to_vec())),
    };
    let (res,): (Nat,) = ic_cdk::call(ledger, "icrc1_balance_of", (arg,))
        .await
        .map_err(|(code, msg)| format!("ledger icrc1_balance_of: {code:?} {msg}"))?;
    Ok(nat_to_u64(&res))
}

/// Move `amount` e8s *out of* one of our own subaccounts to a principal's
/// default account (typically this canister's main account during a sweep,
/// or a rescue target during admin_rescue_order). `from_subaccount` is
/// ours — we're the owner; we don't need approvals.
///
/// The caller must include the ledger fee in the subaccount balance above
/// `amount` (or pass `amount = balance - fee`). On `BadFee` we refresh the
/// cached fee and retry once.
pub async fn transfer_from_subaccount(
    ledger: Principal,
    from_subaccount: [u8; 32],
    to_owner: Principal,
    amount: u64,
) -> Result<u64, String> {
    let fee = cached_ledger_fee();
    match icrc1_transfer_from_subaccount_explicit(ledger, from_subaccount, to_owner, amount, fee).await? {
        Ok(idx) => Ok(idx),
        Err(TransferError::BadFee { expected_fee }) => {
            let new_fee = nat_to_u64(&expected_fee);
            set_ledger_fee(new_fee);
            // Retry with the refreshed fee. `amount` is left unchanged — the
            // caller sized it assuming the old fee, so the ledger may now
            // reject for InsufficientFunds if the new fee is higher. That
            // path returns Err below for the caller to handle.
            match icrc1_transfer_from_subaccount_explicit(ledger, from_subaccount, to_owner, amount, new_fee).await? {
                Ok(idx) => Ok(idx),
                Err(e) => Err(format!("icrc1_transfer (subaccount) rejected after fee refresh: {e:?}")),
            }
        }
        Err(e) => Err(format!("icrc1_transfer (subaccount) rejected: {e:?}")),
    }
}

async fn icrc1_transfer_from_subaccount_explicit(
    ledger: Principal,
    from_subaccount: [u8; 32],
    to_owner: Principal,
    amount: u64,
    fee: u64,
) -> Result<Result<u64, TransferError>, String> {
    let arg = TransferArg {
        from_subaccount: Some(serde_bytes::ByteBuf::from(from_subaccount.to_vec())),
        to: Account { owner: to_owner, subaccount: None },
        amount: Nat::from(amount),
        fee: Some(Nat::from(fee)),
        memo: None,
        created_at_time: None,
    };
    let (res,): (TransferResult,) = ic_cdk::call(ledger, "icrc1_transfer", (arg,))
        .await
        .map_err(|(code, msg)| format!("ledger icrc1_transfer: {code:?} {msg}"))?;
    Ok(res.map(|n| nat_to_u64(&n)))
}

/// Internal: single `icrc1_transfer` call with an explicit fee. The
/// public entry points wrap this with retry-on-BadFee logic.
async fn icrc1_transfer_explicit(
    ledger: Principal,
    to_owner: Principal,
    to_subaccount: Option<[u8; 32]>,
    amount: u64,
    fee: u64,
) -> Result<Result<u64, TransferError>, String> {
    let arg = TransferArg {
        from_subaccount: None,
        to: Account {
            owner: to_owner,
            subaccount: to_subaccount.map(|s| serde_bytes::ByteBuf::from(s.to_vec())),
        },
        amount: Nat::from(amount),
        fee: Some(Nat::from(fee)),
        memo: None,
        created_at_time: None,
    };
    let (res,): (TransferResult,) = ic_cdk::call(ledger, "icrc1_transfer", (arg,))
        .await
        .map_err(|(code, msg)| format!("ledger icrc1_transfer: {code:?} {msg}"))?;
    Ok(res.map(|n| nat_to_u64(&n)))
}

// ───── Legacy ICP ledger `transfer` (AccountIdentifier destination) ─────

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
struct LegacyTokens {
    e8s: u64,
}

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
struct LegacyTimeStamp {
    timestamp_nanos: u64,
}

#[derive(CandidType, Deserialize, Serialize, Clone, Debug)]
struct LegacyTransferArgs {
    memo: u64,
    amount: LegacyTokens,
    fee: LegacyTokens,
    from_subaccount: Option<serde_bytes::ByteBuf>,
    to: serde_bytes::ByteBuf, // 32-byte AccountIdentifier
    created_at_time: Option<LegacyTimeStamp>,
}

#[derive(CandidType, Deserialize, Debug)]
enum LegacyTransferError {
    BadFee { expected_fee: LegacyTokens },
    InsufficientFunds { balance: LegacyTokens },
    TxTooOld { allowed_window_nanos: u64 },
    TxCreatedInFuture,
    TxDuplicate { duplicate_of: u64 },
}

async fn legacy_transfer_explicit(
    ledger: Principal,
    to_account_id: [u8; 32],
    amount: u64,
    fee: u64,
) -> Result<Result<u64, LegacyTransferError>, String> {
    let arg = LegacyTransferArgs {
        memo: 0,
        amount: LegacyTokens { e8s: amount },
        fee: LegacyTokens { e8s: fee },
        from_subaccount: None,
        to: serde_bytes::ByteBuf::from(to_account_id.to_vec()),
        created_at_time: None,
    };
    let (res,): (Result<u64, LegacyTransferError>,) = ic_cdk::call(ledger, "transfer", (arg,))
        .await
        .map_err(|(code, msg)| format!("ledger transfer: {code:?} {msg}"))?;
    Ok(res)
}

/// Destination for a canister → external payout. Mirrors the three
/// address formats we show on the deposit side: AccountId for
/// NNS / exchanges, Icrc1 for modern wallets. Used by claim flows so
/// rewards can land directly where the player wants them, rather than
/// always routing through the caller's II default account.
#[derive(candid::CandidType, serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum PayoutDest {
    /// Legacy 32-byte account identifier (hex-decoded on caller side).
    AccountId(serde_bytes::ByteBuf),
    /// ICRC-1 destination.
    Icrc1 {
        owner: Principal,
        subaccount: Option<serde_bytes::ByteBuf>,
    },
}

impl PayoutDest {
    /// Convert the frontend-friendly inputs into a validated `PayoutDest`.
    /// `account_id_hex` must be exactly 64 hex chars (32 bytes) if given.
    /// `subaccount_hex` must be exactly 64 hex chars if given.
    pub fn from_icrc1(owner: Principal, subaccount_bytes: Option<[u8; 32]>) -> Self {
        PayoutDest::Icrc1 {
            owner,
            subaccount: subaccount_bytes.map(|s| serde_bytes::ByteBuf::from(s.to_vec())),
        }
    }
    pub fn from_account_id(bytes: [u8; 32]) -> Self {
        PayoutDest::AccountId(serde_bytes::ByteBuf::from(bytes.to_vec()))
    }
}

/// Drain pattern: caller supplies the **total** amount they have available
/// (e.g. accumulated wallet share, pending claim). This helper subtracts
/// the cached ledger fee, transfers the remainder, and on `BadFee`
/// refreshes the cache and retries once with the new fee. Returns the
/// **net** amount actually transferred (i.e. `total - fee`).
///
/// Use this anywhere we want to send "everything we have minus the fee" —
/// payouts, treasury claims. It centralises the fee math so call sites
/// stop hardcoding 10_000 e8s.
pub async fn transfer_drain(
    ledger: Principal,
    to: Principal,
    total_available: u64,
) -> Result<u64, String> {
    drain_to_dest(
        ledger,
        &PayoutDest::Icrc1 { owner: to, subaccount: None },
        total_available,
    )
    .await
    .map(|(amount, _idx)| amount)
}

/// Drain pattern with a user-chosen destination format. Routes through
/// either `icrc1_transfer` (for ICRC-1 destinations) or the legacy
/// `transfer` method (for 32-byte AccountIdentifier destinations).
///
/// Returns `(net_amount, block_index)` on success. The block index lets
/// callers surface an explorer link to the user.
pub async fn drain_to_dest(
    ledger: Principal,
    dest: &PayoutDest,
    total_available: u64,
) -> Result<(u64, u64), String> {
    let fee = cached_ledger_fee();
    if total_available <= fee {
        let fresh = refresh_ledger_fee(ledger).await.unwrap_or(fee);
        if total_available <= fresh {
            return Err(format!(
                "amount {total_available} e8s does not cover ledger fee {fresh}"
            ));
        }
        let amount = total_available - fresh;
        return run_transfer(ledger, dest, amount, fresh)
            .await
            .map(|idx| (amount, idx))
            .map_err(|e| match e {
                TransferAny::BadFee(_) => "ledger fee mismatch on fresh fetch".into(),
                TransferAny::Other(s) => s,
            });
    }
    let amount = total_available - fee;
    match run_transfer(ledger, dest, amount, fee).await {
        Ok(idx) => Ok((amount, idx)),
        Err(TransferAny::BadFee(new_fee)) => {
            set_ledger_fee(new_fee);
            if total_available <= new_fee {
                return Err(format!(
                    "amount {total_available} e8s does not cover refreshed ledger fee {new_fee}"
                ));
            }
            let amount = total_available - new_fee;
            run_transfer(ledger, dest, amount, new_fee)
                .await
                .map(|idx| (amount, idx))
                .map_err(|e| match e {
                    TransferAny::BadFee(_) => "ledger fee flipped twice in a row".into(),
                    TransferAny::Other(s) => s,
                })
        }
        Err(TransferAny::Other(s)) => Err(s),
    }
}

/// Narrow error type for the single-attempt path so `drain_to_dest` can
/// distinguish `BadFee` (retry-worthy) from terminal failures.
enum TransferAny {
    BadFee(u64),
    Other(String),
}

async fn run_transfer(
    ledger: Principal,
    dest: &PayoutDest,
    amount: u64,
    fee: u64,
) -> Result<u64, TransferAny> {
    match dest {
        PayoutDest::Icrc1 { owner, subaccount } => {
            let sub_bytes: Option<[u8; 32]> = subaccount.as_ref().and_then(|b| {
                if b.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(b);
                    Some(arr)
                } else {
                    None
                }
            });
            let res = icrc1_transfer_explicit(ledger, *owner, sub_bytes, amount, fee)
                .await
                .map_err(TransferAny::Other)?;
            match res {
                Ok(idx) => Ok(idx),
                Err(TransferError::BadFee { expected_fee }) => {
                    Err(TransferAny::BadFee(nat_to_u64(&expected_fee)))
                }
                Err(e) => Err(TransferAny::Other(format!("icrc1_transfer rejected: {e:?}"))),
            }
        }
        PayoutDest::AccountId(bytes) => {
            if bytes.len() != 32 {
                return Err(TransferAny::Other(format!(
                    "account_id must be 32 bytes, got {}",
                    bytes.len()
                )));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(bytes);
            let res = legacy_transfer_explicit(ledger, arr, amount, fee)
                .await
                .map_err(TransferAny::Other)?;
            match res {
                Ok(idx) => Ok(idx),
                Err(LegacyTransferError::BadFee { expected_fee }) => {
                    Err(TransferAny::BadFee(expected_fee.e8s))
                }
                Err(e) => Err(TransferAny::Other(format!(
                    "legacy transfer rejected: {e:?}"
                ))),
            }
        }
    }
}

