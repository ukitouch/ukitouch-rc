import { React, Button, Select, SettingRow } from "./host";
import { castStore, setCursor, setResolution } from "./api";
import type { HostPlatform, ScreenSize } from "./yatouch";

/** The entry that asks for the peer's own size. */
const SOURCE = "source";

/** One switchable option, and the hosts that expose it. */
interface Toggle {
  label: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
  /** Absent means every host. */
  platform?: HostPlatform;
}

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

/**
 * The switches Cast exposes, filtered to what this host can do.
 */
export function CastSettings() {
  const { settings, platform, connection } = React.useSyncExternalStore(
    castStore.subscribe,
    castStore.get
  );
  const toggles: Toggle[] = [
    {
      label: "Show pointer",
      hint: "Ask the peer to include its mouse cursor in the stream.",
      on: settings.cursor,
      onChange: setCursor,
    },
  ];
  const shown = toggles.filter((t) => !t.platform || t.platform === platform);
  const source =
    connection.status === "connected" ? connection.info?.source : undefined;
  const options = resolutions(source);
  const picked = settings.height === null ? SOURCE : `${settings.height}`;
  // A size this peer's screen cannot reach falls back to its own.
  const value = options.some((o) => o.value === picked) ? picked : SOURCE;

  return (
    <div className="cast-settings">
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
      {shown.map((t) => (
        <SettingRow
          key={t.label}
          label={t.label}
          hint={t.hint}
          action={
            <Button variant="ghost" onClick={() => t.onChange(!t.on)}>
              {t.on ? "On" : "Off"}
            </Button>
          }
        />
      ))}
    </div>
  );
}
