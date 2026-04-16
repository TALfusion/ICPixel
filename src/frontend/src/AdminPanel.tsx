import { useEffect, useState, useCallback } from "react";
import type { AdminStats, BackendActor } from "./idl";

interface Props {
  actor: BackendActor;
  onClose: () => void;
}

function fmt(n: number | bigint): string {
  return Number(n).toLocaleString();
}
function fmtCycles(n: number | bigint): string {
  const t = Number(n) / 1e12;
  return t.toFixed(2) + " T";
}
import { fmtIcp } from "./fmt";
function fmtUsdRate(micro: number | bigint): string {
  if (Number(micro) === 0) return "—";
  return "$" + (Number(micro) / 1e6).toFixed(2);
}
function fmtAge(ns: number | bigint): string {
  if (Number(ns) === 0) return "never";
  const secs = Math.floor((Date.now() * 1e6 - Number(ns)) / 1e9);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
function fmtStable(pages: number | bigint): string {
  const mb = (Number(pages) * 65536) / 1e6;
  return mb.toFixed(1) + " MB";
}

export default function AdminPanel({ actor, onClose }: Props) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  // Price input
  const [priceInput, setPriceInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await actor.get_admin_stats();
      setStats(s);
      setPriceInput(String(s.pixel_price_usd_cents));
    } catch (e) {
      setMsg("Failed to load stats: " + String(e));
    } finally {
      setLoading(false);
    }
  }, [actor]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function togglePause() {
    if (!stats) return;
    setMsg("...");
    try {
      const res = await actor.admin_set_paused(!stats.paused);
      if ("Err" in res) setMsg("Error: " + res.Err);
      else { setMsg(stats.paused ? "Unpaused" : "Paused"); await refresh(); }
    } catch (e) { setMsg(String(e)); }
  }

  async function setPrice() {
    setMsg("...");
    try {
      const cents = parseInt(priceInput);
      if (isNaN(cents) || cents < 0) { setMsg("Invalid price"); return; }
      // set_alliance_billing sets entire billing — we need to read, modify, write
      const billing = await actor.get_alliance_billing();
      billing.pixel_price_usd_cents = cents;
      const res = await actor.set_alliance_billing(billing);
      if ("Err" in res) setMsg("Error: " + res.Err);
      else { setMsg("Price set to " + cents + "¢"); await refresh(); }
    } catch (e) { setMsg(String(e)); }
  }

  async function payoutWallet() {
    setMsg("Paying out...");
    try {
      const res = await actor.admin_payout_wallet();
      if ("Err" in res) setMsg("Error: " + res.Err);
      else { setMsg("Paid out " + fmtIcp(res.Ok)); await refresh(); }
    } catch (e) { setMsg(String(e)); }
  }

  const [exporting, setExporting] = useState(false);
  async function downloadSnapshot() {
    setExporting(true);
    setMsg("Starting snapshot…");
    try {
      // Everything here is a query call — cheap and non-mutating.
      // We page each collection in chunks and assemble a single JSON.
      const counts = await actor.admin_export_counts();
      const singletons = await actor.admin_export_singletons();

      // Pixel-color region: fetch as raw bytes, then decode client-side
      // (hex + painted-bit reconstruction happens at restore time).
      const totalPixelBytes = Number(counts.pixel_colors_bytes);
      const PIXEL_CHUNK = 512 * 1024; // 512 KB per request (safely under 2 MB query cap)
      const pixelChunks: number[] = [];
      for (let o = 0; o < totalPixelBytes; o += PIXEL_CHUNK) {
        setMsg(`pixel colors: ${Math.round((o / totalPixelBytes) * 100)}%`);
        const bytes = (await actor.admin_export_pixel_colors(
          BigInt(o),
          BigInt(Math.min(PIXEL_CHUNK, totalPixelBytes - o)),
        )) as Uint8Array | number[];
        const arr = bytes instanceof Uint8Array ? Array.from(bytes) : (bytes as number[]);
        pixelChunks.push(...arr);
      }
      // Base64-encode the raw region so the JSON stays compact.
      const pixelColorsB64 = btoa(
        pixelChunks.reduce((s, b) => s + String.fromCharCode(b & 0xff), ""),
      );

      async function pagedFetch<T>(
        total: bigint,
        limit: number,
        fetchChunk: (offset: bigint, limit: bigint) => Promise<T[]>,
        label: string,
      ): Promise<T[]> {
        const out: T[] = [];
        const totalN = Number(total);
        for (let off = 0; off < totalN; off += limit) {
          setMsg(`${label}: ${out.length}/${totalN}`);
          const chunk = await fetchChunk(BigInt(off), BigInt(limit));
          out.push(...chunk);
          if (chunk.length < limit) break;
        }
        return out;
      }

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

      setMsg("serializing JSON…");
      const snapshot = {
        schema_version: 1,
        exported_at_ms: Date.now(),
        counts,
        singletons,
        pixel_colors_base64: pixelColorsB64,
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

      // BigInt isn't JSON-serializable by default — stringify via replacer.
      const json = JSON.stringify(
        snapshot,
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      );
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `icpixel-snapshot-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setMsg(`snapshot saved (${(blob.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      setMsg("snapshot failed: " + String(e));
    } finally {
      setExporting(false);
    }
  }


  if (loading) return <div style={panelStyle}><p>Loading admin stats...</p></div>;
  if (!stats) return <div style={panelStyle}><p>Failed to load.</p><button onClick={onClose}>close</button></div>;

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Admin Panel</h2>
        <button onClick={onClose} style={closeBtnStyle}>✕</button>
      </div>

      {msg && <div style={msgStyle}>{msg}</div>}

      {/* Metrics grid */}
      <div style={gridStyle}>
        <MetricCard label="Cycles" value={fmtCycles(stats.cycles)} warn={stats.low_cycles_warning} />
        <MetricCard label="Stable Memory" value={fmtStable(stats.stable_pages)} />
        <MetricCard label="Season" value={String(stats.season)} />
        <MetricCard label="Map Size" value={`${stats.map_size}×${stats.map_size}`} />
        <MetricCard label="Pixels Placed" value={fmt(stats.total_pixels_placed)} />
        <MetricCard label="Unique Cells" value={fmt(stats.unique_pixels_set)} />
        <MetricCard label="Registered Users" value={fmt(stats.total_users)} />
        <MetricCard label="Alliances" value={fmt(stats.total_alliances)} />
        <MetricCard label="NFTs Minted" value={fmt(stats.total_nfts_minted)} />
        <MetricCard label="Treasury" value={fmtIcp(stats.treasury_balance_e8s)} />
        <MetricCard label="Wallet Pending" value={fmtIcp(stats.wallet_pending_e8s)} />
        <MetricCard label="Pixel Price" value="Pack-based" />
        <MetricCard label="Cooldown" value={`${stats.pixel_cooldown_seconds}s`} />
        <MetricCard label="Status" value={stats.paused ? "PAUSED" : "LIVE"} warn={stats.paused} />
      </div>

      {/* Actions */}
      <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 10, color: "#888" }}>ACTIONS</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={actionRow}>
          <button onClick={togglePause} style={stats.paused ? btnDanger : btnPrimary}>
            {stats.paused ? "▶ Unpause Game" : "⏸ Pause Game"}
          </button>
        </div>

        <div style={actionRow}>
          <button onClick={payoutWallet} style={btnPrimary}>
            Payout Wallet ({fmtIcp(stats.wallet_pending_e8s)})
          </button>
        </div>

        <div style={actionRow}>
          <button
            onClick={downloadSnapshot}
            disabled={exporting}
            style={{
              ...btnPrimary,
              background: exporting ? "#333" : "#7c3aed",
              cursor: exporting ? "wait" : "pointer",
            }}
          >
            {exporting ? "exporting…" : "⬇ Download full snapshot (JSON)"}
          </button>
          <span style={{ fontSize: 11, color: "#888" }}>
            query-only · cheap
          </span>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, warn }: {
  label: string; value: string; sub?: string; warn?: boolean;
}) {
  return (
    <div style={{
      background: warn ? "rgba(180,50,50,0.15)" : "rgba(255,255,255,0.03)",
      border: warn ? "1px solid #b34" : "1px solid #333",
      borderRadius: 6,
      padding: "8px 12px",
    }}>
      <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: warn ? "#f55" : "#eee", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#666", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  flex: 1,
  background: "#111",
  color: "#eee",
  padding: 24,
  overflowY: "auto",
  fontFamily: "system-ui, sans-serif",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid #555",
  color: "#eee",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: 4,
  width: 30,
  height: 30,
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 8,
};

const msgStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid #444",
  borderRadius: 4,
  fontSize: 12,
  marginBottom: 12,
  color: "#ccc",
};

const actionRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const btnPrimary: React.CSSProperties = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const btnDanger: React.CSSProperties = {
  background: "#16a34a",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  background: "#222",
  border: "1px solid #444",
  color: "#eee",
  borderRadius: 4,
  padding: "6px 10px",
  width: 70,
  fontSize: 13,
};
