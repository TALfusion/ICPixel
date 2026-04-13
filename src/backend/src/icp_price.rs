//! Live ICP/USD rate, fetched from the **IC Exchange Rate Canister** (XRC).
//!
//! XRC (`uf6dk-hyaaa-aaaaq-qaaaq-cai`) is the canonical on-chain price oracle
//! built and operated by DFINITY. It aggregates rates from ~10 cryptocurrency
//! exchanges (Binance, Kraken, Coinbase, OKX, …) and returns a single
//! consensus rate, with built-in fallback if any individual exchange is
//! unreachable. This eliminates the single-point-of-failure problem the
//! previous CoinGecko HTTPS-outcall implementation had — and at a fraction
//! of the cycle cost (~10B cycles per call vs ~2B per HTTPS outcall, but
//! with fallback baked in instead of needing 3-4 outcalls to multiple
//! sources).
//!
//! ## Cost
//!
//! XRC charges 10B cycles per `get_exchange_rate` call. We refresh on a
//! 6-hour timer (4 calls/day) → ~$0.05/day at mainnet cycle prices, or
//! about $20/year. Game pricing doesn't need anything more frequent — ICP
//! moves a few percent intra-day at most, well inside the 10% buffer the
//! frontend adds to the approve amount.
//!
//! ## Cached value
//!
//! Same `IcpUsdCache` shape as before: `usd_per_icp_micro` (USD × 1e6) and
//! `last_fetched_ns`. `cents_to_e8s` is unchanged, callers don't notice the
//! source switch.

use candid::{CandidType, Nat, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// USD per 1 ICP, scaled by 1e6 (so $6.4321 → 6_432_100). 0 means "never
/// fetched". Stored alongside the fetch timestamp.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct IcpUsdCache {
    pub usd_per_icp_micro: u64, // USD × 1_000_000
    pub last_fetched_ns: u64,
}

impl Storable for IcpUsdCache {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode IcpUsdCache"))
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode IcpUsdCache")
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 32,
        is_fixed_size: false,
    };
}

/// Maximum age before we consider a cached rate stale and unsafe to use
/// for pricing. 24 hours: with the 6h refresh timer this should never
/// trip in normal operation, only after extended XRC downtime.
const MAX_AGE_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

/// XRC canister principal — same on every IC subnet.
const XRC_PRINCIPAL: &str = "uf6dk-hyaaa-aaaaq-qaaaq-cai";

/// Cycles to attach to each `get_exchange_rate` call. XRC currently
/// charges exactly 10B cycles for cryptocurrency rates; refunds the
/// excess.
const XRC_CALL_CYCLES: u128 = 10_000_000_000;

// ───── XRC wire types ─────
//
// Inlined here instead of pulling the `xrc-types` crate so the dep
// surface stays small. Schema is stable per the XRC docs.

