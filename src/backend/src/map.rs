//! Map module — owns all reads/writes to the pixel grid.
//!
//! IMPORTANT: no other module touches `PIXELS` directly.
//! When this module is later split into its own canister, the public
//! functions here become inter-canister calls.

use crate::billing;
use crate::state::{
    game_state, update_game_state, CHANGES, NEXT_VERSION, PIXEL_CREDITS,
};
use crate::types::{
    in_bounds, ChangesResponse, MapSnapshot, PixelChange, PlaceError, VersionInfo,
};
use candid::Principal;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

// ───── Burst rate limit (in-memory, non-stable) ─────
//
// Sliding window on top of the per-principal cooldown. Cooldown is the
// "honest player" pacing (one pixel every 10s); this is the anti-burst
// guard for scripts/bots that try to fire many pixels at once across
// multiple identities or via API replay.
//
// `RATE_LIMIT_MAX` placements allowed per `RATE_LIMIT_WINDOW_NS` per
// principal. Storage is in-memory (thread_local) — losing the buckets
// on upgrade is *safe*: worst case a player gets a free reset, never
// gets falsely blocked. We deliberately do NOT put this in stable
// memory to avoid the per-call write cost.
//
// Numbers picked for $0.05/pixel + 10s cooldown: a real human can place
// at most ~6/min via the cooldown gate, so 20/min is 3× headroom that
// catches scripted bursts (which would otherwise rip through the
// cooldown by rotating principals or by exploiting any future cooldown
// regression) without ever inconveniencing a real player.
const RATE_LIMIT_MAX: usize = 20;
const RATE_LIMIT_WINDOW_NS: u64 = 60 * 1_000_000_000;

thread_local! {
    static RATE_BUCKETS: RefCell<HashMap<Principal, VecDeque<u64>>> =
        RefCell::new(HashMap::new());

    /// Batched GameState delta. Flushed to stable every FLUSH_INTERVAL pixels
    /// or on pre_upgrade. Saves ~2M cycles on 99% of pixels.
    static GS_DELTA: RefCell<(u64, u64)> = RefCell::new((0, 0)); // (total_delta, unique_delta)

    /// In-memory cooldown cache. Replaces the old `LAST_PLACED` stable map
    /// for the per-player cooldown check. Lost on upgrade = all cooldowns
    /// reset (10s, acceptable). Saves ~2M cycles/pixel by avoiding a
    /// stable BTreeMap read+write on every placement.
    static COOLDOWN_CACHE: RefCell<HashMap<Principal, u64>> =
        RefCell::new(HashMap::new());
}

/// Returns Ok if the principal is under the rate limit; on miss, returns
/// the time (ns) until the oldest entry leaves the window. Records the
/// new placement timestamp on success.
fn check_rate_limit(principal: Principal, now_ns: u64) -> Result<(), u64> {
    RATE_BUCKETS.with(|b| {
        let mut map = b.borrow_mut();
        let bucket = map.entry(principal).or_default();
        // Drop entries older than the window.
        let cutoff = now_ns.saturating_sub(RATE_LIMIT_WINDOW_NS);
        while let Some(&front) = bucket.front() {
            if front < cutoff {
                bucket.pop_front();
            } else {
                break;
            }
        }
        if bucket.len() >= RATE_LIMIT_MAX {
            // Retry-after = oldest_entry + window - now.
            let oldest = *bucket.front().unwrap();
            let retry_after = (oldest + RATE_LIMIT_WINDOW_NS).saturating_sub(now_ns);
            return Err(retry_after);
        }
        bucket.push_back(now_ns);
        Ok(())
    })
}

const DEFAULT_COLOR: u32 = 0x2A2A33;

/// How often to flush batched GameState counters to stable memory.
/// Every 100 pixels = 99% fewer stable writes for GameState.
const GS_FLUSH_INTERVAL: u64 = 100;

/// Flush batched GameState deltas to stable memory. Called every
/// GS_FLUSH_INTERVAL pixels and from pre_upgrade.
pub fn flush_game_state_delta() {
    GS_DELTA.with(|d| {
        let (total, unique) = *d.borrow();
        if total == 0 && unique == 0 {
            return;
        }
        let _ = update_game_state(|gs| {
            gs.total_pixels_placed += total;
            gs.unique_pixels_set += unique;
        });
        *d.borrow_mut() = (0, 0);
    });
}

/// Maximum number of entries kept in the change log.
/// Older entries are dropped on each new write. Clients that have fallen
/// behind by more than this number of pixels detect it via
/// `ChangesResponse::min_version` and do a full reload.
///
/// Sized to cover a full typical season (~3 months of play at 10k
/// placements/day ≈ 900k) while staying well under IC stable-memory
/// quotas. At 8 bytes/entry this is ~16 MB of stable storage — tiny on
/// the cycles side (a few cents/month on mainnet). Clients fetch the
/// log in paginated chunks via `get_changes_since(from, max)` so the
/// per-query response stays below the ~3 MB gateway limit.
const CHANGES_LOG_LIMIT: u64 = 1_000_000;

