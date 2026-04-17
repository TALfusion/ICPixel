import React, { useEffect, useState } from "react";
import { Principal } from "@dfinity/principal";
import { makeNftActor, getAuthClient } from "./api";
import type { BackendActor } from "./idl";
import { nftImageUrl } from "./Collection";
import { fmtIcp } from "./fmt";

type V = { Nat: bigint } | { Int: bigint } | { Text: string } | { Blob: Uint8Array | number[] };

interface Nft {
  id: bigint;
  alliance: string;
  season: number;
  pixels: number;
  w: number;
  h: number;
  owner: string;
}

function rv(kvs: [string, V][], k: string): unknown {
  const f = kvs.find(([n]) => n === k);
  if (!f) return undefined;
  const v = f[1] as Record<string, unknown>;
  return "Nat" in v ? v.Nat : "Int" in v ? v.Int : "Text" in v ? v.Text : undefined;
}

const nftCid = (import.meta.env.VITE_NFT_CANISTER_ID as string) || "";

interface Props { actor: BackendActor; myPrincipal: string }
type Tab = "nfts" | "earnings";

export default function MyRewards({ actor, myPrincipal }: Props) {
  const [tab, setTab] = useState<Tab>("nfts");
  const [nfts, setNfts] = useState<Nft[]>([]);
  const [nftLoading, setNftLoading] = useState(true);
  const [credits, setCredits] = useState<bigint>(0n);
  const [treasury, setTreasury] = useState<bigint>(0n);

  // transfer
  const [xferId, setXferId] = useState<bigint | null>(null);
  const [xferAddr, setXferAddr] = useState("");
  const [xferBusy, setXferBusy] = useState(false);
  const [xferMsg, setXferMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let s = false;
    (async () => {
      try {
        const [c, t] = await Promise.all([actor.my_pixel_credits(), actor.my_claimable_treasury()]);
        if (!s) { setCredits(c); setTreasury(t); }
      } catch {}
    })();
    return () => { s = true; };
  }, [actor]);

  useEffect(() => {
    let s = false;
    (async () => {
      try {
        const a = await makeNftActor();
        const raw = await a.icrc7_tokens_of(
          { owner: Principal.fromText(myPrincipal), subaccount: [] }, [], [50n]
        );
        const ids: bigint[] = Array.from(raw as bigint[]);
        if (s) return;
        if (!ids.length) { setNfts([]); setNftLoading(false); return; }
        const [ms, os] = await Promise.all([a.icrc7_token_metadata(ids), a.icrc7_owner_of(ids)]);
        if (s) return;
        setNfts(ids.map((id: bigint, i: number) => {
          const kv = (ms[i]?.[0] ?? []) as [string, V][];
          const o = os[i];
          return {
            id,
            alliance: (rv(kv, "icpixel:alliance_name") as string) ?? "",
            season: Number((rv(kv, "icpixel:season") as bigint) ?? 0n),
            pixels: Number((rv(kv, "icpixel:pixel_count") as bigint) ?? 0n),
            w: Number((rv(kv, "icpixel:width") as bigint) ?? 0n),
            h: Number((rv(kv, "icpixel:height") as bigint) ?? 0n),
            owner: o && o.length > 0 ? o[0]!.owner.toString() : "?",
          };
        }));
        setNftLoading(false);
      } catch (e) { if (!s) { setNftLoading(false); console.warn(e); } }
    })();
    return () => { s = true; };
  }, [myPrincipal]);

  async function transfer(tokenId: bigint) {
    const a = xferAddr.trim();
    if (!a) { setXferMsg("Enter destination principal"); return; }
    let to: { owner: Principal; subaccount: [] };
    try { to = { owner: Principal.fromText(a), subaccount: [] }; }
    catch { setXferMsg("Invalid principal"); return; }
    setXferBusy(true); setXferMsg(null);
    try {
      const nft = await makeNftActor((await getAuthClient()).getIdentity());
      const res = await nft.icrc7_transfer([{
        to, token_id: tokenId, memo: [], from_subaccount: [], created_at_time: [],
      }]);
      const r = res[0]?.[0];
      if (r && "Ok" in r) {
        setXferId(null);
        setNfts(p => p.filter(n => n.id !== tokenId));
        setToast(`NFT #${tokenId} sent`);
        setTimeout(() => setToast(null), 4000);
      } else {
        const k = r ? Object.keys(r.Err)[0] : "Unknown";
        setXferMsg(k === "Unauthorized" ? "You no longer own this NFT" :
          k === "NonExistingTokenId" ? "NFT no longer exists" : "Failed: " + k);
      }
    } catch { setXferMsg("Connection error"); }
    finally { setXferBusy(false); }
  }

  const short = (s: string) => s.length > 24 ? s.slice(0, 12) + "…" + s.slice(-8) : s;

  return (
    <div style={{ flex: 1, background: "#111", color: "#e8e8ec", overflowY: "auto", fontFamily: "system-ui,sans-serif" }}>
      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #222", position: "sticky", top: 0, background: "#111", zIndex: 2 }}>
        {(["nfts", "earnings"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, background: "none", border: "none", padding: "14px 0",
            color: tab === t ? "#f0c040" : "#666", fontSize: 12, fontWeight: 700,
            letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
            borderBottom: tab === t ? "2px solid #f0c040" : "2px solid transparent",
          }}>
            {t === "nfts" ? "My NFTs" : "Earnings"}
          </button>
        ))}
      </div>

      <div style={{ padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div style={{
            padding: "10px 14px", marginBottom: 16, borderRadius: 6,
            background: "rgba(126,237,86,0.08)", border: "1px solid rgba(126,237,86,0.25)",
            color: "#7eed56", fontSize: 12,
          }}>{toast}</div>
        )}

        {/* ── NFTs ── */}
        {tab === "nfts" && (
          nftLoading ? <p style={{ color: "#555" }}>Loading…</p> :
          nfts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#444" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🏆</div>
              <div style={{ fontSize: 13 }}>No NFTs yet</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>Complete a mission as alliance leader to earn one</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
              {nfts.map(n => (
                <div key={String(n.id)} style={{ background: "#161618", border: "1px solid #1e1e24", borderRadius: 8, overflow: "hidden" }}>
                  <img src={nftImageUrl(n.id)} alt="" style={{
                    width: "100%", aspectRatio: "1", objectFit: "cover",
                    imageRendering: "pixelated", display: "block", background: "#1a1a22",
                  }} />
                  <div style={{ padding: "10px 11px 11px" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{n.alliance || `#${n.id}`}</div>
                    <div style={{ fontSize: 10, color: "#555", marginBottom: 6 }}>
                      {n.w}×{n.h} · {n.pixels}px · S{n.season}
                    </div>
                    <div style={{ fontSize: 9, color: "#444", marginBottom: 4 }}>
                      owner: {short(n.owner)}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <a href={nftImageUrl(n.id)} target="_blank" rel="noopener noreferrer" style={linkBtn}>image</a>
                      <a href={`https://dashboard.internetcomputer.org/canister/${nftCid}`} target="_blank" rel="noopener noreferrer" style={linkBtn}>explorer</a>
                      <button onClick={() => { setXferId(n.id); setXferMsg(null); setXferAddr(""); }} style={{
                        ...linkBtn, background: "rgba(240,192,64,0.08)", color: "#f0c040",
                        borderColor: "rgba(240,192,64,0.2)", cursor: "pointer",
                      }}>send</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ── Earnings ── */}
        {tab === "earnings" && (
          <div style={{ maxWidth: 360 }}>
            <Row label="Pixel credits" value={String(credits)} />
            <Row label="Claimable treasury" value={`${fmtIcp(treasury)} ICP`} />
            <Row label="NFTs owned" value={String(nfts.length)} />
            <div style={{ marginTop: 20, fontSize: 11, color: "#444", lineHeight: 1.8 }}>
              50% of pack purchases → project wallet<br />
              40% → season treasury (split among NFT holders)<br />
              10% → mission reward pool (split among contributors)
            </div>
          </div>
        )}
      </div>

      {/* Transfer modal */}
      {xferId !== null && (
        <div onClick={() => { if (!xferBusy) setXferId(null); }} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "#16161a", border: "1px solid #222", borderRadius: 10,
            padding: 20, width: 360, maxWidth: "92vw", color: "#e8e8ec",
          }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>
              Send NFT #{String(xferId)}
            </div>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 4, fontWeight: 600 }}>RECIPIENT PRINCIPAL</div>
            <input
              value={xferAddr} onChange={e => setXferAddr(e.target.value)}
              placeholder="principal-id" spellCheck={false}
              style={{
                width: "100%", padding: "10px", background: "#1b1b22", color: "#ccc",
                border: "1px solid #2a2a32", borderRadius: 6, fontSize: 11,
                fontFamily: "ui-monospace,monospace", boxSizing: "border-box", marginBottom: 12,
              }}
            />
            {xferMsg && <div style={{ fontSize: 11, color: "#ff8080", marginBottom: 10 }}>{xferMsg}</div>}
            <button disabled={xferBusy} onClick={() => xferId !== null && transfer(xferId)} style={{
              width: "100%", padding: 10, background: xferBusy ? "#555" : "#f0c040",
              color: "#111", border: "none", borderRadius: 6, fontSize: 13,
              fontWeight: 800, cursor: xferBusy ? "wait" : "pointer", marginBottom: 6,
            }}>
              {xferBusy ? "sending…" : "Send"}
            </button>
            <button disabled={xferBusy} onClick={() => setXferId(null)} style={{
              width: "100%", padding: 8, background: "none", color: "#666",
              border: "1px solid #222", borderRadius: 6, fontSize: 11, cursor: "pointer",
            }}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "14px 0", borderBottom: "1px solid #1a1a1f",
    }}>
      <span style={{ fontSize: 13, color: "#888" }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  flex: 1, textAlign: "center", padding: "4px 0", fontSize: 9, fontWeight: 600,
  color: "#555", background: "rgba(255,255,255,0.02)", border: "1px solid #1e1e24",
  borderRadius: 4, textDecoration: "none", cursor: "pointer",
};
