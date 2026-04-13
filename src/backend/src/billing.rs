//! Alliance pricing and payout config.
//!
//! Lives in its own `StableCell` (MemoryId 9) so it survives upgrades and
//! can be tweaked at runtime by controllers without redeploying.
//!
//! **Migration rule (see [MIGRATION.md](../../../../MIGRATION.md)):** `Billing`
//! is candid-encoded. Any new field added here must be `Option<T>`; plain
//! `T` will break the upgrade decode for any canister with pre-existing
//! billing state. Verify with `./scripts/test-upgrade.sh`.
//!
//! ## Current state (Phase 1)
//!
//! `alliance_price_e8s = 0`, so `charge_alliance_fee` is a no-op. The
//! infrastructure exists so flipping the price to a non-zero value is a
//! single canister call (`set_alliance_price`). When that happens, the
//! `transfer_split` function below currently returns
//! `PaymentFailed("ICRC-2 payment not yet implemented")` — that error is
//! intentional and points to where the real ICRC-2 `transfer_from` calls
//! need to be wired up.

use crate::alliance_types::AllianceError;
use crate::state::BILLING;
use candid::{CandidType, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// Mutable billing config. All fields can be changed at runtime by a
/// canister controller via the admin endpoints in `lib.rs`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Billing {
    /// Cost of `create_alliance` in e8s (1 ICP = 100_000_000 e8s).
    /// `0` means alliances are free and no payment is attempted.
    pub alliance_price_e8s: u64,

    /// Cost of one pixel in USD cents. `0` means pixels are free (no
    /// buy_pixels / credit tracking). Converted to e8s on the fly using the
    /// cached ICP/USD rate from CoinGecko — so changing this field is enough
    /// to flip the whole game from free to paid.
    #[serde(default)]
    pub pixel_price_usd_cents: u16,

    /// Per-player cooldown between pixel placements, in seconds. `0` disables.
    #[serde(default = "default_pixel_cooldown")]
    pub pixel_cooldown_seconds: u32,

    /// ICP ledger canister — wired to real ICP on mainnet / local ledger on
    /// dev. Used by `buy_pixels` for the ICRC-2 transfer_from. If `None`,
    /// buy_pixels returns `PaymentFailed`.
    #[serde(default)]
    pub ledger: Option<Principal>,

    /// Where the wallet share of the fee goes.
    pub wallet_principal: Principal,
    /// Where the treasury share of the fee goes.
    pub treasury_principal: Principal,
    /// Wallet share, 0..=100. `wallet_pct + treasury_pct + reward_pool_pct` must equal 100.
    pub wallet_pct: u8,
    /// Treasury share, 0..=100.
    pub treasury_pct: u8,
    /// Mission reward pool share, 0..=100. Flows continuously to completed
    /// missions proportional to their pixel count. `None` treated as 0 for
    /// backward compat (pre-existing billing blobs lack this field).
    #[serde(default)]
    pub reward_pool_pct: Option<u8>,
}

fn default_pixel_cooldown() -> u32 {
    10
}

impl Billing {
    /// Default config used the very first time the canister is installed.
    /// Defaults:
    ///  - **pixel price: 5¢** — matches the current spec, live paid mode
    ///    on first deploy. Local-dev can flip to 0 via admin.
    ///  - **alliance price: 0** — still on the ops wishlist, paid mode
    ///    flipped later.
    ///  - **ledger: None** — must be wired via `admin_set_billing` after
    ///    deploy. Without it, any non-zero charge returns `PaymentFailed`.
    ///  - **cooldown: 10s**.
    ///  - **split 50/40/10** wallet/treasury/reward_pool.
    ///  - **wallet_principal = treasury_principal = self** — placeholders,
    ///    admin replaces `wallet_principal` with the dev's real wallet.
    ///    `treasury_principal` stays on the canister itself: treasury ICP
    ///    sits on backend's default account and is paid out via reward
    ///    claims, which we track off the `GameState.treasury_balance_e8s`
    ///    counter. There is no separate treasury canister.
    pub fn default_for_canister(self_id: Principal) -> Self {
        Self {
            alliance_price_e8s: 0,
            pixel_price_usd_cents: 5,
            pixel_cooldown_seconds: 10,
            ledger: None,
            wallet_principal: self_id,
            treasury_principal: self_id,
            wallet_pct: 50,
            treasury_pct: 40,
            reward_pool_pct: Some(10),
        }
    }
}