/// Hard cap on how many changes a single `get_changes_since` response
/// returns. Keeps response size below the query-call limit. At 8 bytes
/// per change, 40k × 8 = 320 KB — comfortable inside the ~3 MB cap with
/// room for candid overhead and the other response fields.
const GET_CHANGES_DEFAULT_MAX: u64 = 40_000;
const GET_CHANGES_HARD_CAP: u64 = 40_000;

/// Map size progression. Once the current stage is fully painted
/// (every cell has been set at least once), advance to the next.
/// Stage progression. Final stage 500×500.
const STAGES: &[u16] = &[1, 5, 10, 50, 100, 500];
const FINAL_STAGE: u16 = 500;
/// Tile size used by `get_map_chunk`. Edge tiles on smaller stages return
/// only `min(CHUNK_SIZE, map_size - tile_origin)` cells per axis.
pub const CHUNK_SIZE: u16 = 256;
/// Season ends 7 days after the final stage is reached.
const SEASON_TAIL_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;

fn next_stage(current: u16) -> Option<u16> {
    let mut iter = STAGES.iter();
    while let Some(&s) = iter.next() {
        if s == current {
            return iter.next().copied();
        }
    }
    None
}

pub fn place_pixel(
    x: i16,
    y: i16,
    color: u32,
    caller: Option<Principal>,
    now_ns: u64,
) -> Result<(), PlaceError> {
    let gs = game_state();
    if gs.paused {
        return Err(PlaceError::Paused);
    }
    if season_ended_at(&gs).is_some_and(|end| now_ns >= end) {
        return Err(PlaceError::SeasonEnded);
    }
    let size = gs.map_size;
    if !in_bounds(x, y, size) {
        return Err(PlaceError::OutOfBounds);
    }
    if color > 0xFFFFFF {
        return Err(PlaceError::InvalidColor);
    }

    // Anonymous callers are allowed (test-mode). All anonymous users share a
    // single cooldown slot under `Principal::anonymous()`.
    let principal = caller.unwrap_or(Principal::anonymous());

    // Per-player cooldown, configurable from Billing (0 disables).
    // Uses in-memory cache instead of stable map — saves ~2M cycles/pixel.
    // Lost on upgrade = cooldowns reset (10s, acceptable).
    let cfg = billing::get();
    let cooldown_ns = (cfg.pixel_cooldown_seconds as u64) * 1_000_000_000;
    if cooldown_ns > 0 {
        COOLDOWN_CACHE.with(|m| -> Result<(), PlaceError> {
            if let Some(&last) = m.borrow().get(&principal) {
                let elapsed = now_ns.saturating_sub(last);
                if elapsed < cooldown_ns {
                    return Err(PlaceError::Cooldown {
                        remaining_ns: cooldown_ns - elapsed,
                    });
                }
            }
            Ok(())
        })?;
    }

    // Burst-rate limiter (in-memory sliding window). Anonymous callers
    // are upstream-rejected at lib.rs, so we only ever bucket real
    // principals. Reuses `Cooldown` so frontend code that already shows
    // a "wait N seconds" toast handles this case for free.
    if let Err(retry_after) = check_rate_limit(principal, now_ns) {
        return Err(PlaceError::Cooldown {
            remaining_ns: retry_after,
        });
    }

    // Billing: if pixels are priced, require and decrement a credit.
    // Free mode (`pixel_price_usd_cents == 0`) skips the credit system entirely.
    if cfg.pixel_price_usd_cents > 0 {
        let had = PIXEL_CREDITS.with(|m| m.borrow().get(&principal).unwrap_or(0));
        if had == 0 {
            return Err(PlaceError::NoCredits);
        }
        PIXEL_CREDITS.with(|m| m.borrow_mut().insert(principal, had - 1));
    }

    COOLDOWN_CACHE.with(|m| {
        m.borrow_mut().insert(principal, now_ns);
    });

    // Flat array: read old color to check was_new, then write new color.
    // ~20k cycles total vs ~3M for BTreeMap read+insert+candid encode.
    let old_color = crate::state::read_pixel_color(x, y);
    let was_new = old_color == 0x2A2A33; // DEFAULT_PIXEL_COLOR
    crate::state::write_pixel_color(x, y, color);
    // Alliance pixel count: only increment (no decrement on overwrite).
    // pixels_captured = "total pixels ever placed by alliance members".
    crate::alliance::on_pixel_placed(caller);

    // Per-round contribution credit. Anonymous callers (already rejected
    // upstream in lib.rs) wouldn't earn credit anyway — the function checks
    // and returns early. Members credit at ×1, non-member helpers at ×0.5
    // (the half-weight is applied later in the claim math).
    if let Some(c) = caller {
        crate::alliance::credit_pixel_contribution(c, x, y, color);
    }

    // Append to change log.
    let version = NEXT_VERSION.with(|c| {
        let cur = *c.borrow().get();
        c.borrow_mut()
            .set(cur + 1)
            .map(|_| cur)
            .map_err(|e| PlaceError::InternalError(format!("version bump: {e:?}")))
    })?;
    CHANGES.with(|cl| {
        let mut log = cl.borrow_mut();
        log.insert(version, PixelChange { x, y, color });
        // Trim: keep at most CHANGES_LOG_LIMIT entries. Drop the oldest.
        // Clients that fall outside this window detect staleness via
        // get_changes_since().min_version and do a full reload.
        while log.len() > CHANGES_LOG_LIMIT {
            if let Some((oldest, _)) = log.iter().next() {
                log.remove(&oldest);
            } else {
                break;
            }
        }
    });

    // Batch GameState counter updates in memory. Flush every GS_FLUSH_INTERVAL
    // pixels — saves ~2M cycles on 99% of placements.
    let unique_inc = if was_new { 1u64 } else { 0 };
    let should_flush = GS_DELTA.with(|d| {
        let mut delta = d.borrow_mut();
        delta.0 += 1;
        delta.1 += unique_inc;
        delta.0 >= GS_FLUSH_INTERVAL
    });
    if should_flush {
        flush_game_state_delta();
    }
    // Map growth check: stable gs + in-memory delta for accurate unique count.
    let gs_now = game_state();
    let effective_unique = gs_now.unique_pixels_set + GS_DELTA.with(|d| d.borrow().1);
    let total = (gs_now.map_size as u64) * (gs_now.map_size as u64);
    let needed = total * 95 / 100; // grow at 95% fill
    if effective_unique >= needed {
        if let Some(next) = next_stage(gs_now.map_size) {
            flush_game_state_delta();
            update_game_state(|gs| {
                gs.map_size = next;
                if next == FINAL_STAGE && gs.final_stage_reached_at.is_none() {
                    gs.final_stage_reached_at = Some(now_ns);
                }
            })
            .map_err(PlaceError::InternalError)?;
            crate::http::invalidate_og_cache();
        }
    }

    Ok(())
}