#[derive(CandidType, Deserialize, Clone, Debug)]
struct Asset {
    symbol: String,
    class: AssetClass,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
enum AssetClass {
    Cryptocurrency,
    FiatCurrency,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct GetExchangeRateRequest {
    base_asset: Asset,
    quote_asset: Asset,
    /// Optional timestamp in seconds since the epoch. Recommended to set
    /// it ~30 seconds in the past so XRC has data ready; otherwise we
    /// risk a `Pending` reply.
    timestamp: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct ExchangeRateMetadata {
    decimals: u32,
    base_asset_num_received_rates: u64,
    base_asset_num_queried_sources: u64,
    quote_asset_num_received_rates: u64,
    quote_asset_num_queried_sources: u64,
    standard_deviation: u64,
    forex_timestamp: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct ExchangeRate {
    base_asset: Asset,
    quote_asset: Asset,
    timestamp: u64,
    /// Rate × 10^decimals. With ICP/USD and decimals=8, a rate of $6.4321
    /// arrives as 643_210_000.
    rate: u64,
    metadata: ExchangeRateMetadata,
}

#[derive(CandidType, Deserialize, Debug)]
enum ExchangeRateError {
    AnonymousPrincipalNotAllowed,
    Pending,
    CryptoBaseAssetNotFound,
    CryptoQuoteAssetNotFound,
    StablecoinRateNotFound,
    StablecoinRateTooFewRates,
    StablecoinRateZeroRate,
    ForexInvalidTimestamp,
    ForexBaseAssetNotFound,
    ForexQuoteAssetNotFound,
    ForexAssetsNotFound,
    RateLimited,
    NotEnoughCycles,
    FailedToAcceptCycles,
    InconsistentRatesReceived,
    Other { code: u32, description: String },
}

#[derive(CandidType, Deserialize, Debug)]
enum GetExchangeRateResult {
    Ok(ExchangeRate),
    Err(ExchangeRateError),
}

// ───── Public API ─────

/// Read the cached rate. None if never fetched or stale.
pub fn cached() -> Option<IcpUsdCache> {
    let c = crate::state::ICP_USD_CACHE.with(|c| c.borrow().get().clone());
    if c.usd_per_icp_micro == 0 {
        return None;
    }
    let age = ic_cdk::api::time().saturating_sub(c.last_fetched_ns);
    if age > MAX_AGE_NS {
        return None;
    }
    Some(c)
}

/// Read the cached rate even if stale (used by admin/debug endpoints).
pub fn raw() -> IcpUsdCache {
    crate::state::ICP_USD_CACHE.with(|c| c.borrow().get().clone())
}

/// Compute how many e8s equal `cents` USD cents, using the current rate.
/// Returns None if there's no fresh rate cached.
pub fn cents_to_e8s(cents: u16) -> Option<u64> {
    let c = cached()?;
    // cents × 10_000 = micros  (1 cent = 10_000 micro-USD)
    // e8s = micros × 1e8 / usd_per_icp_micro
    // careful with overflow — do as u128
    let micros = (cents as u128) * 10_000;
    let e8s = micros * 100_000_000u128 / (c.usd_per_icp_micro as u128);
    Some(e8s as u64)
}

/// Fetch the latest ICP/USD rate from XRC and write it to the cache.
/// Costs `XRC_CALL_CYCLES` (10B) per successful call. Returns the new
/// cached value, or an error string suitable for propagation.
///
/// Called by:
///   * the controller-only `refresh_icp_price` endpoint (manual ops)
///   * the 6-hour repeating timer in `lib.rs::arm_icp_price_timer`
pub async fn refresh() -> Result<IcpUsdCache, String> {
    let xrc = Principal::from_text(XRC_PRINCIPAL)
        .map_err(|e| format!("invalid XRC principal: {e}"))?;

    // Request 30 seconds in the past so XRC has time to aggregate.
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    let req = GetExchangeRateRequest {
        base_asset: Asset {
            symbol: "ICP".to_string(),
            class: AssetClass::Cryptocurrency,
        },
        quote_asset: Asset {
            symbol: "USD".to_string(),
            class: AssetClass::FiatCurrency,
        },
        timestamp: Some(now_secs.saturating_sub(30)),
    };

    let (res,): (GetExchangeRateResult,) =
        ic_cdk::api::call::call_with_payment128(xrc, "get_exchange_rate", (req,), XRC_CALL_CYCLES)
            .await
            .map_err(|(code, msg)| format!("XRC call failed: {code:?} {msg}"))?;

    let rate = match res {
        GetExchangeRateResult::Ok(r) => r,
        GetExchangeRateResult::Err(e) => {
            return Err(format!("XRC error: {e:?}"));
        }
    };

    // XRC returns rate × 10^decimals. Convert to micro-USD per ICP:
    //   usd_per_icp = rate / 10^decimals
    //   usd_per_icp_micro = usd_per_icp × 1_000_000
    //                    = rate × 10^(6 - decimals)        if decimals ≤ 6
    //                    = rate / 10^(decimals - 6)        if decimals > 6
    let decimals = rate.metadata.decimals;
    let usd_per_icp_micro: u64 = if decimals == 6 {
        rate.rate
    } else if decimals < 6 {
        let mult = 10u64.pow(6 - decimals);
        rate.rate.saturating_mul(mult)
    } else {
        let div = 10u64.pow(decimals - 6);
        rate.rate / div.max(1)
    };

    if usd_per_icp_micro == 0 {
        return Err(format!(
            "XRC returned zero/unparseable rate (rate={}, decimals={})",
            rate.rate, decimals
        ));
    }

    let entry = IcpUsdCache {
        usd_per_icp_micro,
        last_fetched_ns: ic_cdk::api::time(),
    };
    crate::state::ICP_USD_CACHE.with(|c| {
        c.borrow_mut()
            .set(entry.clone())
            .map(|_| ())
            .map_err(|e| format!("set ICP_USD_CACHE: {e:?}"))
    })?;
    Ok(entry)
}

// Silence the unused-import diagnostic for `Nat` if anything in this
// module decides not to use it after refactor.
#[allow(dead_code)]
fn _silence_nat(_: Nat) {}
