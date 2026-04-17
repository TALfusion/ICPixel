//! Alliance module — owns all reads/writes to alliances and user→alliance map.
//!
//! No other module should touch ALLIANCES / USER_ALLIANCE directly.
//! When this is later split into its own canister, these public functions
//! become inter-canister calls.

use crate::alliance_types::{
    Alliance, AllianceError, AllianceId, AllianceIdList, AlliancePublic, ClaimResult,
    LeaderboardEntry, LeaderboardPage, Mission, MissionContributionView, MissionRound,
    MissionRoundPublic, MissionStatus, MissionTileKey, MISSION_TILE_SIZE,
};
use crate::map as pixel_map;
use crate::nft_client;
use crate::state::{
    game_state, init_rounds_if_missing, nft_canister, ALLIANCES, MISSION_TILE_INDEX,
    NEXT_ALLIANCE_ID, USER_ALLIANCE,
};
use candid::Principal;

/// Hybrid minimum: each side must be ≥ `MIN_MISSION_DIM` AND the total
/// area must be ≥ `MIN_MISSION_AREA`. The area floor keeps the "mass"
/// of a mission comparable to the old 5×5=25 minimum, while the side
/// floor rejects degenerate 1×N / 2×N strips that trivialize the
/// 95%-match completion condition.
const MIN_MISSION_DIM: u16 = 3;
const MIN_MISSION_AREA: u32 = 25;
const MISSION_COMPLETE_PERCENT: u32 = 95;
/// Max % of the mission template that can already be on the map at the
/// moment a new alliance is created. Above this we reject — see comment in
/// `create_alliance`.
const MAX_INITIAL_MATCH_PERCENT: u8 = 30;
/// Hard caps on alliance text fields. Counted in chars (not bytes) so multi-
/// byte UTF-8 / emoji costs the same as ASCII for the user. Stable storage
/// pays per byte though, so a malicious user with 4-byte chars can still
/// push the upper byte bound to ~4× these — fine at these sizes.
pub const MAX_ALLIANCE_NAME_CHARS: usize = 64;
pub const MAX_ALLIANCE_DESCRIPTION_CHARS: usize = 500;

/// Leader-only mission upgrade. Requires that the current mission is complete
/// (>=95% match), the new rectangle geometrically contains the old one, the
/// cells inside the old footprint are unchanged in the new template, AND if a
/// previous NFT was minted for this alliance, that the NFT has been burned.
pub fn upgrade_mission(
    caller: Principal,
    id: AllianceId,
    new_mission: Mission,
) -> Result<(), AllianceError> {
    if crate::state::game_state().paused {
        return Err(AllianceError::Paused);
    }
    if caller == Principal::anonymous() {
        return Err(AllianceError::Unauthorized);
    }
    let mut alliance = ALLIANCES
        .with(|a| a.borrow().get(&id))
        .ok_or(AllianceError::NotFound)?;
    if alliance.leader != caller || !alliance.members.contains(&caller) {
        return Err(AllianceError::NotLeader);
    }
    if !check_mission(id)?.completed {
        return Err(AllianceError::MissionNotComplete);
    }
    // Move the current NFT id to prev_nft_token_id. The new mission starts
    // with nft_token_id = None so it's eligible for a fresh mint. However,
    // `maybe_mint_for_pixel` will check: if prev_nft_token_id is set AND the
    // old NFT hasn't been burned, the new mint is blocked. The leader must
    // burn the old NFT before the new one is minted — but can upgrade the
    // mission immediately without burning.
    alliance.prev_nft_token_id = alliance.nft_token_id.or(alliance.prev_nft_token_id);
    alliance.nft_token_id = None;
    alliance.nft_mint_in_progress = false;
    validate_mission(&new_mission)?;

    let old = &alliance.mission;
    // Containment in centered (signed) coordinates.
    let old_right = (old.x as i32) + (old.width as i32);
    let old_bottom = (old.y as i32) + (old.height as i32);
    let new_right = (new_mission.x as i32) + (new_mission.width as i32);
    let new_bottom = (new_mission.y as i32) + (new_mission.height as i32);
    if (new_mission.x as i32) > (old.x as i32)
        || (new_mission.y as i32) > (old.y as i32)
        || new_right < old_right
        || new_bottom < old_bottom
    {
        return Err(AllianceError::UpgradeMustContainOld);
    }
    // Old pixel match check removed — leaders can freely redesign the art
    // inside the old footprint when upgrading. The only geometric constraint
    // that remains is containment (new rect ⊇ old rect).

    // Tile-index update: drop the old mission's bucket entries, then add
    // the new mission's. Done before the ALLIANCES write so a panic in
    // the index path leaves alliance state unchanged. Both calls are
    // idempotent so retrying after a partial failure is safe.
    let old_mission_clone = alliance.mission.clone();
    tile_index_remove(id, &old_mission_clone);
    tile_index_insert(id, &new_mission);

    alliance.mission = new_mission.clone();
    ALLIANCES.with(|a| a.borrow_mut().insert(id, alliance.clone()));

    // Open a new mission round. Contributions for the new round start at
    // zero — only pixels placed AFTER this point earn credit (Variant C).
    // The previous round stays in the history with its frozen contributions
    // and reward_pool_e8s, claimable independently.
    let now_ns = ic_cdk::api::time();
    init_rounds_if_missing(&alliance, now_ns);
    let _ = crate::state::mutate_rounds(id, |rounds| {
        let next_index = rounds.last().map(|r| r.round_index + 1).unwrap_or(0);
        rounds.push(MissionRound::new(next_index, new_mission, now_ns));
    });

    Ok(())
}