/// Read a rectangular region row-major in **centered** coordinates.
/// Cells never set return DEFAULT_COLOR. Caller is responsible for any
/// bounds checking; out-of-bounds cells just come back as DEFAULT_COLOR.
pub fn read_region(x: i16, y: i16, w: u16, h: u16) -> Vec<u32> {
    // Flat array bulk read — entire rows at once via memcpy.
    // ~200× cheaper than BTreeMap range scans for large chunks.
    crate::state::read_pixel_region(x, y, w, h)
}

/// Returns the season-end deadline (ns) if the final stage has been reached.
pub fn season_ended_at(gs: &crate::types::GameState) -> Option<u64> {
    gs.final_stage_reached_at.map(|t| t + SEASON_TAIL_NS)
}

/// TEMP debug helper: paints the map with a sweep of r/place palette colors,
/// leaving exactly ONE empty cell so the next manual click triggers the
/// grow cinematic. The `percent` argument is ignored — kept for the existing
/// candid signature. Bumps version + change-log + unique counter as if
/// pixels had been placed normally. Returns the number of cells written.
pub fn debug_fill(_percent: u8) -> u64 {
    const PALETTE: &[u32] = &[
        0x6d001a, 0xbe0039, 0xff4500, 0xffa800, 0xffd635, 0x00a368, 0x00cc78,
        0x2450a4, 0x3690ea, 0x811e9f, 0xb44ac0, 0xde107f, 0xff3881, 0x6d482f,
        0x9c6926, 0x000000, 0xffffff,
    ];
    let size = game_state().map_size;
    let total = (size as u64) * (size as u64);
    let target = total.saturating_sub(1);
    let half_neg = (size / 2) as i16;
    let mut written: u64 = 0;
    let mut palette_idx: usize = 0;
    let last_row = size - 1;
    let last_col = size - 1;
    const PER_CALL_LIMIT: u64 = 5_000;
    'outer: for row in 0..size {
        for col in 0..size {
            if row == last_row && col == last_col {
                break 'outer;
            }
            if written >= target || written >= PER_CALL_LIMIT {
                break 'outer;
            }
            let x = (col as i16) - half_neg;
            let y = (row as i16) - half_neg;
            // Skip already-painted cells (flat array read — cheap).
            if crate::state::read_pixel_color(x, y) != DEFAULT_COLOR {
                continue;
            }
            let color = PALETTE[palette_idx % PALETTE.len()];
            palette_idx += 1;
            crate::state::write_pixel_color(x, y, color);
            // Changelog entry.
            let version = NEXT_VERSION.with(|c| {
                let cur = *c.borrow().get();
                c.borrow_mut().set(cur + 1).map(|_| cur)
            });
            let version = match version {
                Ok(v) => v,
                Err(e) => {
                    ic_cdk::println!("debug_fill: version bump failed: {e:?}");
                    break 'outer;
                }
            };
            CHANGES.with(|cl| {
                let mut log = cl.borrow_mut();
                log.insert(version, PixelChange { x, y, color });
                while log.len() > CHANGES_LOG_LIMIT {
                    if let Some((oldest, _)) = log.iter().next() {
                        log.remove(&oldest);
                    } else {
                        break;
                    }
                }
            });
            if let Err(e) = update_game_state(|gs| {
                gs.total_pixels_placed += 1;
                gs.unique_pixels_set += 1;
            }) {
                ic_cdk::println!("debug_fill: update_game_state failed: {e}");
                break 'outer;
            }
            written += 1;
        }
    }
    written
}

