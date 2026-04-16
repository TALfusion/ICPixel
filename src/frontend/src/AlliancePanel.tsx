import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
import type {
  Alliance,
  AlliancePublic,
  AllianceError,
  BackendActor,
  LeaderboardEntry,
  Mission,
  MissionRoundPublic,
  MissionContributionView,
} from "./idl";
import MissionImageCrop from "./MissionImageCrop";

type PanelTab = "mine" | "leaderboard";

interface Props {
  actor: BackendActor;
  alliances: AlliancePublic[];
  myAlliance: Alliance | null;
  myPrincipal: string | null;
  pendingRect: { x: number; y: number; width: number; height: number } | null;
  creating: boolean;
  mapSize: number;
  setCreating: (v: boolean) => void;
  setPendingRect: (
    r: { x: number; y: number; width: number; height: number } | null
  ) => void;
  onClearRect: () => void;
  onChanged: () => void;
  missionProgress: { matched: number; total: number; percent: number } | null;
  onGoToMission: () => void;
  onShareMission: () => void;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  /// True once the user has signed in (local Ed25519 dev key or II on
  /// mainnet). When false, the panel is in view-only mode and any action
  /// that calls an update method is routed through `requireSignIn`.
  authed: boolean;
  /// Runs `action` immediately when authed; otherwise opens the app-level
  /// sign-in modal with `reason` and stashes the action to replay after
  /// sign-in succeeds. Returns true if the action ran inline.
  requireSignIn: (reason: string, action: () => void | Promise<void>) => boolean;
  /// Eyedropper: called when user clicks a pixel on the mission thumbnail.
  /// Receives the 0xRRGGBB color value. App.tsx uses this to select the
  /// nearest palette slot.
  onPickColor?: (color: number) => void;
  /// Mobile layout flag — renders as bottom sheet instead of side panel.
  isMobile?: boolean;
  /// Close handler for mobile bottom sheet.
  onClose?: () => void;
}

// ── Design tokens ──────────────────────────────────────────────────
const C = {
  bg: "#16161a",
  bgElev: "#1f1f25",
  bgInput: "#0f0f12",
  border: "#2a2a32",
  borderHi: "#3a3a45",
  text: "#e8e8ec",
  textDim: "#9090a0",
  textMuted: "#60606a",
  accent: "#f0c040",   // gold — for "you" / mission
  accentText: "#16161a",
  green: "#4ade80",
  red: "#f87171",
  blue: "#60a5fa",
};