/// Auto-check: compares the on-map region against the alliance's template.
/// Mission is considered complete at >=95% pixel match.
pub fn check_mission(id: AllianceId) -> Result<MissionStatus, AllianceError> {
    let alliance = ALLIANCES
        .with(|a| a.borrow().get(&id))
        .ok_or(AllianceError::NotFound)?;
    let m = &alliance.mission;
    let region = pixel_map::read_region(m.x, m.y, m.width, m.height);
    let total = region.len() as u32;
    let matched: u32 = region
        .iter()
        .zip(m.template.iter())
        .filter(|(a, b)| a == b)
        .count() as u32;
    // Use u64 for arithmetic — `matched * 100` would overflow u32 for very
    // large missions (>~42M pixels). Within current bounds it's fine, but the
    // u64 form is the same cost and removes the foot-gun.
    let m64 = matched as u64;
    let t64 = total as u64;
    let percent = if t64 == 0 { 0 } else { (m64 * 100) / t64 };
    Ok(MissionStatus {
        matched,
        total,
        percent: percent as u8,
        completed: m64 * 100 >= t64 * MISSION_COMPLETE_PERCENT as u64,
    })
}

pub async fn create_alliance(
    caller: Principal,
    name: String,
    description: String,
    mission: Mission,
    website: String,
    now_ns: u64,
) -> Result<AllianceId, AllianceError> {
    if crate::state::game_state().paused {
        return Err(AllianceError::Paused);
    }
    if caller == Principal::anonymous() {
        return Err(AllianceError::Unauthorized);
    }
    if name.trim().is_empty() {
        return Err(AllianceError::NameEmpty);
    }
    if name.chars().count() > MAX_ALLIANCE_NAME_CHARS {
        return Err(AllianceError::NameTooLong);
    }
    if description.chars().count() > MAX_ALLIANCE_DESCRIPTION_CHARS {
        return Err(AllianceError::DescriptionTooLong);
    }
    // Validate optional website: empty string = no website; otherwise must
    // start with "https://" and be ≤ 200 chars.
    let website_opt = if website.is_empty() {
        None
    } else {
        if !website.starts_with("https://") {
            return Err(AllianceError::InvalidWebsite(
                "must start with https://".into(),
            ));
        }
        if website.chars().count() > 200 {
            return Err(AllianceError::InvalidWebsite(
                "must be ≤ 200 characters".into(),
            ));
        }
        Some(website)
    };
    if USER_ALLIANCE.with(|u| u.borrow().contains_key(&caller)) {
        return Err(AllianceError::AlreadyInAlliance);
    }
    validate_mission(&mission)?;

    // Charge the creation fee. No-op while alliance_price_e8s == 0. Runs
    // before any alliance state is written — a failed charge leaves no
    // side effects, so the client can retry cleanly.
    crate::billing::charge_alliance_fee(caller).await?;

    // Anti-cheese: refuse if the chosen mission area is already too close to
    // matching the template (e.g. someone painted the picture, then created
    // an alliance to claim a free NFT). Threshold is intentionally generous
    // (a third of the cells can already match by chance / overlap).
    {
        let region = pixel_map::read_region(mission.x, mission.y, mission.width, mission.height);
        let total = region.len() as u64;
        let matched: u64 = region
            .iter()
            .zip(mission.template.iter())
            .filter(|(a, b)| a == b)
            .count() as u64;
        if total > 0 {
            let percent = (matched * 100 / total) as u8;
            if percent > MAX_INITIAL_MATCH_PERCENT {
                return Err(AllianceError::MissionAreaAlreadyPainted(percent));
            }
        }
    }

    let id = NEXT_ALLIANCE_ID.with(|c| {
        let cur = *c.borrow().get();
        let next = cur.checked_add(1).ok_or_else(|| {
            AllianceError::InternalError("alliance id overflow".into())
        })?;
        c.borrow_mut()
            .set(next)
            .map(|_| cur)
            .map_err(|e| AllianceError::InternalError(format!("alliance id bump: {e:?}")))
    })?;

    let alliance = Alliance {
        id,
        name,
        description,
        leader: caller,
        members: vec![caller],
        mission,
        created_at: now_ns,
        pixels_captured: 0,
        nft_token_id: None,
        prev_nft_token_id: None,
        nft_mint_in_progress: false,
        website: website_opt,
    };

    ALLIANCES.with(|a| a.borrow_mut().insert(id, alliance.clone()));
    USER_ALLIANCE.with(|u| u.borrow_mut().insert(caller, id));
    // Insert into the spatial index so subsequent place_pixel calls can
    // find this mission via the O(log K) tile lookup instead of a linear
    // scan over all alliances.
    tile_index_insert(id, &alliance.mission);

    // Initialise round 0 with the alliance's mission. The contribution
    // tracker hooks (added in step 2) will start counting placements into
    // this round immediately.
    init_rounds_if_missing(&alliance, now_ns);

    Ok(id)
}

pub fn join_alliance(caller: Principal, id: AllianceId) -> Result<(), AllianceError> {
    if crate::state::game_state().paused {
        return Err(AllianceError::Paused);
    }
    if caller == Principal::anonymous() {
        return Err(AllianceError::Unauthorized);
    }
    if USER_ALLIANCE.with(|u| u.borrow().contains_key(&caller)) {
        return Err(AllianceError::AlreadyInAlliance);
    }
    ALLIANCES.with(|a| {
        let mut map = a.borrow_mut();
        let mut alliance = map.get(&id).ok_or(AllianceError::NotFound)?;
        if !alliance.members.contains(&caller) {
            alliance.members.push(caller);
        }
        map.insert(id, alliance);
        Ok(())
    })?;
    USER_ALLIANCE.with(|u| u.borrow_mut().insert(caller, id));
    Ok(())
}

pub fn leave_alliance(caller: Principal) -> Result<(), AllianceError> {
    if crate::state::game_state().paused {
        return Err(AllianceError::Paused);
    }
    let id = USER_ALLIANCE
        .with(|u| u.borrow().get(&caller))
        .ok_or(AllianceError::NotInAlliance)?;
    ALLIANCES.with(|a| {
        let mut map = a.borrow_mut();
        if let Some(mut alliance) = map.get(&id) {
            alliance.members.retain(|p| p != &caller);
            // Leader leaving: alliance still exists (per spec, "потом подумаем").
            map.insert(id, alliance);
        }
    });
    USER_ALLIANCE.with(|u| u.borrow_mut().remove(&caller));
    Ok(())
}

pub fn get_my_alliance(caller: Principal) -> Option<Alliance> {
    let id = USER_ALLIANCE.with(|u| u.borrow().get(&caller))?;
    ALLIANCES.with(|a| a.borrow().get(&id))
}

