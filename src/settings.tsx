import { React, Button, Select, SettingRow, Toggle } from "./host";
import {
  castStore,
  getSmoothPointer,
  setMode,
  setInputMode,
  setResolution,
  setShowCursor,
  setSmoothPointer,
} from "./main";
import type { ScreenSize } from "./ukitouch";

/** The entry that asks for the peer's own size. */
const SOURCE = "source";

const MODES = [
  { value: "cast", label: "Watch" },
  { value: "control", label: "Control" },
];

const INPUT_MODES = [
  { value: "cursor", label: "Cursor" },
  { value: "touch", label: "Touch" },
];

const TIERS = [
  2160, 1440, 1080, 960, 900, 720, 600, 576, 540, 480, 432, 360, 320, 288, 240, 216, 180,
  144,
];

function resolutions(source?: ScreenSize) {
  if (!source) return [{ value: SOURCE, label: "Source" }];
  return [
    { value: SOURCE, label: `${source.width}×${source.height}` },
    ...TIERS.filter((h) => h < source.height).map((h) => ({
      value: `${h}`,
      label: `${Math.round((source.width * h) / source.height)}×${h}`,
    })),
  ];
}

/** What Cast does with this peer while the watch is up. */
export function ViewerSettings({ onKeys }: { onKeys: () => void }) {
  const { settings, connection } = React.useSyncExternalStore(
    castStore.subscribe,
    castStore.get
  );
  const source =
    connection.status === "connected" ? connection.info?.source : undefined;
  const options = resolutions(source);
  const picked = settings.height === null ? SOURCE : `${settings.height}`;
  // A size this peer's screen cannot reach falls back to its own.
  const value = options.some((o) => o.value === picked) ? picked : SOURCE;

  return (
    <div className="viewer-settings">
      <SettingRow
        label="Mode"
        hint={
          settings.mode === "control"
            ? "Drive the peer, not just watch it."
            : "Watch the peer's screen."
        }
        action={
          <Select
            value={settings.mode}
            options={MODES}
            ariaLabel="Mode"
            onChange={(v) => setMode(v === "control" ? "control" : "cast")}
          />
        }
      />
      {settings.mode === "control" ? (
        <SettingRow
          label="Pointer"
          hint={
            settings.inputMode === "touch"
              ? "Tap and drag straight on the screen."
              : "Move a pointer over the screen."
          }
          action={
            <Select
              value={settings.inputMode}
              options={INPUT_MODES}
              ariaLabel="Pointer"
              onChange={(v) =>
                setInputMode(v === "touch" ? "touch" : "cursor")
              }
            />
          }
        />
      ) : (
        <SettingRow
          label="Show pointer"
          hint="Ask the peer to include its mouse cursor in the stream."
          action={
            <Button
              variant="ghost"
              onClick={() => setShowCursor(!settings.cursor)}
            >
              {settings.cursor ? "On" : "Off"}
            </Button>
          }
        />
      )}
      <SettingRow
        label="Resolution"
        hint="How much of the peer's screen to receive."
        action={
          <Select
            value={value}
            options={options}
            ariaLabel="Resolution"
            onChange={(v) => setResolution(v === SOURCE ? null : Number(v))}
          />
        }
      />
      {settings.mode === "control" && (
        <SettingRow
          label="Keys"
          hint="The buttons the control pad offers."
          action={
            <Button variant="ghost" onClick={onKeys}>
              Edit
            </Button>
          }
        />
      )}
    </div>
  );
}

/** TODO: temporary here, waiting for settings for extensions support */
export function HostSettings() {
  const [smooth, setSmooth] = React.useState(getSmoothPointer);

  return (
    <div className="host-settings">
      <SettingRow
        label="Experimental: smooth pointer"
        hint="smooth motion for the pointer, causes higher latency"
        action={
          <Toggle
            checked={smooth}
            ariaLabel="Smooth pointer"
            onChange={(on: boolean) => {
              setSmooth(on);
              setSmoothPointer(on);
            }}
          />
        }
      />
    </div>
  );
}
