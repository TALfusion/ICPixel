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

/// Internal: single `icrc1_transfer` call with an explicit fee. The
/// public entry points wrap this with retry-on-BadFee logic.
async fn icrc1_transfer_explicit(
    ledger: Principal,
    to: Principal,
    amount: u64,
    fee: u64,
) -> Result<Result<u64, TransferError>, String> {
    let arg = TransferArg {
        from_subaccount: None,
        to: Account { owner: to, subaccount: None },
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
    let fee = cached_ledger_fee();
    if total_available <= fee {
        // Cache might be stale-too-high. Try a fresh fetch before bailing.
        let fresh = refresh_ledger_fee(ledger).await.unwrap_or(fee);
        if total_available <= fresh {
            return Err(format!(
                "amount {total_available} e8s does not cover ledger fee {fresh}"
            ));
        }
        let amount = total_available - fresh;
        match icrc1_transfer_explicit(ledger, to, amount, fresh).await? {
            Ok(_) => return Ok(amount),
            Err(e) => return Err(format!("icrc1_transfer rejected: {e:?}")),
        }
    }
    let amount = total_available - fee;
    match icrc1_transfer_explicit(ledger, to, amount, fee).await? {
        Ok(_) => Ok(amount),
        Err(TransferError::BadFee { expected_fee }) => {
            let new_fee = nat_to_u64(&expected_fee);
            set_ledger_fee(new_fee);
            if total_available <= new_fee {
                return Err(format!(
                    "amount {total_available} e8s does not cover refreshed ledger fee {new_fee}"
                ));
            }
            let amount = total_available - new_fee;
            match icrc1_transfer_explicit(ledger, to, amount, new_fee).await? {
                Ok(_) => Ok(amount),
                Err(e) => Err(format!("icrc1_transfer rejected after fee refresh: {e:?}")),
            }
        }
        Err(e) => Err(format!("icrc1_transfer rejected: {e:?}")),
    }
}
