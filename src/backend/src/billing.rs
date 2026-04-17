//! Alliance & pixel-pack pricing and payout config.
//!
//! Lives in its own `StableCell` (MemoryId 9) so it survives upgrades and
//! can be tweaked at runtime by controllers without redeploying.
//!
//! **Migration rule (see [MIGRATION.md](../../../../MIGRATION.md)):** `Billing`
//! is candid-encoded. Any new field added here must be `Option<T>`; plain
//! `T` will break the upgrade decode for any canister with pre-existing
//! billing state. Verify with `./scripts/test-upgrade.sh`.
//!
//! ## Pixel packs (deposit-order flow)
//!
//! Players buy fixed-price packs via `create_order(pack_id)` / `check_order`.
//! Each pack has a pixel count and a total ICP price in e8s. The backend
//! generates a unique subaccount per order; the player sends the exact
//! amount of ICP (±`UNDER_TOLERANCE_E8S` below) from any wallet. Overpayment
//! is fully accepted; excess goes to treasury. Underpayment outside the
//! tolerance leaves the funds stuck on the subaccount (ToS: no refunds;
//! controllers can manually rescue via `admin_rescue_order` for support).

use crate::alliance_types::AllianceError;
use crate::state::BILLING;
use candid::{CandidType, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// A fixed-price pixel pack.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PixelPack {
    pub id: u8,
    pub pixels: u64,
    /// Total pack price in e8s (1 ICP = 100_000_000 e8s).
    pub price_e8s: u64,
}

// ───── Deposit-order types ─────

/// How long a deposit order stays open for payment. After this window
/// `check_order` transitions the order to `Expired` and any ICP already
/// sent is treated as abandoned (admin can rescue via `admin_rescue_order`).
pub const ORDER_TTL_NS: u64 = 30 * 60 * 1_000_000_000;

/// How much less than the expected amount we still accept as "paid". 0.01 ICP
/// covers wallet rounding to 6 decimals and small fee inconsistencies.
/// Overpayment is always accepted; excess goes to treasury.
pub const UNDER_TOLERANCE_E8S: u64 = 1_000_000;

/// 16-byte random order id. Also acts as the first 16 bytes of the
/// deposit subaccount (remaining 16 bytes zero-padded).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrderId(pub [u8; 16]);

impl OrderId {
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from a 32-char hex string (no 0x prefix).
    pub fn from_hex(s: &str) -> Result<Self, String> {
        let bytes = hex::decode(s).map_err(|e| format!("bad hex: {e}"))?;
        if bytes.len() != 16 {
            return Err(format!("expected 16 bytes, got {}", bytes.len()));
        }
        let mut arr = [0u8; 16];
        arr.copy_from_slice(&bytes);
        Ok(OrderId(arr))
    }
}

impl Storable for OrderId {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut arr = [0u8; 16];
        arr.copy_from_slice(&bytes);
        OrderId(arr)
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 16,
        is_fixed_size: true,
    };
}

/// State machine for a pixel-pack deposit order.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    /// Waiting for the player to send ICP to the deposit subaccount.
    Pending,
    /// Sweep in progress — guards against concurrent `settle_order` calls.
    /// Reverts to `Pending` on failure.
    Settling,
    /// Balance on the subaccount reached the expected amount (within
    /// tolerance); funds have been swept to the canister's main account,
    /// pixels credited, and split done.
    Paid {
        block_index: u64,
        settled_e8s: u64,
        pixels_credited: u64,
    },
    /// TTL window elapsed before enough ICP arrived. Any funds still on
    /// the subaccount are salvageable only via `admin_rescue_order`.
    Expired,
    /// A controller manually swept this order's subaccount out to a
    /// different principal (support / refund flow).
    Rescued {
        block_index: u64,
        to: Principal,
        amount_e8s: u64,
    },
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PendingOrder {
    pub order_id: OrderId,
    pub principal: Principal,
    pub pack_id: u8,
    pub expected_e8s: u64,
    pub created_at_ns: u64,
    pub expires_at_ns: u64,
    pub status: OrderStatus,
}

impl Storable for PendingOrder {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode PendingOrder"))
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode PendingOrder")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 256,
        is_fixed_size: false,
    };
}

/// Deterministically derive the 32-byte ICRC-1 subaccount from an order_id.
/// We use the 16-byte order_id as the prefix and zero-pad the rest.
pub fn order_subaccount(order_id: OrderId) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&order_id.0);
    out
}

