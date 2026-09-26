import { React, Button, PageHeader, PeerDeviceSearch } from "./host";
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

/** How long the watch controls linger without input. */
const IDLE_MS = 3000;

export default function CastView() {
  const state = React.useSyncExternalStore(castStore.subscribe, castStore.get);
  const { devices, connection, sharing, error } = state;
  const watching = connection.status === "connected" ? connection : null;
  const isWatching = watching !== null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controls, setControls] = useState(true);
  const hideAt = useRef(Date.now() + IDLE_MS);

  /** Flip the watch controls, restarting the idle timer when they come out. */
  const toggleControls = () => {
    if (controls) {
      setControls(false);
    } else {
      hideAt.current = Date.now() + IDLE_MS;
      setControls(true);
    }
  };

  // Fade the watch controls when nothing has happened for a while, but keep
  // them up while settings are open.
  useEffect(() => {
    if (!isWatching) return;
    if (!settingsOpen) hideAt.current = Date.now() + IDLE_MS;
    const id = window.setInterval(() => {
      if (!settingsOpen && Date.now() > hideAt.current) setControls(false);
    }, 250);
    return () => window.clearInterval(id);
  }, [isWatching, settingsOpen]);

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
        <canvas
          ref={canvasRef}
          className="stage-canvas"
          onClick={toggleControls}
        />

        <div
          className={`stage-bar${controls || settingsOpen ? "" : " stage-hidden"}`}
        >
          <span className="stage-peer">
            {watching.peerId}
            {!watching.info && " · connecting…"}
          </span>
          {sharing && <span className="stage-note">· sharing your screen</span>}
          <div className="stage-actions">
            <Button variant="ghost" onClick={() => setSettingsOpen((o) => !o)}>
              Settings
            </Button>
            <Button variant="danger" onClick={stopWatching}>
              Stop
            </Button>
          </div>
        </div>

        <div
          className={`stage-scrim${settingsOpen ? "" : " stage-hidden"}`}
          onClick={() => setSettingsOpen(false)}
        />

        <div className={`stage-drawer${settingsOpen ? " stage-drawer-open" : ""}`}>
          <div className="stage-drawer-head">
            <span className="stage-drawer-title">Settings</span>
          </div>
          <div className="stage-drawer-body">
            <CastSettings />
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