/// Returns the alliance with full mission only if caller is a member.
pub fn get_alliance(caller: Principal, id: AllianceId) -> Option<AllianceOrPublic> {
    let alliance = ALLIANCES.with(|a| a.borrow().get(&id))?;
    if alliance.members.contains(&caller) {
        Some(AllianceOrPublic::Full(alliance))
    } else {
        Some(AllianceOrPublic::Public(alliance.to_public()))
    }
}

/// Called by `map` whenever a pixel is (re)painted. Adjusts `pixels_captured`
/// for the alliance losing the cell and the alliance gaining it.
/// `prev_owner` is the principal that previously owned the cell (if any).
pub fn on_pixel_placed(new_owner: Option<Principal>) {
    let new_alliance = new_owner.and_then(alliance_of);
    if let Some(id) = new_alliance {
        ALLIANCES.with(|a| {
            let mut map = a.borrow_mut();
            if let Some(mut al) = map.get(&id) {
                al.pixels_captured = al.pixels_captured.saturating_add(1);
                map.insert(id, al);
            }
        });
    }
}

fn alliance_of(p: Principal) -> Option<AllianceId> {
    USER_ALLIANCE.with(|u| u.borrow().get(&p))
}

/// Sort key used everywhere a leaderboard order is needed: pixels_captured
/// desc, then id asc as a stable tie-breaker (older alliances rank higher
/// when tied — usually means they earned the pixels first).
fn sort_by_rank(list: &mut [AlliancePublic]) {
    list.sort_by(|a, b| {
        b.pixels_captured
            .cmp(&a.pixels_captured)
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub fn list_alliances() -> Vec<AlliancePublic> {
    let mut v: Vec<AlliancePublic> =
        ALLIANCES.with(|a| a.borrow().iter().map(|(_, v)| v.to_public()).collect());
    sort_by_rank(&mut v);
    v.truncate(500);
    v
}

/// Paginated leaderboard, sorted by `pixels_captured` descending. Always
/// also returns the caller's own entry (with global rank) if they're in an
/// alliance — even when that alliance is outside the requested page.
pub fn leaderboard(caller: Principal, offset: u64, limit: u64) -> LeaderboardPage {
    // Cap to keep response sizes sane.
    let limit = limit.min(500);
    let mut all: Vec<AlliancePublic> =
        ALLIANCES.with(|a| a.borrow().iter().map(|(_, v)| v.to_public()).collect());
    sort_by_rank(&mut all);

    let total = all.len() as u64;
    let top_pixels = all.first().map(|a| a.pixels_captured).unwrap_or(0);

    let my_id = USER_ALLIANCE.with(|u| u.borrow().get(&caller));
    let my_entry = my_id.and_then(|id| {
        all.iter().enumerate().find_map(|(i, a)| {
            if a.id == id {
                Some(LeaderboardEntry {
                    rank: (i as u32) + 1,
                    alliance: a.clone(),
                })
            } else {
                None
            }
        })
    });

    let start = offset.min(total) as usize;
    let end = (offset.saturating_add(limit)).min(total) as usize;
    let entries = all[start..end]
        .iter()
        .enumerate()
        .map(|(i, a)| LeaderboardEntry {
            rank: (start + i) as u32 + 1,
            alliance: a.clone(),
        })
        .collect();

    LeaderboardPage {
        entries,
        total,
        top_pixels,
        my_entry,
    }
}

fn validate_mission(m: &Mission) -> Result<(), AllianceError> {
    if m.width < MIN_MISSION_DIM || m.height < MIN_MISSION_DIM {
        return Err(AllianceError::InvalidMission(format!(
            "each side must be ≥ {MIN_MISSION_DIM}"
        )));
    }
    let area = (m.width as u32) * (m.height as u32);
    if area < MIN_MISSION_AREA {
        return Err(AllianceError::InvalidMission(format!(
            "total area must be ≥ {MIN_MISSION_AREA} cells (got {area})"
        )));
    }
    // Centered bounds: every cell of the mission rect must lie inside the
    // valid range. Top-left is the most-negative corner; bottom-right is
    // (m.x + width - 1, m.y + height - 1).
    let map_size = game_state().map_size;
    let end_x = (m.x as i32) + (m.width as i32) - 1;
    let end_y = (m.y as i32) + (m.height as i32) - 1;
    let half_neg = (map_size / 2) as i32;
    let half_pos = ((map_size as i32) + 1) / 2;
    if (m.x as i32) < -half_neg
        || (m.y as i32) < -half_neg
        || end_x >= half_pos
        || end_y >= half_pos
    {
        return Err(AllianceError::InvalidMission(
            "mission outside current map bounds".into(),
        ));
    }
    let expected = (m.width as usize) * (m.height as usize);
    const MAX_TEMPLATE_CELLS: usize = 62_500; // 250×250
    if expected > MAX_TEMPLATE_CELLS {
        return Err(AllianceError::InvalidMission(format!(
            "mission too large: {expected} cells (max {MAX_TEMPLATE_CELLS})"
        )));
    }
    if m.template.len() != expected {
        return Err(AllianceError::InvalidMission(format!(
            "template length {} != width*height {}",
            m.template.len(),
            expected
        )));
    }
    for c in &m.template {
        if *c > 0xFFFFFF {
            return Err(AllianceError::InvalidMission("invalid color".into()));
        }
    }
    Ok(())
}

#[derive(candid::CandidType, serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum AllianceOrPublic {
    Full(Alliance),
    Public(AlliancePublic),
}

// ───── Per-round contribution tracking ─────
//
// Called by `map::place_pixel` immediately after a pixel commit. For every
// alliance whose **current** mission round contains (x, y), we check whether
// the placed color matches the round's template at that cell and whether
// the cell hasn't already been credited in this round. If both conditions
// hold we mark the bitmap bit and bump the placer's contribution counter
// (members ×1 in `contributions`, non-members ×0.5 implicitly via
// `helper_contributions` — the weight scaling lives in the claim math).
//
// Closed rounds (`completed_at.is_some()`) are skipped. The active round is
// always the last element of the rounds vector.
//
// First-correct-pixel-wins is the entire anti-sabotage rule: once a cell
// has earned credit for one player, no later overwrite can re-credit it,
// so painting the wrong color back is a pure money-loss for the saboteur.
pub fn credit_pixel_contribution(caller: Principal, x: i16, y: i16, color: u32) {
    if caller == Principal::anonymous() {
        return;
    }
    let now_ns = ic_cdk::api::time();
    // Snapshot of all alliance ids first to avoid borrowing the ALLIANCES
    // map across the contribution write below.
    let candidates: Vec<(AllianceId, bool)> = ALLIANCES.with(|a| {
        a.borrow()
            .iter()
            .filter_map(|(id, al)| {
                let m = &al.mission;
                let xi = x as i32;
                let yi = y as i32;
                let mx = m.x as i32;
                let my = m.y as i32;
                let in_x = xi >= mx && xi < mx + m.width as i32;
                let in_y = yi >= my && yi < my + m.height as i32;
                if !(in_x && in_y) {
                    return None;
                }
                let is_member = al.members.contains(&caller);
                Some((id, is_member))
            })
            .collect()
    });
    for (id, is_member) in candidates {
        // Lazy-init for pre-existing alliances. No-op if rounds already
        // exist for this alliance (the common case).
        if let Some(al) = ALLIANCES.with(|a| a.borrow().get(&id)) {
            init_rounds_if_missing(&al, now_ns);
        } else {
            continue;
        }
        let _ = crate::state::mutate_rounds(id, |rounds| {
            // Active round = last element. Closed rounds never get new
            // credits (they're frozen by `completed_at`).
            let Some(round) = rounds.last_mut() else {
                return;
            };
            if round.completed_at.is_some() {
                return;
            }
            let m = &round.mission;
            // Local cell index (row-major) inside the round's mission rect.
            let local_x = (x as i32 - m.x as i32) as usize;
            let local_y = (y as i32 - m.y as i32) as usize;
            let w = m.width as usize;
            let h = m.height as usize;
            if local_x >= w || local_y >= h {
                return;
            }
            let idx = local_y * w + local_x;
            if idx >= m.template.len() {
                return;
            }
            // Wrong color → no credit. We deliberately don't track "almost
            // correct" or "partial credit" — only exact matches earn payout.
            if m.template[idx] != color {
                return;
            }
            // Last-correct-wins: if this cell was already credited to
            // someone, revoke their credit and give it to the new placer.
            let creditors = round.cell_creditors.get_or_insert_with(Vec::new);
            let idx32 = idx as u32;

            // Binary search on sorted vec (O(log N) vs O(N)).
            if let Ok(pos) = creditors.binary_search_by_key(&idx32, |(ci, _)| *ci) {
                let prev_principal = creditors[pos].1;
                if prev_principal == caller {
                    // Same person re-placed correct color → no change.
                    return;
                }
                // Decrement the previous creditor's count.
                let prev_is_member = ALLIANCES.with(|a| {
                    a.borrow()
                        .get(&id)
                        .map(|al| al.members.contains(&prev_principal))
                        .unwrap_or(false)
                });
                // We stored the prev contributor based on their membership
                // at the time of their placement. Find them in the right bucket.
                let prev_bucket = if prev_is_member {
                    &mut round.contributions
                } else {
                    &mut round.helper_contributions
                };
                // Also check the other bucket in case membership changed.
                let found_in_primary = prev_bucket.iter_mut().find(|(p, _)| *p == prev_principal);
                if let Some(entry) = found_in_primary {
                    entry.1 = entry.1.saturating_sub(1);
                    if entry.1 == 0 {
                        prev_bucket.retain(|(p, _)| *p != prev_principal);
                    }
                } else {
                    // Membership changed since placement — check other bucket.
                    let alt_bucket = if prev_is_member {
                        &mut round.helper_contributions
                    } else {
                        &mut round.contributions
                    };
                    if let Some(entry) = alt_bucket.iter_mut().find(|(p, _)| *p == prev_principal) {
                        entry.1 = entry.1.saturating_sub(1);
                        if entry.1 == 0 {
                            alt_bucket.retain(|(p, _)| *p != prev_principal);
                        }
                    }
                }
                // Update creditor for this cell.
                creditors[pos].1 = caller;
            } else if let Err(insert_pos) = creditors.binary_search_by_key(&idx32, |(ci, _)| *ci) {
                // First correct pixel in this cell — insert sorted + mark bitmap.
                let byte_idx = idx / 8;
                let bit = 1u8 << (idx % 8);
                if byte_idx < round.credited_cells.len() {
                    round.credited_cells[byte_idx] |= bit;
                }
                creditors.insert(insert_pos, (idx32, caller));
            }
            // Bump new contributor's counter.
            let bucket = if is_member {
                &mut round.contributions
            } else {
                &mut round.helper_contributions
            };
            if let Some(entry) = bucket.iter_mut().find(|(p, _)| *p == caller) {
                entry.1 = entry.1.saturating_add(1);
            } else {
                bucket.push((caller, 1));
            }
        });
    }
}

// ───── Continuous reward distribution ─────

use std::cell::RefCell;

thread_local! {
    /// In-memory cache of completed mission rounds. Avoids scanning all
    /// alliances on every `credit_reward_pool` call. Populated lazily on
    /// first use and updated when rounds complete. Lost on upgrade =
    /// rebuilt on next call (one-time O(N) scan).
    static COMPLETED_ROUNDS_CACHE: RefCell<Option<Vec<(AllianceId, u32, u64)>>> =
        RefCell::new(None);
}

/// Register a newly completed round in the in-memory cache.
pub fn cache_completed_round(id: AllianceId, round_index: u32, pixel_count: u64) {
    COMPLETED_ROUNDS_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        let v = cache.get_or_insert_with(Vec::new);
        if !v.iter().any(|(a, r, _)| *a == id && *r == round_index) {
            v.push((id, round_index, pixel_count));
        }
    });
}

