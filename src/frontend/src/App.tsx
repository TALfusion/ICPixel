import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Principal } from "@dfinity/principal";
import {
  makeActor,
  makeAgent,
  getAuthClient,
  loginWithII,
  logout,
  loadOrCreateIdentity,
  clearIdentity,
  useII,
} from "./api";
import type { Alliance, AlliancePublic, BackendActor, GameState, PlaceError } from "./idl";
import { createLedgerActor, buildApproveAmount } from "./ledger";
import AlliancePanel from "./AlliancePanel";
import AdminPanel from "./AdminPanel";
import Dashboard from "./Dashboard";
import {
  isMuted,
  setMuted,
  unlockAudio,
  playPlacePixel,
  playError,
  playMissionDing,
  playMissionComplete,
  playMapGrew,
  playAllianceCreated,
} from "./sound";

// Map growth stages (mirrors STAGES in src/backend/src/map.rs).
// When `unique_pixels_set` reaches `map_size²`, map grows to the next stage.
const STAGES = [1, 5, 10, 50, 100, 500];
function nextStage(current: number): number | null {
  const i = STAGES.indexOf(current);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

// r/place 2022 official 32-color palette.
const DEFAULT_PALETTE = [
  0x6d001a, 0xbe0039, 0xff4500, 0xffa800, 0xffd635, 0xfff8b8,
  0x00a368, 0x00cc78, 0x7eed56, 0x00756f, 0x009eaa, 0x00ccc0,
  0x2450a4, 0x3690ea, 0x51e9f4, 0x493ac1, 0x6a5cff, 0x94b3ff,
  0x811e9f, 0xb44ac0, 0xe4abff, 0xde107f, 0xff3881, 0xff99aa,
  0x6d482f, 0x9c6926, 0xffb470, 0x000000, 0x515252, 0x898d90,
  0xd4d7d9, 0xffffff,
];

function intToHex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}

/// Centered-coordinate helpers. (0,0) is the geometric center of the map.
/// Valid range for size N is x ∈ [-(N/2), (N+1)/2), same for y.
/// halfNeg = |min coord|; halfPos = exclusive upper bound (positive).
function halfNeg(size: number): number {
  return Math.floor(size / 2);
}
function halfPos(size: number): number {
  return Math.ceil(size / 2);
}
/// Convert a (signed) cell coordinate to its index in the row-major
/// canvas array. The array is `size × size` with the top-left cell at
/// world coordinate (-halfNeg, -halfNeg).
function cellToIdx(x: number, y: number, size: number): number {
  const hn = halfNeg(size);
  return (y + hn) * size + (x + hn);
}
function inBounds(x: number, y: number, size: number): boolean {
  const hn = halfNeg(size);
  const hp = halfPos(size);
  return x >= -hn && x < hp && y >= -hn && y < hp;
}

/// Local-time YYYY-MM-DD key for the daily-streak counter.
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/// Whole calendar-day difference between two YYYY-MM-DD keys.
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}

// ── Palette hotkey bindings ────────────────────────────────────────
// Map from digit string ("1".."9") to palette slot index. Persisted in
// localStorage. Defaults: digit N → slot N-1.
const BINDINGS_KEY = "icpixel:palette-bindings:v1";
function loadBindings(): Record<string, number> {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function saveBindings(b: Record<string, number>) {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(b));
  } catch {}
}

// ── View (zoom + pan) persistence ─────────────────────────────────
// Tied to `mapSize` — when the map grows, the saved pan is meaningless and
// we fall back to the auto-fit default.
const VIEW_KEY = "icpixel:view:v1";
type SavedView = { mapSize: number; zoom: number; panX: number; panY: number };
function loadView(): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.mapSize === "number" && typeof v?.zoom === "number") return v;
  } catch {}
  return null;
}
function saveView(v: SavedView) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {}
}

