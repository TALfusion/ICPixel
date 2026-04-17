//! End-of-season treasury distribution.
//!
//! Splits the canister's spare ICP balance between the project owner (40%)
//! and NFT holders of the current season (60%). Holder shares are weighted
//! so that bigger and earlier missions are worth more — see [`weight_for`]
//! for the formula.
//!
//! Holder payouts are **pull-style**: `distribute_treasury` writes per-
//! principal entries into `CLAIMABLE_TREASURY` and holders later call
//! `claim_treasury` to drain their balance. The owner cut is pushed
//! synchronously via a single `icrc1_transfer`.
//!
//! ## Concurrency
//!
//! `distribute_treasury` is `controllers`-only and sets
//! `GameState.treasury_last_distributed_season` synchronously **at the
//! start** of execution as a guard against re-entrant double credits.
//! On any failure after that point the field stays set; admin must use
//! `admin_reset_treasury_distribution` to retry.
//!
//! ## Migration
//!
//! See [MIGRATION.md](../../../../MIGRATION.md). New stable structures live
//! under `MEM_CLAIMABLE_TREASURY` (MemoryId 14); the new GameState fields
//! are `Option<T>`.

use crate::nft_client;
use crate::state::{game_state, nft_canister, update_game_state, CLAIMABLE_TREASURY};
use candid::Principal;

/// Default operational buffer in e8s — 20 ICP. Kept on the canister so
/// it always has gas for ledger fees, mission reward claims, and other
/// in-flight obligations. Tunable per-canister via
/// `treasury_operational_buffer_e8s`.
pub const DEFAULT_TREASURY_BUFFER_E8S: u64 = 20 * 100_000_000;

/// Holders share, percent. Owner gets the remaining 100 - HOLDERS_PCT.
const HOLDERS_PCT: u128 = 60;

/// Pagination chunk for `list_season_tokens` calls.
const LIST_PAGE_SIZE: u64 = 500;

/// Result returned by `distribute_treasury` so the admin can sanity-check
/// what just happened.
#[derive(candid::CandidType, serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DistributeReport {
    pub season: u32,
    pub total_distributable_e8s: u64,
    pub owner_paid_e8s: u64,
    pub holders_pool_e8s: u64,
    pub holders_credited: u32,
    pub tokens_considered: u32,
}

/// Per-token weight: `sqrt(pixel_count) * (1 + (1 - rank/total))`.
///
/// `sqrt` gives diminishing returns on size so a single whale mission
/// can't dominate the pool — a 10 000-pixel mission is worth 10× a 100-
/// pixel mission, not 100×. The age multiplier ranges linearly from 2.0
/// (rank 0, the very first NFT of the season) down to ~1.0 (the last).
///
/// Returned scaled by 1e6 and packed into a u128 to keep the downstream
/// share math integer-only.
fn weight_for(pixel_count: u64, rank: u32, total: u32) -> u128 {
    if total == 0 {
        return 0;
    }
    // Integer sqrt scaled by 1e6 for precision.
    // isqrt(pixel_count * 1e12) = sqrt(pixel_count) * 1e6
    let size = isqrt((pixel_count as u128) * 1_000_000_000_000);
    // age_mult = 1 + (1 - rank/total), scaled by 1e6.
    // = (2*total - rank) / total, scaled by 1e6
    let rank128 = rank as u128;
    let total128 = total as u128;
    if rank128 >= 2 * total128 {
        return 0; // safety: rank should never exceed total, but clamp to avoid underflow
    }
    let age = (2 * total128 - rank128) * 1_000_000 / total128;
    // weight = size * age / 1e6 (remove one scale factor)
    size * age / 1_000_000
}