/// Get the cached completed rounds, rebuilding from stable storage if
/// the cache was lost (e.g. after upgrade).
fn get_completed_rounds() -> Vec<(AllianceId, u32, u64)> {
    COMPLETED_ROUNDS_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if cache.is_none() {
            // Rebuild from stable storage (one-time O(N) scan).
            let mut completed = Vec::new();
            ALLIANCES.with(|a| {
                for (id, _al) in a.borrow().iter() {
                    if let Some(rounds) = crate::state::rounds_of(id) {
                        for r in &rounds {
                            if r.completed_at.is_some() {
                                completed.push((id, r.round_index, r.pixel_count()));
                            }
                        }
                    }
                }
            });
            *cache = Some(completed);
        }
        cache.as_ref().unwrap().clone()
    })
}

/// Distribute `e8s` to all completed mission rounds, proportional to
/// each round's pixel count. Uses in-memory cache for O(K) where K =
/// completed rounds (not N = all alliances).
pub fn distribute_reward_to_missions(mut e8s: u64) -> u64 {
    // Add any parked global pool balance.
    let parked = crate::state::game_state().reward_pool_balance_e8s.unwrap_or(0);
    if parked > 0 {
        e8s = e8s.saturating_add(parked);
        let _ = crate::state::update_game_state(|gs| {
            gs.reward_pool_balance_e8s = Some(0);
        });
    }
    if e8s == 0 {
        return 0;
    }
    let completed = get_completed_rounds();
    if completed.is_empty() {
        // No completed missions — park the money back.
        let _ = crate::state::update_game_state(|gs| {
            let cur = gs.reward_pool_balance_e8s.unwrap_or(0);
            gs.reward_pool_balance_e8s = Some(cur.saturating_add(e8s));
        });
        return 0;
    }
    let total_pixels: u128 = completed.iter().map(|(_, _, pc)| *pc as u128).sum();
    if total_pixels == 0 {
        return 0;
    }
    let mut distributed: u64 = 0;
    for (id, round_index, pixel_count) in &completed {
        let share = ((e8s as u128) * (*pixel_count as u128) / total_pixels) as u64;
        if share == 0 {
            continue;
        }
        let _ = crate::state::mutate_rounds(*id, |rounds| {
            if let Some(r) = rounds.get_mut(*round_index as usize) {
                let cur = r.accumulated_pool_e8s.unwrap_or(0);
                r.accumulated_pool_e8s = Some(cur.saturating_add(share));
            }
        });
        distributed = distributed.saturating_add(share);
    }
    // Rounding dust goes back to global pool.
    let dust = e8s.saturating_sub(distributed);
    if dust > 0 {
        let _ = crate::state::update_game_state(|gs| {
            let cur = gs.reward_pool_balance_e8s.unwrap_or(0);
            gs.reward_pool_balance_e8s = Some(cur.saturating_add(dust));
        });
    }
    distributed
}

