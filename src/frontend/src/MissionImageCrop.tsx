import { useRef, useState, useEffect, useCallback } from "react";

/**
 * Crop-to-grid mission image picker with pixel touch-up editor.
 *
 * The user drops / pastes / browses an image. It's displayed overlaid on a
 * W×H pixel grid (the mission rect). They can drag to reposition and scroll
 * to resize the image. We sample the color at the center of each grid cell
 * and snap it to the nearest palette color — producing the template array
 * the backend expects.
 *
 * After the image is positioned, the user can toggle "edit" mode to click
 * individual pixels and repaint them with a chosen palette color.
 */

// r/place 2022 palette — must match DEFAULT_PALETTE in App.tsx.
const PALETTE_RGB = [
  [0x6d, 0x00, 0x1a], [0xbe, 0x00, 0x39], [0xff, 0x45, 0x00], [0xff, 0xa8, 0x00],
  [0xff, 0xd6, 0x35], [0xff, 0xf8, 0xb8], [0x00, 0xa3, 0x68], [0x00, 0xcc, 0x78],
  [0x7e, 0xed, 0x56], [0x00, 0x75, 0x6f], [0x00, 0x9e, 0xaa], [0x00, 0xcc, 0xc0],
  [0x24, 0x50, 0xa4], [0x36, 0x90, 0xea], [0x51, 0xe9, 0xf4], [0x49, 0x3a, 0xc1],
  [0x6a, 0x5c, 0xff], [0x94, 0xb3, 0xff], [0x81, 0x1e, 0x9f], [0xb4, 0x4a, 0xc0],
  [0xe4, 0xab, 0xff], [0xde, 0x10, 0x7f], [0xff, 0x38, 0x81], [0xff, 0x99, 0xaa],
  [0x6d, 0x48, 0x2f], [0x9c, 0x69, 0x26], [0xff, 0xb4, 0x70], [0x00, 0x00, 0x00],
  [0x51, 0x52, 0x52], [0x89, 0x8d, 0x90], [0xd4, 0xd7, 0xd9], [0xff, 0xff, 0xff],
] as const;

const PALETTE_HEX: number[] = PALETTE_RGB.map(
  ([r, g, b]) => (r << 16) | (g << 8) | b,
);