impl Storable for Billing {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode Billing"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode Billing")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 256,
        is_fixed_size: false,
    };
}

/// Read the current billing config.
pub fn get() -> Billing {
    BILLING.with(|c| c.borrow().get().clone())
}

/// Overwrite the entire billing config. Caller is responsible for
/// permission checks (controllers only — see `lib.rs`).
pub fn set(b: Billing) -> Result<(), String> {
    let rp = b.reward_pool_pct.unwrap_or(0);
    let sum = b.wallet_pct as u16 + b.treasury_pct as u16 + rp as u16;
    if sum != 100 {
        return Err(format!(
            "wallet_pct + treasury_pct + reward_pool_pct must equal 100 (got {} + {} + {} = {})",
            b.wallet_pct, b.treasury_pct, rp, sum
        ));
    }
    BILLING.with(|c| c.borrow_mut().set(b).map_err(|e| format!("{e:?}")))?;
    Ok(())
}

/// Increment the in-canister treasury counter. Treasury holds money for
/// end-of-season NFT holder distribution.
pub fn credit_treasury(e8s: u64) {
    if e8s == 0 {
        return;
    }
    let _ = crate::state::update_game_state(|gs| {
        let cur = gs.treasury_balance_e8s.unwrap_or(0);
        gs.treasury_balance_e8s = Some(cur.saturating_add(e8s));
    });
}

/// Distribute incoming reward pool money to all completed missions,
/// proportional to their pixel count. If no missions are completed yet,
/// the money accumulates in `GameState.reward_pool_balance_e8s` and will
/// be distributed when the first mission completes.
///
/// Called from `charge_and_split` on every payment (pixel purchase,
/// alliance creation).
pub fn credit_reward_pool(e8s: u64) {
    if e8s == 0 {
        return;
    }
    // Try to distribute to completed missions immediately.
    let distributed = crate::alliance::distribute_reward_to_missions(e8s);
    let remainder = e8s.saturating_sub(distributed);
    if remainder > 0 {
        // No completed missions (or rounding dust) — park in global pool.
        let _ = crate::state::update_game_state(|gs| {
            let cur = gs.reward_pool_balance_e8s.unwrap_or(0);
            gs.reward_pool_balance_e8s = Some(cur.saturating_add(remainder));
        });
    }
}

/// Update only the price. Convenience for the most common admin op.
/// Returns an error string if the stable-memory write fails (callers can
/// propagate via `?` — used by controller-only `set_alliance_price` in lib.rs).
pub fn set_price(e8s: u64) -> Result<(), String> {
    BILLING.with(|c| {
        let mut current = c.borrow().get().clone();
        current.alliance_price_e8s = e8s;
        c.borrow_mut()
            .set(current)
            .map(|_| ())
            .map_err(|e| format!("set BILLING price: {e:?}"))
    })
}

/// Tiered alliance pricing: 1st free, 2nd $3, 3rd $5, 4th $7, 5th+ $10.
/// Uses the current alliance count (NEXT_ALLIANCE_ID - 1) to determine tier.
/// Returns the USD price in cents for the Nth alliance (0-indexed).
pub fn alliance_price_usd_cents(alliance_count: u64) -> u16 {
    match alliance_count {
        0 => 0,      // 1st alliance: free
        1 => 300,    // 2nd: $3
        2 => 500,    // 3rd: $5
        3 => 700,    // 4th: $7
        _ => 1000,   // 5th+: $10
    }
}

