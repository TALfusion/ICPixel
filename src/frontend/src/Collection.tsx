//! Gallery view of every NFT minted so far — one tile per live token.
//!
//! Data: ICRC-7 on the `nft` canister. We don't maintain a secondary index
//! server-side; instead we page through `icrc7_tokens` and batch-fetch
//! metadata + owners in groups. ICRC-7 metadata is `Vec<(String, Value)>`
//! where `Value` is a variant — we un-variant it into a typed shape on
//! the client so the rest of the component doesn't care about the raw
//! form.
//!
//! Images come from the nft canister's `http_request` endpoint via
//! `raw.icp0.io` (see `nftImageUrl` in AlliancePanel for the why).

import { useEffect, useMemo, useState } from "react";
import { makeNftActor } from "./api";
import type { Principal } from "@dfinity/principal";

// ICRC-7 `Value` variant. Only the cases we actually emit are listed;
// unknown cases decode as `undefined` in `readValue`.
type Icrc7Value =
  | { Nat: bigint }
  | { Int: bigint }
  | { Text: string }
  | { Blob: Uint8Array | number[] }
  | { Array: Icrc7Value[] }
  | { Map: Array<[string, Icrc7Value]> };

type Account = { owner: Principal; subaccount: [] | [Uint8Array | number[]] };

interface NftTile {
  tokenId: bigint;
  name: string;
  description: string;
  allianceName: string;
  allianceId: bigint;
  season: number;
  pixelCount: number;
  width: number;
  height: number;
  completedAtMs: number;
  owner: Account | null; // null = burned
}

const PAGE_SIZE = 50;

function readValue(kvs: Array<[string, Icrc7Value]>, key: string): unknown {
  const found = kvs.find(([k]) => k === key);
  if (!found) return undefined;
  const v = found[1] as Record<string, unknown>;
  if ("Nat" in v) return v.Nat;
  if ("Int" in v) return v.Int;
  if ("Text" in v) return v.Text;
  return undefined;
}

const nftCanisterId = (import.meta.env.VITE_NFT_CANISTER_ID as string) || "";
const network = (import.meta.env.VITE_DFX_NETWORK as string) || "local";

export function nftImageUrl(tokenId: bigint): string {
  if (!nftCanisterId) return "";
  return network === "ic"
    ? `https://${nftCanisterId}.raw.icp0.io/token/${tokenId}.png`
    : `http://${nftCanisterId}.localhost:4943/token/${tokenId}.png`;
}

