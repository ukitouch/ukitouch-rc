import { React, Button, PageHeader, PeerDeviceSearch, PinchArea } from "./host";
import { HostSettings, ViewerSettings } from "./settings";
import { castStore, stop } from "./main";
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
import { KeysPanel, padLabel } from "./pad";
import type { CursorSpot } from "./picture";

const { useEffect, useRef, useState } = React;

/** The smallest a peer cursor is drawn at. */
const MIN_CURSOR = 16;

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

export default function CastView() {
  //#region PStore

  const state = React.useSyncExternalStore(castStore.subscribe, castStore.get);
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const { devices, connection, screenInfo, error, settings, platform } = state;
  const isTouchDevice = platform === "android"; // currently only Android implemented
  const watching = connection.status === "connected" ? connection : null;
  const sharing = screenInfo !== null;
  const isWatching = watching !== null;
  const controlling = watching !== null && settings.mode === "control";
  const hideCursor = controlling && settings.inputMode === "cursor";

  //#endregion
  //#region POverlay

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cursorElementRef = useRef<HTMLImageElement | null>(null);
  const keysRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<"settings" | "keys">("settings");
  const [padOpen, setPadOpen] = useState(false);
  const [padHeld, setPadHeld] = useState<readonly number[]>([]);
  const [padPressed, setPadPressed] = useState<readonly number[]>([]);
  const [handlers, setHandlers] = useState<InputHandlers | null>(null);

  //#endregion
  //#region Cursor

  /** Cursor's coordinates on the viewer's screen. */
  const cursorSpotRef = useRef<CursorSpot | null>(null);
  const cursorImageRef = useRef<CursorImage | null>(null);
  const [peerCursor, setPeerCursor] = useState<CursorImage | null>(null);

  /** Apply a cursor image to the overlay. */
  function applyCursorSpot() {
    const overlay = cursorElementRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const image = cursorImageRef.current;
    const spot = cursorSpotRef.current;
    if (!overlay) return;
    if (!stage || !canvas || !image || !spot) {
      overlay.style.opacity = "0";
      return;
    }

    const c = castStore.get().connection;
    const source = c.status === "connected" ? c.info?.source : undefined;

    // cursor image's style
    const area = canvas.closest<HTMLElement>(".stage-area") ?? canvas;
    const contain =
      canvas.offsetWidth > 0 && canvas.offsetHeight > 0
        ? Math.min(
          area.clientWidth / canvas.offsetWidth,
          area.clientHeight / canvas.offsetHeight
        )
        : 1;
    const fit = source ? (canvas.offsetWidth * contain) / source.width : 1;
    const k = Math.max(MIN_CURSOR / image.width, fit);
    const r = stage.getBoundingClientRect();
    overlay.style.width = `${image.width * k}px`;
    overlay.style.height = `${image.height * k}px`;
    overlay.style.transform = `translate(${spot.x - r.left - image.xhot * k}px, ${spot.y - r.top - image.yhot * k}px)`;
    overlay.style.opacity = "1";
  }

  function placeCursor(spot: CursorSpot | null) {
    cursorSpotRef.current = spot;
    applyCursorSpot();
  }

  //#endregion
  //#region Effects

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

  // The peer's cursor image, will be drawn by viewer itself.
  useEffect(() => {
    setCursorSink((c) => {
      const image = c ? toCursorImage(c) : null;
      cursorImageRef.current = image;
      setPeerCursor(image);
    });
    return () => setCursorSink(null);
  }, []);

  // hide cursor
  useEffect(() => {
    if (hideCursor) return;
    cursorImageRef.current = null;
    setPeerCursor(null);
  }, [hideCursor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = zoomRef.current;
    const keys = keysRef.current;
    if (!isWatching || !canvas || !stage || !keys) {
      setHandlers(null);
      return;
    }

    const next = attachViewer(canvas, stage, keys, placeCursor);
    setHandlers(next);
    return () => {
      next?.dispose();
      setHandlers(null);
    };
  }, [isWatching]);

  // Keep the soft keyboard up.
  useEffect(() => {
    if (!isWatching) return;
    const keep = (e: TouchEvent) => {
      // Leave the UI alone, or it never clicks.
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, .stage-drawer, .stage-scrim")) return;
      e.preventDefault();
    };
    window.addEventListener("touchstart", keep, { passive: false, capture: true });
    return () => window.removeEventListener("touchstart", keep, { capture: true });
  }, [isWatching]);

  // make sure settings panel close
  useEffect(() => {
    if (!isWatching) setSettingsOpen(false);
  }, [isWatching]);

  // The drawer always opens `settings` when toggled.
  useEffect(() => {
    if (!settingsOpen) setPanel("settings");
  }, [settingsOpen]);

  // Fold the pad away whenever it stops being usable.
  useEffect(() => {
    if (!controlling) setPadOpen(false);
  }, [controlling]);

  // Follow the pad buttons held down.
  useEffect(() => {
    if (!handlers) {
      setPadHeld([]);
      return;
    }
    handlers.onPad((held) => setPadHeld([...held]));
  }, [handlers]);

  // hold focus
  useEffect(() => {
    if (controlling && !isTouchDevice) keysRef.current?.focus();
  }, [controlling, isTouchDevice]);

  // The overlay only exists once the image has arrived.
  useEffect(() => {
    applyCursorSpot();
  }, [peerCursor]);

  useEffect(() => () => stopWatching(), []);

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
              style={hideCursor ? { cursor: "none" } : undefined}
            />
          </div>
        </PinchArea>

        {hideCursor && peerCursor && (
          <img
            ref={cursorElementRef}
            className="stage-cursor"
            src={peerCursor.url}
            alt=""
          />
        )}

        <textarea
          ref={keysRef}
          className="stage-keys"
          tabIndex={-1}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        {controlling && (
          <button
            type="button"
            className="stage-keys-open"
            aria-label="Keyboard"
            onClick={() => keysRef.current?.focus()}
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
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
          </button>
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

        {controlling && (
          <div className={`stage-pad${padOpen ? " stage-pad-open" : ""}`}>
            <div className="stage-pad-row">
              {settings.pad.map((button, i) => (
                <button
                  key={i}
                  type="button"
                  className={`stage-pad-key${padHeld.includes(i) ? " stage-pad-held" : ""}${padPressed.includes(i) ? " stage-pad-press" : ""}`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setPadPressed((was) => (was.includes(i) ? was : [...was, i]));
                    handlers?.padDown(i, button.codes);
                  }}
                  onPointerUp={() => {
                    setPadPressed((was) => was.filter((n) => n !== i));
                    handlers?.padUp(i);
                  }}
                  onPointerCancel={() => {
                    setPadPressed((was) => was.filter((n) => n !== i));
                    handlers?.padCancel(i);
                  }}
                >
                  {button.label ?? padLabel(button.codes)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="stage-pad-toggle"
              aria-label="Keys"
              aria-expanded={padOpen}
              onClick={() => setPadOpen(!padOpen)}
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
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>
        )}

        <div
          className={`stage-scrim${settingsOpen ? "" : " stage-hidden"}`}
          onClick={() => setSettingsOpen(false)}
        />

        <div className={`stage-drawer${settingsOpen ? " stage-drawer-open" : ""}`}>
          {panel === "keys" ? (
            <KeysPanel onBack={() => setPanel("settings")} />
          ) : (
            <>
              <div className="stage-drawer-head">
                <span className="stage-drawer-title">Settings</span>
                <span className="stage-peer">
                  {watching.label}
                  {!watching.info && " · connecting…"}
                  {sharing && " · sharing your screen"}
                </span>
              </div>
              <div className="stage-drawer-body">
                <ViewerSettings onKeys={() => setPanel("keys")} />
              </div>
              <div className="stage-drawer-foot">
                <Button variant="danger" onClick={stopWatching}>
                  Stop
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const selected = devices.find((d) => d.uuid === selectedUuid);
  const canConnect = selectedUuid !== null || text.trim() !== "";

  return (
    <div className="cast-page">
      <PageHeader title="Remote Control" subtitle="remote control other devices" />

      {error && <p className="cast-error">{error}</p>}

      {sharing && (
        <div className="cast-row">
          <span className="cast-note">Sharing this screen</span>
          <Button variant="danger" onClick={stop}>
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

      {state.platform !== "android" && (
        <>
          <hr style={{ borderColor: "#6b7280" }} />
          <HostSettings />
        </>
      )}
    </div>
  );
}
