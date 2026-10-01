import { React, Button, PageHeader, PeerDeviceSearch, PinchArea } from "./host";
import { CastSettings } from "./settings";
import { castStore, stopSharing } from "./main";
import {
  attachViewer,
  cancelWatch,
  setCursorSink,
  setViewer,
  stopWatching,
  requestWatch,
  type PeerCursor,
  type StreamTile,
} from "./viewer";
import type { InputHandlers } from "./input";
import type { CursorSpot } from "./picture";

const { useEffect, useRef, useState } = React;

/** The smallest a peer cursor is drawn at. */
const MIN_CURSOR = 16;

export default function CastView() {
  const state = React.useSyncExternalStore(castStore.subscribe, castStore.get);
  const { devices, connection, screenInfo, error, settings } = state;
  const watching = connection.status === "connected" ? connection : null;
  const sharing = screenInfo !== null;
  const isWatching = watching !== null;
  const controlling = watching !== null && settings.mode === "control";
  const hideCursor = controlling && settings.inputMode === "cursor";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLImageElement | null>(null);
  const [peerCursor, setPeerCursor] = useState<CursorImage | null>(null);
  /** Cursor's coordinates on the viewer's screen. */
  const spotRef = useRef<CursorSpot | null>(null);
  const imageRef = useRef<CursorImage | null>(null);

  const applySpot = () => {
    const overlay = cursorRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const spot = spotRef.current;
    if (!overlay) return;
    if (!stage || !canvas || !image || !spot) {
      overlay.style.opacity = "0";
      return;
    }
    const c = castStore.get().connection;
    const source = c.status === "connected" ? c.info?.source : undefined;
    const fit = source ? canvas.offsetWidth / source.width : 1;
    // Layout width, not the rect: a pinch scales the picture, not the cursor.
    // A picture scaled far down would leave a cursor too small to aim with, so
    // it is never drawn below a readable size.
    const k = Math.max(MIN_CURSOR / image.width, fit);
    const r = stage.getBoundingClientRect();
    overlay.style.width = `${image.width * k}px`;
    overlay.style.height = `${image.height * k}px`;
    overlay.style.transform = `translate(${spot.x - r.left - image.xhot * k}px, ${spot.y - r.top - image.yhot * k}px)`;
    overlay.style.opacity = "1";
  };

  const placeCursor = (spot: CursorSpot | null) => {
    spotRef.current = spot;
    applySpot();
  };
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // A fresh watch starts with settings closed.
  useEffect(() => {
    if (!isWatching) setSettingsOpen(false);
  }, [isWatching]);

  // Hand frame batches to the canvas. Registered once and the ref is resolved at
  // draw time so the viewer can mount later.
  useEffect(() => {
    let queued: StreamTile[][] = [];
    let drawing = false;
    let screen = { width: 0, height: 0 };

    async function pump(): Promise<void> {
      if (drawing) return;
      drawing = true;
      try {
        while (queued.length > 0) {
          const tiles = queued.shift()!;
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) continue;
          const bitmaps = await Promise.all(
            tiles.map((tile) =>
              createImageBitmap(
                new Blob([tile.data as Uint8Array<ArrayBuffer>], {
                  type: "image/webp",
                })
              )
            )
          );
          tiles.forEach((tile, i) => {
            ctx.drawImage(bitmaps[i], tile.x, tile.y);
            bitmaps[i].close();
          });
        }
      } catch (e) {
        console.error("[cast] draw failed", e);
      } finally {
        drawing = false;
      }
    }

    setViewer({
      resize(width, height) {
        screen = { width, height };
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width;
          canvas.height = height;
        }
      },
      draw(tiles) {
        const full = tiles.some(
          (t) =>
            t.x === 0 &&
            t.y === 0 &&
            t.width >= screen.width &&
            t.height >= screen.height
        );
        queued = full ? [tiles] : [...queued, tiles];
        void pump();
      },
    });
    return () => setViewer(null);
  }, []);

  // Leaving the page ends the watch: there is no canvas left to draw into.
  useEffect(() => () => stopWatching(), []);

  // Size up front when the view mounts after the announce already arrived.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && watching?.info) {
      canvas.width = watching.info.width;
      canvas.height = watching.info.height;
    }
  }, [watching?.info]);

  // The peer's cursor image, will be drawn by viewer itself.
  useEffect(() => {
    setCursorSink((c) => {
      const image = c ? toCursorImage(c) : null;
      imageRef.current = image;
      setPeerCursor(image);
    });
    return () => setCursorSink(null);
  }, []);

  useEffect(() => {
    if (hideCursor) return;
    imageRef.current = null;
    setPeerCursor(null);
  }, [hideCursor]);

  const [handlers, setHandlers] = useState<InputHandlers | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = zoomRef.current;
    if (!isWatching || !canvas || !stage) {
      setHandlers(null);
      return;
    }
    const next = attachViewer(canvas, stage, placeCursor);
    setHandlers(next);
    return () => {
      next?.dispose();
      setHandlers(null);
    };
  }, [isWatching]);

  // hold focus
  useEffect(() => {
    if (controlling) canvasRef.current?.focus();
  }, [controlling]);

  // The overlay only exists once the image has arrived.
  useEffect(() => {
    applySpot();
  }, [peerCursor]);

  if (watching) {
    return (
      <div className="stage" ref={stageRef}>
        <PinchArea
          className="stage-area"
          {...(handlers
            ? {
                onPointerDown: handlers.onPointerDown,
                onPointerMove: handlers.onPointerMove,
                onPointerUp: handlers.onPointerUp,
                onPointerCancel: handlers.onPointerCancel,
              }
            : {})}
        >
          <div className="stage-zoom" ref={zoomRef}>
            <canvas
              ref={canvasRef}
              className="stage-canvas"
              tabIndex={0}
              style={hideCursor ? { cursor: "none" } : undefined}
            />
          </div>
        </PinchArea>

        {hideCursor && peerCursor && (
          <img
            ref={cursorRef}
            className="stage-cursor"
            src={peerCursor.url}
            alt=""
          />
        )}

        <button
          type="button"
          className="stage-open"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <div
          className={`stage-scrim${settingsOpen ? "" : " stage-hidden"}`}
          onClick={() => setSettingsOpen(false)}
        />

        <div className={`stage-drawer${settingsOpen ? " stage-drawer-open" : ""}`}>
          <div className="stage-drawer-head">
            <span className="stage-drawer-title">Settings</span>
            <span className="stage-peer">
              {watching.label}
              {!watching.info && " · connecting…"}
              {sharing && " · sharing your screen"}
            </span>
          </div>
          <div className="stage-drawer-body">
            <CastSettings />
          </div>
          <div className="stage-drawer-foot">
            <Button variant="danger" onClick={stopWatching}>
              Stop
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const selected = devices.find((d) => d.uuid === selectedUuid);
  const canConnect = selectedUuid !== null || text.trim() !== "";

  return (
    <div className="cast-page">
      <PageHeader title="Cast" subtitle="Watch another device's screen" />

      {error && <p className="cast-error">{error}</p>}

      {sharing && (
        <div className="cast-row">
          <span className="cast-note">Sharing this screen</span>
          <Button variant="danger" onClick={stopSharing}>
            Stop
          </Button>
        </div>
      )}

      <div className="cast-stack">
        <PeerDeviceSearch
          devices={devices}
          selectedUuid={selectedUuid}
          text={text}
          onTextChange={(t) => {
            setText(t);
            setSelectedUuid(null);
          }}
          onSelect={(uuid, label) => {
            setSelectedUuid(uuid);
            setText(label);
          }}
          onCreate={(id) => {
            setSelectedUuid(null);
            setText(id);
          }}
        />
        <Button
          variant={"primary"}
          onClick={() => {
            if (connection.status === "connecting") {
              cancelWatch();
            } else if (selected) {
              void requestWatch(
                selected.uuid,
                selected.remark ?? selected.name ?? "Unknown device"
              );
            } else if (text.trim()) {
              void requestWatch(text.trim(), text.trim());
            }
          }}
          disabled={connection.status !== "connecting" && !canConnect}
        >
          {connection.status === "connecting" ? "Cancel" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

/** The peer's cursor, ready to draw. */
interface CursorImage {
  url: string;
  width: number;
  height: number;
  xhot: number;
  yhot: number;
}

/** Turn the peer's premultiplied RGBA into something an `<img>` can show. */
function toCursorImage(c: PeerCursor): CursorImage {
  const canvas = document.createElement("canvas");
  canvas.width = c.width;
  canvas.height = c.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: "", width: c.width, height: c.height, xhot: c.xhot, yhot: c.yhot };

  const image = ctx.createImageData(c.width, c.height);
  const src = c.pixels;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    image.data[i + 3] = a;
    if (a === 0) continue;
    // X hands out premultiplied alpha; ImageData wants it straight.
    image.data[i] = Math.min(255, Math.round((src[i] * 255) / a));
    image.data[i + 1] = Math.min(255, Math.round((src[i + 1] * 255) / a));
    image.data[i + 2] = Math.min(255, Math.round((src[i + 2] * 255) / a));
  }
  ctx.putImageData(image, 0, 0);
  return {
    url: canvas.toDataURL(),
    width: c.width,
    height: c.height,
    xhot: c.xhot,
    yhot: c.yhot,
  };
}