export default function Collection() {
  const [tiles, setTiles] = useState<NftTile[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<NftTile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const actor = await makeNftActor();
        const supply = await actor.icrc7_total_supply();
        if (cancelled) return;
        setTotal(Number(supply));

        // Page through `icrc7_tokens` (live tokens only — burned skipped
        // by the canister). `prev` = last id from previous page; `take`
        // = page size (capped at 1000 server-side, but we stay under to
        // keep each response small).
        let prev: [] | [bigint] = [];
        const collected: NftTile[] = [];
        let guard = 0;
        while (true) {
          guard += 1;
          if (guard > 200) break; // hard safety — 200 pages × 50 = 10k
          const ids: BigUint64Array | bigint[] = await actor.icrc7_tokens(
            prev,
            [BigInt(PAGE_SIZE)],
          );
          const idList: bigint[] = Array.from(ids);
          if (idList.length === 0) break;

          const [metas, owners] = await Promise.all([
            actor.icrc7_token_metadata(idList),
            actor.icrc7_owner_of(idList),
          ]);

          idList.forEach((tokenId: bigint, i: number) => {
            const metaOpt = metas[i];
            const ownerOpt = owners[i];
            if (!metaOpt || metaOpt.length === 0) return;
            const kvs = metaOpt[0] as Array<[string, Icrc7Value]>;
            const name = (readValue(kvs, "icrc7:name") as string) ?? "";
            const description =
              (readValue(kvs, "icrc7:description") as string) ?? "";
            const allianceName =
              (readValue(kvs, "icpixel:alliance_name") as string) ?? "";
            const allianceId = BigInt(
              (readValue(kvs, "icpixel:alliance_id") as bigint | undefined) ?? 0n,
            );
            const season = Number(
              (readValue(kvs, "icpixel:season") as bigint | undefined) ?? 0n,
            );
            const pixelCount = Number(
              (readValue(kvs, "icpixel:pixel_count") as bigint | undefined) ?? 0n,
            );
            const width = Number(
              (readValue(kvs, "icpixel:width") as bigint | undefined) ?? 0n,
            );
            const height = Number(
              (readValue(kvs, "icpixel:height") as bigint | undefined) ?? 0n,
            );
            const completedAtNs = BigInt(
              (readValue(kvs, "icpixel:completed_at") as bigint | undefined) ?? 0n,
            );
            collected.push({
              tokenId,
              name,
              description,
              allianceName,
              allianceId,
              season,
              pixelCount,
              width,
              height,
              completedAtMs: Number(completedAtNs / 1_000_000n),
              owner: ownerOpt && ownerOpt.length > 0 ? ownerOpt[0]! : null,
            });
          });

          // Progressive render: push what we have every page so the user
          // sees tiles appearing instead of a blank screen for big collections.
          if (!cancelled) setTiles([...collected]);

          prev = [idList[idList.length - 1]!];
          if (idList.length < PAGE_SIZE) break;
        }
        if (!cancelled) {
          setTiles(collected);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sort: newest first (by completed_at desc), stable by token id.
  const sorted = useMemo(
    () =>
      [...tiles].sort((a, b) => {
        if (a.completedAtMs !== b.completedAtMs)
          return b.completedAtMs - a.completedAtMs;
        return Number(b.tokenId - a.tokenId);
      }),
    [tiles],
  );

  return (
    <>
      {loading && total !== null && tiles.length < total && (
        <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>
          loading {tiles.length}/{total}…
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 12,
            background: "rgba(180,50,50,0.1)",
            border: "1px solid #b34",
            borderRadius: 6,
            color: "#f88",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {!error && total === 0 && !loading && (
        <div className="dash-empty">
          <div style={{ fontSize: 36, opacity: 0.3, marginBottom: 8 }}>🖼</div>
          <div>No NFTs minted yet. Complete a mission to mint the first one!</div>
        </div>
      )}

      {sorted.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {sorted.map((t) => (
            <button
              key={String(t.tokenId)}
              onClick={() => setSelected(t)}
              style={{
                background: "#111117",
                border: "1px solid #2a2a32",
                borderRadius: 8,
                padding: 8,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                textAlign: "left",
                color: "#e8e8ec",
              }}
            >
              <div
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  background: "#1a1a22",
                  borderRadius: 4,
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <img
                  src={nftImageUrl(t.tokenId)}
                  alt={t.name}
                  loading="lazy"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    imageRendering: "pixelated",
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                #{String(t.tokenId)} · {t.allianceName || "—"}
              </div>
              <div style={{ fontSize: 10, color: "#888" }}>
                Season {t.season} · {t.width}×{t.height}
                {t.owner === null && (
                  <span style={{ color: "#f88", marginLeft: 6 }}>burned</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <DetailModal tile={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function DetailModal({ tile, onClose }: { tile: NftTile; onClose: () => void }) {
  const ownerStr = tile.owner
    ? tile.owner.owner.toString()
    : "(burned — no owner)";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#111117",
          border: "1px solid #2a2a32",
          borderRadius: 10,
          padding: 20,
          maxWidth: 520,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          color: "#e8e8ec",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            #{String(tile.tokenId)} · {tile.allianceName}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid #333",
              color: "#aaa",
              width: 28,
              height: 28,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <img
          src={nftImageUrl(tile.tokenId)}
          alt={tile.name}
          style={{
            width: "100%",
            maxHeight: 280,
            objectFit: "contain",
            imageRendering: "pixelated",
            background: "#1a1a22",
            borderRadius: 6,
            marginBottom: 12,
          }}
        />

        {tile.description && (
          <p style={{ fontSize: 12, color: "#c8c8d0", marginTop: 0 }}>
            {tile.description}
          </p>
        )}

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            gap: "4px 12px",
            fontSize: 12,
            margin: 0,
          }}
        >
          <dt style={{ color: "#888" }}>Season</dt>
          <dd style={{ margin: 0 }}>{tile.season}</dd>
          <dt style={{ color: "#888" }}>Size</dt>
          <dd style={{ margin: 0 }}>
            {tile.width} × {tile.height} ({tile.pixelCount.toLocaleString()} px)
          </dd>
          <dt style={{ color: "#888" }}>Minted</dt>
          <dd style={{ margin: 0 }}>
            {tile.completedAtMs
              ? new Date(tile.completedAtMs).toLocaleString()
              : "—"}
          </dd>
          <dt style={{ color: "#888" }}>Alliance</dt>
          <dd style={{ margin: 0 }}>
            {tile.allianceName} (#{String(tile.allianceId)})
          </dd>
          <dt style={{ color: "#888" }}>Owner</dt>
          <dd
            style={{
              margin: 0,
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              wordBreak: "break-all",
            }}
          >
            {ownerStr}
          </dd>
        </dl>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <a
            href={nftImageUrl(tile.tokenId)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              border: "1px solid #2a2a32",
              borderRadius: 4,
              color: "#9090a0",
              fontSize: 12,
              textDecoration: "none",
            }}
          >
            open PNG
          </a>
        </div>
      </div>
    </div>
  );
}
