import { React, Button, PageHeader, PeerDeviceSearch, PinchArea } from "./host";
import { CastSettings } from "./settings";
import {
  cancelWatch,
  castStore,
  setViewer,
  stopSharing,
  stopWatching,
  watch,
  type StreamTile,
} from "./api";

const { useEffect, useRef, useState } = React;

export default function CastView() {
  const state = React.useSyncExternalStore(castStore.subscribe, castStore.get);
  const { devices, connection, sharing, error } = state;
  const watching = connection.status === "connected" ? connection : null;
  const isWatching = watching !== null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

  if (watching) {
    return (
      <div className="stage">
        <PinchArea className="stage-area">
          <canvas ref={canvasRef} className="stage-canvas" />
        </PinchArea>

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
              {watching.peerId}
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
              void watch(
                selected.uuid,
                selected.remark ?? selected.name ?? "Unknown device"
              );
            } else if (text.trim()) {
              void watch(text.trim(), text.trim());
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