/// Charge a caller for creating an alliance. Tiered pricing:
/// 1st free, 2nd $3, 3rd $5, 4th $7, 5th+ $10.
///
/// Returns `Ok(())` if the alliance is free (1st one). For paid tiers,
/// converts USD to e8s via cached ICP/USD rate and charges via ICRC-2.
pub async fn charge_alliance_fee(caller: Principal) -> Result<(), AllianceError> {
    let cfg = get();
    let count = crate::state::NEXT_ALLIANCE_ID.with(|c| *c.borrow().get()) - 1;
    let cents = alliance_price_usd_cents(count);
    if cents == 0 {
        return Ok(());
    }
    let total_e8s = crate::icp_price::cents_to_e8s(cents).ok_or_else(|| {
        AllianceError::PaymentFailed(
            "ICP/USD rate not cached — admin must call refresh_icp_price".into(),
        )
    })?;
    charge_and_split(&cfg, caller, total_e8s)
        .await
        .map_err(AllianceError::PaymentFailed)
}

/// Charge a caller for buying `count` pixel credits. Returns the total
/// e8s moved on success. In **free mode** (`pixel_price_usd_cents == 0`)
/// returns `Ok(0)` without touching the ledger — `buy_pixels` skips the
/// charge and credits directly.
///
/// Price computation uses the cached ICP/USD rate from `icp_price` — if
/// the rate is stale or unset we return an error and the caller should
/// either refresh manually or wait for the next auto-refresh tick.
pub async fn charge_pixel_fee(caller: Principal, count: u64) -> Result<u64, String> {
    if count == 0 {
        return Err("count must be > 0".into());
    }
    let cfg = get();
    if cfg.pixel_price_usd_cents == 0 {
        return Ok(0);
    }
    let cents_total = (cfg.pixel_price_usd_cents as u64).saturating_mul(count);
    if cents_total > u16::MAX as u64 {
        // cents_to_e8s takes a u16 — split into chunks if we ever need big
        // bundles. For now 5¢ × 65535 = ~$3276 per bundle, way past what a
        // single buy_pixels call would ever ask for.
        return Err(format!(
            "cents_total {cents_total} exceeds u16 — reduce count"
        ));
    }
    let total_e8s = crate::icp_price::cents_to_e8s(cents_total as u16).ok_or_else(|| {
        "ICP/USD rate not cached yet — admin must call refresh_icp_price".to_string()
    })?;
    charge_and_split(&cfg, caller, total_e8s).await?;
    Ok(total_e8s)
}

/// Core charge path shared by `charge_alliance_fee` and `charge_pixel_fee`.
/// Does the `icrc2_transfer_from` call, then splits the received amount
/// between wallet (pending) and treasury (counter).
async fn charge_and_split(
    cfg: &Billing,
    caller: Principal,
    total_e8s: u64,
) -> Result<(), String> {
    let ledger = cfg
        .ledger
        .ok_or_else(|| "ledger not configured — admin must wire it via set_alliance_billing".to_string())?;
    if caller == Principal::anonymous() {
        return Err("anonymous caller cannot be charged".into());
    }
    let me = ic_cdk::api::id();

    // Move `total_e8s` from caller → this canister. Ledger fee (10k e8s)
    // is taken out of the caller's balance on top of `total_e8s`.
    crate::icp_ledger::transfer_from(ledger, caller, me, total_e8s).await?;

    // 3-way split: wallet / treasury / reward_pool.
    // Arithmetic uses u128 to avoid overflow. Rounding dust goes to treasury.
    let rp_pct = cfg.reward_pool_pct.unwrap_or(0) as u128;
    let wallet_share =
        ((total_e8s as u128) * (cfg.wallet_pct as u128) / 100u128) as u64;
    let reward_share =
        ((total_e8s as u128) * rp_pct / 100u128) as u64;
    let treasury_share = total_e8s
        .saturating_sub(wallet_share)
        .saturating_sub(reward_share);

    crate::state::credit_wallet_pending(wallet_share)?;
    credit_treasury(treasury_share);
    credit_reward_pool(reward_share);
    Ok(())
}