const styles = {
  panel: {
    position: "absolute",
    top: 56,
    right: 12,
    bottom: 76,
    width: 340,
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: 0,
    fontSize: 13,
    color: C.text,
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    fontFamily: "system-ui,sans-serif",
  } as CSSProperties,
  header: {
    padding: "14px 16px 10px",
    borderBottom: `1px solid ${C.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  } as CSSProperties,
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.3,
  } as CSSProperties,
  body: {
    padding: 14,
    overflowY: "auto",
    flex: 1,
  } as CSSProperties,

  primaryBtn: {
    width: "100%",
    padding: "10px 12px",
    background: C.accent,
    color: C.accentText,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  } as CSSProperties,
  ghostBtn: {
    padding: "6px 10px",
    background: "transparent",
    color: C.textDim,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
  } as CSSProperties,
  dangerBtn: {
    padding: "6px 12px",
    background: "transparent",
    color: C.red,
    border: `1px solid ${C.red}40`,
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
  } as CSSProperties,
  smallBtn: {
    padding: "5px 12px",
    background: C.bgElev,
    color: C.text,
    border: `1px solid ${C.borderHi}`,
    borderRadius: 5,
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
  } as CSSProperties,

  input: {
    width: "100%",
    padding: "8px 10px",
    background: C.bgInput,
    border: `1px solid ${C.border}`,
    borderRadius: 5,
    color: C.text,
    fontSize: 12,
    fontFamily: "inherit",
    boxSizing: "border-box",
    marginBottom: 8,
    outline: "none",
  } as CSSProperties,

  myCard: {
    padding: 14,
    background: `linear-gradient(135deg, ${C.bgElev}, ${C.bg})`,
    border: `1px solid ${C.accent}80`,
    borderRadius: 8,
    marginBottom: 14,
    position: "relative",
    overflow: "hidden",
  } as CSSProperties,
  myBadge: {
    display: "inline-block",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    color: C.accent,
    textTransform: "uppercase",
    marginBottom: 6,
  } as CSSProperties,
  myName: {
    fontSize: 16,
    fontWeight: 700,
    color: C.text,
    wordBreak: "break-word",
    marginBottom: 4,
  } as CSSProperties,
  myDesc: {
    fontSize: 12,
    color: C.textDim,
    wordBreak: "break-word",
    marginBottom: 10,
    lineHeight: 1.4,
  } as CSSProperties,
  statRow: {
    display: "flex",
    gap: 12,
    fontSize: 11,
    color: C.textMuted,
    marginBottom: 8,
    flexWrap: "wrap",
  } as CSSProperties,
  stat: { display: "flex", alignItems: "center", gap: 4 } as CSSProperties,
  statValue: { color: C.text, fontWeight: 600 } as CSSProperties,

  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: C.textMuted,
    marginBottom: 8,
    marginTop: 4,
  } as CSSProperties,

  step: {
    padding: 10,
    background: C.bgInput,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    marginBottom: 8,
  } as CSSProperties,
  stepTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: C.textDim,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  } as CSSProperties,

  rankRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: C.bgElev,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    marginBottom: 6,
  } as CSSProperties,
  rankNum: {
    width: 22,
    textAlign: "center",
    fontWeight: 700,
    fontSize: 13,
    color: C.textMuted,
    flexShrink: 0,
  } as CSSProperties,
  rankName: {
    fontWeight: 600,
    fontSize: 13,
    color: C.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  rankMeta: {
    fontSize: 10,
    color: C.textMuted,
    marginTop: 2,
  } as CSSProperties,
  rankDesc: {
    fontSize: 11,
    color: C.textDim,
    marginTop: 3,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  } as CSSProperties,
};

const RANK_COLORS = ["#f0c040", "#c0c0c0", "#cd7f32"];

/// Returns a browser URL for the NFT image PNG served by the nft canister's
/// http_request endpoint. Local uses subdomain on localhost:4943,
/// mainnet uses icp0.io.
const _nftId = import.meta.env.VITE_NFT_CANISTER_ID as string || "";
const _network = import.meta.env.VITE_DFX_NETWORK as string || "local";
function nftImageUrl(token_id: bigint): string {
  if (!_nftId) return "#";
  return _network === "ic"
    ? `https://${_nftId}.icp0.io/token/${token_id}.png`
    : `http://${_nftId}.localhost:4943/token/${token_id}.png`;
}

function fmtError(err: AllianceError | string | null): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if ("InvalidMission" in err) return "Invalid mission: " + err.InvalidMission;
  if ("Unauthorized" in err) return "Login required";
  if ("NotFound" in err) return "Alliance not found";
  if ("AlreadyInAlliance" in err) return "You are already in an alliance";
  if ("NotInAlliance" in err) return "You are not in any alliance";
  if ("NameEmpty" in err) return "Name is required";
  if ("NameTooLong" in err) return "Name is too long (max 64 chars)";
  if ("DescriptionTooLong" in err) return "Description is too long (max 500 chars)";
  if ("NotLeader" in err) return "Only the alliance leader can do that";
  if ("MissionNotComplete" in err) return "Mission must reach 95% before upgrading";
  if ("UpgradeMustContainOld" in err) return "New mission must fully contain the old one";
  if ("OldPixelsModified" in err) return "Old mission pixels must stay unchanged";
  if ("MissionAreaAlreadyPainted" in err)
    return `That area already matches the template by ${err.MissionAreaAlreadyPainted}% — pick a different spot`;
  if ("NftCanisterNotConfigured" in err) return "NFT canister is not configured";
  if ("NftMintFailed" in err) return "NFT mint failed: " + err.NftMintFailed;
  if ("NftNotBurned" in err)
    return "Burn the old NFT first to upgrade your mission";
  if ("PaymentFailed" in err) return "Payment failed: " + err.PaymentFailed;
  if ("Paused" in err) return "Game is paused for maintenance";
  if ("InternalError" in err) return "Something went wrong: " + err.InternalError;
  if ("RoundNotFound" in err) return "Round not found";
  if ("RoundNotCompleted" in err) return "Round not finished yet";
  if ("NoContribution" in err) return "You haven't placed any correct pixels in this round";
  if ("AlreadyClaimed" in err) return "You already claimed this round";
  return "Unknown error";
}

/// Format an e8s amount as ICP with up to 4 decimal places. Used by the
/// rewards UI to show estimated and actual claim shares.
import { fmtIcp } from "./fmt";