pub fn get_version() -> VersionInfo {
    VersionInfo {
        version: NEXT_VERSION.with(|c| *c.borrow().get()),
        map_size: game_state().map_size,
    }
}

/// Paginated change-log read. Returns up to `max` changes starting at
/// `from_version` (inclusive). Response is capped internally at
/// `GET_CHANGES_HARD_CAP` regardless of what the caller asks for, so
/// malicious or naive callers can't blow the query response limit.
///
/// Clients should loop while `next_version < current_version` to walk
/// the full history in pages. For live delta polling, passing
/// `from_version = last_seen_version` works the same as before — the
/// hard cap is large enough that no realistic polling interval will
/// accumulate enough changes to truncate, and if it does the client's
/// next tick catches up.
pub fn get_changes_since(from_version: u64, max: Option<u64>) -> ChangesResponse {
    let limit = max
        .unwrap_or(GET_CHANGES_DEFAULT_MAX)
        .min(GET_CHANGES_HARD_CAP);
    let map_size = game_state().map_size;
    let current_version = NEXT_VERSION.with(|c| *c.borrow().get());
    let (changes, min_version, next_version) = CHANGES.with(|cl| {
        let log = cl.borrow();
        let min_version = log.iter().next().map(|(k, _)| k).unwrap_or(current_version);
        // Take the first `limit` entries of the suffix and remember the
        // version key of the last one so we can advance the cursor.
        let mut changes: Vec<PixelChange> = Vec::new();
        let mut last_key: Option<u64> = None;
        for (k, v) in log.range(from_version..) {
            if (changes.len() as u64) >= limit {
                break;
            }
            last_key = Some(k);
            changes.push(v);
        }
        let next_version = match last_key {
            Some(k) => k + 1,
            // Nothing returned — either from_version is past the end, or
            // the log is empty. Either way the caller is caught up with
            // whatever the server currently has.
            None => from_version.max(current_version),
        };
        (changes, min_version, next_version)
    });
    ChangesResponse {
        changes,
        current_version,
        min_version,
        map_size,
        next_version,
    }
}

/// Returns a CHUNK_SIZE×CHUNK_SIZE tile of the map at tile coordinates
/// `(tile_x, tile_y)`. Edge tiles whose origin + CHUNK_SIZE exceeds the
/// current map size return a smaller row-major rectangle of size
/// `(min(CHUNK_SIZE, map_size - origin_x)) × (min(CHUNK_SIZE, map_size - origin_y))`.
///
/// Returns an empty vec if the requested tile is entirely outside the
/// current map.
///
/// Implementation: range-scans `PIXELS` over the y-rows that intersect the
/// tile and skips x-cells outside the column band. On the typical sparse
/// map this is much faster than the worst-case 65k point lookups.
pub fn get_map_chunk(tile_x: u16, tile_y: u16) -> MapSnapshot {
    let size = game_state().map_size;
    let ox = tile_x.saturating_mul(CHUNK_SIZE);
    let oy = tile_y.saturating_mul(CHUNK_SIZE);
    if ox >= size || oy >= size {
        return Vec::new();
    }
    let w = (size - ox).min(CHUNK_SIZE);
    let h = (size - oy).min(CHUNK_SIZE);

    // Tile (0,0) corresponds to the top-left of the centered map, i.e.
    // world coordinate (-half_neg, -half_neg). Convert tile-local origin
    // to world (centered) coordinates and reuse `read_region`.
    let half_neg = (size / 2) as i16;
    let world_x = (ox as i16) - half_neg;
    let world_y = (oy as i16) - half_neg;
    read_region(world_x, world_y, w, h)
}