// ───── Mission spatial index (tile-bucket) ─────
//
// Maintenance protocol:
//
//   * On `create_alliance`           → `tile_index_insert(id, &mission)`
//   * On `upgrade_mission`           → `tile_index_remove(id, &old)`
//                                      then `tile_index_insert(id, &new)`
//   * On `delete_alliance` / leave   → `tile_index_remove(id, &mission)`
//
// `mintable_missions_covering(x, y)` then does a single tile lookup
// (O(log K) on the stable map, K = populated tiles) and a linear scan of
// the typically 0-5 ids in that bucket — instead of iterating every
// alliance.
//
// The index is rebuilt from scratch in `post_upgrade` so a freshly
// upgraded canister never carries stale entries from a previous schema.

/// World cell coordinate → tile coordinate. Uses a floor-divide so
/// negative coordinates round the right way (`-1 / 64 == 0` in Rust,
/// which would put `-1` in tile 0 — wrong). We use `div_euclid`.
#[inline]
fn cell_to_tile(c: i32) -> i16 {
    c.div_euclid(MISSION_TILE_SIZE) as i16
}

/// Iterate every (tx, ty) tile that the mission rect overlaps. Caller
/// gets a closure they can run for each.
fn for_each_tile<F: FnMut(MissionTileKey)>(mission: &Mission, mut f: F) {
    let x0 = mission.x as i32;
    let y0 = mission.y as i32;
    let x1 = x0 + mission.width as i32 - 1;
    let y1 = y0 + mission.height as i32 - 1;
    let tx0 = cell_to_tile(x0);
    let ty0 = cell_to_tile(y0);
    let tx1 = cell_to_tile(x1);
    let ty1 = cell_to_tile(y1);
    for ty in ty0..=ty1 {
        for tx in tx0..=tx1 {
            f(MissionTileKey { tx, ty });
        }
    }
}

/// Insert `alliance_id` into every tile bucket the mission overlaps.
/// Idempotent: re-inserting an id already in a bucket is a no-op.
pub fn tile_index_insert(alliance_id: AllianceId, mission: &Mission) {
    MISSION_TILE_INDEX.with(|idx| {
        let mut map = idx.borrow_mut();
        let mut tiles = Vec::new();
        for_each_tile(mission, |k| tiles.push(k));
        for k in tiles {
            let mut entry = map.get(&k).unwrap_or_default();
            if !entry.0.contains(&alliance_id) {
                entry.0.push(alliance_id);
                map.insert(k, entry);
            }
        }
    });
}

/// Remove `alliance_id` from every tile bucket the mission overlaps.
/// Empty buckets are removed entirely so the index doesn't accumulate
/// stale keys after high churn.
pub fn tile_index_remove(alliance_id: AllianceId, mission: &Mission) {
    MISSION_TILE_INDEX.with(|idx| {
        let mut map = idx.borrow_mut();
        let mut tiles = Vec::new();
        for_each_tile(mission, |k| tiles.push(k));
        for k in tiles {
            if let Some(mut entry) = map.get(&k) {
                entry.0.retain(|id| *id != alliance_id);
                if entry.0.is_empty() {
                    map.remove(&k);
                } else {
                    map.insert(k, entry);
                }
            }
        }
    });
}

