import { useEffect, useRef } from "react";

export interface UseTouchCanvasOptions {
  wrapperRef: React.RefObject<HTMLDivElement>;
  enabled: boolean;
  zoom: number;
  pan: { x: number; y: number };
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  baseSize: number;
  clampPan: (p: { x: number; y: number }, rs: number) => { x: number; y: number };
  onTap: (clientX: number, clientY: number) => void;
  growingRef: React.RefObject<boolean>;
}

type Phase = "idle" | "pending" | "panning" | "pinching";

function dist(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
function mid(a: Touch, b: Touch): { x: number; y: number } {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

export function useTouchCanvas(opts: UseTouchCanvasOptions) {
  const {
    wrapperRef, enabled, zoom, pan, setZoom, setPan,
    baseSize, clampPan, onTap, growingRef,
  } = opts;

  // Stash latest values in refs so listeners don't go stale.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const baseSizeRef = useRef(baseSize);
  baseSizeRef.current = baseSize;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  const phaseRef = useRef<Phase>("idle");
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTouchRef = useRef<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinchRef = useRef<{ dist: number; zoom: number; mid: { x: number; y: number }; pan: { x: number; y: number } } | null>(null);
  const velRef = useRef<{ vx: number; vy: number; lastX: number; lastY: number; lastT: number } | null>(null);
  const inertiaRafRef = useRef<number | null>(null);

  const MOVE_THRESHOLD = 8;
  const TAP_DELAY = 150;

  useEffect(() => {
    if (!enabled) return;
    const w = wrapperRef.current;
    if (!w) return;

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
      if (Math.hypot(vx, vy) < 0.05) return;
      const friction = 0.92;
      const tick = () => {
        vx *= friction;
        vy *= friction;
        if (Math.hypot(vx, vy) < 0.05) {
          inertiaRafRef.current = null;
          return;
        }
        setPan((p) => clampPan({ x: p.x + vx * 16, y: p.y + vy * 16 }, baseSizeRef.current * zoomRef.current));
        inertiaRafRef.current = requestAnimationFrame(tick);
      };
      inertiaRafRef.current = requestAnimationFrame(tick);
    }

    function clearTapTimer() {
      if (tapTimerRef.current != null) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
    }

    function onTouchStart(e: TouchEvent) {
      if (growingRef.current) return;
      e.preventDefault();

      stopInertia();
      clearTapTimer();

      const touches = e.touches;

      if (touches.length === 1) {
        const t = touches[0];
        phaseRef.current = "pending";
        startTouchRef.current = { x: t.clientX, y: t.clientY };
        dragOriginRef.current = { x: t.clientX, y: t.clientY, px: panRef.current.x, py: panRef.current.y };
        velRef.current = { vx: 0, vy: 0, lastX: t.clientX, lastY: t.clientY, lastT: performance.now() };

        // Start tap timer — if it fires without movement, it's a tap
        tapTimerRef.current = setTimeout(() => {
          tapTimerRef.current = null;
          // If still in pending (no movement), treat as tap
          if (phaseRef.current === "pending" && startTouchRef.current) {
            onTapRef.current(startTouchRef.current.x, startTouchRef.current.y);
            phaseRef.current = "idle";
            startTouchRef.current = null;
          }
        }, TAP_DELAY);
      }

      if (touches.length === 2) {
        clearTapTimer();
        phaseRef.current = "pinching";
        const d = dist(touches[0], touches[1]);
        const m = mid(touches[0], touches[1]);
        pinchRef.current = {
          dist: d,
          zoom: zoomRef.current,
          mid: m,
          pan: { ...panRef.current },
        };
      }
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      const touches = e.touches;

      if (phaseRef.current === "pinching" && touches.length >= 2 && pinchRef.current) {
        const d = dist(touches[0], touches[1]);
        const m = mid(touches[0], touches[1]);
        const ratio = d / pinchRef.current.dist;
        const newZoom = Math.min(200, Math.max(0.5, pinchRef.current.zoom * ratio));

        // Cursor-centered zoom around the pinch midpoint
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const cx = pinchRef.current.mid.x - rect.left;
          const cy = pinchRef.current.mid.y - rect.top;
          const zRatio = newZoom / pinchRef.current.zoom;
          const ccx = rect.width / 2 + pinchRef.current.pan.x;
          const ccy = rect.height / 2 + pinchRef.current.pan.y;
          const dx = cx - ccx;
          const dy = cy - ccy;
          const newPan = clampPan(
            {
              x: cx - dx * zRatio - rect.width / 2 + (m.x - pinchRef.current.mid.x),
              y: cy - dy * zRatio - rect.height / 2 + (m.y - pinchRef.current.mid.y),
            },
            baseSizeRef.current * newZoom,
          );
          setZoom(newZoom);
          setPan(newPan);
        }
        return;
      }

      if (touches.length === 1 && dragOriginRef.current) {
        const t = touches[0];
        const dx = t.clientX - dragOriginRef.current.x;
        const dy = t.clientY - dragOriginRef.current.y;

        if (phaseRef.current === "pending") {
          if (Math.hypot(dx, dy) > MOVE_THRESHOLD) {
            clearTapTimer();
            phaseRef.current = "panning";
          } else {
            return; // still within threshold
          }
        }

        if (phaseRef.current === "panning") {
          setPan(
            clampPan(
              { x: dragOriginRef.current.px + dx, y: dragOriginRef.current.py + dy },
              baseSizeRef.current * zoomRef.current,
            ),
          );
          const v = velRef.current;
          if (v) {
            const now = performance.now();
            const dt = Math.max(1, now - v.lastT);
            v.vx = (t.clientX - v.lastX) / dt;
            v.vy = (t.clientY - v.lastY) / dt;
            v.lastX = t.clientX;
            v.lastY = t.clientY;
            v.lastT = now;
          }
        }
      }
    }

    function onTouchEnd(e: TouchEvent) {
      e.preventDefault();

      if (e.touches.length === 0) {
        // All fingers lifted
        if (phaseRef.current === "panning") {
          startInertia();
        }
        // If still pending when finger lifts (before timer), treat as tap
        if (phaseRef.current === "pending" && startTouchRef.current) {
          clearTapTimer();
          onTapRef.current(startTouchRef.current.x, startTouchRef.current.y);
        }
        phaseRef.current = "idle";
        dragOriginRef.current = null;
        startTouchRef.current = null;
        pinchRef.current = null;
      } else if (e.touches.length === 1 && phaseRef.current === "pinching") {
        // Went from 2 fingers to 1 — switch to panning
        const t = e.touches[0];
        phaseRef.current = "panning";
        dragOriginRef.current = { x: t.clientX, y: t.clientY, px: panRef.current.x, py: panRef.current.y };
        velRef.current = { vx: 0, vy: 0, lastX: t.clientX, lastY: t.clientY, lastT: performance.now() };
        pinchRef.current = null;
      }
    }

    w.addEventListener("touchstart", onTouchStart, { passive: false });
    w.addEventListener("touchmove", onTouchMove, { passive: false });
    w.addEventListener("touchend", onTouchEnd, { passive: false });
    w.addEventListener("touchcancel", onTouchEnd, { passive: false });

    return () => {
      w.removeEventListener("touchstart", onTouchStart);
      w.removeEventListener("touchmove", onTouchMove);
      w.removeEventListener("touchend", onTouchEnd);
      w.removeEventListener("touchcancel", onTouchEnd);
      stopInertia();
      clearTapTimer();
    };
  }, [enabled, wrapperRef, setZoom, setPan, clampPan, growingRef]);
}