// Generate the "blocked" cursor (logo rotated 45°) as a data URL at module
// load time. Drawn once via an offscreen canvas so it's pixel-identical to
// the CSS-rotated logo on the ready button.
const blockedCursorUrl: string = (() => {
  try {
    const size = 32;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.rotate(Math.PI / 4);
    ctx.translate(-size / 2, -size / 2);
    ctx.fillStyle = "#ffffff";
    // Top arm + T-cap
    ctx.fillRect(15, 4, 2, 9);
    ctx.fillRect(13, 3, 6, 2);
    // Bottom arm + T-cap
    ctx.fillRect(15, 19, 2, 9);
    ctx.fillRect(13, 27, 6, 2);
    // Left arm + T-cap
    ctx.fillRect(4, 15, 9, 2);
    ctx.fillRect(3, 13, 2, 6);
    // Right arm + T-cap
    ctx.fillRect(19, 15, 9, 2);
    ctx.fillRect(27, 13, 2, 6);
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
})();

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── Screen routing ───────────────────────────────────────────────
  type Screen = "game" | "dashboard" | "admin" | "alliances" | "profile";
  const [screen, setScreen] = useState<Screen>("game");
  // Ref mirror so global event handlers can read the current screen
  // without being re-created on every screen switch.
  const screenRef = useRef<Screen>("game");
  screenRef.current = screen;

  const [actor, setActor] = useState<BackendActor | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [map, setMap] = useState<number[] | null>(null);
  // ── Replay mode ───────────────────────────────────────────────────
  // When active, the map you see is reconstructed from the change-log up
  // to `replayIndex` instead of being driven by polling. Polling pauses
  // entirely while replay is open. Memory usage on the client is ~16 bytes
  // per change (x, y, color, padding) — 10k changes = ~160KB, fine.
  const [replayMode, setReplayMode] = useState(false);
  const [replayChanges, setReplayChanges] = useState<
    Array<{ x: number; y: number; color: number }>
  >([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const REPLAY_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];
  const [replaySpeedIdx, setReplaySpeedIdx] = useState(3); // default 1x
  const replaySpeed = REPLAY_SPEEDS[replaySpeedIdx];

  // Alliance state — single source of truth, lifted from AlliancePanel.
  const [myAlliance, setMyAlliance] = useState<Alliance | null>(null);
  const [alliances, setAlliances] = useState<AlliancePublic[]>([]);

  const palette = DEFAULT_PALETTE;
  const [selectedSlot, setSelectedSlot] = useState<number>(2);

  // Same-color overwrite warning
  const SAME_COLOR_KEY = "icpixel:skip-same-color-warn";
  const [skipSameColorWarn, setSkipSameColorWarn] = useState(() => {
    try { return localStorage.getItem(SAME_COLOR_KEY) === "1"; } catch { return false; }
  });
  const [sameColorConfirm, setSameColorConfirm] = useState<{
    x: number; y: number; color: number;
  } | null>(null);

  // Hotkey bindings: digit → palette slot. Default: digit N maps to slot N-1
  // unless the user has overridden it via Ctrl+digit then click.
  const [bindings, setBindings] = useState<Record<string, number>>(() => loadBindings());
  useEffect(() => {
    saveBindings(bindings);
  }, [bindings]);
  // Pending rebind: when user holds Ctrl and presses a digit, we remember it
  // and the next swatch click writes the binding.
  const pendingRebindRef = useRef<{ digit: string; until: number } | null>(null);
  const [rebindDigit, setRebindDigit] = useState<string | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Auto-fit / restore-view: when we first see a particular `map_size`, try to
  // restore the saved view (if it was for the same size), otherwise reset to
  // the auto-fit default (zoom=1, pan=0,0). This re-runs when the map grows.
  const restoredForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    if (restoredForRef.current === state.map_size) return;
    restoredForRef.current = state.map_size;
    const saved = loadView();
    if (saved && saved.mapSize === state.map_size) {
      setZoom(saved.zoom);
      setPan({ x: saved.panX, y: saved.panY });
    } else {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [state]);
  // Persist view changes (debounced via the natural render cadence — fine).
  useEffect(() => {
    if (!state) return;
    saveView({ mapSize: state.map_size, zoom, panX: pan.x, panY: pan.y });
  }, [zoom, pan, state]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // Eyedropper: active while holding Tab OR while eyedropper mode is toggled
  // on via the toolbar button. Hovering any cell picks that cell's color.
  const [tabDown, setTabDown] = useState(false);
  const [eyedropperMode, setEyedropperMode] = useState(false);
  const eyedropperActive = tabDown || eyedropperMode;
  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (screenRef.current !== "game") return;
      if (e.key === "Tab") {
        e.preventDefault(); // browsers want Tab for focus — we want it.
        if (!e.repeat) setTabDown(true);
      }
    }
    function up(e: KeyboardEvent) {
      if (e.key === "Tab") setTabDown(false);
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  const [shiftDown, setShiftDown] = useState(false);

  // Mission rectangle being drawn (shift + drag).
  const [pendingRect, setPendingRect] = useState<
    { x: number; y: number; width: number; height: number } | null
  >(null);
  const rectDrawRef = useRef<{ startX: number; startY: number } | null>(null);

  // Whether the create-alliance form is open. Pending rect overlay only
  // renders when this is true.
  const [creatingAlliance, setCreatingAlliance] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"mine" | "leaderboard">("mine");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showFullPrincipal, setShowFullPrincipal] = useState(false);

  // Pan clamp.
  function clampPan(p: { x: number; y: number }, rs: number): { x: number; y: number } {
    const wrapper = wrapperRef.current;
    if (!wrapper) return p;
    const rect = wrapper.getBoundingClientRect();
    const MARGIN = 50;
    const maxX = rect.width / 2 + rs / 2 - MARGIN;
    const maxY = rect.height / 2 + rs / 2 - MARGIN;
    return {
      x: Math.max(-maxX, Math.min(maxX, p.x)),
      y: Math.max(-maxY, Math.min(maxY, p.y)),
    };
  }
  const [status, setStatus] = useState<string>("loading...");

  const [authed, setAuthed] = useState(false);
  const [isController, setIsController] = useState(false);

  // ── View-only / sign-in gating ────────────────────────────────────
  //
  // The site works read-only when the user is not signed in — they can pan,
  // zoom, browse alliances, inspect missions. Any action that calls an
  // update method (place_pixel, create/join/leave alliance, upgrade
  // mission, buy pixels, ...) routes through `requireSignIn`, which either
  // runs it immediately (if authed) or opens a modal explaining why sign-in
  // is needed. On successful sign-in from the modal, the original action
  // fires automatically — one click from "browsing" to "playing".
  const [signInPromptOpen, setSignInPromptOpen] = useState(false);
  const [signInPromptReason, setSignInPromptReason] = useState<string>(
    "Sign in to play"
  );
  // Captured callback to run after sign-in succeeds. We use a ref instead
  // of state so requireSignIn can close over it without triggering a
  // re-render at capture time.
  const pendingActionRef = useRef<null | (() => void | Promise<void>)>(null);

  /// Run `action` immediately if signed in; otherwise open the sign-in
  /// modal with `reason` and remember the action to replay post-sign-in.
  function requireSignIn(
    reason: string,
    action: () => void | Promise<void>
  ): boolean {
    if (authed) {
      void action();
      return true;
    }
    pendingActionRef.current = action;
    setSignInPromptReason(reason);
    setSignInPromptOpen(true);
    return false;
  }
  const [muted, setMutedState] = useState(isMuted());

  // Mission completion latch — flips true once we've fired the fanfare.
  // If nft_token_id is already set on load, mission was completed before
  // this session → skip confetti. On upgrade_mission nft_token_id resets
  // so the latch resets automatically. No localStorage needed.
  const missionDoneRef = useRef(false);
  useEffect(() => {
    if (!myAlliance) {
      missionDoneRef.current = false;
      return;
    }
    missionDoneRef.current = (myAlliance.nft_token_id?.length ?? 0) > 0;
  }, [myAlliance?.id, myAlliance?.nft_token_id?.length]);

  // ── Cooldown ──────────────────────────────────────────────────────
  // `cooldownUntil` is wall-clock ms when the next pixel becomes legal.
  // Set from the backend's Cooldown error and also optimistically after a
  // successful place (must match backend `pixel_cooldown_seconds` from
  // billing config — currently 10s).
  const COOLDOWN_MS = 10_000;
  const [cooldownUntil, setCooldownUntilState] = useState<number>(0);
  // Mirror of `cooldownUntil` in a ref so the click gate sees the latest
  // value synchronously, even when the user clicks again before React has
  // re-rendered after the previous successful place. Without this the second
  // rapid click reads stale state == 0 and slips through the gate.
  const cooldownUntilRef = useRef<number>(0);
  const setCooldownUntil = useCallback((v: number) => {
    cooldownUntilRef.current = v;
    setCooldownUntilState(v);
  }, []);
  // `now` exists *purely* to trigger re-renders while the cooldown badge
  // is ticking. All actual timer math uses `Date.now()` directly — using
  // `now` in the arithmetic caused a stale-state bug where the first click
  // after a long idle period read `cooldownUntil - stale_now` and briefly
  // displayed e.g. 13s for a 10s cooldown.
  const [, setNowTick] = useState<number>(0);
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);
  const cooldownRemaining = Math.max(0, cooldownUntil - Date.now());
  const onCooldown = cooldownRemaining > 0;

  // ── Pixel credits / pixel-pack shop ───────────────────────────────
  // In free mode (`pixel_price_usd_cents == 0` on the backend) buy_pixels
  // credits immediately without any ledger interaction. Once flipped to
  // paid mode the same UI will trigger an ICRC-2 transfer_from path on
  // the backend — no client changes needed.
  const [pixelCredits, setPixelCredits] = useState<bigint>(0n);
  const [shopOpen, setShopOpen] = useState(false);
  // Cached ICP/USD rate for shop display. Fetched from backend on mount.
  const [usdPerIcp, setUsdPerIcp] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [howToPlay, setHowToPlay] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [shopBusy, setShopBusy] = useState(false);
  // Two-step pack flow: (1) click a pack → stash the count in
  // `shopDepositPack` and switch the modal to the deposit view;
  // (2) user sends ICP to the shown address and clicks "I paid" →
  // backend credits the pack (currently free-mode, but the flow is
  // already wired so flipping to real ICRC-2 later changes backend only).
  const [shopDepositPack, setShopDepositPack] = useState<number | null>(null);
  const refreshCredits = useCallback(async () => {
    if (!actor) return;
    try {
      const c = await actor.my_pixel_credits();
      setPixelCredits(c);
    } catch (e) {
      console.warn("my_pixel_credits failed", e);
    }
  }, [actor]);
  useEffect(() => {
    refreshCredits();
  }, [refreshCredits]);

  async function handleBuyPixels(count: number) {
    if (!actor || shopBusy) return;
    // View-only gate. After sign-in, replay the same purchase automatically.
    if (!authed) {
      requireSignIn("Sign in to buy pixel credits", () => handleBuyPixels(count));
      return;
    }
    setShopBusy(true);
    try {
      // Fetch the live billing config to decide whether this is a free or
      // paid purchase. Checking right before the call (instead of caching)
      // means the UI always acts on the latest admin config and we don't
      // accidentally bypass payment after a price flip.
      const billing = await actor.get_alliance_billing();
      const priceCents = Number(billing.pixel_price_usd_cents ?? 0);
      const ledgerPrincipal: Principal | null =
        billing.ledger.length > 0 && billing.ledger[0]
          ? billing.ledger[0]
          : null;
      const paid = priceCents > 0 && ledgerPrincipal !== null;

      if (paid && ledgerPrincipal) {
        // Compute an approve amount the browser can commit to. The backend
        // will re-derive the exact e8s from its own cached ICP/USD rate,
        // so our number only has to be a safe upper bound (base + 10%
        // buffer + ledger fee — see buildApproveAmount).
        if (usdPerIcp <= 0) {
          throw new Error(
            "ICP/USD rate not yet loaded — wait a few seconds and try again",
          );
        }
        const usdTotal = (count * priceCents) / 100; // dollars
        const icpTotal = usdTotal / usdPerIcp;
        const e8sPerPixel = BigInt(
          Math.ceil(((priceCents / 100) / usdPerIcp) * 1e8),
        );
        const approveAmount = buildApproveAmount(BigInt(count), e8sPerPixel);

        setStatus(`approving ${icpTotal.toFixed(4)} ICP…`);
        const identity = (await getAuthClient()).getIdentity();
        const agent = await makeAgent(identity);
        const ledgerActor = createLedgerActor(agent, ledgerPrincipal.toString());
        const backendIdStr = import.meta.env.VITE_BACKEND_CANISTER_ID as string;
        const approveRes = await ledgerActor.icrc2_approve({
          from_subaccount: [],
          spender: {
            owner: Principal.fromText(backendIdStr),
            subaccount: [],
          },
          amount: approveAmount,
          expected_allowance: [],
          expires_at: [],
          fee: [],
          memo: [],
          created_at_time: [],
        });
        if ("Err" in approveRes) {
          setStatus("approve failed: " + JSON.stringify(approveRes.Err));
          return;
        }
        setStatus("charging…");
      }

      const res = await actor.buy_pixels(BigInt(count));
      if ("Err" in res) {
        setStatus("buy_pixels: " + res.Err);
      } else {
        setStatus(`+${count} pixels`);
        await refreshCredits();
        setShopOpen(false);
        setShopDepositPack(null);
      }
    } catch (e) {
      setStatus("buy_pixels error: " + String(e));
    } finally {
      setShopBusy(false);
    }
  }

  // ── Mission template overlay ──────────────────────────────────────
  // A separate canvas that paints the alliance's mission template at its
  // intrinsic pixel size (mission.width × mission.height). It's then CSS-
  // scaled in the JSX below to match the on-screen mission rect and laid
  // over the main map at low opacity, so the leader sees what to draw.
  // Costs nothing — template is already on the client.
  const missionOverlayRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = missionOverlayRef.current;
    if (!canvas || !myAlliance) return;
    const m = myAlliance.mission;
    canvas.width = m.width;
    canvas.height = m.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(m.width, m.height);
    const tpl = m.template as Array<number | bigint>;
    for (let i = 0; i < tpl.length; i++) {
      const c = Number(tpl[i]);
      img.data[i * 4 + 0] = (c >> 16) & 0xff;
      img.data[i * 4 + 1] = (c >> 8) & 0xff;
      img.data[i * 4 + 2] = c & 0xff;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [myAlliance]);

  // ── Mission progress (matched/total over current map) ─────────────
  const missionProgress = useMemo(() => {
    if (!map || !myAlliance || !state) return null;
    const m = myAlliance.mission;
    const tpl = m.template as Array<number | bigint>;
    let matched = 0;
    const total = m.width * m.height;
    for (let yy = 0; yy < m.height; yy++) {
      for (let xx = 0; xx < m.width; xx++) {
        const want = Number(tpl[yy * m.width + xx]);
        const idx = cellToIdx(m.x + xx, m.y + yy, state.map_size);
        if (map[idx] === want) matched++;
      }
    }
    return { matched, total, percent: total ? matched / total : 0 };
  }, [map, myAlliance, state]);

  // ── Global mission completion banner ───────────────────────────────
  // Shows "Alliance X completed their mission!" to ALL players when any
  // alliance's NFT is minted. Detects by comparing last_completed_mission_at
  // in GameState across polls.
  const [missionBanner, setMissionBanner] = useState<string | null>(null);
  const lastSeenCompletionRef = useRef<bigint>(0n);
  useEffect(() => {
    if (!state) return;
    const at = state.last_completed_mission_at?.[0] ?? 0n;
    const name = state.last_completed_mission_name?.[0] ?? null;
    if (at > 0n && at > lastSeenCompletionRef.current && name) {
      lastSeenCompletionRef.current = at;
      setMissionBanner(name);
      window.setTimeout(() => setMissionBanner(null), 8000);
    }
  }, [state?.last_completed_mission_at?.[0]]);

  // Fanfare + confetti on first crossing of 95%.
  const [confetti, setConfetti] = useState(false);
  useEffect(() => {
    if (!missionProgress) return;
    if (missionDoneRef.current) return;
    if (missionProgress.percent >= 0.95) {
      missionDoneRef.current = true;
      playMissionComplete();
      setConfetti(true);
      window.setTimeout(() => setConfetti(false), 2000);
    }
  }, [missionProgress]);

  // Alliance-created chord: fires when we go from no alliance to having one.
  const prevAllianceIdRef = useRef<bigint | null>(null);
  useEffect(() => {
    const prev = prevAllianceIdRef.current;
    const cur = myAlliance ? myAlliance.id : null;
    if (prev == null && cur != null) playAllianceCreated();
    prevAllianceIdRef.current = cur;
  }, [myAlliance]);

  // ── Bootstrap ─────────────────────────────────────────────────────
  // Local dev: auto-load (or generate) an Ed25519 identity from localStorage
  // — II doesn't run locally so we never need a sign-in flow.
  // Mainnet: read existing II session if present, otherwise start anonymous
  // (read-only) and let the user click "sign in".
  useEffect(() => {
    (async () => {
      try {
        if (useII) {
          // Mainnet or local-with-II-canister: respect an existing II
          // session, otherwise start anonymous (view-only). Never auto-
          // open the II popup on page load — that would be intrusive and
          // blocks the view-only experience.
          const client = await getAuthClient();
          const isAuthed = await client.isAuthenticated();
          const identity = isAuthed ? client.getIdentity() : undefined;
          setAuthed(isAuthed);
          setPrincipal(identity ? identity.getPrincipal().toString() : null);
          const a = await makeActor(identity);
          setActor(a);
          await refreshAll(a);
          a.am_i_controller().then(setIsController).catch(() => {});
          a.get_icp_price().then((p: { usd_per_icp_micro: bigint }) => {
            if (p.usd_per_icp_micro > 0n) setUsdPerIcp(Number(p.usd_per_icp_micro) / 1_000_000);
          }).catch(() => {});
          setStatus(isAuthed ? "ready" : "ready (read-only — sign in to play)");
        } else {
          // Local dev: auto-hydrate (or generate on first run) a persistent
          // Ed25519 dev identity, so hitting refresh drops you into a
          // signed-in state immediately. View-only / sign-in flow is only
          // exercised on mainnet where real II is required.
          const identity = loadOrCreateIdentity();
          setAuthed(true);
          setPrincipal(identity.getPrincipal().toString());
          const a = await makeActor(identity);
          setActor(a);
          await refreshAll(a);
          a.am_i_controller().then(setIsController).catch(() => {});
          setStatus("ready (local dev identity)");
        }
      } catch (e) {
        console.error(e);
        setStatus("error: " + String(e));
      }
    })();
  }, []);

  async function handleLogin() {
    try {
      setStatus("signing in...");
      const identity = await loginWithII();
      const a = await makeActor(identity);
      setActor(a);
      setAuthed(true);
      setPrincipal(identity.getPrincipal().toString());
      setMyAlliance(null);
      setPendingRect(null);
      setCreatingAlliance(false);
      await refreshAll(a);
      setStatus("ready");
      // Close the sign-in modal if it was open, and replay the deferred
      // action (e.g. the pixel click that triggered the prompt).
      setSignInPromptOpen(false);
      const pending = pendingActionRef.current;
      pendingActionRef.current = null;
      if (pending) {
        try {
          await pending();
        } catch (err) {
          console.warn("pending post-sign-in action failed", err);
        }
      }
    } catch (e) {
      console.error(e);
      setStatus("login failed: " + String(e));
    }
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
    setPrincipal(null);
    setMyAlliance(null);
    setPendingRect(null);
    setCreatingAlliance(false);
    const a = await makeActor(undefined);
    setActor(a);
    await refreshAll(a);
    setStatus("signed out");
  }

  /// Local-only: rotate the dev Ed25519 identity. No-op on mainnet.
  async function resetIdentity() {
    clearIdentity();
    const identity = loadOrCreateIdentity();
    setPrincipal(identity.getPrincipal().toString());
    const a = await makeActor(identity);
    setActor(a);
    setMyAlliance(null);
    setPendingRect(null);
    setCreatingAlliance(false);
    await refreshAll(a);
    setStatus("new local id");
  }

  // ── Two-stage adaptive polling ────────────────────────────────────
  //
  // Stage 1: poll get_version() — 16 bytes, ~minimum cost. Fires often.
  // Stage 2: only when version changed, fetch get_changes_since() with the
  //          actual deltas. Almost never fires when nothing's happening.
  //
  // Adaptive interval: starts at FAST (200ms). After 5 polls with no change
  // → MED (1s). After 30 more no-change polls → SLOW (3s). When tab is
  // hidden → IDLE (10s). Any change snaps back to FAST.
  const lastVersionRef = useRef<bigint>(0n);
  const lastMapSizeRef = useRef<number>(0);
  useEffect(() => {
    if (!actor) return;
    // Pause polling entirely while we're scrubbing through replay history.
    if (replayMode) return;
    // Capture into a non-null local so the inner async tick() doesn't lose
    // narrowing across awaits.
    const a: BackendActor = actor;
    lastVersionRef.current = 0n;
    lastMapSizeRef.current = 0;

    const FAST = 200;
    const MED = 1000;
    const SLOW = 3000;
    const IDLE = 10000;

    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let noChangeStreak = 0;

    function pickInterval(): number {
      if (document.visibilityState === "hidden") return IDLE;
      if (noChangeStreak < 5) return FAST;
      if (noChangeStreak < 35) return MED;
      return SLOW;
    }

    async function tick() {
      if (stopped) return;
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const v = await a.get_version();
        if (stopped) return;

        const sizeChanged = v.map_size !== lastMapSizeRef.current;
        const versionChanged = v.version !== lastVersionRef.current;

        if (!versionChanged && !sizeChanged) {
          noChangeStreak++;
        } else {
          noChangeStreak = 0;

          if (sizeChanged) {
            // Map grew — coordinates shifted, full reload via tiled fetch.
            // Re-fetch version after the reload so we don't miss pixels
            // placed between get_version() and the tile fetches.
            const gs = await a.get_game_state();
            const m = await fetchFullMap(a, gs.map_size);
            const vAfter = await a.get_version();
            if (stopped) return;
            setMap(m);
            setState(gs);
            lastVersionRef.current = vAfter.version;
            lastMapSizeRef.current = vAfter.map_size;
          } else {
            // Just deltas. The backend caps each response at 40k changes,
            // so for a typical 200ms–10s poll interval a single call is
            // more than enough. If a client has been offline for a long
            // time and ends up >40k behind, we simply do a full reload —
            // cheaper than looping a paginated fetch for an edge case.
            const resp = await a.get_changes_since(lastVersionRef.current, []);
            if (stopped) return;
            // Stale: we've fallen outside the change-log trim window. The
            // server has dropped entries we never saw — full reload.
            if (
              lastVersionRef.current > 0n &&
              resp.min_version > lastVersionRef.current
            ) {
              const gs = await a.get_game_state();
              const m = await fetchFullMap(a, gs.map_size);
              const vAfter = await a.get_version();
              if (stopped) return;
              setMap(m);
              setState(gs);
              lastVersionRef.current = vAfter.version;
              lastMapSizeRef.current = vAfter.map_size;
              return;
            }
            // Paginated: if the reply hit the 40k cap and more data is
            // waiting, fall back to a full reload rather than loop-fetching
            // in the poll hot-path. This only triggers when a client has
            // been asleep a long time — live polling never accumulates
            // that many changes between ticks.
            if (resp.next_version < resp.current_version) {
              const gs = await a.get_game_state();
              const m = await fetchFullMap(a, gs.map_size);
              const vAfter = await a.get_version();
              if (stopped) return;
              setMap(m);
              setState(gs);
              lastVersionRef.current = vAfter.version;
              lastMapSizeRef.current = vAfter.map_size;
              return;
            }
            if (resp.changes.length > 0) {
              setMap((m) => {
                if (!m) return m;
                const next = m.slice();
                for (const ch of resp.changes) {
                  const idx = cellToIdx(ch.x, ch.y, resp.map_size);
                  if (idx >= 0 && idx < next.length) next[idx] = ch.color;
                }
                return next;
              });
              // Stats — fire and forget, don't block next poll.
              a.get_game_state().then((gs: GameState) => {
                if (!stopped) setState(gs);
              });
            }
            // Use resp.next_version so we don't replay changes that
            // landed between get_version() and get_changes_since(), and
            // so we resume from the paginated cursor.
            lastVersionRef.current = resp.next_version;
            lastMapSizeRef.current = resp.map_size;
          }
        }
      } catch (e) {
        console.warn("poll failed", e);
      } finally {
        inFlight = false;
        schedule();
      }
    }

    function schedule() {
      if (stopped) return;
      timer = setTimeout(tick, pickInterval());
    }

    function onVisibility() {
      // Snap to fast when tab becomes visible.
      if (document.visibilityState === "visible") {
        noChangeStreak = 0;
        if (timer) {
          clearTimeout(timer);
          tick();
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [actor, replayMode]);

  // ── Poll alliances less frequently (every 5s) ─────────────────────
  useEffect(() => {
    if (!actor) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const [mine, list] = await Promise.all([
          actor.get_my_alliance(),
          actor.list_alliances(),
        ]);
        if (stopped) return;
        setMyAlliance(mine[0] ?? null);
        setAlliances(list);
      } catch (e) {
        console.warn("alliance poll failed", e);
      }
    };
    const id = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [actor]);

  // ── Track shift key + palette hotkeys ─────────────────────────────
  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.key === "Shift") setShiftDown(true);

      // Game-only hotkeys: don't fire on dashboard/alliances/profile.
      if (screenRef.current !== "game") return;

      // Don't intercept digits when typing in inputs.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }

      // Arrow keys / WASD → pan the map.
      const PAN_STEP = 40;
      if (e.key === "ArrowLeft" || e.key === "a") {
        e.preventDefault();
        setPan((p) => ({ ...p, x: p.x + PAN_STEP }));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "d") {
        e.preventDefault();
        setPan((p) => ({ ...p, x: p.x - PAN_STEP }));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "w") {
        e.preventDefault();
        setPan((p) => ({ ...p, y: p.y + PAN_STEP }));
        return;
      }
      if (e.key === "ArrowDown" || e.key === "s") {
        e.preventDefault();
        setPan((p) => ({ ...p, y: p.y - PAN_STEP }));
        return;
      }

      if (e.key >= "1" && e.key <= "9") {
        if (e.ctrlKey || e.metaKey) {
          // Begin rebind: next swatch click will bind this digit.
          e.preventDefault();
          pendingRebindRef.current = { digit: e.key, until: Date.now() + 5000 };
          setRebindDigit(e.key);
          setStatus(`press a color to bind to ${e.key}`);
        } else {
          // Activate the slot bound to this digit (or default = digit-1).
          const slot = bindings[e.key] ?? Number(e.key) - 1;
          if (slot >= 0 && slot < palette.length) setSelectedSlot(slot);
        }
      } else if (e.key === "Escape") {
        if (pendingRebindRef.current) {
          pendingRebindRef.current = null;
          setRebindDigit(null);
          setStatus("rebind cancelled");
        }
      }
    }
    function up(e: KeyboardEvent) {
      if (e.key === "Shift") setShiftDown(false);
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [bindings, palette.length]);

  // ── Replay map: rebuild from change-log up to replayIndex ────────
  // Also tracks the *historical* map size at that moment by replaying
  // the backend's grow rule (unique-pixels-set >= stage² → next stage),
  // so cells outside the active box can be rendered transparent instead
  // of as a white/grey halo of the final 2048×2048 canvas.
  const REPLAY_STAGES = [1, 5, 10, 50, 100, 500];
  const replayMap = useMemo(() => {
    if (!replayMode || !state) return null;
    const DEFAULT_COLOR = 0x2a2a33; // matches backend map.rs
    const maxStage = REPLAY_STAGES[REPLAY_STAGES.length - 1];
    const maxHn = halfNeg(maxStage);

    // Pass 1: determine activeSize by replaying growth logic.
    const seen = new Set<number>();
    let stageIdx = 0;
    let activeSize = REPLAY_STAGES[0];
    for (let i = 0; i < replayIndex && i < replayChanges.length; i++) {
      const ch = replayChanges[i];
      const key = (ch.y + maxHn) * maxStage + (ch.x + maxHn);
      if (!seen.has(key)) {
        seen.add(key);
        if (stageIdx < REPLAY_STAGES.length - 1 && seen.size > activeSize * activeSize) {
          stageIdx++;
          activeSize = REPLAY_STAGES[stageIdx];
        }
      }
    }
    // Clamp: never exceed current map_size (e.g. if game started at 50×50).
    activeSize = Math.min(activeSize, state.map_size);
    // At frame 0 (empty): use the smallest stage that's >= 1.
    if (replayIndex === 0) activeSize = Math.min(REPLAY_STAGES[0], state.map_size);

    // Pass 2: build array at activeSize, fill with default color.
    const arr = new Array<number>(activeSize * activeSize).fill(DEFAULT_COLOR);
    for (let i = 0; i < replayIndex && i < replayChanges.length; i++) {
      const ch = replayChanges[i];
      const idx = cellToIdx(ch.x, ch.y, activeSize);
      if (idx >= 0 && idx < arr.length) arr[idx] = ch.color;
    }
    return { arr, activeSize };
  }, [replayMode, replayChanges, replayIndex, state]);

  const displayMap = replayMode ? (replayMap?.arr ?? null) : map;
  const replayActiveSize = replayMode ? (replayMap?.activeSize ?? 0) : 0;

  // Eyedropper: while Tab is held, sample the color under the cursor and
  // switch the active palette slot to the closest matching color. Exact
  // match → snap to that slot. No exact match → snap to the nearest by
  // squared RGB distance.
  useEffect(() => {
    if (!eyedropperActive || !hover || !displayMap || !state) return;
    const idx = cellToIdx(hover.x, hover.y, state.map_size);
    if (idx < 0 || idx >= displayMap.length) return;
    const c = displayMap[idx];
    // Skip default (unpainted) color — only pick colors players actually placed.
    if (c === 0x2a2a33) return;
    const exact = palette.indexOf(c);
    if (exact >= 0) {
      if (exact !== selectedSlot) setSelectedSlot(exact);
      return;
    }
    const cr = (c >> 16) & 0xff;
    const cg = (c >> 8) & 0xff;
    const cb = c & 0xff;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = ((p >> 16) & 0xff) - cr;
      const dg = ((p >> 8) & 0xff) - cg;
      const db = (p & 0xff) - cb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best !== selectedSlot) setSelectedSlot(best);
  }, [eyedropperActive, hover, displayMap, state, palette, selectedSlot]);

  // Enter replay: loop-fetch the full change-log in 40k chunks and snap
  // to the end. The backend caps each response at 40k entries to stay
  // inside the query response-size limit, so a season-spanning log of up
  // to 1M changes needs ~25 round-trips. Query calls don't cost the user
  // anything and each one completes in ~40-80ms locally, so the whole
  // fetch is typically under 2 seconds even at the cap.
  async function enterReplay() {
    if (!actor) return;
    try {
      setStatus("fetching history…");
      const all: { x: number; y: number; color: number }[] = [];
      let cursor = 0n;
      // Safety: even at 40k/page × 100 pages = 4M changes, this never
      // reasonably triggers. Just avoids an infinite loop if the backend
      // cursor logic ever regresses.
      for (let iter = 0; iter < 100; iter++) {
        const resp = await actor.get_changes_since(cursor, [40_000n]);
        for (const c of resp.changes) {
          all.push({ x: c.x, y: c.y, color: Number(c.color) });
        }
        // Caught up — either the cursor advanced to current_version, or
        // the server returned an empty page.
        if (resp.next_version >= resp.current_version || resp.changes.length === 0) {
          break;
        }
        cursor = resp.next_version;
      }
      setReplayChanges(all);
      setReplayIndex(all.length);
      setReplayPlaying(false);
      setReplayMode(true);
      setStatus(`replay: ${all.length.toLocaleString()} frames`);
    } catch (e) {
      console.warn("enterReplay failed", e);
      setStatus("replay failed: " + String(e));
    }
  }
  function exitReplay() {
    setReplayPlaying(false);
    setReplayMode(false);
    setReplayChanges([]);
    setReplayIndex(0);
  }
  // Auto-play tick: advance replayIndex while playing.
  // Base rate: ~300 frames to cover the whole timeline at 1x speed (~5s).
  // Speed multiplier scales the step size, not the interval, so the
  // frame rate stays smooth.
  useEffect(() => {
    if (!replayMode || !replayPlaying) return;
    if (replayIndex >= replayChanges.length) {
      setReplayPlaying(false);
      return;
    }
    const baseStep = Math.max(1, Math.floor(replayChanges.length / 300));
    // At low speeds: keep step=1 and increase interval (slower ticks).
    // At high speeds: keep interval=16ms and increase step (bigger jumps).
    let step: number;
    let interval: number;
    if (replaySpeed <= 0.5) {
      step = 1;
      interval = Math.round(16 / replaySpeed); // 0.25x→64ms, 0.5x→32ms
    } else {
      step = Math.max(1, Math.round(baseStep * replaySpeed));
      interval = 16;
    }
    const t = window.setTimeout(() => {
      setReplayIndex((i) => Math.min(replayChanges.length, i + step));
    }, interval);
    return () => window.clearTimeout(t);
  }, [replayMode, replayPlaying, replayIndex, replayChanges.length, replaySpeed]);

  // ── Render canvas ─────────────────────────────────────────────────
  // Performance: reuse a single ImageData buffer (avoids per-render GC),
  // only resize the canvas when `map_size` actually changes (setting w/h
  // clears the buffer, which is expensive on large maps), and coalesce
  // back-to-back updates into one frame via rAF.
  const imageDataRef = useRef<ImageData | null>(null);
  const imageDataSizeRef = useRef<number>(0);
  const renderRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!displayMap || !state) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = state.map_size;
    // Cancel any pending frame so we always paint the latest snapshot.
    if (renderRafRef.current != null) {
      cancelAnimationFrame(renderRafRef.current);
    }
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      const ctx = canvas.getContext("2d")!;
      // In replay mode the array is activeSize × activeSize (not map_size).
      const renderDim = replayActiveSize > 0 ? replayActiveSize : size;
      // Resize only when needed — assigning w/h clears the canvas.
      if (canvas.width !== renderDim || canvas.height !== renderDim) {
        canvas.width = renderDim;
        canvas.height = renderDim;
      }
      // Reuse the ImageData buffer across renders.
      let img = imageDataRef.current;
      if (!img || imageDataSizeRef.current !== renderDim) {
        img = ctx.createImageData(renderDim, renderDim);
        imageDataRef.current = img;
        imageDataSizeRef.current = renderDim;
      }
      const data = img.data;
      for (let i = 0; i < displayMap.length; i++) {
        const c = displayMap[i];
        const o = i * 4;
        data[o] = (c >> 16) & 0xff;
        data[o + 1] = (c >> 8) & 0xff;
        data[o + 2] = c & 0xff;
        data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    return () => {
      if (renderRafRef.current != null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
    };
  }, [displayMap, state, replayActiveSize]);

  // ── Resize handling ───────────────────────────────────────────────
  const [baseSize, setBaseSize] = useState(800);
  useEffect(() => {
    function recalc() {
      if (!wrapperRef.current) return;
      const r = wrapperRef.current.getBoundingClientRect();
      setBaseSize(Math.min(r.width, r.height));
    }
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, []);

  // ── Wheel zoom (cursor-centered) ──────────────────────────────────
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (growingRef.current) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setZoom((z) => {
      const nz = Math.min(200, Math.max(0.5, z * factor));
      const ratio = nz / z;
      setPan((p) => {
        const ccx = rect.width / 2 + p.x;
        const ccy = rect.height / 2 + p.y;
        const dx = cx - ccx;
        const dy = cy - ccy;
        return clampPan(
          {
            x: cx - dx * ratio - rect.width / 2,
            y: cy - dy * ratio - rect.height / 2,
          },
          baseSize * nz
        );
      });
      return nz;
    });
  }, []);
  useEffect(() => {
    const w = wrapperRef.current;
    if (!w) return;
    w.addEventListener("wheel", handleWheel, { passive: false });
    return () => w.removeEventListener("wheel", handleWheel);
    // Re-run when actor/state/map arrive so the listener attaches after
    // the splash screen unmounts and wrapperRef becomes non-null.
  }, [handleWheel, actor, state, map]);

  // ── Mouse interaction ─────────────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  // True once a left-button drag has moved past the click threshold (~5px),
  // so handleClick knows to suppress the pixel placement.
  const dragMovedRef = useRef(false);
  // Velocity tracking for inertial pan after release.
  const velRef = useRef<{ vx: number; vy: number; lastX: number; lastY: number; lastT: number } | null>(null);
  const inertiaRafRef = useRef<number | null>(null);

  /// Returns the pixel coordinates the cursor is over, clamped into [0, size).
  /// Used during shift-drag so the rectangle keeps growing even when the cursor
  /// leaves the canvas bounds.
  function clampedPixelFromEvent(e: React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !state) return null;
    const rect = canvas.getBoundingClientRect();
    const size = state.map_size;
    const cellPx = rect.width / size;
    const rawX = Math.floor((e.clientX - rect.left) / cellPx);
    const rawY = Math.floor((e.clientY - rect.top) / cellPx);
    // Convert from canvas-array coords (0..size) to centered coords.
    const hn = halfNeg(size);
    const hp = halfPos(size);
    const cx = rawX - hn;
    const cy = rawY - hn;
    return {
      x: Math.max(-hn, Math.min(hp - 1, cx)),
      y: Math.max(-hn, Math.min(hp - 1, cy)),
    };
  }

  /// Strict version: returns null if the cursor is outside the map.
  function pixelFromEvent(e: React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !state) return null;
    const rect = canvas.getBoundingClientRect();
    const size = state.map_size;
    const cellPx = rect.width / size;
    const rawX = Math.floor((e.clientX - rect.left) / cellPx);
    const rawY = Math.floor((e.clientY - rect.top) / cellPx);
    const hn = halfNeg(size);
    const x = rawX - hn;
    const y = rawY - hn;
    if (!inBounds(x, y, size)) return null;
    return { x, y };
  }

  useEffect(() => () => {
    if (inertiaRafRef.current != null) cancelAnimationFrame(inertiaRafRef.current);
  }, []);

  // Cancel an in-flight inertia animation (called on a fresh drag/zoom).
  function stopInertia() {
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  }

  function startInertia() {
    const v = velRef.current;
    if (!v) return;
    let vx = v.vx;
    let vy = v.vy;
    if (Math.hypot(vx, vy) < 0.05) return; // not enough flick
    const friction = 0.92;
    const tick = () => {
      vx *= friction;
      vy *= friction;
      if (Math.hypot(vx, vy) < 0.05) {
        inertiaRafRef.current = null;
        return;
      }
      setPan((p) => clampPan({ x: p.x + vx * 16, y: p.y + vy * 16 }, renderSize));
      inertiaRafRef.current = requestAnimationFrame(tick);
    };
    inertiaRafRef.current = requestAnimationFrame(tick);
  }

  function onMouseDown(e: React.MouseEvent) {
    if (growing) return;
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      stopInertia();
      dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      velRef.current = {
        vx: 0,
        vy: 0,
        lastX: e.clientX,
        lastY: e.clientY,
        lastT: performance.now(),
      };
      return;
    }
    // Left button without shift: start a *potential* drag-pan. We don't lock
    // into pan mode immediately — handleClick checks dragMovedRef to decide
    // whether to place a pixel or treat the gesture as a drag.
    if (e.button === 0 && !e.shiftKey) {
      stopInertia();
      dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      dragMovedRef.current = false;
      velRef.current = {
        vx: 0,
        vy: 0,
        lastX: e.clientX,
        lastY: e.clientY,
        lastT: performance.now(),
      };
    }
    if (e.button === 0 && e.shiftKey && creatingAlliance) {
      e.preventDefault();
      const p = clampedPixelFromEvent(e);
      if (p) {
        rectDrawRef.current = { startX: p.x, startY: p.y };
        setPendingRect({ x: p.x, y: p.y, width: 1, height: 1 });
      }
    }
  }
  function onMouseMove(e: React.MouseEvent) {
    if (rectDrawRef.current) {
      const p = clampedPixelFromEvent(e);
      if (p) {
        const sx = rectDrawRef.current.startX;
        const sy = rectDrawRef.current.startY;
        const x = Math.min(sx, p.x);
        const y = Math.min(sy, p.y);
        const width = Math.abs(p.x - sx) + 1;
        const height = Math.abs(p.y - sy) + 1;
        setPendingRect({ x, y, width, height });
      }
      return;
    }
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      if (Math.hypot(dx, dy) > 5) dragMovedRef.current = true;
      setPan(
        clampPan(
          {
            x: dragRef.current.px + dx,
            y: dragRef.current.py + dy,
          },
          renderSize
        )
      );
      // Update velocity (px per ms) for inertia after release.
      const v = velRef.current;
      if (v) {
        const now = performance.now();
        const dt = Math.max(1, now - v.lastT);
        v.vx = (e.clientX - v.lastX) / dt;
        v.vy = (e.clientY - v.lastY) / dt;
        v.lastX = e.clientX;
        v.lastY = e.clientY;
        v.lastT = now;
      }
      return;
    }
    const p = pixelFromEvent(e);
    if (!p) setHover(null);
    else setHover((h) => (h && h.x === p.x && h.y === p.y ? h : p));
  }
  function onMouseUp() {
    if (dragRef.current) {
      dragRef.current = null;
      startInertia();
    }
    rectDrawRef.current = null;
  }

  // ── Refresh helpers ───────────────────────────────────────────────

  /// Pulls the entire map for a given size by fetching every 256×256 tile
  /// in parallel and stitching them into a single row-major Uint32 array.
  /// Edge tiles return shorter rows (`min(CHUNK_SIZE, size - origin)`),
  /// which we lay out at the correct stride.
  const CHUNK_SIZE = 256;
  async function fetchFullMap(a: BackendActor, size: number): Promise<number[]> {
    const tilesPerSide = Math.ceil(size / CHUNK_SIZE);
    const out = new Array<number>(size * size).fill(0x2a2a33);
    const jobs: Promise<void>[] = [];
    for (let ty = 0; ty < tilesPerSide; ty++) {
      for (let tx = 0; tx < tilesPerSide; tx++) {
        jobs.push(
          (async () => {
            const ox = tx * CHUNK_SIZE;
            const oy = ty * CHUNK_SIZE;
            const w = Math.min(CHUNK_SIZE, size - ox);
            const h = Math.min(CHUNK_SIZE, size - oy);
            const tile = await a.get_map_chunk(tx, ty);
            for (let dy = 0; dy < h; dy++) {
              for (let dx = 0; dx < w; dx++) {
                const v = tile[dy * w + dx];
                out[(oy + dy) * size + (ox + dx)] = Number(v);
              }
            }
          })()
        );
      }
    }
    await Promise.all(jobs);
    return out;
  }

  /// Full refresh: pulls the entire map. Use only after pixel changes.
  async function refreshAll(a: BackendActor) {
    const [gs, mine, list] = await Promise.all([
      a.get_game_state(),
      a.get_my_alliance(),
      a.list_alliances(),
    ]);
    const m = await fetchFullMap(a, gs.map_size);
    setMap(m);
    setState(gs);
    setMyAlliance(mine[0] ?? null);
    setAlliances(list);
  }

  /// Lightweight refresh: skips get_map(). Use after alliance ops.
  async function refreshMeta(a: BackendActor) {
    const [gs, mine, list] = await Promise.all([
      a.get_game_state(),
      a.get_my_alliance(),
      a.list_alliances(),
    ]);
    setState(gs);
    setMyAlliance(mine[0] ?? null);
    setAlliances(list);
  }

  async function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!actor || !state || !map) return;
    if (e.shiftKey) return;
    if (growing) return;
    // If the user dragged the map (left-button pan), suppress the click.
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    // Eyedropper click: pick color under cursor and exit eyedropper mode.
    if (eyedropperMode) {
      const p = pixelFromEvent(e);
      if (p) {
        const idx = cellToIdx(p.x, p.y, state.map_size);
        if (idx >= 0 && idx < map.length) {
          const c = map[idx];
          const exact = palette.indexOf(c);
          if (exact >= 0) {
            setSelectedSlot(exact);
          } else {
            let best = 0, bestD = Infinity;
            for (let i = 0; i < palette.length; i++) {
              const pi = palette[i];
              const dr = ((pi >> 16) & 0xff) - ((c >> 16) & 0xff);
              const dg = ((pi >> 8) & 0xff) - ((c >> 8) & 0xff);
              const db = (pi & 0xff) - (c & 0xff);
              const d = dr * dr + dg * dg + db * db;
              if (d < bestD) { bestD = d; best = i; }
            }
            setSelectedSlot(best);
          }
        }
      }
      setEyedropperMode(false);
      return;
    }
    // View-only gate: anonymous users get the sign-in modal. Auto-replay
    // is skipped for pixel clicks — the action is a single click, trivial
    // to repeat after sign-in. For heavier flows (create alliance, buy
    // pixels) requireSignIn *does* stash a pending action.
    if (!authed) {
      requireSignIn("Sign in to place pixels", () => {});
      return;
    }
    // First user gesture in the page may be this click — make sure the audio
    // context is allowed to make sound.
    unlockAudio();
    // Client-side cooldown gate. Mirrors the backend cooldown so the click
    // is rejected BEFORE the optimistic paint — otherwise the user sees a
    // pixel appear and then disappear when the backend rejects.
    if (Date.now() < cooldownUntilRef.current) {
      playError();
      shake();
      const sec = Math.ceil((cooldownUntilRef.current - Date.now()) / 1000);
      setStatus(`cooldown: ${sec}s`);
      return;
    }
    const p = pixelFromEvent(e);
    if (!p) return;
    const color = palette[selectedSlot];

    // Optimistic update: paint locally immediately so the click feels instant.
    const idx = cellToIdx(p.x, p.y, state.map_size);
    const prev = map[idx];

    // Same-color warning: don't waste a pixel overwriting with the same color.
    if (prev === color && !skipSameColorWarn) {
      setSameColorConfirm({ x: p.x, y: p.y, color });
      return;
    }

    // Spawn click ripple at cursor position
    spawnClickRipple(e.clientX, e.clientY, color);
    doPlacePixel(p.x, p.y, color);
  }

  // Click ripple animation state
  const [clickRipples, setClickRipples] = useState<Array<{
    id: number; x: number; y: number; color: string;
  }>>([]);
  const rippleIdRef = useRef(0);

  function spawnClickRipple(clientX: number, clientY: number, color: number) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const id = ++rippleIdRef.current;
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    setClickRipples((prev) => [
      ...prev.slice(-5), // keep max 6 active
      { id, x: clientX - rect.left, y: clientY - rect.top, color: hex },
    ]);
    setTimeout(() => {
      setClickRipples((prev) => prev.filter((r) => r.id !== id));
    }, 500);
  }

  async function doPlacePixel(px: number, py: number, color: number) {
    if (!actor || !state || !map) return;
    const idx = cellToIdx(px, py, state.map_size);
    const prev = map[idx];
    const next = [...map];
    next[idx] = color;
    setMap(next);
    setStatus(`placing (${px},${py})...`);
    // Arm the cooldown EAGERLY, before the await — so any clicks fired during
    // the 1-2s round-trip to the backend hit the gate. We'll roll it back to
    // the previous value if the backend rejects.
    const prevCooldownUntil = cooldownUntilRef.current;
    setCooldownUntil(Date.now() + COOLDOWN_MS);
    // Play the click sound now (synchronously, while we still have a fresh
    // user gesture). If the backend rejects, we'll play an error sound below.
    playPlacePixel();

    try {
      const res = await actor.place_pixel(px, py, color);
      if ("Err" in res) {
        setMap((m) => {
          if (!m) return m;
          if (m[idx] !== color) return m;
          const r = [...m];
          r[idx] = prev;
          return r;
        });
        const err = res.Err as PlaceError;
        console.error("[place_pixel] backend rejected at", { px, py }, "→", err);
        if ("Cooldown" in err) {
          const remMs = Math.ceil(Number(err.Cooldown.remaining_ns) / 1_000_000);
          setCooldownUntil(Date.now() + remMs);
          setStatus(`Cooldown — wait ${Math.ceil(remMs / 1000)}s before your next pixel`);
        } else {
          // Other error — roll the eagerly-armed cooldown back so the user
          // can retry without waiting a full cycle.
          setCooldownUntil(prevCooldownUntil);
          // Human-readable label for the top-bar; full JSON in console.
          const label =
            "Unauthorized" in err ? "Sign in to place pixels" :
            "OutOfBounds" in err ? "That cell is outside the map" :
            "InvalidColor" in err ? "That color isn't allowed" :
            "SeasonEnded" in err ? "The season has ended — no more pixels" :
            "Paused" in err ? "Game is paused for maintenance" :
            "NoCredits" in err ? "Out of pixel credits — buy more to continue" :
            "InternalError" in err ? "Something went wrong: " + err.InternalError :
            JSON.stringify(err);
          setStatus(label);
        }
        playError();
      shake();
        return;
      }
      setStatus("ready");
      // Cooldown was already armed eagerly before the await — nothing to do.
      bumpStreak();
      bumpPersonalBest();
      playPlacePixel();

      // Mission feedback: if this pixel landed inside our alliance's mission
      // and matches the template, ding. If overall match crosses ≥95%, fanfare
      // (once per mission instance).
      if (myAlliance) {
        const m = myAlliance.mission;
        const inside =
          px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height;
        if (inside) {
          const ox = px - m.x;
          const oy = py - m.y;
          const expected = Number((m.template as Array<number | bigint>)[oy * m.width + ox]);
          if (expected === color) {
            playMissionDing();
            if (!missionDoneRef.current) {
              // Walk the mission area against the (now updated) local map to
              // see if we've crossed the threshold.
              let matched = 0;
              const total = m.width * m.height;
              for (let yy = 0; yy < m.height; yy++) {
                for (let xx = 0; xx < m.width; xx++) {
                  const localIdx = cellToIdx(m.x + xx, m.y + yy, state.map_size);
                  const want = Number(
                    (m.template as Array<number | bigint>)[yy * m.width + xx]
                  );
                  if (next[localIdx] === want) matched++;
                }
              }
              if (matched * 100 >= total * 95) {
                missionDoneRef.current = true;
                playMissionComplete();
              }
            }
          }
        }
      }

      // Refresh map + game state only (alliances don't change on pixel place).
      // Skipped if map didn't grow — current size matches.
      const gs = await actor.get_game_state();
      setState(gs);
      if (gs.map_size !== state.map_size) {
        // Map grew — pull the full map via tiled fetch (coordinates shifted
        // on the backend).
        playMapGrew();
        const newMap = await fetchFullMap(actor, gs.map_size);
        setMap(newMap);
      }
    } catch (err) {
      setMap((m) => {
        if (!m) return m;
        if (m[idx] !== color) return m;
        const r = [...m];
        r[idx] = prev;
        return r;
      });
      setStatus("error: " + String(err));
    }
  }

  const renderSize = baseSize * zoom;

  // ── Mini-map ──────────────────────────────────────────────────────
  // Throttled to ~10 FPS: downsampling a 1000×1000 map on every poll tick
  // is wasted work — at 180px the user can't perceive sub-100ms updates.
  const MINI_SIZE = 180;
  const miniRef = useRef<HTMLCanvasElement>(null);
  const miniImageDataRef = useRef<ImageData | null>(null);
  const miniLastRenderRef = useRef<number>(0);
  const miniPendingRef = useRef<number | null>(null);
  useEffect(() => {
    const c = miniRef.current;
    if (!c || !map || !state) return;
    const size = state.map_size;

    const draw = () => {
      miniLastRenderRef.current = performance.now();
      miniPendingRef.current = null;
      if (c.width !== MINI_SIZE || c.height !== MINI_SIZE) {
        c.width = MINI_SIZE;
        c.height = MINI_SIZE;
      }
      const ctx = c.getContext("2d")!;
      let img = miniImageDataRef.current;
      if (!img) {
        img = ctx.createImageData(MINI_SIZE, MINI_SIZE);
        miniImageDataRef.current = img;
      }
      const data = img.data;
      // Nearest-neighbor downsample.
      for (let yy = 0; yy < MINI_SIZE; yy++) {
        const sy = Math.min(size - 1, Math.floor((yy * size) / MINI_SIZE));
        const rowOff = sy * size;
        const outRow = yy * MINI_SIZE * 4;
        for (let xx = 0; xx < MINI_SIZE; xx++) {
          const sx = Math.min(size - 1, Math.floor((xx * size) / MINI_SIZE));
          const c2 = map[rowOff + sx];
          const o = outRow + xx * 4;
          data[o] = (c2 >> 16) & 0xff;
          data[o + 1] = (c2 >> 8) & 0xff;
          data[o + 2] = c2 & 0xff;
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const MIN_INTERVAL = 100; // 10 FPS cap
    const elapsed = performance.now() - miniLastRenderRef.current;
    if (elapsed >= MIN_INTERVAL) {
      draw();
    } else if (miniPendingRef.current == null) {
      miniPendingRef.current = window.setTimeout(draw, MIN_INTERVAL - elapsed);
    }
    return () => {
      if (miniPendingRef.current != null) {
        clearTimeout(miniPendingRef.current);
        miniPendingRef.current = null;
      }
    };
  }, [map, state]);

  // Viewport rect on the mini-map. Computes the actual fractional bounds of
  // the visible region in canvas (= map) coordinates, then clamps to [0,1]
  // and projects onto the mini-map. Correct for any zoom and any pan.
  const miniViewport = (() => {
    if (!state || !wrapperRef.current) return null;
    const wrap = wrapperRef.current.getBoundingClientRect();
    // Canvas top-left in viewport pixels:
    //   centerX = wrap.width/2 + pan.x   (and same for y)
    //   topLeftX = centerX - renderSize/2
    // The viewport's top-left in CANVAS-local pixels is therefore -topLeftX,
    // i.e. (renderSize - wrap.width)/2 - pan.x.
    const leftPx = renderSize / 2 - wrap.width / 2 - pan.x;
    const rightPx = leftPx + wrap.width;
    const topPx = renderSize / 2 - wrap.height / 2 - pan.y;
    const bottomPx = topPx + wrap.height;
    // Clamp to canvas bounds and convert to fractions.
    const lf = Math.max(0, Math.min(1, leftPx / renderSize));
    const rf = Math.max(0, Math.min(1, rightPx / renderSize));
    const tf = Math.max(0, Math.min(1, topPx / renderSize));
    const bf = Math.max(0, Math.min(1, bottomPx / renderSize));
    if (rf <= lf || bf <= tf) return null; // map is fully off-screen
    return {
      x: lf * MINI_SIZE,
      y: tf * MINI_SIZE,
      w: (rf - lf) * MINI_SIZE,
      h: (bf - tf) * MINI_SIZE,
    };
  })();

  // Click + drag on mini-map → teleport / continuously pan so that the
  // pointer position becomes the viewport center.
  function panToMiniPoint(clientX: number, clientY: number, el: HTMLElement) {
    if (!state) return;
    const rect = el.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const tx = fx * state.map_size;
    const ty = fy * state.map_size;
    const cell = renderSize / state.map_size;
    setPan(
      clampPan(
        {
          x: -(tx - state.map_size / 2) * cell,
          y: -(ty - state.map_size / 2) * cell,
        },
        renderSize
      )
    );
  }
  function handleMiniPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    panToMiniPoint(e.clientX, e.clientY, e.currentTarget);
  }
  function handleMiniPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons === 0) return; // not dragging
    panToMiniPoint(e.clientX, e.clientY, e.currentTarget);
  }


  // Center the viewport on the given rect at a sensible zoom. Coordinates
  // are in **centered** world space (x, y can be negative).
  function focusOnRect(x: number, y: number, w: number, h: number) {
    if (!state || !wrapperRef.current) return;
    const wrap = wrapperRef.current.getBoundingClientRect();
    const cellTarget = (Math.min(wrap.width, wrap.height) * 0.6) / Math.max(w, h);
    const baseCell = baseSize / state.map_size;
    const targetZoom = Math.max(1, Math.min(40, cellTarget / baseCell));
    // Convert world center to canvas-array center (origin at top-left).
    const hn = halfNeg(state.map_size);
    const cx = x + hn + w / 2;
    const cy = y + hn + h / 2;
    const rs = baseSize * targetZoom;
    const cell = rs / state.map_size;
    const newPan = clampPan(
      {
        x: -(cx - state.map_size / 2) * cell,
        y: -(cy - state.map_size / 2) * cell,
      },
      rs
    );
    setZoom(targetZoom);
    setPan(newPan);
  }

  function goToMission() {
    if (!myAlliance) return;
    const m = myAlliance.mission;
    focusOnRect(m.x, m.y, m.width, m.height);
  }

  // Build a shareable URL for the user's mission and copy it to clipboard.
  async function shareMyAlliance() {
    if (!myAlliance) return;
    const m = myAlliance.mission;
    const url = `${location.origin}${location.pathname}?mission=${m.x},${m.y},${m.width},${m.height}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("share link copied");
    } catch {
      setStatus(url);
    }
  }

  // On bootstrap: if URL has ?mission=x,y,w,h, fly to that rect once the map
  // and viewport are ready. Runs once after both are available.
  const sharedMissionRef = useRef(false);
  useEffect(() => {
    if (sharedMissionRef.current) return;
    if (!state || baseSize === 0) return;
    const params = new URLSearchParams(location.search);
    const mission = params.get("mission");
    if (!mission) {
      sharedMissionRef.current = true;
      return;
    }
    const parts = mission.split(",").map((s) => parseInt(s, 10));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      focusOnRect(parts[0], parts[1], parts[2], parts[3]);
    }
    sharedMissionRef.current = true;
  }, [state, baseSize]);

  // Click swatch: either bind a pending hotkey, or just select.
  function handleSwatchClick(i: number) {
    const pending = pendingRebindRef.current;
    if (pending && Date.now() < pending.until) {
      setBindings((b) => ({ ...b, [pending.digit]: i }));
      pendingRebindRef.current = null;
      setRebindDigit(null);
      setStatus(`bound ${pending.digit} → slot ${i + 1}`);
    }
    setSelectedSlot(i);
  }

  // Copy principal to clipboard. Shift+click toggles full/short display.
  function handlePrincipalClick(e: React.MouseEvent) {
    if (e.shiftKey) {
      setShowFullPrincipal((v) => !v);
      return;
    }
    if (!principal) return;
    navigator.clipboard?.writeText(principal).then(
      () => setStatus("principal copied"),
      () => setStatus("copy failed")
    );
  }

  const overlayBorderWidth = Math.max(2, Math.min(4, Math.round(zoom)));

  // ── Personal best ────────────────────────────────────────────────
  // Tracks pixels-per-calendar-day in localStorage. Two keys: today's count
  // and the all-time best. Cheap, no backend.
  // Value slots kept as destructured-empty so React still rerenders when
  // bumped; the setters are what we use externally.
  const [, setPbToday] = useState<number>(() => {
    try {
      const d = localStorage.getItem("icpixel_pb_date");
      if (d === todayKey()) {
        return Number(localStorage.getItem("icpixel_pb_today") || "0") || 0;
      }
      return 0;
    } catch {
      return 0;
    }
  });
  const [, setPbAllTime] = useState<number>(() => {
    try {
      return Number(localStorage.getItem("icpixel_pb_all") || "0") || 0;
    } catch {
      return 0;
    }
  });

  function bumpPersonalBest() {
    try {
      const today = todayKey();
      const lastDate = localStorage.getItem("icpixel_pb_date");
      const cur = lastDate === today
        ? Number(localStorage.getItem("icpixel_pb_today") || "0") || 0
        : 0;
      const nextToday = cur + 1;
      localStorage.setItem("icpixel_pb_date", today);
      localStorage.setItem("icpixel_pb_today", String(nextToday));
      setPbToday(nextToday);
      const all = Number(localStorage.getItem("icpixel_pb_all") || "0") || 0;
      if (nextToday > all) {
        localStorage.setItem("icpixel_pb_all", String(nextToday));
        setPbAllTime(nextToday);
      }
    } catch {}
  }

  // ── Map-grow cinematic ───────────────────────────────────────────
  // When the map size increases, briefly zoom out to fit the whole new map,
  // hold for ~1.5s, then restore the previous pan/zoom. Animated via CSS
  // transition on the canvas (see `growing` below).
  const prevMapSizeRef = useRef<number | null>(null);
  const [growing, setGrowing] = useState(false);
  const growingRef = useRef(false);
  useEffect(() => {
    growingRef.current = growing;
  }, [growing]);
  useEffect(() => {
    if (!state) return;
    const prev = prevMapSizeRef.current;
    prevMapSizeRef.current = state.map_size;
    if (prev == null || state.map_size <= prev) return;

    // With centered coordinates the WORLD content does not shift on a grow
    // — but `pan` is stored in screen pixels at the current zoom, and the
    // mapping between pan and the world cell under the viewport center
    // depends on `cellPx = renderSize/map_size`, which DOES change because
    // map_size changes. So we re-derive `pan` to keep the same world cell
    // pinned under the viewport center.
    //
    // World x at viewport center = -pan.x * size/renderSize - parityOffset(size)
    // where parityOffset = 0 for odd sizes and 0.5 for even sizes.
    // Inverting and equating before/after gives:
    //   pan_new = pan_old * (s1/s2) + (po(s1) - po(s2)) * renderSize/s2
    const s1 = prev;
    const s2 = state.map_size;
    const po = (s: number) => (s % 2 === 0 ? 0.5 : 0);
    const adjustedPan = {
      x: pan.x * (s1 / s2) + (po(s1) - po(s2)) * (renderSize / s2),
      y: pan.y * (s1 / s2) + (po(s1) - po(s2)) * (renderSize / s2),
    };
    const savedZoom = zoom;

    setGrowing(true);
    setZoom(0.5); // max zoom-out for the cinematic
    setPan({ x: 0, y: 0 });
    const t = window.setTimeout(() => {
      setZoom(savedZoom);
      setPan(adjustedPan);
      window.setTimeout(() => setGrowing(false), 600);
    }, 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.map_size]);

  // ── First-visit: open help modal automatically ──────────────────
  useEffect(() => {
    try {
      if (localStorage.getItem("icpixel_welcomed") !== "1") {
        localStorage.setItem("icpixel_welcomed", "1");
        setHelpOpen(true);
      }
    } catch {}
  }, []);

  // Bumps every time we want to play the cursor-shake animation. Used as
  // React key on the hover ring so the animation restarts cleanly.
  const [shakeKey, setShakeKey] = useState(0);
  function shake() {
    setShakeKey((k) => k + 1);
  }

  function bumpStreak() {
    try {
      const today = todayKey();
      const last = localStorage.getItem("icpixel_streak_date");
      const cur = Number(localStorage.getItem("icpixel_streak") || "0") || 0;
      let next: number;
      if (!last) next = 1;
      else {
        const d = daysBetween(last, today);
        if (d === 0) return; // already counted today
        if (d === 1) next = cur + 1;
        else next = 1; // missed a day
      }
      localStorage.setItem("icpixel_streak", String(next));
      localStorage.setItem("icpixel_streak_date", today);
      setStreak(next);
    } catch {}
  }

  // ── Daily streak ─────────────────────────────────────────────────
  // Local YYYY-MM-DD key, stored in localStorage. Bumped after a confirmed
  // pixel placement (see handleClick). Resets to 0 if more than a full
  // calendar day was missed.
  const [, setStreak] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem("icpixel_streak") || "0");
      const last = localStorage.getItem("icpixel_streak_date");
      if (last) {
        const d = daysBetween(last, todayKey());
        if (d >= 2) return 0;
      }
      return n || 0;
    } catch {
      return 0;
    }
  });

  // 60 confetti pieces with deterministic-ish randomness so re-renders during
  // the animation don't reshuffle them mid-flight.
  const confettiPieces = useMemo(() => {
    if (!confetti) return [];
    const colors = ["#ff4500", "#ffd635", "#3690ea", "#7eed56", "#ff3881", "#b44ac0", "#00cc78"];
    return Array.from({ length: 60 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.3,
      color: colors[i % colors.length],
      drift: (Math.random() - 0.5) * 80,
    }));
  }, [confetti]);

  // ── Splash screen while loading ─────────────────────────────────
  if (!actor || !state || !map) {
    return (
      <div style={{
        position: "fixed", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: "#0e0e14",
        gap: 24,
      }}>
        <img
          src="/img/logo.svg"
          alt="ICPixel"
          style={{
            width: 120,
            height: 120,
            animation: "splash-spin 2s ease-in-out infinite",
          }}
        />
        <div style={{
          fontSize: 24,
          fontWeight: 800,
          color: "#e8e8ec",
          letterSpacing: 1,
          fontFamily: "system-ui,sans-serif",
        }}>
          ICPixel
        </div>
        <div style={{
          fontSize: 13,
          color: "#60606a",
        }}>
          {status}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "#111",
        color: "#eee",
        fontFamily: "system-ui,sans-serif",
      }}
    >
      {growing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9998,
            background: "transparent",
            pointerEvents: "auto",
            cursor: "wait",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: 80,
          }}
        >
          <div
            style={{
              background: "rgba(22, 22, 26, 0.85)",
              color: "#e8e8ec",
              padding: "10px 18px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              border: "1px solid #2a2a32",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <img src="/img/logo.svg" alt="" style={{ width: 16, height: 16, animation: "spin 2s linear infinite" }} />
            the map is growing…
          </div>
        </div>
      )}
      {missionBanner && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, background: "rgba(22, 22, 26, 0.92)", border: "1px solid #f0c040",
          borderRadius: 12, padding: "12px 24px", color: "#e8e8ec",
          fontSize: 14, fontWeight: 600, textAlign: "center",
          boxShadow: "0 8px 32px rgba(240, 192, 64, 0.3)",
          animation: "fadeInDown 0.4s ease-out",
        }}>
          <span style={{ color: "#f0c040" }}>{missionBanner}</span> completed their mission!
        </div>
      )}
      {confetti && (
        <div className="confetti-layer">
          {confettiPieces.map((p, i) => (
            <div
              key={i}
              className="confetti-piece"
              style={{
                left: `calc(${p.left}% + ${p.drift}px)`,
                background: p.color,
                animationDelay: `${p.delay}s`,
                transform: `rotate(${i * 23}deg)`,
              }}
            />
          ))}
        </div>
      )}
      {/* Global pause banner — admin kill-switch. Shown above the top bar
          so it's unmissable. All gameplay endpoints (place_pixel, alliance
          mutations) return `Paused` while this is on. */}
      {state?.paused && (
        <div
          style={{
            padding: "10px 14px",
            background: "linear-gradient(90deg, #3a1500, #5a2200)",
            borderBottom: "1px solid #7a2f00",
            color: "#ffbe7a",
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
            letterSpacing: 0.3,
          }}
        >
          ⚠ game paused for maintenance — painting and alliance actions are
          temporarily disabled
        </div>
      )}

      {/* ── Unified nav bar ── */}
      <div className="nav-bar">
        <span className="nav-brand">
          <img src="/img/logo.svg" alt="" style={{ width: 18, height: 18, marginRight: 6, verticalAlign: -3 }} />
          ICPixel
        </span>
        {(["game", "dashboard", ...(isController ? ["admin" as const] : [])] as const).map((s) => (
          <button
            key={s}
            className={`nav-tab ${screen === s ? "active" : ""}`}
            onClick={() => setScreen(s)}
          >
            {s === "game" ? "Play" : s === "dashboard" ? "Dashboard" : "Admin"}
          </button>
        ))}

        {/* Map progress pill removed — info lives in Dashboard now */}

        {/* Pixel credits — centered */}
        {screen === "game" && !replayMode && (
          <button
            onClick={() => setShopOpen(true)}
            title="Buy pixel credits"
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px",
              background: "#1a1a20",
              border: "1px solid #2a2a32",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              color: "#e8e8ec",
              fontVariantNumeric: "tabular-nums",
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "background 0.12s ease, border-color 0.12s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#22222a";
              e.currentTarget.style.borderColor = "#3a3a44";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#1a1a20";
              e.currentTarget.style.borderColor = "#2a2a32";
            }}
          >
            <span>{String(pixelCredits)}</span>
            <span style={{ opacity: 0.55, fontWeight: 500, fontSize: 11, letterSpacing: 0.5 }}>PIXEL</span>
            <span style={{ marginLeft: 2, fontSize: 14, lineHeight: 1, opacity: 0.7 }}>+</span>
          </button>
        )}

        <span className="nav-spacer" />

        {/* Game action buttons — right side */}
        {screen === "game" && !replayMode && (
          <>
            <button
              className="btn"
              onClick={() => enterReplay()}
              data-tip="Replay the entire history of the map from the change log"
            >
              replay
            </button>
            <button
              className="btn"
              onClick={() => setPanelOpen((v) => !v)}
              data-tip="Toggle alliance panel"
              style={panelOpen ? { background: "#2a2a32" } : undefined}
            >
              alliances
            </button>
          </>
        )}

        {/* Settings dropdown — always visible, contains principal/sign out */}
        <div style={{ position: "relative" }}>
          <button
            className="btn"
            onClick={() => setSettingsOpen((v) => !v)}
            data-tip="Settings"
          >
            settings
          </button>
          {settingsOpen && (
            <>
              <div
                onClick={() => setSettingsOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 90 }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  zIndex: 100,
                  background: "#1a1a20",
                  border: "1px solid #2a2a32",
                  borderRadius: 8,
                  padding: 12,
                  minWidth: 240,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {/* Sound */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "#9090a0" }}>sound</span>
                  <button
                    className="btn"
                    onClick={() => {
                      unlockAudio();
                      const next = !muted;
                      setMuted(next);
                      setMutedState(next);
                    }}
                  >
                    {muted ? "off" : "on"}
                  </button>
                </div>
                {/* Identity + sign out */}
                {authed && principal ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#9090a0" }}>identity</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#e8e8ec",
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        wordBreak: "break-all",
                        cursor: "pointer",
                        userSelect: "all",
                      }}
                      title={principal + " · click to copy · shift+click to expand"}
                      onClick={handlePrincipalClick}
                    >
                      {showFullPrincipal
                        ? principal
                        : `${principal.slice(0, 12)}…${principal.slice(-6)}`}
                    </span>
                    {useII ? (
                      <button className="btn" onClick={handleLogout}>
                        sign out
                      </button>
                    ) : (
                      <button className="btn" onClick={resetIdentity}>
                        new id
                      </button>
                    )}
                  </div>
                ) : (
                  <button className="btn primary" onClick={handleLogin}>
                    sign in
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Dashboard screen ── */}
      {screen === "dashboard" && actor && (
        <Dashboard
          actor={actor}
          initialState={state}
          alliances={alliances}
          onPlay={() => setScreen("game")}
        />
      )}

      {screen === "admin" && actor && (
        <AdminPanel actor={actor} onClose={() => setScreen("game")} />
      )}

      {/* ── Game screen ── (canvas + palette + replay + alliances panel)
           Hidden via CSS instead of unmounting so refs (canvas, wrapper)
           stay alive, effects keep running, and returning from dashboard
           doesn't cause blank canvas / stale zoom / broken mission overlay. */}
      <div style={{ display: screen === "game" ? "contents" : "none" }}>
      {/* Map area */}
      <div
        ref={wrapperRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          dragRef.current = null;
          setHover(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "#222",
          cursor: dragRef.current ? "grabbing" : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: renderSize,
            height: renderSize,
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            imageRendering: "pixelated",
            background: "#2a2a33",
            cursor: eyedropperActive ? "copy" : onCooldown && blockedCursorUrl ? `url(${blockedCursorUrl}) 16 16, not-allowed` : onCooldown ? "not-allowed" : "url(/img/cursor.png) 16 16, crosshair",
            visibility: map && state ? "visible" : "hidden",
            transition: growing
              ? "transform 0.6s ease-out, width 0.6s ease-out, height 0.6s ease-out"
              : undefined,
          }}
        />

        {/* Click ripple animations */}
        {clickRipples.map((r) => (
          <div
            key={r.id}
            style={{
              position: "absolute",
              left: r.x,
              top: r.y,
              width: 0,
              height: 0,
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            <div style={{
              position: "absolute",
              left: -20,
              top: -20,
              width: 40,
              height: 40,
              borderRadius: "50%",
              border: `2px solid ${r.color}`,
              animation: "click-ripple 0.5s ease-out forwards",
            }} />
          </div>
        ))}

        {(!map || !state) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              pointerEvents: "none",
            }}
          >
            <div
              className="skeleton"
              style={{ width: "min(70%, 520px)", aspectRatio: "1 / 1" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <div className="skeleton" style={{ width: 90, height: 14 }} />
              <div className="skeleton" style={{ width: 60, height: 14 }} />
              <div className="skeleton" style={{ width: 110, height: 14 }} />
            </div>
            <div style={{ fontSize: 11, color: "#666", letterSpacing: 0.5 }}>
              {status}
            </div>
          </div>
        )}

        {/* Mission and pending rect overlays */}
        {state &&
          (() => {
            const cell = renderSize / state.map_size;
            const overlays: JSX.Element[] = [];
            const drawRect = (
              x: number,
              y: number,
              w: number,
              h: number,
              color: string,
              key: string,
              label?: string,
              className?: string
            ) => {
              overlays.push(
                <div
                  key={key}
                  className={className}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: w * cell,
                    height: h * cell,
                    transform: `translate(calc(-50% + ${
                      pan.x - renderSize / 2 + (x + halfNeg(state.map_size) + w / 2) * cell
                    }px), calc(-50% + ${
                      pan.y - renderSize / 2 + (y + halfNeg(state.map_size) + h / 2) * cell
                    }px))`,
                    border: `${overlayBorderWidth}px solid ${color}`,
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                >
                  {label && (
                    <div
                      style={{
                        position: "absolute",
                        top: -18,
                        left: 0,
                        fontSize: 11,
                        background: color,
                        color: "#000",
                        padding: "1px 4px",
                        borderRadius: 2,
                        whiteSpace: "nowrap",
                        fontWeight: "bold",
                      }}
                    >
                      {label}
                    </div>
                  )}
                </div>
              );
            };
            if (myAlliance && !replayMode) {
              const m = myAlliance.mission;
              drawRect(m.x, m.y, m.width, m.height, "#ffcc00", "mission", myAlliance.name, "mission-rect");
            }
            if (pendingRect && creatingAlliance) {
              // Dashed white border for pending selection — less aggressive
              // than the old solid neon green.
              overlays.push(
                <div
                  key="pending"
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: pendingRect.width * cell,
                    height: pendingRect.height * cell,
                    transform: `translate(calc(-50% + ${
                      pan.x - renderSize / 2 + (pendingRect.x + halfNeg(state.map_size) + pendingRect.width / 2) * cell
                    }px), calc(-50% + ${
                      pan.y - renderSize / 2 + (pendingRect.y + halfNeg(state.map_size) + pendingRect.height / 2) * cell
                    }px))`,
                    border: `2px dashed rgba(255,255,255,0.7)`,
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                />
              );
            }
            return overlays;
          })()}

        {hover && state && (
          <div
            key={`hover-${shakeKey}`}
            className={shakeKey > 0 ? "hover-shake" : undefined}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: renderSize / state.map_size,
              height: renderSize / state.map_size,
              transform: `translate(calc(-50% + ${
                pan.x - renderSize / 2 + (hover.x + halfNeg(state.map_size) + 0.5) * (renderSize / state.map_size)
              }px), calc(-50% + ${
                pan.y - renderSize / 2 + (hover.y + halfNeg(state.map_size) + 0.5) * (renderSize / state.map_size)
              }px))`,
              // Frame drawn INSIDE the cell via inset shadows, so the
              // hover indicator never exceeds one cell at any zoom level.
              // Inner colored ring + a thin dark ring for contrast.
              background: "transparent",
              boxShadow: `inset 0 0 0 2px ${intToHex(palette[selectedSlot])}, inset 0 0 0 3px rgba(0,0,0,0.7)`,
              pointerEvents: "none",
            }}
          />
        )}

        {/* Cooldown badge — pinned bottom-right of the map area.
            Shifts left when the alliance panel (340px + 12 margin) is open.
            Hidden during replay mode — you can't place pixels while
            scrubbing through history, so the badge is meaningless there
            and the replay scrubber bar at the bottom was visually
            colliding with it. */}
        {!replayMode && (
          <div
            data-tip="Time until you can place the next pixel"
            data-tip-pos="top"
            style={{
              position: "absolute",
              right: panelOpen ? 14 + 340 + 12 : 14,
              bottom: 14,
              transition: "right 0.18s ease",
              fontSize: 16,
              fontWeight: 800,
              padding: "8px 16px",
              borderRadius: 8,
              background: onCooldown ? "#b34" : "#2b8a3e",
              color: "#fff",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: 0.5,
              boxShadow: onCooldown
                ? "0 4px 14px rgba(0,0,0,0.4), 0 0 0 1px #ff6b7a55"
                : "0 4px 14px rgba(0,0,0,0.4), 0 0 0 1px #4ade8055",
              zIndex: 5,
            }}
          >
            <img
              src="/img/logo.svg"
              alt=""
              style={{
                width: 18,
                height: 18,
                marginRight: 6,
                verticalAlign: -3,
                transform: onCooldown ? "rotate(45deg)" : "rotate(0deg)",
                transition: "transform 0.3s ease",
              }}
            />
            {onCooldown
              ? `${Math.ceil(cooldownRemaining / 1000)}s`
              : "ready"}
          </div>
        )}

        {/* Buy-pixels popup — three preset bundles. Free mode credits
            immediately; paid mode will trigger ICRC-2 on the backend. */}
        {shopOpen && (
          <div
            onClick={() => {
              if (shopBusy) return;
              setShopOpen(false);
              setShopDepositPack(null);
                  }}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.65)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 50,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "#16161a",
                border: "1px solid #2a2a32",
                borderRadius: 10,
                padding: 24,
                minWidth: 340,
                maxWidth: 420,
                color: "#e8e8ec",
                boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
              }}
            >
              {shopDepositPack == null ? (
                // ── Pack list ─────────────────────────────────────
                <>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      marginBottom: 4,
                      color: "#e8e8ec",
                    }}
                  >
                    Pixel Pack
                  </div>
                  <div style={{ fontSize: 12, color: "#9090a0", marginBottom: 16 }}>
                    Buy pixel credits. Each credit = 1 pixel. Currently free
                    — the deposit address below is for the live-mode preview.
                  </div>
                  {([
                    { count: 10, icp: "0.001" },
                    { count: 100, icp: "2" },
                    { count: 500, icp: "5" },
                    { count: 1000, icp: "8" },
                  ] as const).map(({ count: n, icp }) => (
                      <button
                        key={n}
                        disabled={shopBusy}
                        onClick={() => {
                          setShopDepositPack(n);
                                          }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                          padding: "12px 14px",
                          marginBottom: 8,
                          background: "#1f1f25",
                          color: "#e8e8ec",
                          border: "1px solid #b88a1f",
                          borderRadius: 6,
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: shopBusy ? "wait" : "pointer",
                          textAlign: "left",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        <span>+{n.toLocaleString()} pixels</span>
                        <span
                          style={{
                            fontSize: 11,
                            color: "#9090a0",
                            fontWeight: 500,
                          }}
                        >
                          {icp} ICP
                        </span>
                      </button>
                  ))}
                  <button
                    onClick={() => setShopOpen(false)}
                    disabled={shopBusy}
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: 8,
                      padding: "8px",
                      background: "transparent",
                      color: "#9090a0",
                      border: "1px solid #2a2a32",
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    cancel
                  </button>
                </>
              ) : (
                // ── Confirm + pay view (ICRC-2 approve flow) ──────
                (() => {
                  return (
                    <>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 800,
                          marginBottom: 4,
                          color: "#e8e8ec",
                        }}
                      >
                        Buy {shopDepositPack.toLocaleString()} pixels
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#9090a0",
                          marginBottom: 16,
                        }}
                      >
                        {usdPerIcp > 0 ? (
                          <>
                            You will approve{" "}
                            <span style={{ color: "#f0c040", fontWeight: 700 }}>
                              ~{((shopDepositPack * 0.05) / usdPerIcp * 1.1).toFixed(4)} ICP
                            </span>{" "}
                            from your wallet. The exact amount is calculated from the
                            live ICP/USD rate (${usdPerIcp.toFixed(2)}/ICP) + 10% buffer.
                          </>
                        ) : (
                          "Loading ICP rate..."
                        )}
                      </div>

                      <button
                        disabled={shopBusy || usdPerIcp <= 0}
                        onClick={() => handleBuyPixels(shopDepositPack)}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "10px 14px",
                          marginBottom: 8,
                          background: shopBusy ? "#9090a0" : "#f0c040",
                          color: "#16161a",
                          border: "none",
                          borderRadius: 6,
                          fontSize: 14,
                          fontWeight: 800,
                          cursor: shopBusy ? "wait" : "pointer",
                        }}
                      >
                        {shopBusy ? status || "processing…" : "Approve & Buy"}
                      </button>

                      <button
                        onClick={() => {
                          setShopDepositPack(null);
                        }}
                        disabled={shopBusy}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "8px",
                          background: "transparent",
                          color: "#9090a0",
                          border: "1px solid #2a2a32",
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        ← back to packs
                      </button>
                    </>
                  );
                })()
              )}
            </div>
          </div>
        )}

        {/* View-only → sign-in prompt. Opened by `requireSignIn` from any
            gated action (pixel placement, create/join/leave alliance, buy
            pixels, ...). On successful sign-in the stashed pendingAction
            fires automatically inside handleLogin. */}
        {signInPromptOpen && (
          <div
            onClick={() => {
              // Click outside the card = cancel. Clear the pending action so
              // it doesn't fire on a later unrelated sign-in.
              pendingActionRef.current = null;
              setSignInPromptOpen(false);
            }}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.65)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 80,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "#16161a",
                border: "1px solid #2a2a32",
                borderRadius: 10,
                padding: 24,
                minWidth: 320,
                maxWidth: 420,
                color: "#e8e8ec",
                boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>
                {signInPromptReason}
              </div>
              <div style={{ fontSize: 13, color: "#9090a0", marginBottom: 18 }}>
                You're browsing in view-only mode. Sign in with Internet
                Identity to start playing — you can place pixels, join an
                alliance, and mint NFTs of completed missions.
              </div>
              <button
                onClick={handleLogin}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "10px 14px",
                  marginBottom: 8,
                  background: "#f0c040",
                  color: "#16161a",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Sign in
              </button>
              <button
                onClick={() => {
                  pendingActionRef.current = null;
                  setSignInPromptOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px",
                  background: "transparent",
                  color: "#9090a0",
                  border: "1px solid #2a2a32",
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                cancel
              </button>
            </div>
          </div>
        )}

        {/* Mini-map (bottom-left) — moved off the right edge to avoid
            overlapping the alliance panel. */}
        {map && state && !replayMode && (
          <div
            onPointerDown={handleMiniPointerDown}
            onPointerMove={handleMiniPointerMove}
            onContextMenu={(e) => e.preventDefault()}
            title="click or drag (any button) to jump"
            style={{
              position: "absolute",
              bottom: 10,
              left: 10,
              width: MINI_SIZE,
              height: MINI_SIZE,
              border: "1px solid #444",
              borderRadius: 4,
              background: "#000",
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
              cursor: "crosshair",
              overflow: "hidden",
            }}
          >
            <canvas
              ref={miniRef}
              style={{
                width: "100%",
                height: "100%",
                imageRendering: "pixelated",
                display: "block",
              }}
            />
            {miniViewport && (
              <div
                style={{
                  position: "absolute",
                  left: miniViewport.x,
                  top: miniViewport.y,
                  width: miniViewport.w,
                  height: miniViewport.h,
                  border: "1.5px solid #fff",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.7)",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        )}

        {/* Hint overlay when creating */}
        {creatingAlliance && (
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              padding: "6px 10px",
              background: "rgba(0,0,0,0.7)",
              border: "1px solid #555",
              borderRadius: 4,
              fontSize: 12,
              color: shiftDown ? "#aaa" : "#eee",
              pointerEvents: "none",
            }}
          >
            {shiftDown
              ? "drag to draw mission area"
              : "hold SHIFT and drag on the map to draw mission area"}
          </div>
        )}
      </div>

      {actor && state && !replayMode && panelOpen && (
        <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid #2a2a32" }}>
          {(
        <AlliancePanel
          actor={actor}
          alliances={alliances}
          myAlliance={myAlliance}
          myPrincipal={principal}
          pendingRect={pendingRect}
          creating={creatingAlliance}
          mapSize={state.map_size}
          setCreating={setCreatingAlliance}
          setPendingRect={setPendingRect}
          onClearRect={() => setPendingRect(null)}
          onChanged={() => refreshMeta(actor)}
          missionProgress={missionProgress}
          onGoToMission={goToMission}
          onShareMission={shareMyAlliance}
          tab={panelTab}
          setTab={setPanelTab}
          authed={authed}
          requireSignIn={requireSignIn}
          onPickColor={(color) => {
            const exact = palette.indexOf(color);
            if (exact >= 0) { setSelectedSlot(exact); return; }
            let best = 0, bestD = Infinity;
            for (let i = 0; i < palette.length; i++) {
              const p = palette[i];
              const dr = ((p >> 16) & 0xff) - ((color >> 16) & 0xff);
              const dg = ((p >> 8) & 0xff) - ((color >> 8) & 0xff);
              const db = (p & 0xff) - (color & 0xff);
              const d = dr * dr + dg * dg + db * db;
              if (d < bestD) { bestD = d; best = i; }
            }
            setSelectedSlot(best);
          }}
        />
          )}
        </div>
      )}


      {/* Replay scrubber bar — only visible while in replay mode. */}
      {replayMode && (
        <div
          style={{
            padding: "10px 16px",
            background: "#16161a",
            borderTop: "1px solid #2a2a32",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "#e8e8ec",
            flexWrap: "wrap",
          }}
        >
          {/* Jump to start */}
          <button
            className="btn"
            onClick={() => { setReplayPlaying(false); setReplayIndex(0); }}
            style={{ minWidth: 28, fontSize: 11 }}
            title="Jump to start"
          >
            ⏮
          </button>

          {/* Step back */}
          <button
            className="btn"
            onClick={() => { setReplayPlaying(false); setReplayIndex((i) => Math.max(0, i - 1)); }}
            style={{ minWidth: 28, fontSize: 11 }}
            title="Step back"
          >
            ◀
          </button>

          {/* PLAY / PAUSE — big, centered */}
          <button
            className="btn"
            onClick={() => {
              if (replayIndex >= replayChanges.length) setReplayIndex(0);
              setReplayPlaying((p) => !p);
            }}
            style={{
              minWidth: 44,
              height: 36,
              fontSize: 18,
              fontWeight: 700,
              background: replayPlaying ? "#b34" : "#2b8a3e",
              color: "#fff",
              border: "none",
              borderRadius: 6,
            }}
            title={replayPlaying ? "Pause" : "Play"}
          >
            {replayPlaying ? "⏸" : "▶"}
          </button>

          {/* Step forward */}
          <button
            className="btn"
            onClick={() => { setReplayPlaying(false); setReplayIndex((i) => Math.min(replayChanges.length, i + 1)); }}
            style={{ minWidth: 28, fontSize: 11 }}
            title="Step forward"
          >
            ▶
          </button>

          {/* Jump to end */}
          <button
            className="btn"
            onClick={() => { setReplayPlaying(false); setReplayIndex(replayChanges.length); }}
            style={{ minWidth: 28, fontSize: 11 }}
            title="Jump to end"
          >
            ⏭
          </button>

          {/* Speed selector */}
          <button
            className="btn"
            onClick={() => setReplaySpeedIdx((i) => (i + 1) % REPLAY_SPEEDS.length)}
            style={{
              minWidth: 44,
              fontWeight: 700,
              fontSize: 11,
              color: replaySpeed === 1 ? "#9090a0" : "#ffcc00",
            }}
            title="Playback speed — click to cycle"
          >
            {replaySpeed}x
          </button>

          {/* Slider */}
          <input
            type="range"
            min={0}
            max={replayChanges.length}
            value={replayIndex}
            onChange={(e) => {
              setReplayPlaying(false);
              setReplayIndex(Number(e.target.value));
            }}
            style={{ flex: 1, minWidth: 120, accentColor: "#ff4500" }}
          />

          {/* Frame counter + percentage */}
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color: "#9090a0",
              minWidth: 140,
              textAlign: "right",
              fontSize: 11,
            }}
          >
            {replayIndex.toLocaleString()} / {replayChanges.length.toLocaleString()}
            {replayChanges.length > 0 && (
              <span style={{ color: "#666", marginLeft: 6 }}>
                {Math.round((replayIndex / replayChanges.length) * 100)}%
              </span>
            )}
          </span>

          {/* Close */}
          <button className="btn" onClick={exitReplay} title="Exit replay">
            ✕
          </button>
        </div>
      )}

      {/* Bottom palette — hidden during replay. */}
      {!replayMode && (
      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid #333",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          position: "relative",
        }}
      >
        {/* Help button */}
        <button
          onClick={() => setHelpOpen(true)}
          style={{
            position: "absolute",
            right: 14,
            top: "50%",
            transform: "translateY(-50%)",
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "none",
            border: "1px solid #3a3a45",
            color: "#60606a",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            zIndex: 2,
          }}
        >
          ?
        </button>
        {/* Cursor coordinates — visible when hovering the map. */}
        <div
          style={{
            position: "absolute",
            left: 14,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontVariantNumeric: "tabular-nums",
            color: hover ? "#eee" : "#555",
            minWidth: 70,
          }}
        >
          {hover ? `(${hover.x}, ${-hover.y})` : "(—, —)"}
        </div>
        {palette.map((c, i) => {
          // Find the digit (if any) bound to this slot — shown as a small label.
          const digit = Object.entries(bindings).find(([, s]) => s === i)?.[0]
            ?? (i < 9 && bindings[String(i + 1)] === undefined ? String(i + 1) : null);
          return (
            <button
              key={i}
              onClick={() => handleSwatchClick(i)}
              title={
                rebindDigit
                  ? `click to bind ${rebindDigit} to this color`
                  : `${intToHex(c)}${digit ? ` · key ${digit}` : ""}`
              }
              style={{
                position: "relative",
                width: 30,
                height: 30,
                background: intToHex(c),
                border:
                  i === selectedSlot
                    ? "3px solid #fff"
                    : rebindDigit
                    ? "1px dashed #f0c040"
                    : "1px solid #555",
                cursor: "pointer",
                padding: 0,
                transform: i === selectedSlot ? "scale(1.18)" : "scale(1)",
                transition: "transform 0.18s cubic-bezier(.34,1.56,.64,1), border-color 0.12s",
                zIndex: i === selectedSlot ? 2 : 1,
              }}
            >
              {digit && (
                <span
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#fff",
                    background: "#000",
                    border: "1px solid #555",
                    borderRadius: 3,
                    padding: "0 3px",
                    lineHeight: "12px",
                    pointerEvents: "none",
                  }}
                >
                  {digit}
                </span>
              )}
            </button>
          );
        })}
        {/* Eyedropper toggle */}
        <div
          style={{ position: "relative", marginLeft: 4, flexShrink: 0 }}
          onMouseEnter={(e) => { e.currentTarget.querySelector<HTMLElement>("[data-tip]")!.style.opacity = "1"; }}
          onMouseLeave={(e) => { e.currentTarget.querySelector<HTMLElement>("[data-tip]")!.style.opacity = "0"; }}
        >
          <button
            onClick={() => setEyedropperMode((v) => !v)}
            style={{
              width: 30,
              height: 30,
              background: "#2a2a32",
              border: "1px solid #555",
              borderRadius: 4,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              transform: eyedropperActive ? "scale(1.25)" : "scale(1)",
              transition: "transform 0.15s ease",
            }}
          >
            {/* Eyedropper / color picker icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Barrel of the pipette */}
              <path d="M13.4 10.6L7.7 16.3C7.3 16.7 6.5 17.5 5.5 18.5L4 22L5.5 22L9.5 18.5C10 18 10.7 17.3 11.1 16.9L16.4 11.6" stroke="#ccc" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              {/* Tip / nib */}
              <path d="M4 22L3 23" stroke="#ccc" strokeWidth="1.5" strokeLinecap="round"/>
              {/* Bulb / top */}
              <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5" transform="rotate(45 17.25 6.75)" stroke="#ccc" strokeWidth="1.8" fill="none"/>
              {/* Connection */}
              <path d="M13.4 10.6L16.4 11.6" stroke="#ccc" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
          <div data-tip style={{
            position: "absolute",
            bottom: 36,
            right: 0,
            background: "#1a1a22",
            border: "1px solid #444",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 11,
            color: "#aaa",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
            opacity: 0,
            transition: "opacity 0.15s",
            lineHeight: 1.5,
            zIndex: 10,
          }}>
            <div>pick color from map or <span style={{ color: "#f0c040" }}>mission preview</span></div>
            <div>shortcut: hold <span style={{ color: "#f0c040", fontWeight: 700 }}>Tab</span></div>
          </div>
        </div>
      </div>
      )}
      </div>

      {/* Help / info overlay */}
      {helpOpen && (
        <div
          onClick={() => setHelpOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#16161a",
              border: "1px solid #2a2a32",
              borderRadius: 14,
              padding: "32px 40px",
              maxWidth: 400,
              maxHeight: "85vh",
              overflowY: "auto",
              width: "90%",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              position: "relative",
            }}
          >
            <button
              onClick={() => setHelpOpen(false)}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                background: "none",
                border: "none",
                color: "#60606a",
                fontSize: 20,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ✕
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <img src="/img/logo.svg" alt="" style={{ width: 28, height: 28 }} />
              <span style={{ fontSize: 20, fontWeight: 800, color: "#e8e8ec" }}>ICPixel</span>
            </div>
            <p style={{ fontSize: 13, color: "#9090a0", margin: 0, lineHeight: 1.5 }}>
              Collaborative pixel battle on the Internet Computer. Place pixels, form alliances, mint NFTs of completed missions.
            </p>

            {/* How to play */}
            <button
              onClick={() => setHowToPlay((v) => !v)}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "14px 10px",
                background: howToPlay ? "#2a2a32" : "#1f1f25",
                border: `1px solid ${howToPlay ? "#51e9f4" : "#2a2a32"}`,
                borderRadius: 8,
                color: "#e8e8ec",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {howToPlay ? "▾ How to play" : "▸ How to play?"}
            </button>
            {howToPlay && (
              <div style={{
                padding: "14px 16px",
                background: "#12121a",
                border: "1px solid #2a2a32",
                borderRadius: 8,
                fontSize: 12,
                color: "#b0b0c0",
                lineHeight: 1.7,
              }}>
                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginBottom: 6 }}>
                  Place pixels
                </div>
                Click anywhere on the map to paint a pixel with your selected color.
                Pick colors from the palette at the bottom, or press <b style={{ color: "#f0c040" }}>1-9</b> for quick switch.
                Hold <b style={{ color: "#f0c040" }}>Tab</b> to eyedrop a color from the map.

                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                  Form an alliance
                </div>
                Open the Alliances panel on the right. Create your own alliance or join an existing one.
                Each alliance has a <b>mission</b> — a pixel-art template drawn on the map.

                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                  Complete missions
                </div>
                Work with your alliance to paint the mission template onto the map.
                When <b style={{ color: "#f0c040" }}>95%</b> of the template matches — an <b>NFT</b> is automatically minted for the alliance leader.
                The leader can then <b>upgrade</b> the mission to a bigger template.

                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                  Grow the map
                </div>
                The map starts at 1×1 and grows through stages (5→10→50→100→500) as players fill 95% of cells.
                When the final stage is reached — a <b style={{ color: "#f0c040" }}>7-day countdown</b> begins. Season ends when it hits zero.

                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                  Earn rewards
                </div>
                Every pixel you place on a mission earns you a share of the reward pool.
                NFT holders receive treasury distributions at the end of each season —
                bigger missions and earlier NFTs get a larger share.

                <div style={{ fontWeight: 700, color: "#e8e8ec", fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                  Controls
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11, color: "#9090a0" }}>
                  <span style={{ color: "#f0c040" }}>Click</span><span>Place pixel</span>
                  <span style={{ color: "#f0c040" }}>Scroll</span><span>Zoom in/out</span>
                  <span style={{ color: "#f0c040" }}>Drag</span><span>Pan the map</span>
                  <span style={{ color: "#f0c040" }}>Arrows / WASD</span><span>Pan the map</span>
                  <span style={{ color: "#f0c040" }}>1-9</span><span>Switch color</span>
                  <span style={{ color: "#f0c040" }}>Tab</span><span>Eyedropper</span>
                  <span style={{ color: "#f0c040" }}>Shift+Drag</span><span>Draw mission area</span>
                </div>
              </div>
            )}

            {/* Docs / GitHub */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <a
                href="https://github.com/TALfusion/ICPixel"
                target="_blank"
                rel="noopener noreferrer"
                onClickCapture={(e) => { e.stopPropagation(); window.open("https://github.com/TALfusion/ICPixel", "_blank"); }}
                style={{
                  padding: "12px 10px",
                  background: "#1f1f25",
                  border: "1px solid #2a2a32",
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "center",
                  textDecoration: "none",
                  display: "block",
                  zIndex: 10000,
                  position: "relative",
                  pointerEvents: "auto",
                }}
              >
                GitHub
              </a>
              <a
                href="https://icpixel.gitbook.io/icpixel-docs/"
                target="_blank"
                rel="noopener noreferrer"
                onClickCapture={(e) => { e.stopPropagation(); window.open("https://icpixel.gitbook.io/icpixel-docs/", "_blank"); }}
                style={{
                  padding: "12px 10px",
                  background: "#1f1f25",
                  border: "1px solid #2a2a32",
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "center",
                  textDecoration: "none",
                  display: "block",
                  zIndex: 10000,
                  position: "relative",
                  pointerEvents: "auto",
                }}
              >
                Gitbook
              </a>
            </div>

            {/* Privacy / Terms buttons on one line */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <button
                onClick={() => { setShowPrivacy((v) => !v); setShowTerms(false); }}
                style={{
                  padding: "12px 10px",
                  background: showPrivacy ? "#2a2a32" : "#1f1f25",
                  border: `1px solid ${showPrivacy ? "#51e9f4" : "#2a2a32"}`,
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {showPrivacy ? "▾ Privacy Policy" : "▸ Privacy Policy"}
              </button>
              <button
                onClick={() => { setShowTerms((v) => !v); setShowPrivacy(false); }}
                style={{
                  padding: "12px 10px",
                  background: showTerms ? "#2a2a32" : "#1f1f25",
                  border: `1px solid ${showTerms ? "#51e9f4" : "#2a2a32"}`,
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {showTerms ? "▾ Terms of Service" : "▸ Terms of Service"}
              </button>
            </div>
            {showPrivacy && (
              <div style={{
                padding: "14px 16px",
                background: "#12121a",
                border: "1px solid #2a2a32",
                borderRadius: 8,
                fontSize: 11,
                color: "#b0b0c0",
                lineHeight: 1.7,
                maxHeight: 300,
                overflowY: "auto",
              }}>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec", fontSize: 12 }}>Privacy Policy — Last updated: April 14, 2026</p>
                <p style={{ margin: "0 0 8px" }}>ICPixel is a fully decentralized application running on the Internet Computer Protocol (ICP) blockchain. There are no centralized servers, databases, or cloud infrastructure operated by us.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>We do NOT collect:</p>
                <p style={{ margin: "0 0 8px" }}>Names, emails, phone numbers, IP addresses, browser fingerprints, cookies, tracking pixels, analytics data, location data, or any personally identifiable information (PII).</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Blockchain data:</p>
                <p style={{ margin: "0 0 8px" }}>Your Internet Identity principal, pixel placements, alliance membership, transactions, and NFT ownership are recorded on the ICP blockchain. This data is public by design, pseudonymous, permanent, and not controlled by us. We cannot delete, modify, or restrict access to on-chain data.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Third parties:</p>
                <p style={{ margin: "0 0 8px" }}>We do not share data with third parties. There is nothing to share. Authentication is handled by Internet Identity (DFINITY). Payments go through the ICP Ledger. We have no control over these services.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Limitation of liability:</p>
                <p style={{ margin: "0 0 8px" }}>The Service is provided "AS IS" without warranty. Our total aggregate liability shall not exceed $0.00 USD. You assume all risks associated with using the Service, including loss of funds, smart contract failure, and complete loss of digital assets.</p>
                <p style={{ margin: "0 0 4px" }}>Contact: <b>ICPixel@proton.me</b></p>
              </div>
            )}
            {showTerms && (
              <div style={{
                padding: "14px 16px",
                background: "#12121a",
                border: "1px solid #2a2a32",
                borderRadius: 8,
                fontSize: 11,
                color: "#b0b0c0",
                lineHeight: 1.7,
                maxHeight: 300,
                overflowY: "auto",
              }}>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec", fontSize: 12 }}>Terms of Service — Last updated: April 14, 2026</p>
                <p style={{ margin: "0 0 8px" }}>By using ICPixel you agree to these terms. ICPixel is experimental, decentralized software for entertainment purposes only.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>No refunds:</p>
                <p style={{ margin: "0 0 8px" }}>All transactions are final and non-refundable. This includes pixel purchases, alliance fees, and any ICP spent. We cannot reverse blockchain transactions.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>No guarantees:</p>
                <p style={{ margin: "0 0 8px" }}>The Service is provided "AS IS". We do not guarantee uptime, correctness, security, or value of any digital assets. NFTs are speculative collectibles with no guaranteed value. Rewards are not dividends or guaranteed income.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Smart contract risk:</p>
                <p style={{ margin: "0 0 8px" }}>Smart contracts may contain bugs or vulnerabilities. Loss of funds due to exploits, bugs, or network issues is your sole responsibility. We are under no obligation to fix, compensate, or refund.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Changes:</p>
                <p style={{ margin: "0 0 8px" }}>Game mechanics, rules, pricing, and rewards may change at any time without notice. We may pause, modify, or shut down the Service at our discretion.</p>
                <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#e8e8ec" }}>Liability:</p>
                <p style={{ margin: "0 0 8px" }}>Our total aggregate liability is $0.00 USD. You waive the right to class action lawsuits. Any disputes are resolved through binding arbitration. You agree to indemnify and hold us harmless from any claims.</p>
                <p style={{ margin: "0 0 4px" }}>Contact: <b>ICPixel@proton.me</b></p>
              </div>
            )}

            {/* Social / Contact */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <a
                href="https://x.com/IcPixel80970"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "12px 10px",
                  background: "#1f1f25",
                  border: "1px solid #2a2a32",
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "center",
                  textDecoration: "none",
                }}
              >
                Our X
              </a>
              <a
                href="mailto:ICPixel@proton.me"
                style={{
                  padding: "12px 10px",
                  background: "#1f1f25",
                  border: "1px solid #2a2a32",
                  borderRadius: 8,
                  color: "#e8e8ec",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "center",
                  textDecoration: "none",
                }}
              >
                Contact us
              </a>
            </div>

            {/* Bug reports / ideas */}
            <div style={{
              marginTop: 12,
              padding: "12px 14px",
              background: "#1a1a22",
              border: "1px solid #2a2a32",
              borderRadius: 8,
              fontSize: 12,
              color: "#9090a0",
              lineHeight: 1.6,
              textAlign: "center",
            }}>
              Found a bug or have an idea?<br />
              Send it to <span style={{ color: "#f0c040", fontWeight: 600 }}>ICPixel@proton.me</span><br />
              <span style={{ color: "#60606a", fontSize: 11 }}>get free pixels for good suggestions</span>
            </div>

            <div style={{
              marginTop: 12,
              textAlign: "center",
              fontSize: 12,
              color: "#4a4a55",
            }}>
              Powered by <span style={{ color: "#60606a", fontWeight: 600 }}>Internet Computer</span>
            </div>
          </div>
        </div>
      )}

      {/* Same-color overwrite warning */}
      {sameColorConfirm && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
        }} onClick={() => setSameColorConfirm(null)}>
          <div style={{
            background: "#1a1a2e", border: "1px solid #333", borderRadius: 8,
            padding: "24px 32px", maxWidth: 360, textAlign: "center",
          }} onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: "0 0 12px", fontSize: 15 }}>
              This cell is already this color. Place anyway?
            </p>
            <label style={{ display: "block", margin: "0 0 16px", fontSize: 13, opacity: 0.7, cursor: "pointer" }}>
              <input
                type="checkbox"
                style={{ marginRight: 6 }}
                onChange={(e) => {
                  setSkipSameColorWarn(e.target.checked);
                  try { localStorage.setItem(SAME_COLOR_KEY, e.target.checked ? "1" : "0"); } catch {}
                }}
              />
              Don't show this again
            </label>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button
                className="btn"
                style={{ padding: "6px 20px" }}
                onClick={() => { setSameColorConfirm(null); }}
              >
                Cancel
              </button>
              <button
                className="btn"
                style={{ padding: "6px 20px", background: "#e57a00" }}
                onClick={() => {
                  const { x, y, color } = sameColorConfirm;
                  setSameColorConfirm(null);
                  doPlacePixel(x, y, color);
                }}
              >
                Place anyway
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