function nearestPalette(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE_RGB.length; i++) {
    const [pr, pg, pb] = PALETTE_RGB[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  const [r2, g2, b2] = PALETTE_RGB[best];
  return (r2 << 16) | (g2 << 8) | b2;
}

function hexStr(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}

interface Props {
  /** Mission grid width in cells. */
  gridW: number;
  /** Mission grid height in cells. */
  gridH: number;
  /** Called whenever the sampled template changes (or null if no image). */
  onTemplate: (tpl: number[] | null) => void;
  /** Design tokens. */
  accent: string;
  border: string;
  textDim: string;
  textMuted: string;
}

export default function MissionImageCrop({
  gridW, gridH, onTemplate, accent, border, textDim, textMuted,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageBitmap, setImageBitmap] = useState<ImageBitmap | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Stable data URL — created once on load, not on every render.
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  // Image position/scale relative to the grid. offX/offY are in grid-cell
  // units (0,0 = image top-left aligned with grid top-left). scale = how
  // many grid cells the image width covers.
  const [offX, setOffX] = useState(0);
  const [offY, setOffY] = useState(0);
  const [scale, setScale] = useState(1); // image width in grid cells
  const [needsFit, setNeedsFit] = useState(false);

  // Canvas for sampling source pixels.
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const srcCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  // Cached full-image pixel data — avoid re-calling getImageData every render.
  const srcDataRef = useRef<ImageData | null>(null);

  // Preview canvas.
  const previewRef = useRef<HTMLCanvasElement>(null);

  // ── Pixel touch-up editor state ──
  const [editing, setEditing] = useState(false);
  const [paintColor, setPaintColor] = useState(PALETTE_HEX[27]); // black default
  // The current template as mutable array — kept in a ref so edits don't
  // trigger the sampling effect (which would overwrite them).
  const tplRef = useRef<number[] | null>(null);

  // Load image into a bitmap + an offscreen canvas for pixel sampling.
  // No dependency on gridW/gridH — fit is recomputed in the sampling effect.
  const loadImage = useCallback(async (file: File) => {
    const bm = await createImageBitmap(file);
    setImageBitmap(bm);
    setFileName(file.name);

    const c = document.createElement("canvas");
    c.width = bm.width;
    c.height = bm.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bm.width, bm.height);
    ctx.drawImage(bm, 0, 0);
    srcCanvasRef.current = c;
    srcCtxRef.current = ctx;
    srcDataRef.current = ctx.getImageData(0, 0, bm.width, bm.height);
    // Create stable data URL once — never again per render.
    setImageDataUrl(c.toDataURL());

    // Default fit — will be recomputed if grid changes.
    setScale(bm.width);
    setOffX(0);
    setOffY(0);
    setNeedsFit(true);
    setEditing(false);
  }, []);

  // Paste handler.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) { loadImage(file); e.preventDefault(); return; }
        }
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [loadImage]);

  // Drop handler is inline in JSX.

  // Re-fit whenever grid dimensions change (user drew a new rect).
  const prevGridRef = useRef({ w: gridW, h: gridH });
  useEffect(() => {
    if (prevGridRef.current.w !== gridW || prevGridRef.current.h !== gridH) {
      prevGridRef.current = { w: gridW, h: gridH };
      if (imageBitmap) setNeedsFit(true);
    }
  }, [gridW, gridH, imageBitmap]);

  // Auto-fit image to grid when image loads or grid size changes.
  useEffect(() => {
    if (!imageBitmap) return;
    if (!needsFit) return;
    const imgAspect = imageBitmap.width / imageBitmap.height;
    const gridAspect = gridW / gridH;
    if (imgAspect > gridAspect) {
      setScale(gridH * imgAspect);
      setOffX(-(gridH * imgAspect - gridW) / 2);
      setOffY(0);
    } else {
      setScale(gridW);
      setOffX(0);
      setOffY(-(gridW / imgAspect - gridH) / 2);
    }
    setNeedsFit(false);
  }, [imageBitmap, needsFit, gridW, gridH]);

  // Sample grid + update preview. Debounced to max once per frame so
  // dragging/resizing doesn't cause 60× full-grid resamples per second.
  const sampleRaf = useRef<number>(0);
  useEffect(() => {
    if (!imageBitmap || !srcDataRef.current) {
      onTemplate(null);
      tplRef.current = null;
      return;
    }
    // Skip resampling while in edit mode — edits are the source of truth.
    if (editing) return;

    cancelAnimationFrame(sampleRaf.current);
    sampleRaf.current = requestAnimationFrame(() => {
    const bw = imageBitmap.width;
    const bh = imageBitmap.height;

    const imgH = scale * (bh / bw);
    const cellSrcW = bw / scale;
    const cellSrcH = bh / imgH;

    const tpl = new Array<number>(gridW * gridH);
    const data = srcDataRef.current!.data;

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const sx = Math.floor((gx - offX + 0.5) * cellSrcW);
        const sy = Math.floor((gy - offY + 0.5) * cellSrcH);
        if (sx < 0 || sx >= bw || sy < 0 || sy >= bh) {
          tpl[gy * gridW + gx] = 0xffffff;
        } else {
          const i = (sy * bw + sx) * 4;
          tpl[gy * gridW + gx] = nearestPalette(data[i], data[i + 1], data[i + 2]);
        }
      }
    }
    tplRef.current = tpl;
    onTemplate(tpl);
    drawPreview(tpl);
    }); // close requestAnimationFrame
    return () => cancelAnimationFrame(sampleRaf.current);
  }, [imageBitmap, offX, offY, scale, gridW, gridH, editing]);
  // Intentionally omitting onTemplate from deps — it's a callback prop,
  // and including it would cause infinite re-renders.

  function drawPreview(tpl: number[]) {
    const pc = previewRef.current;
    if (!pc) return;
    pc.width = gridW;
    pc.height = gridH;
    const pctx = pc.getContext("2d")!;
    const img = pctx.createImageData(gridW, gridH);
    for (let i = 0; i < tpl.length; i++) {
      const c = tpl[i];
      img.data[i * 4 + 0] = (c >> 16) & 0xff;
      img.data[i * 4 + 1] = (c >> 8) & 0xff;
      img.data[i * 4 + 2] = c & 0xff;
      img.data[i * 4 + 3] = 255;
    }
    pctx.putImageData(img, 0, 0);
  }

  // ── Pixel editing ──

  /** Convert a pointer event on the container to grid (gx, gy). */
  function pointerToCell(e: React.PointerEvent | React.MouseEvent): [number, number] | null {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const cPx = rect.width / gridW;
    const gx = Math.floor(px / cPx);
    const gy = Math.floor(py / cPx);
    if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) return null;
    return [gx, gy];
  }

  function paintPixel(gx: number, gy: number) {
    const tpl = tplRef.current;
    if (!tpl) return;
    const idx = gy * gridW + gx;
    if (idx < 0 || idx >= tpl.length) return;
    tpl[idx] = paintColor;
    onTemplate([...tpl]);
    drawPreview(tpl);
  }

  const paintingRef = useRef(false);

  function onEditPointerDown(e: React.PointerEvent) {
    if (!editing || !tplRef.current) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    paintingRef.current = true;
    const cell = pointerToCell(e);
    if (cell) paintPixel(cell[0], cell[1]);
  }

  function onEditPointerMove(e: React.PointerEvent) {
    if (!editing || !paintingRef.current) return;
    const cell = pointerToCell(e);
    if (cell) paintPixel(cell[0], cell[1]);
  }

  function onEditPointerUp() {
    paintingRef.current = false;
  }

  // Eyedropper: right-click in edit mode picks color from that pixel.
  function onEditContextMenu(e: React.MouseEvent) {
    if (!editing || !tplRef.current) return;
    e.preventDefault();
    const cell = pointerToCell(e);
    if (!cell) return;
    const idx = cell[1] * gridW + cell[0];
    if (idx >= 0 && idx < tplRef.current.length) {
      setPaintColor(tplRef.current[idx]);
    }
  }

  // Drag to reposition (only in crop mode, not edit mode).
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (editing) return onEditPointerDown(e);
    if (!imageBitmap) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offX, oy: offY };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (editing) return onEditPointerMove(e);
    if (!dragRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cPx = rect.width / gridW;
    const dx = (e.clientX - dragRef.current.startX) / cPx;
    const dy = (e.clientY - dragRef.current.startY) / cPx;
    setOffX(dragRef.current.ox + dx);
    setOffY(dragRef.current.oy + dy);
  }
  function onPointerUp() {
    if (editing) return onEditPointerUp();
    dragRef.current = null;
  }

  // Scroll to resize (disabled in edit mode).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!imageBitmap || editing) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((s) => Math.max(1, Math.min(gridW * 10, s * factor)));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [imageBitmap, gridW, editing]);

  function handleFile(file: File) {
    if (file.type.startsWith("image/")) loadImage(file);
  }

  function clear() {
    setImageBitmap(null);
    setFileName(null);
    setImageDataUrl(null);
    srcCanvasRef.current = null;
    srcCtxRef.current = null;
    srcDataRef.current = null;
    tplRef.current = null;
    setEditing(false);
    onTemplate(null);
  }

  // Render size: fit into available panel width. The panel is 340px with
  // padding/borders, and the upgrade form adds another layer of padding.
  // Using 100% via a ref would be cleaner, but a safe static max is simpler.
  const DISPLAY_W = 270;
  const cellPx = DISPLAY_W / gridW;
  const DISPLAY_H = cellPx * gridH;

  // Image display rect (CSS).
  const imgDisplayW = imageBitmap ? scale * cellPx : 0;
  const imgDisplayH = imageBitmap
    ? imgDisplayW * (imageBitmap.height / imageBitmap.width)
    : 0;

  return (
    <div>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onEditContextMenu}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        style={{
          position: "relative",
          width: DISPLAY_W,
          height: DISPLAY_H,
          overflow: "hidden",
          border: `2px ${editing ? "solid" : "dashed"} ${imageBitmap ? (editing ? "#ff4500" : accent) : border}`,
          borderRadius: 8,
          background: "#0a0a0e",
          cursor: editing ? "crosshair" : (imageBitmap ? "grab" : "pointer"),
          touchAction: "none",
          userSelect: "none",
        }}
        onClick={() => {
          if (imageBitmap) return; // Don't open picker when image loaded.
          const inp = document.createElement("input");
          inp.type = "file";
          inp.accept = "image/*";
          inp.onchange = () => { if (inp.files?.[0]) handleFile(inp.files[0]); };
          inp.click();
        }}
      >
        {!imageBitmap && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", gap: 6,
          }}>
            <div style={{ fontSize: 20, opacity: 0.3 }}>🖼</div>
            <div style={{ fontSize: 11, color: textDim, textAlign: "center" }}>
              Drop image, click to browse, or <b>Ctrl+V</b>
            </div>
          </div>
        )}

        {/* Grid overlay — only when no image (empty state). Once an image
            is loaded the pixelated preview canvas IS the visual. */}
        <svg
          width={DISPLAY_W}
          height={DISPLAY_H}
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", display: imageBitmap ? "none" : "block" }}
        >
          {/* Vertical lines */}
          {Array.from({ length: gridW + 1 }, (_, i) => (
            <line
              key={`v${i}`}
              x1={i * cellPx} y1={0} x2={i * cellPx} y2={DISPLAY_H}
              stroke="rgba(255,255,255,0.15)" strokeWidth={i === 0 || i === gridW ? 1.5 : 0.5}
            />
          ))}
          {/* Horizontal lines */}
          {Array.from({ length: gridH + 1 }, (_, i) => (
            <line
              key={`h${i}`}
              x1={0} y1={i * cellPx} x2={DISPLAY_W} y2={i * cellPx}
              stroke="rgba(255,255,255,0.15)" strokeWidth={i === 0 || i === gridH ? 1.5 : 0.5}
            />
          ))}
        </svg>

        {/* Quantized preview overlay — shows actual cell colors at low opacity */}
        <canvas
          ref={previewRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: DISPLAY_W,
            height: DISPLAY_H,
            imageRendering: "pixelated",
            pointerEvents: "none",
            opacity: imageBitmap ? 1 : 0,
          }}
        />
      </div>

      {/* Controls below the crop area */}
      {imageBitmap && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 10, color: textDim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {editing
              ? "click to paint · right-click to pick color"
              : `${fileName} · drag to move · scroll to resize`}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(!editing); }}
            style={{
              background: editing ? "#ff4500" : "none",
              border: `1px solid ${editing ? "#ff4500" : border}`,
              borderRadius: 4,
              color: editing ? "#fff" : textDim,
              fontSize: 10,
              padding: "2px 6px",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {editing ? "done" : "edit"}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); clear(); }}
            style={{
              background: "none", border: `1px solid ${border}`,
              borderRadius: 4, color: textDim, fontSize: 10,
              padding: "2px 6px", cursor: "pointer", flexShrink: 0,
            }}
          >
            remove
          </button>
        </div>
      )}

      {/* Palette — shown in edit mode */}
      {imageBitmap && editing && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 2, marginTop: 6,
          maxWidth: DISPLAY_W,
        }}>
          {PALETTE_HEX.map((c) => (
            <div
              key={c}
              onClick={() => setPaintColor(c)}
              style={{
                width: 14,
                height: 14,
                borderRadius: 2,
                background: hexStr(c),
                border: c === paintColor ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                cursor: "pointer",
                boxSizing: "border-box",
              }}
            />
          ))}
        </div>
      )}

      {!imageBitmap && (
        <div style={{ fontSize: 10, color: textMuted, marginTop: 4, textAlign: "center" }}>
          tip: use pixel-art sized images for best results
        </div>
      )}
    </div>
  );
}
