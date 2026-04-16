// Scheduled-backup companion to the "Download snapshot" button in the
// admin panel. Called from .github/workflows/snapshot.yml on a daily
// cron — dumps every admin_export_* endpoint, gzips the result, and
// writes it to snapshots/YYYY-MM-DD.json.gz so the GitHub Actions
// commit step can push a new file per day.
//
// Authentication: the workflow stores a dedicated secp256k1 PEM in the
// `ICPIXEL_SNAPSHOT_PEM` secret. The corresponding principal is wired
// on the canister via `admin_set_snapshot_reader` (one-time). This key
// is read-only — it cannot mutate state.
//
// Run locally: `ICPIXEL_SNAPSHOT_PEM="$(cat ~/.config/dfx/identity/default/identity.pem)" node scripts/export-snapshot.mjs`

import { Actor, HttpAgent } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);

// ── Config ──────────────────────────────────────────────────────────
const NETWORK = process.env.ICPIXEL_NETWORK ?? "ic";
const HOST = NETWORK === "ic" ? "https://icp-api.io" : "http://127.0.0.1:4943";
const CANISTER_ID =
  process.env.ICPIXEL_BACKEND_CANISTER_ID ??
  (NETWORK === "ic" ? "s743i-5qaaa-aaaai-axh3a-cai" : null);
if (!CANISTER_ID) {
  throw new Error("ICPIXEL_BACKEND_CANISTER_ID not set and no mainnet default");
}
const PEM = process.env.ICPIXEL_SNAPSHOT_PEM;
if (!PEM) {
  throw new Error("ICPIXEL_SNAPSHOT_PEM env var is required");
}

// ── Identity ────────────────────────────────────────────────────────
// dfx identities are secp256k1 by default; fall back to Ed25519 for
// keys generated via `dfx identity new --storage-mode=plaintext` if
// someone explicitly chose Ed25519.
function loadIdentity(pem) {
  const trimmed = pem.trim();
  try {
    return Secp256k1KeyIdentity.fromPem(trimmed);
  } catch (e1) {
    try {
      return Ed25519KeyIdentity.fromPem(trimmed);
    } catch (e2) {
      throw new Error(
        `Could not parse PEM as secp256k1 (${e1.message}) or Ed25519 (${e2.message})`,
      );
    }
  }
}
const identity = loadIdentity(PEM);
console.log(`[snapshot] identity principal: ${identity.getPrincipal().toString()}`);

// ── Actor ──────────────────────────────────────────────────────────
// Import the generated IDL from the frontend build (same did file as
// the in-app admin download button uses).
const { idlFactory } = await import(
  new URL("../src/declarations/backend/backend.did.js", import.meta.url).href
);
const agent = await HttpAgent.create({ host: HOST, identity });
if (NETWORK !== "ic") {
  await agent.fetchRootKey();
}
const actor = Actor.createActor(idlFactory, { agent, canisterId: CANISTER_ID });

// ── Export orchestration ────────────────────────────────────────────
async function pagedFetch(total, limit, fn, label) {
  const out = [];
  const totalN = Number(total);
  for (let off = 0; off < totalN; off += limit) {
    const chunk = await fn(BigInt(off), BigInt(limit));
    out.push(...chunk);
    if (chunk.length < limit) break;
    if (out.length % (limit * 10) === 0) {
      process.stdout.write(`  ${label}: ${out.length}/${totalN}\r`);
    }
  }
  console.log(`  ${label}: ${out.length}/${totalN}`);
  return out;
}

console.log("[snapshot] fetching counts + singletons");
const counts = await actor.admin_export_counts();
const singletons = await actor.admin_export_singletons();

console.log("[snapshot] fetching pixel colors (raw flat region)");
const PIXEL_CHUNK = 512 * 1024;
const totalPixelBytes = Number(counts.pixel_colors_bytes);
const pixelBuf = Buffer.alloc(totalPixelBytes);
for (let o = 0; o < totalPixelBytes; o += PIXEL_CHUNK) {
  const want = Math.min(PIXEL_CHUNK, totalPixelBytes - o);
  const got = await actor.admin_export_pixel_colors(BigInt(o), BigInt(want));
  // agent-js returns `blob` as Uint8Array or number[] depending on version.
  const arr = got instanceof Uint8Array ? got : Uint8Array.from(got);
  pixelBuf.set(arr, o);
}
const pixelColorsBase64 = pixelBuf.toString("base64");

console.log("[snapshot] fetching BTreeMap collections");
const [
  pixels,
  alliances,
  user_alliance,
  changes,
  last_placed,
  pixel_credits,
  alliance_rounds,
  mission_tile_index,
  user_stats,
  claimable_treasury,
  pending_orders,
] = await Promise.all([
  pagedFetch(counts.pixels, 1000, actor.admin_export_pixels, "pixels"),
  pagedFetch(counts.alliances, 100, actor.admin_export_alliances, "alliances"),
  pagedFetch(counts.user_alliance, 1000, actor.admin_export_user_alliance, "user_alliance"),
  pagedFetch(counts.changes, 1000, actor.admin_export_changes, "changes"),
  pagedFetch(counts.last_placed, 1000, actor.admin_export_last_placed, "last_placed"),
  pagedFetch(counts.pixel_credits, 1000, actor.admin_export_pixel_credits, "pixel_credits"),
  pagedFetch(counts.alliance_rounds, 50, actor.admin_export_alliance_rounds, "alliance_rounds"),
  pagedFetch(counts.mission_tile_index, 500, actor.admin_export_mission_tile_index, "mission_tile_index"),
  pagedFetch(counts.user_stats, 500, actor.admin_export_user_stats, "user_stats"),
  pagedFetch(counts.claimable_treasury, 1000, actor.admin_export_claimable_treasury, "claimable_treasury"),
  pagedFetch(counts.pending_orders, 500, actor.admin_export_pending_orders, "pending_orders"),
]);

const snapshot = {
  schema_version: 1,
  exported_at_ms: Date.now(),
  network: NETWORK,
  canister_id: CANISTER_ID,
  counts,
  singletons,
  pixel_colors_base64: pixelColorsBase64,
  collections: {
    pixels,
    alliances,
    user_alliance,
    changes,
    last_placed,
    pixel_credits,
    alliance_rounds,
    mission_tile_index,
    user_stats,
    claimable_treasury,
    pending_orders,
  },
};

// Principal / BigInt need manual JSON handling. Both become strings.
const json = JSON.stringify(
  snapshot,
  (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && typeof v.toText === "function") {
      return v.toText();
    }
    return v;
  },
  2,
);

// ── Write ───────────────────────────────────────────────────────────
const outDir = path.resolve("snapshots");
fs.mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const outPath = path.join(outDir, `${today}.json.gz`);
const gzipped = await gzip(Buffer.from(json, "utf8"));
fs.writeFileSync(outPath, gzipped);

const rawSize = (json.length / 1024).toFixed(1);
const gzSize = (gzipped.length / 1024).toFixed(1);
console.log(`[snapshot] wrote ${outPath} (${gzSize} KB gz / ${rawSize} KB raw)`);