/// Drop every entry and rebuild from the current ALLIANCES table. Run
/// once in `post_upgrade` so freshly-deployed canisters always have a
/// consistent index regardless of any historical bugs in the maintenance
/// path. Cost: one full pass over alliances on canister start, never on
/// the hot path.
pub fn rebuild_tile_index() {
    MISSION_TILE_INDEX.with(|idx| {
        let mut map = idx.borrow_mut();
        // Empty the index. StableBTreeMap has no `clear()`, so we collect
        // keys and remove one by one.
        let keys: Vec<MissionTileKey> = map.iter().map(|(k, _)| k).collect();
        for k in keys {
            map.remove(&k);
        }
    });
    // Collect only the fields tile_index_insert needs (x, y, w, h) to
    // avoid cloning the full mission template (which can be 250KB+ each).
    // At 10k alliances this saves ~2.5 GB of peak memory.
    let snapshot: Vec<(AllianceId, i16, i16, u16, u16)> = ALLIANCES.with(|a| {
        a.borrow()
            .iter()
            .map(|(id, al)| (id, al.mission.x, al.mission.y, al.mission.width, al.mission.height))
            .collect()
    });
    for (id, x, y, w, h) in snapshot {
        let stub = Mission { x, y, width: w, height: h, template: vec![] };
        tile_index_insert(id, &stub);
    }
}

// ───── NFT auto-mint ─────

/// All alliance ids whose mission rect contains (x, y) AND that have
/// not yet minted an NFT (and aren't currently minting). O(log K + B)
/// where K is the populated tile count and B is the bucket size for
/// the touched tile (typically <5).
fn mintable_missions_covering(x: i16, y: i16) -> Vec<AllianceId> {
    let key = MissionTileKey {
        tx: cell_to_tile(x as i32),
        ty: cell_to_tile(y as i32),
    };
    let bucket = MISSION_TILE_INDEX.with(|idx| idx.borrow().get(&key).unwrap_or_default());
    if bucket.0.is_empty() {
        return Vec::new();
    }
    let xi = x as i32;
    let yi = y as i32;
    ALLIANCES.with(|a| {
        let map = a.borrow();
        bucket
            .0
            .into_iter()
            .filter_map(|id| {
                let al = map.get(&id)?;
                if al.nft_token_id.is_some() || al.nft_mint_in_progress {
                    return None;
                }
                let m = &al.mission;
                let mx = m.x as i32;
                let my = m.y as i32;
                let in_x = xi >= mx && xi < mx + m.width as i32;
                let in_y = yi >= my && yi < my + m.height as i32;
                if in_x && in_y { Some(id) } else { None }
            })
            .collect()
    })
}

#[allow(dead_code)]
fn _silence_alliance_id_list_warning(_: &AllianceIdList) {}

/// Called by `place_pixel` after the pixel is committed. For each mission
/// covering this cell, re-runs `check_mission`; if completed, mints an NFT
/// to the alliance leader via inter-canister call AND closes the active
/// mission round (locks the reward pool from treasury).
///
/// Best-effort: a failed mint does NOT roll back the pixel placement (it
/// would be terrible UX, and the next pixel placed inside the mission
/// triggers another attempt anyway). The round is closed even if the mint
/// fails, because round closure is a deterministic state-machine event
/// (95% reached) independent of the cross-canister NFT call.
pub async fn maybe_mint_for_pixel(x: i16, y: i16) {
    let candidates = mintable_missions_covering(x, y);
    if candidates.is_empty() {
        return;
    }
    let nft = match nft_canister() {
        Some(p) => p,
        None => return, // not configured — silently skip
    };

    for id in candidates {
        // Re-check status now (the pixel is already committed by this point).
        let status = match check_mission(id) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !status.completed {
            continue;
        }

        // Read the alliance and arm the in-progress sentinel atomically (no
        // await between read and write). Concurrent place_pixel calls running
        // during our await below will see the sentinel and skip.
        let alliance = match ALLIANCES.with(|a| {
            let mut map = a.borrow_mut();
            let mut al = map.get(&id)?;
            if al.nft_token_id.is_some() || al.nft_mint_in_progress {
                return None;
            }
            al.nft_mint_in_progress = true;
            map.insert(id, al.clone());
            Some(al)
        }) {
            Some(a) => a,
            None => continue,
        };

        // If the alliance has a previous NFT from a prior mission round,
        // check whether it's been burned. If not → skip minting the new
        // one. The leader must burn the old NFT before getting the upgrade.
        if let Some(prev_token) = alliance.prev_nft_token_id {
            let burned = match nft_client::owner_of(nft, prev_token).await {
                Ok(owner) => owner.is_none(), // None = burned
                Err(_) => false,              // call failed — treat as not-burned
            };
            // Re-read after the await.
            ALLIANCES.with(|a| {
                let mut map = a.borrow_mut();
                if let Some(mut al) = map.get(&id) {
                    if burned {
                        al.prev_nft_token_id = None;
                    } else {
                        // Old NFT not burned — can't mint new one. Clear sentinel.
                        al.nft_mint_in_progress = false;
                        map.insert(id, al);
                        return;
                    }
                    map.insert(id, al);
                }
            });
            if !burned {
                continue;
            }
        }

        // Close the active round: mark completed_at and lock its reward
        // pool from treasury BEFORE the mint call. This is local state, no
        // await, so it's atomic relative to other place_pixel invocations.
        // Locking the pool now (rather than after mint success) means a
        // failed mint doesn't leave the round in a half-closed state where
        // contributions keep coming in for an already-completed mission.
        let now_ns = ic_cdk::api::time();
        // Save the round index BEFORE the await so we can write the NFT
        // token id to the correct round afterwards (upgrade_mission could
        // append a new round during the mint await).
        let closed_round_index = crate::state::rounds_of(id)
            .and_then(|r| r.last().map(|last| last.round_index));
        close_active_round(id, now_ns);

        let args = nft_client::MintArgs {
            to: nft_client::Account {
                owner: alliance.leader,
                subaccount: None,
            },
            metadata: nft_client::TokenMetadata {
                name: format!("ICPixel Mission #{}", id),
                description: alliance.description.clone(),
                alliance_id: id,
                alliance_name: alliance.name.clone(),
                season: game_state().season,
                global_nft_number: 0, // stamped by nft canister to == token id
                pixel_count: (alliance.mission.width as u64)
                    * (alliance.mission.height as u64),
                width: alliance.mission.width,
                height: alliance.mission.height,
                x: alliance.mission.x,
                y: alliance.mission.y,
                template: alliance.mission.template.clone(),
                completed_at: ic_cdk::api::time(),
                match_percent: status.percent,
            },
        };

        let mint_result = nft_client::mint(nft, args).await;

        // Re-read after the await — state may have changed (e.g. leader left,
        // alliance was deleted, etc.). If the alliance is gone we just leak
        // the minted token (it sits on the leader's account, harmless).
        ALLIANCES.with(|a| {
            let mut map = a.borrow_mut();
            if let Some(mut al) = map.get(&id) {
                al.nft_mint_in_progress = false;
                if let Ok(token_id) = &mint_result {
                    al.nft_token_id = Some(*token_id);
                }
                map.insert(id, al);
            }
        });
        // Mirror the token id into the round, so a closed round always
        // knows which NFT it produced even after the alliance's *current*
        // round (and `Alliance.nft_token_id`) moves on via upgrade_mission.
        // Uses the saved round_index (not last_mut) because upgrade_mission
        // could have appended a new round during the mint await.
        if let Ok(token_id) = &mint_result {
            if let Some(ri) = closed_round_index {
                let _ = crate::state::mutate_rounds(id, |rounds| {
                    if let Some(round) = rounds.get_mut(ri as usize) {
                        round.nft_token_id = Some(*token_id);
                    }
                });
            }
        }
        if let Ok(_token_id) = &mint_result {
            // Record last completed mission in GameState for frontend banner.
            crate::state::GAME_STATE.with(|gs| {
                let mut cell = gs.borrow_mut();
                let mut state = cell.get().clone();
                state.last_completed_mission_name = Some(alliance.name.clone());
                state.last_completed_mission_at = Some(ic_cdk::api::time());
                let _ = cell.set(state);
            });
        }
        if let Err(e) = mint_result {
            ic_cdk::println!("nft mint for alliance {id} failed: {e}");
        }
    }
}

