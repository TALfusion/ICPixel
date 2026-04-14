import { useEffect, useState, useCallback, useRef } from "react";
import type { BackendActor, GameState, AlliancePublic, LeaderboardPage } from "./idl";

// ── Constants ────────────────────────────────────────────────────────
// Mirrors STAGES in src/backend/src/map.rs.
const STAGES = [1, 5, 10, 50, 100, 500];
const SEASON_TAIL_DAYS = 4;
const REFRESH_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────
function fmtIcp(e8s: bigint): string {
  const whole = e8s / 100_000_000n;
  const frac = e8s % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, "0").slice(0, 2)}`;
}

function fmtUsd(e8s: bigint, microRate: bigint): string {
  if (microRate === 0n) return "—";
  // usd = icp * rate/1e6;  icp = e8s/1e8
  const cents = (e8s * microRate) / 1_000_000n / 1_000_000n; // in micro-usd → /1e6
  const usd = Number(e8s) * (Number(microRate) / 1e6) / 1e8;
  return `$${usd.toFixed(2)}`;
}

function stageIndex(mapSize: number): number {
  const idx = STAGES.indexOf(mapSize);
  return idx >= 0 ? idx : 0;
}

function fmtDate(ns: bigint | undefined): string {
  if (!ns) return "TBD";
  return new Date(Number(ns / 1_000_000n)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function timeSince(ns: bigint): string {
  const ms = Date.now() - Number(ns / 1_000_000n);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ── Props ────────────────────────────────────────────────────────────
interface DashboardProps {
  actor: BackendActor;
  /** Initial state if already fetched by App, avoids a blank flash. */
  initialState: GameState | null;
  alliances: AlliancePublic[];
  onPlay: () => void;
}

// ── Component ────────────────────────────────────────────────────────
export default function Dashboard({ actor, initialState, alliances, onPlay }: DashboardProps) {
  const [gs, setGs] = useState<GameState | null>(initialState);
  const [treasury, setTreasury] = useState<bigint>(0n);
  const [icpRate, setIcpRate] = useState<bigint>(0n); // micro-USD per ICP
  const [lb, setLb] = useState<LeaderboardPage | null>(null);
  const [lastRefresh, setLastRefresh] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, t, price, board] = await Promise.all([
        actor.get_game_state(),
        actor.get_treasury_balance(),
        actor.get_icp_price(),
        actor.leaderboard(0n, 20n),
      ]);
      setGs(g);
      setTreasury(t);
      setIcpRate(price.usd_per_icp_micro);
      setLb(board);
      setLastRefresh(Date.now());
    } catch (e) {
      console.warn("dashboard refresh failed", e);
    }
  }, [actor]);

  // Initial + periodic refresh.
  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const mapSize = gs?.map_size ?? 1;
  const stage = stageIndex(mapSize);
  const totalCells = mapSize * mapSize;
  const filled = Number(gs?.unique_pixels_set ?? 0n);
  const remaining = Math.max(0, totalCells - filled);
  const nextSize = stage < STAGES.length - 1 ? STAGES[stage + 1] : null;
  const isFinalStage = stage === STAGES.length - 1;

  // Season countdown: 7 days after final stage is reached.
  const SEASON_TAIL_MS = 7 * 24 * 60 * 60 * 1000;
  const finalReachedMs = gs?.final_stage_reached_at?.length
    ? Number(gs.final_stage_reached_at[0]) / 1_000_000 // ns → ms
    : null;
  const seasonDeadlineMs = finalReachedMs ? finalReachedMs + SEASON_TAIL_MS : null;
  const seasonRemainingMs = seasonDeadlineMs ? Math.max(0, seasonDeadlineMs - Date.now()) : null;
  const seasonEnded = seasonRemainingMs !== null && seasonRemainingMs <= 0;

  // Timeline progress fraction (0..1) between current and next stage.
  const stagePct = totalCells > 0 ? Math.min(1, filled / totalCells) : 0;

  const agoText =
    lastRefresh > 0
      ? (() => {
          const s = Math.floor((Date.now() - lastRefresh) / 1000);
          return s < 5 ? "just now" : `${s}s ago`;
        })()
      : "—";

  // Re-render the "ago" text every second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="dashboard">
      {/* ── Header row ──────────────────────────────────────────── */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">
            <img src="/img/logo.svg" alt="" style={{ width: 22, height: 22, marginRight: 8, verticalAlign: -3 }} />
            Season Dashboard
          </h1>
          <span className="dash-subtitle">
            Live stats · Auto-refreshes every 30s
          </span>
        </div>
        <span className="dash-ago">Updated {agoText}</span>
      </div>

      {/* ── Season countdown ────────────────────────────────────── */}
      {seasonRemainingMs !== null && (
        <div style={{
          textAlign: "center",
          padding: "16px 0",
          margin: "0 0 8px",
          background: seasonEnded
            ? "linear-gradient(135deg, rgba(248,113,113,0.15), rgba(248,113,113,0.05))"
            : "linear-gradient(135deg, rgba(81,233,244,0.1), rgba(54,144,234,0.05))",
          borderRadius: 10,
          border: `1px solid ${seasonEnded ? "rgba(248,113,113,0.3)" : "rgba(81,233,244,0.2)"}`,
        }}>
          <div style={{ fontSize: 11, color: "#9090a0", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1.5 }}>
            {seasonEnded ? "Season ended" : "Season ends in"}
          </div>
          <div style={{
            fontSize: 42,
            fontWeight: 800,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontVariantNumeric: "tabular-nums",
            color: seasonEnded ? "#f87171" : "#e8e8ec",
            letterSpacing: 2,
          }}>
            {(() => {
              if (seasonEnded) return "00:00:00:00";
              const ms = seasonRemainingMs;
              const d = Math.floor(ms / 86_400_000);
              const h = Math.floor((ms % 86_400_000) / 3_600_000);
              const m = Math.floor((ms % 3_600_000) / 60_000);
              const s = Math.floor((ms % 60_000) / 1000);
              return `${String(d).padStart(2, "0")}:${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
            })()}
          </div>
          <div style={{ fontSize: 10, color: "#60606a", marginTop: 4 }}>
            DD : HH : MM : SS
          </div>
        </div>
      )}

      {/* ── Three stat cards ────────────────────────────────────── */}
      <div className="dash-cards">
        {/* Card: Current Season */}
        <div className="dash-card">
          <div className="dash-card-label">CURRENT SEASON</div>
          <span className="dash-card-big">Season #{gs?.season ?? 1}</span>
          <div className="dash-card-row">
            <span className="dash-card-dim">Total pixels placed</span>
            <span>{Number(gs?.total_pixels_placed ?? 0n).toLocaleString()}</span>
          </div>
          <div className="dash-card-row">
            <span className="dash-card-dim">Missions completed</span>
            <span>{lb ? lb.entries.filter((e) => e.alliance.nft_token_id.length > 0).length : 0}</span>
          </div>
        </div>

        {/* Card: Map Size */}
        <div className="dash-card">
          <div className="dash-card-label">MAP SIZE</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span className="dash-card-big">
              {mapSize}×{mapSize}
            </span>
            <span className="dash-card-dim">
              Stage {stage} / {STAGES.length - 1}
            </span>
          </div>
          <div className="dash-card-row">
            <span className="dash-card-dim">Total cells</span>
            <span>{totalCells.toLocaleString()}</span>
          </div>
          <div className="dash-card-row">
            <span className="dash-card-dim">Next</span>
            <span>{nextSize ? `${nextSize}×${nextSize}` : "final stage"}</span>
          </div>
        </div>

        {/* Card: Season Treasury */}
        <div className="dash-card">
          <div className="dash-card-label">SEASON TREASURY</div>
          <span className="dash-card-big">{fmtIcp(treasury)} ICP</span>
          <span className="dash-card-dim" style={{ marginTop: 2 }}>
            ≈ {fmtUsd(treasury, icpRate)} USD
          </span>
          <span className="dash-card-dim" style={{ marginTop: 6, fontSize: 11 }}>
            Split among all NFT holders at season end
          </span>
        </div>
      </div>

      {/* ── Map Expansion Timeline ──────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-header">
          <span className="dash-section-title">MAP EXPANSION TIMELINE</span>
          <span style={{ flex: 1 }} />
          <span className="dash-card-dim" style={{ fontSize: 11 }}>
            {remaining.toLocaleString()} / {totalCells.toLocaleString()} px to next stage
          </span>
        </div>

        {/* Timeline bar */}
        <div className="timeline">
          <div className="timeline-track">
            {/* Filled portion up to current stage */}
            <div
              className="timeline-fill"
              style={{
                width: `${((stage + stagePct) / (STAGES.length - 1)) * 100}%`,
              }}
            />
          </div>
          <div className="timeline-dots">
            {STAGES.map((s, i) => {
              const done = i < stage || (i === stage && stagePct >= 1);
              const active = i === stage;
              return (
                <div key={s} className="timeline-step">
                  <div
                    className={`timeline-dot ${done ? "done" : ""} ${active ? "active" : ""}`}
                  />
                  <span className="timeline-label">
                    {s}×{s}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Progress bar under timeline */}
        <div className="timeline-progress-row">
          <span className="dash-card-dim" style={{ fontSize: 11 }}>
            {(stagePct * 100).toFixed(1)}% to {nextSize ? `${nextSize}×${nextSize}` : "—"}
          </span>
          <span className="dash-card-dim" style={{ fontSize: 11 }}>
            {mapSize}×{mapSize}
          </span>
        </div>
      </div>

      {/* ── Alliances / Streaks tabbed section ──────────────────── */}
      <div className="dash-section">
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #2a2a32", marginBottom: 12 }}>
          <span style={{
            flex: 1,
            padding: "8px 0",
            borderBottom: "2px solid #51e9f4",
            color: "#e8e8ec",
            fontWeight: 700,
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}>
            Alliances ({lb ? Number(lb.total) : 0})
          </span>
        </div>

        {lb && lb.entries.length > 0 ? (
              <div className="dash-alliance-grid">
                {lb.entries.map((e) => {
                  const rank = Number(e.rank);
                  const medalColor =
                    rank === 1
                      ? "#ffd700"
                      : rank === 2
                        ? "#c0c0c0"
                        : rank === 3
                          ? "#cd7f32"
                          : undefined;
                  return (
                  <div
                    key={String(e.alliance.id)}
                    className="dash-alliance-card"
                    style={
                      medalColor
                        ? {
                            borderColor: medalColor,
                            boxShadow: `0 0 12px ${medalColor}44, inset 0 0 20px ${medalColor}0a`,
                          }
                        : undefined
                    }
                  >
                    <div
                      className="dash-alliance-rank"
                      style={medalColor ? { color: medalColor } : undefined}
                    >
                      {rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`}
                    </div>
                    <div className="dash-alliance-info">
                      <span className="dash-alliance-name">{e.alliance.name}</span>
                      <span className="dash-card-dim" style={{ fontSize: 11 }}>
                        {e.alliance.member_count} member{e.alliance.member_count !== 1 ? "s" : ""} ·{" "}
                        {Number(e.alliance.pixels_captured).toLocaleString()} px
                      </span>
                      {e.alliance.description && (
                        <span
                          className="dash-card-dim"
                          style={{
                            fontSize: 10,
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 260,
                          }}
                        >
                          {e.alliance.description}
                        </span>
                      )}
                    </div>
                    {e.alliance.nft_token_id.length > 0 && (
                      <span className="dash-nft-badge">NFT #{String(e.alliance.nft_token_id[0])}</span>
                    )}
                    {e.alliance.nft_token_id.length > 0 && e.alliance.website && e.alliance.website.length > 0 && (
                      <a
                        href={e.alliance.website[0]}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(ev) => {
                          if (!window.confirm(`You are leaving ICPixel to visit:\n\n${e.alliance.website![0]}\n\nThis is an external link not controlled by ICPixel. Proceed?`)) {
                            ev.preventDefault();
                          }
                        }}
                        className="dash-nft-badge"
                        style={{ textDecoration: "none", cursor: "pointer" }}
                      >
                        🔗 website
                      </a>
                    )}
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="dash-empty">
                <div style={{ fontSize: 36, opacity: 0.3, marginBottom: 8 }}>⚔</div>
                <div>No alliances yet. Be the first to create one!</div>
                <button
                  className="btn primary"
                  style={{ marginTop: 12 }}
                  onClick={onPlay}
                >
                  Create an Alliance
                </button>
              </div>
            )}
      </div>
    </div>
  );
}