/// Compute the old-style AccountIdentifier (64 hex chars = CRC32 + SHA-224)
/// for a principal + subaccount. Compatible with NNS dapp, legacy wallets,
/// and most block explorers.
pub fn account_identifier_hex(principal: Principal, subaccount: [u8; 32]) -> String {
    use sha2::{Digest, Sha224};
    let mut h = Sha224::new();
    h.update(b"\x0Aaccount-id");
    h.update(principal.as_slice());
    h.update(subaccount);
    let hash = h.finalize();
    let checksum = crc32fast::hash(&hash).to_be_bytes();
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(&checksum);
    out.extend_from_slice(&hash);
    hex::encode(out)
}

/// Hard-coded pack catalogue. Returned by `get_packs` query and validated
/// inside `buy_pack`. To change prices, update here and redeploy.
pub fn packs() -> Vec<PixelPack> {
    vec![
        PixelPack { id: 1, pixels: 100,  price_e8s: 200_000_000 },  // 2 ICP
        PixelPack { id: 2, pixels: 500,  price_e8s: 500_000_000 },  // 5 ICP
        PixelPack { id: 3, pixels: 1000, price_e8s: 800_000_000 },  // 8 ICP
    ]
}

/// Mutable billing config. All fields can be changed at runtime by a
/// canister controller via the admin endpoints in `lib.rs`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Billing {
    /// Cost of `create_alliance` in e8s (1 ICP = 100_000_000 e8s).
    /// `0` means alliances are free and no payment is attempted.
    pub alliance_price_e8s: u64,

    /// Legacy field kept for backward-compat decode. Ignored at runtime.
    #[serde(default)]
    pub pixel_price_usd_cents: u16,

    /// Per-player cooldown between pixel placements, in seconds. `0` disables.
    #[serde(default = "default_pixel_cooldown")]
    pub pixel_cooldown_seconds: u32,

    /// ICP ledger canister. Required for all paid operations (packs,
    /// alliances). Must be set via `set_alliance_billing` after deploy.
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
    /// Mission reward pool share, 0..=100.
    #[serde(default)]
    pub reward_pool_pct: Option<u8>,

    /// Legacy field kept for backward-compat decode. Ignored at runtime.
    #[serde(default)]
    pub pixel_price_e8s: Option<u64>,
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
            pixel_price_e8s: None,
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

/// Alliance creation cost in pixel credits. Tiered pricing encourages
/// early alliance formation while scaling up over time.
pub fn alliance_price_pixels(alliance_count: u64) -> u64 {
    match alliance_count {
        0 => 0,       // 1st: free
        1 => 50,      // 2nd: 50
        2 => 100,     // 3rd: 100
        3 => 500,     // 4th: 500
        4 => 1000,    // 5th: 1000
        _ => 1500,    // 6th+: 1500
    }
}

/// Next tier price (what the NEXT alliance will cost after the current one).
/// Returns None if already at max tier (1500).
pub fn alliance_next_price_pixels(alliance_count: u64) -> Option<u64> {
    match alliance_count {
        0 => Some(50),
        1 => Some(100),
        2 => Some(500),
        3 => Some(1000),
        4 => Some(1500),
        _ => None, // already at max
    }
}

/// Charge a caller for creating an alliance by deducting pixel credits.
/// Returns `Ok(())` on success, `PaymentFailed` if not enough credits.
pub async fn charge_alliance_fee(caller: Principal) -> Result<(), AllianceError> {
    if caller == Principal::anonymous() {
        return Err(AllianceError::Unauthorized);
    }
    let count = crate::state::NEXT_ALLIANCE_ID.with(|c| *c.borrow().get()) - 1;
    let cost = alliance_price_pixels(count);
    if cost == 0 {
        return Ok(());
    }
    crate::state::PIXEL_CREDITS.with(|m| {
        let had = m.borrow().get(&caller).unwrap_or(0);
        if had < cost {
            return Err(AllianceError::PaymentFailed(format!(
                "Need {} pixel credits to create an alliance, you have {}",
                cost, had
            )));
        }
        m.borrow_mut().insert(caller, had - cost);
        Ok(())
    })
}

/// Core charge path used by `charge_alliance_fee` (ICRC-2 approve + pull).
/// Pack purchases no longer go through this — they use `settle_order`.
/// Does the `icrc2_transfer_from` call, then splits the received amount.
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

    split_payment(cfg, total_e8s)
}