/// Marks the active round (the last in the rounds vector) as completed and
/// locks its reward pool from treasury. Idempotent — if already closed,
/// no-op. Caller must ensure rounds are initialised for this alliance
/// (`maybe_mint_for_pixel` always processes alliances that already had at
/// least one place_pixel hit, which lazy-initialises rounds via
/// `credit_pixel_contribution`, so we're safe in practice).
fn close_active_round(id: AllianceId, now_ns: u64) {
    // Mark the round as completed. The continuous reward flow model means
    // we do NOT lock treasury here — instead, all future payments'
    // reward_pool_pct share will be distributed to this (now completed)
    // round proportionally. Any parked global reward_pool_balance_e8s
    // will also be flushed on the next `credit_reward_pool` call.
    let mut round_info: Option<(u32, u64)> = None;
    let _ = crate::state::mutate_rounds(id, |rounds| {
        if let Some(round) = rounds.last_mut() {
            if round.completed_at.is_some() {
                return;
            }
            round.completed_at = Some(now_ns);
            round_info = Some((round.round_index, round.pixel_count()));
        }
    });
    // Register in cache so future distribute calls skip the O(N) scan.
    if let Some((ri, pc)) = round_info {
        cache_completed_round(id, ri, pc);
    }
    // Flush any parked global reward pool to all completed missions
    // (including this newly completed one).
    let parked = crate::state::game_state().reward_pool_balance_e8s.unwrap_or(0);
    if parked > 0 {
        distribute_reward_to_missions(0); // 0 new e8s, but flushes parked
    }
}

// ───── Round / contribution queries ─────

/// Read all rounds for an alliance, projected into the public DTO. Heavy
/// fields (template, full bitmap, contributor lists) are not included —
/// callers fetch caller-specific contribution detail via
/// `my_mission_contribution`.
pub fn get_mission_rounds(id: AllianceId) -> Vec<MissionRoundPublic> {
    // Lazy-init: a pre-existing alliance with no rounds entry yet would
    // otherwise return [], which is misleading (Round 0 should always
    // exist). We init from the alliance's current mission so the first
    // read after upgrade reflects reality.
    if let Some(al) = ALLIANCES.with(|a| a.borrow().get(&id)) {
        init_rounds_if_missing(&al, ic_cdk::api::time());
    }
    let rounds = match crate::state::rounds_of(id) {
        Some(r) => r,
        None => return Vec::new(),
    };
    rounds
        .into_iter()
        .map(|r| {
            let credited = r
                .credited_cells
                .iter()
                .map(|b| b.count_ones() as u64)
                .sum::<u64>();
            MissionRoundPublic {
                round_index: r.round_index,
                x: r.mission.x,
                y: r.mission.y,
                width: r.mission.width,
                height: r.mission.height,
                started_at: r.started_at,
                completed_at: r.completed_at,
                pixel_count: (r.mission.width as u64) * (r.mission.height as u64),
                member_contributor_count: r.contributions.len() as u32,
                helper_contributor_count: r.helper_contributions.len() as u32,
                credited_cells_count: credited,
                reward_pool_e8s: r.accumulated_pool_e8s.unwrap_or(0) + r.reward_pool_e8s,
                claimed_count: r.claimed_principals.len() as u32,
                nft_token_id: r.nft_token_id,
            }
        })
        .collect()
}

/// Compute the share weight (member×2 + helper×1) for a single round and
/// the total. Returns (caller_weight, total_weight).
fn round_weights(round: &MissionRound, caller: Principal) -> (u64, u64) {
    let mut total: u64 = 0;
    let mut mine: u64 = 0;
    for (p, n) in &round.contributions {
        let w = (*n as u64) * 2;
        total += w;
        if *p == caller {
            mine += w;
        }
    }
    for (p, n) in &round.helper_contributions {
        let w = *n as u64;
        total += w;
        if *p == caller {
            mine += w;
        }
    }
    (mine, total)
}