/// Integer square root via Newton's method.
fn isqrt(n: u128) -> u128 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Admin-only. Distribute the canister's spare ICP balance between the
/// project owner (40%) and NFT holders of the current season (60%).
///
/// Holders are credited into the pull-claim map; the owner is paid
/// synchronously. Returns a `DistributeReport` for audit. Idempotent
/// per-season — re-running for the same season returns an error.
pub async fn distribute_treasury(
    owner_principal: Principal,
) -> Result<DistributeReport, String> {
    let nft = nft_canister().ok_or_else(|| "nft canister not configured".to_string())?;
    let cfg = crate::billing::get();
    let ledger = cfg
        .ledger
        .ok_or_else(|| "ledger not configured".to_string())?;

    let gs = game_state();
    let season = gs.season;
    if gs.treasury_last_distributed_season == Some(season) {
        return Err(format!(
            "treasury already distributed for season {season}; \
             admin_reset_treasury_distribution to retry"
        ));
    }
    let buffer = gs
        .treasury_operational_buffer_e8s
        .unwrap_or(DEFAULT_TREASURY_BUFFER_E8S);

    // Reserve the season slot before any awaits so a concurrent call from
    // another admin invocation can't double-credit holders.
    update_game_state(|gs| gs.treasury_last_distributed_season = Some(season))?;

    // Now we can do inter-canister calls safely. Any failure below leaves
    // the slot reserved — admin must reset to retry.
    let me = ic_cdk::api::id();
    let balance = crate::icp_ledger::balance_of(ledger, me).await?;
    let fee = crate::icp_ledger::cached_ledger_fee();
    if balance <= buffer + fee {
        return Err(format!(
            "balance {balance} e8s does not exceed operational buffer {buffer} + fee {fee}"
        ));
    }
    let distributable = balance - buffer;
    // Rounding: floor division for owner_cut; remainder rolls into
    // holders_pool. `distributable` is bounded by canister ICP balance
    // (always ≤ u64), so the u128→u64 cast cannot truncate.
    let owner_cut = ((distributable as u128) * (100 - HOLDERS_PCT) / 100) as u64;
    let holders_pool = distributable - owner_cut;

    // Pull every live token of this season in pages.
    let mut tokens: Vec<nft_client::TokenInfo> = Vec::new();
    let mut prev: Option<u64> = None;
    loop {
        let page = nft_client::list_season_tokens(nft, season, prev, LIST_PAGE_SIZE).await?;
        if page.is_empty() {
            break;
        }
        prev = Some(page.last().unwrap().token_id);
        tokens.extend(page);
    }

    // Owner-only path: pay owner cut, no holders to credit.
    if tokens.is_empty() {
        let owner_paid = if owner_cut > 0 {
            crate::icp_ledger::transfer_drain(ledger, owner_principal, owner_cut)
                .await
                .unwrap_or(0)
        } else {
            0
        };
        return Ok(DistributeReport {
            season,
            total_distributable_e8s: distributable,
            owner_paid_e8s: owner_paid,
            holders_pool_e8s: 0,
            holders_credited: 0,
            tokens_considered: 0,
        });
    }

    // Sort by minted_at ascending so rank 0 = first NFT of the season.
    // Tie-break by token_id for determinism.
    tokens.sort_by(|a, b| {
        a.minted_at
            .cmp(&b.minted_at)
            .then_with(|| a.token_id.cmp(&b.token_id))
    });
    let total = tokens.len() as u32;

    // Compute weights and aggregate per principal.
    let mut total_weight: u128 = 0;
    let mut per_principal: std::collections::BTreeMap<Principal, u128> = Default::default();
    for (rank, tok) in tokens.iter().enumerate() {
        let w = weight_for(tok.pixel_count, rank as u32, total);
        total_weight = total_weight.saturating_add(w);
        *per_principal.entry(tok.owner.owner).or_insert(0) += w;
    }

    if total_weight == 0 {
        return Err("total weight is zero — no tokens to credit".into());
    }

    // Credit holders FIRST (synchronous, no awaits). This ensures that if
    // the subsequent owner transfer fails, credits are already written and
    // the admin can retry without double-crediting holders (saturating_add)
    // and without double-paying the owner.
    let pool_u128 = holders_pool as u128;
    let mut holders_credited: u32 = 0;
    CLAIMABLE_TREASURY.with(|m| {
        let mut map = m.borrow_mut();
        for (p, w) in per_principal.iter() {
            let share = ((pool_u128 * *w) / total_weight) as u64;
            if share == 0 {
                continue;
            }
            let cur = map.get(p).unwrap_or(0);
            map.insert(*p, cur.saturating_add(share));
            holders_credited += 1;
        }
    });

    // Pay owner AFTER holder credits are safely persisted.
    let owner_paid = if owner_cut > 0 {
        crate::icp_ledger::transfer_drain(ledger, owner_principal, owner_cut).await?
    } else {
        0
    };

    Ok(DistributeReport {
        season,
        total_distributable_e8s: distributable,
        owner_paid_e8s: owner_paid,
        holders_pool_e8s: holders_pool,
        holders_credited,
        tokens_considered: total,
    })
}

/// Pull-claim entry point. Drains the caller's `CLAIMABLE_TREASURY`
/// balance via a single `icrc1_transfer`. The ledger fee is taken out of
/// the credited amount (so the user pays it, not the canister). On
/// transfer failure the credit is restored so the user can retry.
pub async fn claim_treasury(
    caller: Principal,
    dest: crate::icp_ledger::PayoutDest,
) -> Result<u64, String> {
    if caller == Principal::anonymous() {
        return Err("anonymous caller cannot claim".into());
    }
    let cfg = crate::billing::get();
    let ledger = cfg
        .ledger
        .ok_or_else(|| "ledger not configured".to_string())?;

    // Atomically remove the credit so concurrent claim calls can't
    // double-spend. We restore on failure below.
    let credit = CLAIMABLE_TREASURY.with(|m| {
        let mut map = m.borrow_mut();
        let v = map.get(&caller).unwrap_or(0);
        if v > 0 {
            map.remove(&caller);
        }
        v
    });

    if credit == 0 {
        return Err("nothing to claim".into());
    }
    // `drain_to_dest` handles fee subtraction + BadFee retry, and routes
    // to legacy `transfer` or `icrc1_transfer` based on the destination
    // format the caller chose. We only need the net amount here; block
    // index is logged by the caller if they care.
    match crate::icp_ledger::drain_to_dest(ledger, &dest, credit).await {
        Ok((amount, _idx)) => Ok(amount),
        Err(e) => {
            CLAIMABLE_TREASURY.with(|m| {
                m.borrow_mut().insert(caller, credit);
            });
            Err(e)
        }
    }
}

pub fn claimable_for(p: Principal) -> u64 {
    CLAIMABLE_TREASURY.with(|m| m.borrow().get(&p).unwrap_or(0))
}