/// 3-way split of a payment already sitting on the canister's main account.
/// Used by both the ICRC-2 charge path (after transfer_from) and the
/// deposit-order settle path (after sweeping a subaccount).
///
/// Arithmetic uses u128 to avoid overflow. Rounding dust goes to treasury.
fn split_payment(cfg: &Billing, total_e8s: u64) -> Result<(), String> {
    if total_e8s == 0 {
        return Ok(());
    }
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

/// Advance a pending order by one step based on its current state and the
/// live balance sitting on its subaccount. Returns the new status.
///
/// Called from `check_order` (player poll) and from `admin_rescue_order`
/// indirectly when a rescue target needs the order marked terminal.
///
/// Idempotent: calling on an already-terminal order just returns it
/// unchanged. Transition graph:
///
/// ```text
/// Pending --(balance >= expected - tolerance)--> Paid
/// Pending --(now > expires_at)--> Expired
/// Pending --(underpaid & not yet expired)--> Pending
/// Paid / Expired / Rescued --> unchanged
/// ```
pub async fn settle_order(order_id: OrderId) -> Result<OrderStatus, String> {
    use crate::state::PENDING_ORDERS;

    let order = PENDING_ORDERS
        .with(|m| m.borrow().get(&order_id))
        .ok_or_else(|| format!("order {} not found", order_id.hex()))?;

    // Already terminal or being settled concurrently? No-op.
    if !matches!(order.status, OrderStatus::Pending) {
        return Ok(order.status);
    }

    let now = ic_cdk::api::time();
    // Expiry check BEFORE balance read — if the TTL lapsed we freeze the
    // order even if money arrived late. Rescue is the only way out then.
    if now > order.expires_at_ns {
        let mut o = order;
        o.status = OrderStatus::Expired;
        PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o.clone()));
        return Ok(o.status);
    }

    // Set Settling sentinel before any async call to prevent concurrent
    // settle_order calls from double-sweeping the same subaccount.
    {
        let mut o = order.clone();
        o.status = OrderStatus::Settling;
        PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
    }

    let cfg = get();
    let ledger = match cfg.ledger {
        Some(l) => l,
        None => {
            // Revert to Pending on failure.
            let mut o = order;
            o.status = OrderStatus::Pending;
            PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
            return Err("ledger not configured".to_string());
        }
    };
    let subaccount = order_subaccount(order_id);
    let balance = match crate::icp_ledger::balance_of_subaccount(
        ledger,
        ic_cdk::api::id(),
        subaccount,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            // Revert to Pending on failure.
            let mut o = order;
            o.status = OrderStatus::Pending;
            PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
            return Err(e);
        }
    };

    // Need at least expected - tolerance. Overpayment (balance > expected)
    // is fine and will flow into treasury as excess.
    let min_e8s = order.expected_e8s.saturating_sub(UNDER_TOLERANCE_E8S);
    if balance < min_e8s {
        // Revert Settling → Pending (not yet paid enough).
        let mut o = order;
        o.status = OrderStatus::Pending;
        PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
        return Ok(OrderStatus::Pending);
    }

    // Sweep subaccount → canister's default account (minus ledger fee).
    let fee = crate::icp_ledger::cached_ledger_fee();
    if balance <= fee {
        // Can't sweep — deposit is dust. Revert Settling → Pending until TTL.
        let mut o = order;
        o.status = OrderStatus::Pending;
        PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
        return Ok(OrderStatus::Pending);
    }
    let sweep_amount = balance - fee;
    let block_index = match crate::icp_ledger::transfer_from_subaccount(
        ledger,
        subaccount,
        ic_cdk::api::id(),
        sweep_amount,
    )
    .await
    {
        Ok(idx) => idx,
        Err(e) => {
            // Sweep failed — revert Settling → Pending so player can retry.
            let mut o = order;
            o.status = OrderStatus::Pending;
            PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o));
            return Err(e);
        }
    };

    // Split: pack_portion goes through normal wallet/treasury/reward_pool
    // split; excess over the pack price is lumped fully into treasury.
    let pack_portion = std::cmp::min(sweep_amount, order.expected_e8s);
    let excess = sweep_amount.saturating_sub(pack_portion);
    split_payment(&cfg, pack_portion)?;
    if excess > 0 {
        credit_treasury(excess);
    }

    // Credit pack pixels.
    let pack = packs()
        .into_iter()
        .find(|p| p.id == order.pack_id)
        .ok_or_else(|| format!("pack {} vanished mid-settle", order.pack_id))?;
    crate::state::PIXEL_CREDITS.with(|m| {
        let cur = m.borrow().get(&order.principal).unwrap_or(0);
        m.borrow_mut()
            .insert(order.principal, cur.saturating_add(pack.pixels));
    });

    // Persist terminal state.
    let mut o = order;
    o.status = OrderStatus::Paid {
        block_index,
        settled_e8s: balance,
        pixels_credited: pack.pixels,
    };
    PENDING_ORDERS.with(|m| m.borrow_mut().insert(order_id, o.clone()));
    Ok(o.status)
}