/// Self-contained rewards section. Polls `get_mission_rounds` and
/// `my_mission_contribution` for the current alliance and renders:
///   - The active round's contribution counter and estimated share
///   - A list of completed rounds with claim status / claim button
///
/// Refreshes whenever `tick` changes (parent bumps it after a successful
/// place_pixel via the existing meta-refresh path) so feedback is near-
/// instant. The polling itself is cheap (two query calls).
function RewardsPanel({
  actor,
  allianceId,
  tick,
}: {
  actor: BackendActor;
  allianceId: bigint;
  tick: number;
}) {
  const [rounds, setRounds] = useState<MissionRoundPublic[]>([]);
  const [activeContribution, setActiveContribution] =
    useState<MissionContributionView | null>(null);
  const [completedContributions, setCompletedContributions] = useState<
    Record<number, MissionContributionView>
  >({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Reload rounds + contributions whenever the parent ticks (post place_pixel)
  // or the alliance changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rs = await actor.get_mission_rounds(allianceId);
        if (cancelled) return;
        setRounds(rs);
        // Active round = last one. May be the only one (round 0) or a fresh
        // round opened by upgrade_mission.
        if (rs.length === 0) {
          setActiveContribution(null);
          setCompletedContributions({});
          return;
        }
        const active = rs[rs.length - 1];
        const activeRes = await actor.my_mission_contribution(
          allianceId,
          active.round_index,
        );
        if (!cancelled && "Ok" in activeRes) setActiveContribution(activeRes.Ok);

        // Pull contribution view for every completed round so we can show
        // claim buttons. Skip the active round if it's not completed.
        const next: Record<number, MissionContributionView> = {};
        for (const r of rs) {
          if (r.completed_at.length === 0) continue;
          const res = await actor.my_mission_contribution(allianceId, r.round_index);
          if (cancelled) return;
          if ("Ok" in res) next[r.round_index] = res.Ok;
        }
        if (!cancelled) setCompletedContributions(next);
      } catch (e) {
        if (!cancelled) setMsg("rewards load failed: " + String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actor, allianceId, tick]);

  async function claim(roundIndex: number) {
    setBusy(roundIndex);
    setMsg(null);
    try {
      const res = await actor.claim_mission_reward(allianceId, roundIndex);
      if ("Ok" in res) {
        setMsg(
          res.Ok.share_e8s === 0n
            ? "claimed (0 ICP — pool empty in free mode)"
            : `claimed ${fmtIcp(res.Ok.share_e8s)} ICP`,
        );
        // Force a refresh by re-pulling the contribution for that round.
        const fresh = await actor.my_mission_contribution(allianceId, roundIndex);
        if ("Ok" in fresh) {
          setCompletedContributions((prev) => ({ ...prev, [roundIndex]: fresh.Ok }));
        }
      } else {
        setMsg(fmtError(res.Err));
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  }

  if (rounds.length === 0) return null;
  const active = rounds[rounds.length - 1];
  const completedRounds = rounds.filter((r) => r.completed_at.length > 0);

  return (
    <div
      style={{
        marginBottom: 10,
        padding: "8px 10px",
        background: C.bgInput,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 700, color: C.text }}>
          rewards · round {active.round_index + 1}
        </span>
        <span style={{ color: C.textDim, fontSize: 11 }}>
          {String(active.credited_cells_count)}/{String(active.pixel_count)} cells
        </span>
      </div>
      {activeContribution && (
        <div style={{ color: C.textDim, fontSize: 11, marginBottom: 4 }}>
          your placements:{" "}
          <span style={{ color: C.text, fontWeight: 600 }}>
            {activeContribution.member_pixels} member
          </span>
          {activeContribution.helper_pixels > 0 && (
            <>
              {" · "}
              <span style={{ color: C.text, fontWeight: 600 }}>
                {activeContribution.helper_pixels} helper
              </span>
            </>
          )}
        </div>
      )}
      {completedRounds.length > 0 && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>
            completed rounds
          </div>
          {completedRounds.map((r) => {
            const c = completedContributions[r.round_index];
            const claimed = c?.claimed ?? false;
            const hasContribution = c && (c.member_pixels > 0 || c.helper_pixels > 0);
            const share = c?.estimated_share_e8s ?? 0n;
            return (
              <div
                key={r.round_index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  padding: "4px 0",
                }}
              >
                <span style={{ color: C.text, fontSize: 11 }}>
                  R{r.round_index + 1} · {r.width}×{r.height}
                  {hasContribution && (
                    <span style={{ color: C.textDim }}>
                      {" "}
                      · {(c.member_pixels ?? 0) + (c.helper_pixels ?? 0)} px → {fmtIcp(share)} ICP
                    </span>
                  )}
                </span>
                {hasContribution && !claimed ? (
                  <button
                    disabled={busy === r.round_index}
                    onClick={() => claim(r.round_index)}
                    style={{
                      padding: "3px 8px",
                      fontSize: 11,
                      background: C.green,
                      color: C.accentText,
                      border: "none",
                      borderRadius: 4,
                      cursor: busy === r.round_index ? "wait" : "pointer",
                      fontWeight: 700,
                    }}
                  >
                    {busy === r.round_index ? "…" : "claim"}
                  </button>
                ) : claimed ? (
                  <span style={{ fontSize: 10, color: C.textDim }}>claimed</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {msg && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: msg.startsWith("claimed") ? C.green : C.textDim,
          }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}

// Palette + image-to-template conversion moved into MissionImageCrop.

function shortPrincipal(p: { toString: () => string }): string {
  const s = p.toString();
  return s.slice(0, 5) + "…" + s.slice(-3);
}

function MissionThumbWithCoords({
  canvasRef,
  mission,
  onPickColor,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  mission: Mission;
  onPickColor?: (color: number) => void;
}) {
  const [coord, setCoord] = useState<string | null>(null);
  const mw = mission.width;
  const mh = mission.height;
  const mx = mission.x;
  const my = mission.y;
  const BOX = 120;
  const scale = Math.min(BOX / mw, BOX / mh);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {coord && (
        <div
          style={{
            position: "absolute",
            top: -20,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            fontWeight: 600,
            color: "#ffcc00",
            background: "rgba(0,0,0,0.7)",
            padding: "1px 6px",
            borderRadius: 3,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {coord}
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          width: mw * scale,
          height: mh * scale,
          imageRendering: "pixelated",
          background: "#fff",
          border: "1px solid #333",
          borderRadius: 4,
          cursor: "crosshair",
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = Math.floor(((e.clientX - rect.left) / rect.width) * mw);
          const py = Math.floor(((e.clientY - rect.top) / rect.height) * mh);
          setCoord(`(${px + mx}, ${py + my})`);
        }}
        onMouseLeave={() => setCoord(null)}
        onClick={(e) => {
          if (!onPickColor) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const px = Math.floor(((e.clientX - rect.left) / rect.width) * mw);
          const py = Math.floor(((e.clientY - rect.top) / rect.height) * mh);
          const idx = py * mw + px;
          const tpl = mission.template as Array<number | bigint>;
          if (idx >= 0 && idx < tpl.length) {
            onPickColor(Number(tpl[idx]));
          }
        }}
      />
    </div>
  );
}

export default function AlliancePanel({
  actor,
  alliances,
  myAlliance,
  myPrincipal,
  pendingRect,
  creating,
  mapSize,
  setCreating,
  setPendingRect,
  onClearRect,
  onChanged,
  missionProgress,
  onGoToMission,
  onShareMission,
  tab,
  setTab,
  authed,
  requireSignIn,
  onPickColor,
  isMobile,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /// True when the leader is in the middle of upgrading the mission. The form
  /// reuses the create-alliance flow (rect + image), but on submit it calls
  /// `upgrade_mission` instead of `create_alliance` and the new rect must
  /// CONTAIN the old one.
  const [upgrading, setUpgrading] = useState(false);
  // Alliance creation fee. Refetched on mount; cheap to call (small query).
  const [priceE8s, setPriceE8s] = useState<bigint>(0n);
  useEffect(() => {
    let stop = false;
    actor
      .get_alliance_billing()
      .then((b: { alliance_price_e8s: bigint }) => {
        if (!stop) setPriceE8s(b.alliance_price_e8s);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [actor]);

  // ── Leaderboard tab data ──────────────────────────────────────────
  // Lazy-loaded: only fetched when the leaderboard tab is opened. Refreshes
  // every 5s while that tab is visible. When the user switches to "mine"
  // we stop the timer to save query bandwidth.
  const LB_PAGE_SIZE = 50;
  const [lbEntries, setLbEntries] = useState<LeaderboardEntry[]>([]);
  const [lbTotal, setLbTotal] = useState(0);
  const [lbTopPixels, setLbTopPixels] = useState<bigint>(0n);
  const [lbMyEntry, setLbMyEntry] = useState<LeaderboardEntry | null>(null);
  const [lbLoading, setLbLoading] = useState(false);

  async function fetchLeaderboard(loadCount: number) {
    setLbLoading(true);
    try {
      const p = await actor.leaderboard(0n, BigInt(loadCount));
      setLbEntries(p.entries);
      setLbTotal(Number(p.total));
      setLbTopPixels(p.top_pixels);
      setLbMyEntry(p.my_entry?.[0] ?? null);
    } catch (e) {
      console.warn("leaderboard fetch failed", e);
    } finally {
      setLbLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "leaderboard") return;
    // Initial load + 5s refresh while the tab is open.
    fetchLeaderboard(Math.max(LB_PAGE_SIZE, lbEntries.length));
    const id = setInterval(() => {
      fetchLeaderboard(Math.max(LB_PAGE_SIZE, lbEntries.length));
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, actor]);
  const isLeader =
    !!myAlliance && !!myPrincipal && myAlliance.leader.toString() === myPrincipal;
  const missionDone = !!missionProgress && missionProgress.percent >= 0.95;

  // ── Mission thumbnail ─────────────────────────────────────────────
  // Renders the alliance's own mission template into a tiny canvas. The
  // template is already on the client (it was sent at create time and
  // returned by get_my_alliance), so this costs zero queries and zero
  // bytes — just a putImageData of width×height pixels, CSS-scaled.
  const missionThumbRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = missionThumbRef.current;
    if (!canvas || !myAlliance) return;
    const m = myAlliance.mission;
    canvas.width = m.width;
    canvas.height = m.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(m.width, m.height);
    const tpl = m.template;
    for (let i = 0; i < tpl.length; i++) {
      const c = Number(tpl[i]);
      img.data[i * 4 + 0] = (c >> 16) & 0xff;
      img.data[i * 4 + 1] = (c >> 8) & 0xff;
      img.data[i * 4 + 2] = c & 0xff;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [myAlliance]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState<number[] | null>(null);

  // Callback for MissionImageCrop → feeds into the same previewTemplate
  // that the submit flow reads.
  const setCropTemplate = useCallback((tpl: number[] | null) => {
    setPreviewTemplate(tpl);
  }, []);

  // Old paste/image-processing effects removed — MissionImageCrop handles
  // image loading, paste, crop, and palette quantization internally.

  function canSubmit(): boolean {
    return (
      !busy &&
      !!name.trim() &&
      !!pendingRect &&
      pendingRect.width >= 5 &&
      pendingRect.height >= 5 &&
      !!previewTemplate
    );
  }

  async function handleCreate() {
    // View-only gate. On successful sign-in the same submit replays.
    if (!authed) {
      requireSignIn("Sign in to create an alliance", () => handleCreate());
      return;
    }
    setErr(null);
    if (!name.trim()) return setErr("name required");
    if (!pendingRect) return setErr("draw a rectangle on the map");
    if (pendingRect.width < 5 || pendingRect.height < 5) return setErr("min size 5×5");
    if (!previewTemplate) return setErr("upload an image");
    setBusy(true);
    try {
      const mission: Mission = { ...pendingRect, template: previewTemplate };
      const res = await actor.create_alliance(name, description, mission, website);
      if ("Err" in res) {
        setErr(fmtError(res.Err));
      } else {
        setName("");
        setDescription("");
        setWebsite("");
        setPreviewTemplate(null);
        onClearRect();
        setCreating(false);
        onChanged();
      }
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpgrade() {
    if (!authed) {
      requireSignIn("Sign in to upgrade the mission", () => handleUpgrade());
      return;
    }
    setErr(null);
    if (!myAlliance) return;
    if (!pendingRect) return setErr("draw the new (larger) rectangle");
    if (pendingRect.width < 5 || pendingRect.height < 5) return setErr("min size 5×5");
    if (!previewTemplate) return setErr("upload the new image");
    // Client-side containment check — backend re-validates anyway, but
    // catching it here avoids a wasted round-trip and a confusing error.
    const old = myAlliance.mission;
    const newRight = pendingRect.x + pendingRect.width;
    const newBottom = pendingRect.y + pendingRect.height;
    const oldRight = old.x + old.width;
    const oldBottom = old.y + old.height;
    if (
      pendingRect.x > old.x ||
      pendingRect.y > old.y ||
      newRight < oldRight ||
      newBottom < oldBottom
    ) {
      return setErr("new rect must fully contain the old one");
    }
    // Patch the new template so the cells corresponding to the old mission
    // area are byte-identical to the old template. Without this the backend
    // rejects with OldPixelsModified almost every time, because the user's
    // re-uploaded image is unlikely to land on the exact same pixels after
    // resampling.
    const tpl = previewTemplate.slice();
    const dx = old.x - pendingRect.x;
    const dy = old.y - pendingRect.y;
    const oldTpl = old.template as Array<number | bigint>;
    for (let row = 0; row < old.height; row++) {
      for (let col = 0; col < old.width; col++) {
        const oldIdx = row * old.width + col;
        const newIdx = (dy + row) * pendingRect.width + (dx + col);
        tpl[newIdx] = Number(oldTpl[oldIdx]);
      }
    }
    setBusy(true);
    try {
      const mission: Mission = { ...pendingRect, template: tpl };
      const res = await actor.upgrade_mission(myAlliance.id, mission);
      if ("Err" in res) {
        setErr(fmtError(res.Err));
      } else {
        setPreviewTemplate(null);
        onClearRect();
        setUpgrading(false);
        setCreating(false);
        onChanged();
      }
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(id: bigint) {
    if (!authed) {
      requireSignIn("Sign in to join an alliance", () => handleJoin(id));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await actor.join_alliance(id);
      if ("Err" in res) setErr(fmtError(res.Err));
      else onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!authed) {
      requireSignIn("Sign in to manage your alliance", () => handleLeave());
      return;
    }
    if (!confirm("Leave this alliance? You can't undo this.")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await actor.leave_alliance();
      if ("Err" in res) setErr(fmtError(res.Err));
      else onChanged();
    } catch (e) {
      setErr("Failed to leave: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  const sortedAlliances = [...alliances].sort((a, b) =>
    Number(b.pixels_captured - a.pixels_captured)
  );

  const mobilePanelStyle: CSSProperties = {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    top: "auto",
    width: "auto",
    maxHeight: "70vh",
    borderRadius: "16px 16px 0 0",
    zIndex: 50,
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderBottom: "none",
    fontSize: 13,
    color: C.text,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 -8px 32px rgba(0,0,0,0.5)",
    fontFamily: "system-ui,sans-serif",
    overscrollBehavior: "contain",
  };

  return (
    <>
    {isMobile && onClose && (
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 49 }}
      />
    )}
    <div style={isMobile ? mobilePanelStyle : styles.panel}>
      {isMobile && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "10px 0 6px",
            cursor: "grab",
          }}
          onClick={onClose}
        >
          <div style={{ width: 40, height: 4, background: "#3a3a44", borderRadius: 2 }} />
        </div>
      )}
      <div style={styles.header}>
        <h3 style={styles.title}>⚔ Alliances</h3>
        <span style={{ fontSize: 11, color: C.textMuted }}>
          {alliances.length} active
        </span>
      </div>

      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${C.border}`,
          background: C.bg,
        }}
      >
        {(["mine", "leaderboard"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              borderBottom:
                tab === t ? `2px solid ${C.accent}` : "2px solid transparent",
              color: tab === t ? C.text : C.textDim,
              padding: "10px 8px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              letterSpacing: 0.3,
              textTransform: "uppercase",
            }}
          >
            {t === "mine" ? "Your alliance" : "Leaderboard"}
          </button>
        ))}
      </div>

      <div style={styles.body}>
       {tab === "mine" && (
        <>
        {/* My alliance / create button / create form */}
        {myAlliance ? (
          <div style={styles.myCard}>
            <div style={styles.myBadge}>★ Your alliance</div>
            <div style={styles.myName}>{myAlliance.name}</div>
            {myAlliance.description && (
              <div style={styles.myDesc}>{myAlliance.description}</div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 10,
              }}
            >
              <MissionThumbWithCoords
                canvasRef={missionThumbRef}
                mission={myAlliance.mission}
                onPickColor={onPickColor}
              />
            </div>
            <div style={styles.statRow}>
              <span style={styles.stat}>
                <span style={styles.statValue}>{myAlliance.members.length}</span> members
              </span>
              <span style={styles.stat}>
                <span style={styles.statValue}>
                  {myAlliance.mission.width}×{myAlliance.mission.height}
                </span>{" "}
                mission
              </span>
              <span style={styles.stat}>
                <span style={styles.statValue}>{String(myAlliance.pixels_captured)}</span>{" "}
                captured
              </span>
            </div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 10 }}>
              led by {shortPrincipal(myAlliance.leader)}
            </div>

            {/* Map share — pie chart of how much of the map your alliance owns. */}
            {(() => {
              const captured = Number(myAlliance.pixels_captured);
              const total = mapSize * mapSize;
              const share = total > 0 ? Math.min(1, captured / total) : 0;
              const angle = share * 2 * Math.PI;
              const r = 22;
              const cx = 26;
              const cy = 26;
              const x2 = cx + r * Math.sin(angle);
              const y2 = cy - r * Math.cos(angle);
              const largeArc = angle > Math.PI ? 1 : 0;
              const path =
                share >= 0.999
                  ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
                  : `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
              return (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 10,
                    padding: 8,
                    background: C.bgInput,
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                  }}
                  title={`${captured} / ${total} cells (${(share * 100).toFixed(2)}%)`}
                >
                  <svg width={52} height={52} viewBox="0 0 52 52">
                    <circle cx={cx} cy={cy} r={r} fill="#1a1a20" stroke={C.border} strokeWidth="1" />
                    {share > 0 && <path d={path} fill={C.accent} />}
                    <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth="1" />
                  </svg>
                  <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.4 }}>
                    <div style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>
                      {(share * 100).toFixed(share < 0.01 ? 3 : 2)}%
                    </div>
                    <div>of map captured</div>
                  </div>
                </div>
              );
            })()}

            {missionProgress && (
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: C.textDim,
                    marginBottom: 4,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span>mission progress</span>
                  <span>
                    {missionProgress.matched}/{missionProgress.total} ·{" "}
                    {Math.floor(missionProgress.percent * 100)}%
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: C.bgInput,
                    borderRadius: 4,
                    overflow: "hidden",
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <div
                    style={{
                      width: `${missionProgress.percent * 100}%`,
                      height: "100%",
                      background:
                        missionProgress.percent >= 0.95 ? C.green : C.accent,
                      transition: "width 0.25s ease",
                    }}
                  />
                </div>
              </div>
            )}

            <RewardsPanel
              actor={actor}
              allianceId={myAlliance.id}
              tick={missionProgress?.matched ?? 0}
            />

            {/* NFT badge — appears once the backend has minted the mission's
                NFT to the leader. Clicking opens the canister's HTTP image
                endpoint in a new tab. */}
            {myAlliance.nft_token_id.length > 0 && (() => {
              const tokenId = myAlliance.nft_token_id[0]!;
              return (
              <a
                href={nftImageUrl(tokenId)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  marginBottom: 10,
                  background: "linear-gradient(135deg,#3a2a06,#5a4108)",
                  border: `1px solid #b88a1f`,
                  borderRadius: 6,
                  color: "#ffd76a",
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: "none",
                }}
                title="Open the NFT image in a new tab"
              >
                <span style={{ fontSize: 16 }}>🏆</span>
                <span>NFT #{String(tokenId)} minted</span>
              </a>
              );
            })()}
            {myAlliance.nft_mint_in_progress && myAlliance.nft_token_id.length === 0 && (
              <div
                style={{
                  padding: "6px 10px",
                  marginBottom: 10,
                  background: C.bgInput,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  fontSize: 12,
                  color: C.textDim,
                }}
              >
                ⏳ minting NFT…
              </div>
            )}

            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={onGoToMission}
                style={{ ...styles.smallBtn, flex: 1 }}
                title="center the map on your mission"
              >
                ⤢ go to mission
              </button>
              <button
                onClick={onShareMission}
                style={styles.smallBtn}
                title="copy a shareable link to your mission"
              >
                🔗 share
              </button>
              <button onClick={handleLeave} disabled={busy} style={styles.dangerBtn}>
                leave
              </button>
            </div>
            {/* Mission upgrade — leader only, only after the current mission
                has crossed the 95% completion threshold. Opens the create
                form repurposed for upgrade. */}
            {isLeader && missionDone && !upgrading && (
              <button
                onClick={() => {
                  setUpgrading(true);
                  // Reuse the create-flow shift-drag wiring in App.tsx —
                  // it gates on `creating`, so flipping that on lets the
                  // user shift-drag a new rect over the map. The render
                  // conditional below still falls into the myAlliance
                  // branch (myAlliance is non-null), so the upgrade form
                  // — not the create form — is what's shown.
                  setCreating(true);
                  setErr(null);
                  setPreviewTemplate(null);
                  // Pre-seed the rect with the existing mission so the user
                  // can extend it instead of starting from scratch.
                  setPendingRect({
                    x: myAlliance.mission.x,
                    y: myAlliance.mission.y,
                    width: myAlliance.mission.width,
                    height: myAlliance.mission.height,
                  });
                }}
                style={{
                  ...styles.smallBtn,
                  width: "100%",
                  marginTop: 8,
                  background: "linear-gradient(135deg, #2a4fd8, #3b6cff)",
                  color: "#fff",
                  borderColor: "#3b6cff",
                  fontWeight: 700,
                }}
                title="grow your mission area — burns the old NFT, mints a new one when complete"
              >
                ⇪ upgrade mission
              </button>
            )}
            {upgrading && (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  background: C.bgInput,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 11, color: C.textDim }}>
                  Shift-drag a NEW rectangle that fully contains the old one,
                  then upload a new image. The old pixels are preserved
                  automatically.
                </div>
                <div style={{ fontSize: 11, color: C.textMuted }}>
                  {pendingRect
                    ? `${pendingRect.width}×${pendingRect.height} @ (${pendingRect.x}, ${-pendingRect.y})`
                    : "draw a rectangle"}
                </div>
                <div style={{ display: pendingRect && pendingRect.width >= 5 && pendingRect.height >= 5 ? "block" : "none" }}>
                  <MissionImageCrop
                    gridW={pendingRect?.width ?? 5}
                    gridH={pendingRect?.height ?? 5}
                    onTemplate={setCropTemplate}
                    accent={C.accent}
                    border={C.border}
                    textDim={C.textDim}
                    textMuted={C.textMuted}
                  />
                </div>
                {err && (
                  <div style={{ fontSize: 11, color: C.red }}>{err}</div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={handleUpgrade}
                    disabled={busy || !pendingRect || !previewTemplate}
                    style={{ ...styles.primaryBtn, flex: 1 }}
                  >
                    {busy ? "upgrading…" : "upgrade"}
                  </button>
                  <button
                    onClick={() => {
                      setUpgrading(false);
                      setCreating(false);
                      setPreviewTemplate(null);
                      setErr(null);
                      onClearRect();
                    }}
                    disabled={busy}
                    style={styles.ghostBtn}
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : creating ? (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div style={{ ...styles.sectionLabel, margin: 0 }}>New alliance</div>
              <button
                onClick={() => {
                  setCreating(false);
                  onClearRect();
                  setErr(null);
                }}
                style={styles.ghostBtn}
              >
                cancel
              </button>
            </div>

            <input
              placeholder="Alliance name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              style={styles.input}
            />
            <textarea
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              style={{ ...styles.input, minHeight: 50, resize: "vertical" }}
            />
            <input
              placeholder="Website (optional, https://...)"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              maxLength={200}
              style={styles.input}
            />

            <div style={styles.step}>
              <div style={styles.stepTitle}>1 · Mission area</div>
              <div style={{ fontSize: 12 }}>
                {pendingRect ? (
                  <span
                    style={{
                      color:
                        pendingRect.width >= 5 && pendingRect.height >= 5
                          ? C.green
                          : C.red,
                      fontWeight: 600,
                    }}
                  >
                    {pendingRect.width}×{pendingRect.height} @ ({pendingRect.x},
                    {pendingRect.y})
                    {(pendingRect.width < 5 || pendingRect.height < 5) && " — min 5×5"}
                  </span>
                ) : (
                  <span style={{ color: C.textMuted }}>
                    Hold <b>SHIFT</b> and drag on the map
                  </span>
                )}
              </div>
            </div>

            <div style={styles.step}>
              <div style={styles.stepTitle}>2 · Mission image</div>
              {/* Always mounted so image state survives rect changes. Hidden when rect too small. */}
              <div style={{ display: pendingRect && pendingRect.width >= 5 && pendingRect.height >= 5 ? "block" : "none" }}>
                <MissionImageCrop
                  gridW={pendingRect?.width ?? 5}
                  gridH={pendingRect?.height ?? 5}
                  onTemplate={setCropTemplate}
                  accent={C.accent}
                  border={C.border}
                  textDim={C.textDim}
                  textMuted={C.textMuted}
                />
              </div>
              {!(pendingRect && pendingRect.width >= 5 && pendingRect.height >= 5) && (
                <div style={{ fontSize: 11, color: C.textMuted, opacity: 0.5 }}>
                  draw the mission area first (step 1)
                </div>
              )}
            </div>

            <div
              style={{
                fontSize: 11,
                color: "#9aa",
                marginBottom: 6,
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
              }}
              title="Alliance creation fee — paid once on submit"
            >
              Cost: {(Number(priceE8s) / 1e8).toFixed(2)} ICP
            </div>
            <button
              onClick={handleCreate}
              disabled={!canSubmit()}
              style={{
                ...styles.primaryBtn,
                opacity: canSubmit() ? 1 : 0.4,
                cursor: canSubmit() ? "pointer" : "not-allowed",
              }}
            >
              create alliance
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            style={{ ...styles.primaryBtn, marginBottom: 14 }}
          >
            + create alliance
          </button>
        )}

        {err && (
          <div
            style={{
              color: C.red,
              fontSize: 12,
              padding: "6px 10px",
              background: `${C.red}15`,
              border: `1px solid ${C.red}40`,
              borderRadius: 5,
              marginBottom: 10,
            }}
          >
            {err}
          </div>
        )}

        </>
       )}

       {tab === "leaderboard" && (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
            {lbTotal} alliance{lbTotal === 1 ? "" : "s"} ranked by pixels captured
            {lbLoading && " · loading..."}
          </div>

          {/* Sticky "your rank" row when off-page. */}
          {lbMyEntry &&
            !lbEntries.some(
              (e) => e.alliance.id === lbMyEntry.alliance.id
            ) && (
              <>
                <div
                  style={{
                    fontSize: 10,
                    color: C.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    marginBottom: 4,
                  }}
                >
                  Your rank
                </div>
                <LbRow
                  entry={lbMyEntry}
                  topPixels={lbTopPixels}
                  isMine
                  myAlliance={myAlliance}
                  busy={busy}
                  onJoin={handleJoin}
                />
                <div style={{ height: 10 }} />
              </>
            )}

          {lbEntries.length === 0 && !lbLoading && (
            <div style={{ color: C.textMuted, fontSize: 12, padding: "8px 0" }}>
              No alliances yet — be the first.
            </div>
          )}

          {lbEntries.map((e) => (
            <LbRow
              key={String(e.alliance.id)}
              entry={e}
              topPixels={lbTopPixels}
              isMine={
                lbMyEntry !== null &&
                e.alliance.id === lbMyEntry.alliance.id
              }
              myAlliance={myAlliance}
              busy={busy}
              onJoin={handleJoin}
            />
          ))}

          {lbEntries.length > 0 && lbEntries.length < lbTotal && (
            <button
              onClick={() => fetchLeaderboard(lbEntries.length + LB_PAGE_SIZE)}
              disabled={lbLoading}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "8px",
                background: C.bgElev,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                color: C.text,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {lbLoading
                ? "loading..."
                : `load more (${lbEntries.length} / ${lbTotal})`}
            </button>
          )}

          {/* Suppress unused warnings on `sortedAlliances` while we keep
              the array around for any future fallback rendering. */}
          {void sortedAlliances}
        </>
       )}
      </div>
    </div>
    </>
  );
}

// ── Leaderboard row (compact, fits the 340px panel) ────────────────
function LbRow({
  entry,
  topPixels,
  isMine,
  myAlliance,
  busy,
  onJoin,
}: {
  entry: LeaderboardEntry;
  topPixels: bigint;
  isMine: boolean;
  myAlliance: Alliance | null;
  busy: boolean;
  onJoin: (id: bigint) => void;
}) {
  const a = entry.alliance;
  const top = Number(topPixels);
  const px = Number(a.pixels_captured);
  const pct = top > 0 ? (px / top) * 100 : 0;
  const medal =
    entry.rank === 1 ? "🥇"
    : entry.rank === 2 ? "🥈"
    : entry.rank === 3 ? "🥉"
    : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: isMine ? `${C.accent}15` : C.bgElev,
        border: `1px solid ${isMine ? `${C.accent}80` : C.border}`,
        borderRadius: 6,
        marginBottom: 6,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 28,
          textAlign: "center",
          fontSize: medal ? 18 : 13,
          fontWeight: 800,
          color: isMine ? C.accent : C.textMuted,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        {medal ?? `#${entry.rank}`}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: C.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={a.name}
        >
          {a.name}
          {isMine && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                background: C.accent,
                color: C.accentText,
                padding: "1px 5px",
                borderRadius: 3,
                verticalAlign: "middle",
                fontWeight: 800,
              }}
            >
              YOU
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: C.textMuted,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Number(a.pixels_captured).toLocaleString("en-US")} px ·{" "}
          {a.member_count} members
        </div>
      </div>
      {!myAlliance && (
        <button
          onClick={() => onJoin(a.id)}
          disabled={busy}
          style={{
            background: C.bgInput,
            border: `1px solid ${C.border}`,
            color: C.text,
            fontSize: 11,
            padding: "5px 10px",
            borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          join
        </button>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: 2,
          width: `${pct}%`,
          background: isMine ? C.accent : C.blue,
          transition: "width 0.4s",
        }}
      />
    </div>
  );
}