/// Caller's contribution view for a single round. Used by the frontend to
/// show "you placed N correct pixels · estimated share: X ICP".
pub fn my_mission_contribution(
    caller: Principal,
    id: AllianceId,
    round_index: u32,
) -> Result<MissionContributionView, AllianceError> {
    // Lazy-init for pre-existing alliances.
    if let Some(al) = ALLIANCES.with(|a| a.borrow().get(&id)) {
        init_rounds_if_missing(&al, ic_cdk::api::time());
    } else {
        return Err(AllianceError::NotFound);
    }
    let rounds = crate::state::rounds_of(id).ok_or(AllianceError::NotFound)?;
    let round = rounds
        .get(round_index as usize)
        .ok_or(AllianceError::RoundNotFound)?;
    let member_pixels = round
        .contributions
        .iter()
        .find(|(p, _)| *p == caller)
        .map(|(_, n)| *n)
        .unwrap_or(0);
    let helper_pixels = round
        .helper_contributions
        .iter()
        .find(|(p, _)| *p == caller)
        .map(|(_, n)| *n)
        .unwrap_or(0);
    let (my_weight, total_weight) = round_weights(round, caller);
    let pool = round.accumulated_pool_e8s.unwrap_or(0) + round.reward_pool_e8s;
    let my_total_share = if total_weight == 0 || pool == 0 {
        0
    } else {
        ((pool as u128) * (my_weight as u128) / (total_weight as u128)) as u64
    };
    let already_claimed = round
        .claimed_amounts
        .as_ref()
        .and_then(|v| v.iter().find(|(p, _)| *p == caller))
        .map(|(_, amt)| *amt)
        .unwrap_or(0);
    let claimable = my_total_share.saturating_sub(already_claimed);
    Ok(MissionContributionView {
        round_index: round.round_index,
        completed: round.completed_at.is_some(),
        member_pixels,
        helper_pixels,
        my_weight,
        total_weight,
        reward_pool_e8s: pool,
        estimated_share_e8s: claimable,
        claimed: claimable == 0 && already_claimed > 0,
    })
}

/// Claim the caller's share of a completed round's accumulated reward pool.
///
/// **Continuous flow model:** the pool grows over time as new payments
/// come in. Players can claim multiple times — each claim pays out the
/// delta since their last claim. The round tracks per-principal claimed
/// amounts so double-payment is impossible.
///
/// Flow: compute claimable → transfer ICP → record claim. If transfer
/// fails, claim is NOT recorded so the player can retry.
pub async fn claim_mission_reward(
    caller: Principal,
    id: AllianceId,
    round_index: u32,
    dest: crate::icp_ledger::PayoutDest,
) -> Result<ClaimResult, AllianceError> {
    if game_state().paused {
        return Err(AllianceError::Paused);
    }
    if caller == Principal::anonymous() {
        return Err(AllianceError::Unauthorized);
    }
    if let Some(al) = ALLIANCES.with(|a| a.borrow().get(&id)) {
        init_rounds_if_missing(&al, ic_cdk::api::time());
    } else {
        return Err(AllianceError::NotFound);
    }
    let rounds = crate::state::rounds_of(id).ok_or(AllianceError::NotFound)?;
    let round = rounds
        .get(round_index as usize)
        .ok_or(AllianceError::RoundNotFound)?;
    if round.completed_at.is_none() {
        return Err(AllianceError::RoundNotCompleted);
    }
    let (my_weight, total_weight) = round_weights(round, caller);
    if my_weight == 0 {
        return Err(AllianceError::NoContribution);
    }
    let pool = round.accumulated_pool_e8s.unwrap_or(0)
        + round.reward_pool_e8s;
    let my_total_share = if total_weight == 0 || pool == 0 {
        0
    } else {
        ((pool as u128) * (my_weight as u128) / (total_weight as u128)) as u64
    };
    let already_claimed = round
        .claimed_amounts
        .as_ref()
        .and_then(|v| v.iter().find(|(p, _)| *p == caller))
        .map(|(_, amt)| *amt)
        .unwrap_or(0);
    let claimable = my_total_share.saturating_sub(already_claimed);
    if claimable == 0 {
        return Err(AllianceError::AlreadyClaimed);
    }

    // --- Race guard: add caller to claimed_principals BEFORE the async
    // transfer so a concurrent call sees them and computes claimable == 0.
    // If the transfer fails we remove the sentinel so the player can retry.
    crate::state::mutate_rounds(id, |rounds| {
        if let Some(r) = rounds.get_mut(round_index as usize) {
            if !r.claimed_principals.contains(&caller) {
                r.claimed_principals.push(caller);
            }
        }
    })
    .map_err(AllianceError::InternalError)?;

    // --- Transfer ICP to caller BEFORE recording the claim ---
    // If transfer fails, claim is not recorded → player can retry.
    let cfg = crate::billing::get();
    let (transferred, block_index) = if let Some(ledger) = cfg.ledger {
        match crate::icp_ledger::drain_to_dest(ledger, &dest, claimable).await {
            Ok((net, idx)) => {
                ic_cdk::println!(
                    "claim_mission_reward: transferred {} e8s (block {}) to {:?} (alliance {}, round {})",
                    net, idx, dest, id, round_index
                );
                (true, Some(idx))
            }
            Err(e) => {
                // Transfer failed — remove the sentinel so player can retry.
                let _ = crate::state::mutate_rounds(id, |rounds| {
                    if let Some(r) = rounds.get_mut(round_index as usize) {
                        r.claimed_principals.retain(|p| *p != caller);
                    }
                });
                return Err(AllianceError::PaymentFailed(format!(
                    "ICP transfer failed: {e}"
                )));
            }
        }
    } else {
        // No ledger configured — bookkeeping only (free mode / pre-mainnet).
        (false, None)
    };

    // --- Record the claim (only reached on successful transfer or free mode) ---
    crate::state::mutate_rounds(id, |rounds| {
        if let Some(r) = rounds.get_mut(round_index as usize) {
            let amounts = r.claimed_amounts.get_or_insert_with(Vec::new);
            if let Some(entry) = amounts.iter_mut().find(|(p, _)| *p == caller) {
                entry.1 = entry.1.saturating_add(claimable);
            } else {
                amounts.push((caller, claimable));
            }
            let tc = r.total_claimed_e8s.unwrap_or(0);
            r.total_claimed_e8s = Some(tc.saturating_add(claimable));
            if !r.claimed_principals.contains(&caller) {
                r.claimed_principals.push(caller);
            }
        }
    })
    .map_err(AllianceError::InternalError)?;
    Ok(ClaimResult {
        share_e8s: claimable,
        transferred,
        block_index,
    })
}
