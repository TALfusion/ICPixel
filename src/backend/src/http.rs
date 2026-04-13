//! Certified-HTTP gateway handler for the backend canister.
//!
//! Right now it only serves `/og.png` — a dynamic Open Graph preview image
//! used by Twitter/Discord/Telegram/etc when someone shares the game URL.
//! The PNG is rendered on-demand from the current map state at the standard
//! 1200×630 OG size.
//!
//! Boundary nodes cache HTTP responses keyed on URL for up to the value of
//! `Cache-Control: max-age`. We keep that short (5 minutes) so the preview
//! reflects the current map without hammering the canister on every request.

use crate::map;
use crate::state::game_state;
use candid::CandidType;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

thread_local! {
    /// Cached OG PNG blob. Regenerated when map size changes (8 times per
    /// season at most). Avoids re-rendering the 1200×630 PNG on every
    /// HTTP request — saves ~100M cycles per cache hit.
    static OG_CACHE: RefCell<Option<(u16, Vec<u8>)>> = RefCell::new(None);
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

pub fn handle(req: HttpRequest) -> HttpResponse {
    if req.method.to_uppercase() != "GET" {
        return text(405, "method not allowed");
    }

    // Strip query string + leading slash so "/og.png?v=1" still matches.
    let path = req.url.split('?').next().unwrap_or("");
    let path = path.trim_start_matches('/');

    match path {
        "og.png" => og_png(),
        _ => text(404, "not found"),
    }
}

fn text(status: u16, body: &str) -> HttpResponse {
    HttpResponse {
        status_code: status,
        headers: vec![("Content-Type".into(), "text/plain".into())],
        body: body.as_bytes().to_vec(),
    }
}

fn og_png() -> HttpResponse {
    let current_size = game_state().map_size;
    // Return cached PNG if map size hasn't changed. Regenerates only on
    // map growth (8 times per season max).
    let cached = OG_CACHE.with(|c| {
        let cache = c.borrow();
        if let Some((size, ref blob)) = *cache {
            if size == current_size {
                return Some(blob.clone());
            }
        }
        None
    });
    if let Some(body) = cached {
        return HttpResponse {
            status_code: 200,
            headers: vec![
                ("Content-Type".into(), "image/png".into()),
                ("Cache-Control".into(), "public, max-age=300".into()),
            ],
            body,
        };
    }
    match render_og_png() {
        Ok(body) => {
            OG_CACHE.with(|c| {
                *c.borrow_mut() = Some((current_size, body.clone()));
            });
            HttpResponse {
                status_code: 200,
                headers: vec![
                    ("Content-Type".into(), "image/png".into()),
                    ("Cache-Control".into(), "public, max-age=300".into()),
                ],
                body,
            }
        }
        Err(e) => {
            ic_cdk::println!("og_png: encode failed: {e}");
            HttpResponse {
                status_code: 500,
                headers: vec![("Content-Type".into(), "text/plain".into())],
                body: b"png encode failed".to_vec(),
            }
        }
    }
}

/// Invalidate the OG cache so the next request re-renders. Called when
/// the map content changes significantly (e.g. after map growth).
pub fn invalidate_og_cache() {
    OG_CACHE.with(|c| *c.borrow_mut() = None);
}

// ── Rendering ─────────────────────────────────────────────────────
//
// OG standard is 1200×630. The map is always square (N×N). We nearest-
// neighbor sample the map into a 600×600 tile centered inside a 1200×630
// dark-grey canvas, so the composition stays balanced at every map size
// from 1×1 up to 500×500.

const CANVAS_W: u32 = 1200;
const CANVAS_H: u32 = 630;
const TILE: u32 = 600;
const BG_R: u8 = 0x11;
const BG_G: u8 = 0x11;
const BG_B: u8 = 0x13;

fn render_og_png() -> Result<Vec<u8>, String> {
    let size_u16 = game_state().map_size;
    let n = size_u16 as u32;
    // Guard against a (hypothetical) 0-size map. Should never happen since
    // the smallest stage is 1, but keeps render_og_png total.
    if n == 0 {
        return encode_png(&solid_canvas());
    }
    // read_region takes centered coords. Top-left of the full map is
    // `-(size/2)` on both axes, which matches how get_map_chunk anchors its
    // tiles and how the frontend draws them.
    let half = (size_u16 / 2) as i16;
    let map = map::read_region(-half, -half, size_u16, size_u16);

    let mut rgba = solid_canvas();

    let offset_x = (CANVAS_W - TILE) / 2;
    let offset_y = (CANVAS_H - TILE) / 2;
    for dy in 0..TILE {
        // Nearest-neighbor: source row = dy * n / TILE. Works both for
        // upscaling (n < TILE) and downscaling (n > TILE).
        let sy = (dy * n) / TILE;
        for dx in 0..TILE {
            let sx = (dx * n) / TILE;
            let idx = (sy as usize) * (n as usize) + (sx as usize);
            let c = map.get(idx).copied().unwrap_or(0x2A2A33);
            let cx = offset_x + dx;
            let cy = offset_y + dy;
            let off = ((cy * CANVAS_W + cx) * 4) as usize;
            rgba[off] = ((c >> 16) & 0xFF) as u8;
            rgba[off + 1] = ((c >> 8) & 0xFF) as u8;
            rgba[off + 2] = (c & 0xFF) as u8;
            rgba[off + 3] = 255;
        }
    }

    encode_png(&rgba)
}

fn solid_canvas() -> Vec<u8> {
    let mut rgba = vec![0u8; (CANVAS_W * CANVAS_H * 4) as usize];
    for px in rgba.chunks_exact_mut(4) {
        px[0] = BG_R;
        px[1] = BG_G;
        px[2] = BG_B;
        px[3] = 255;
    }
    rgba
}

fn encode_png(rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, CANVAS_W, CANVAS_H);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("png header: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("png data: {e}"))?;
    }
    Ok(buf)
}
