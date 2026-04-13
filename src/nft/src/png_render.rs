//! PNG rendering for NFT image endpoint.
//!
//! Templates are stored as `Vec<u32>` row-major where each cell is 0xRRGGBB.
//! We render at the *display* resolution, not the native template resolution:
//! a 5×5 mission would render as 5×5 pixels which is unviewable on any
//! marketplace, so we nearest-neighbor upscale the larger side to ~512 px.
//! Missions whose larger side already exceeds 512 px render at native size.

use crate::types::TokenMetadata;

const TARGET_LONG_SIDE: u32 = 512;

/// Returns a PNG byte buffer for the given metadata's template, or a
/// human-readable error if the `png` encoder fails. Writing to an in-memory
/// `Vec<u8>` should never fail in practice, but the encoder's return type
/// is fallible and we propagate it instead of trapping.
pub fn render(meta: &TokenMetadata) -> Result<Vec<u8>, String> {
    let w = meta.width.max(1) as u32;
    let h = meta.height.max(1) as u32;
    let long = w.max(h);
    let scale = if long >= TARGET_LONG_SIDE {
        1
    } else {
        // Integer upscale that fits the long side at-or-just-below the target.
        // Using floor instead of ceil so we don't blow past TARGET_LONG_SIDE.
        (TARGET_LONG_SIDE / long).max(1)
    };
    let out_w = w * scale;
    let out_h = h * scale;

    // Build RGBA8 pixel buffer (alpha is always 255).
    let mut rgba = vec![0u8; (out_w as usize) * (out_h as usize) * 4];
    for sy in 0..h {
        for sx in 0..w {
            let src_idx = (sy as usize) * (w as usize) + (sx as usize);
            let c = meta.template.get(src_idx).copied().unwrap_or(0xFFFFFF);
            let r = ((c >> 16) & 0xFF) as u8;
            let g = ((c >> 8) & 0xFF) as u8;
            let b = (c & 0xFF) as u8;
            // Fill the scale×scale block.
            for dy in 0..scale {
                let row = sy * scale + dy;
                let row_off = (row as usize) * (out_w as usize) * 4;
                for dx in 0..scale {
                    let col = sx * scale + dx;
                    let off = row_off + (col as usize) * 4;
                    rgba[off] = r;
                    rgba[off + 1] = g;
                    rgba[off + 2] = b;
                    rgba[off + 3] = 255;
                }
            }
        }
    }

    // Encode.
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, out_w, out_h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("png header: {e}"))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| format!("png data: {e}"))?;
    }
    Ok(buf)
}
