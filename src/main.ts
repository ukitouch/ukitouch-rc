import {
  createStore,
  getHostPlatform,
  injectInput,
  releaseInput,
  setFullscreen,
  startInput,
  startScreenStream,
} from "./host";
import type { InputMode } from "./input";
import type {
  Channel,
  Cursor,
  DeviceRecord,
  ExtensionContext,
  HostPlatform,
  InputEvent,
  ScreenInfo,
  ScreenStream,
  StreamOptions,
} from "./yatouch";

//#region Settings

/** Cast only or remote control. */
export type CastMode = "cast" | "control";

export interface CastSettings {
  /** see {@link CastMode}, cast only or remote control. */
  mode: CastMode;
  /** see {@link InputMode}, cursor or touch. */
  inputMode: InputMode;
  /** Cast mode: whether ask the host to capture the cursor. */
  cursor: boolean;
  /** Height of the resolution. */
  height: number | null;
}

const SETTINGS_KEY = "yatouch.cast.settings";
const DEFAULTS: CastSettings = {
  mode: "cast",
  inputMode: "cursor",
  cursor: true,
  height: null,
};

/** Viewer side: re-send the running watch's stream options, or null if none. */
let optionsSink: (() => void) | null = null;

/** Register an {@link optionsSink} */
export function setOptionsSink(sink: (() => void) | null): void {
  optionsSink = sink;
}

function loadSettings(): CastSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as
      | Partial<CastSettings>
      | null;
    return {
      mode: saved?.mode === "control" ? "control" : "cast",
      inputMode: saved?.inputMode === "touch" ? "touch" : "cursor",
      cursor: typeof saved?.cursor === "boolean" ? saved.cursor : DEFAULTS.cursor,
      height: typeof saved?.height === "number" ? saved.height : DEFAULTS.height,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Put a change to our own settings to the peer. */
function applySettings(patch: Partial<CastSettings>): void {
  const settings = { ...castStore.get().settings, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  castStore.set({ settings });
  optionsSink?.();
}

/** Whether the viewer only watches the peer or also drives it. */
export function setMode(mode: CastMode): void {
  applySettings({ mode });
}

/** set {@link InputMode}. */
export function setInputMode(inputMode: InputMode): void {
  applySettings({ inputMode });
}

/** Ask the peer to draw its cursor into the stream (cast mode). */
export function setShowCursor(on: boolean): void {
  applySettings({ cursor: on });
}

/** Ask the peer for a screen no taller than `height`, or its own for `null`. */
export function setResolution(height: number | null): void {
  applySettings({ height });
}

//#endregion
//#region State

let ctx: ExtensionContext | null = null;

/** The connection status. */
export type Connection =
  | { status: "idle" }
  | { status: "connecting"; peerId: string; label: string }
  | { status: "connected"; peerId: string; label: string; info: ScreenInfo | null };

export interface CastState {
  devices: DeviceRecord[];
  /** Viewer side: the connection status. */
  connection: Connection;
  /** Host side: shape of the screen. */
  screenInfo: ScreenInfo | null;
  settings: CastSettings;
  platform: HostPlatform | null;
  error: string | null;
}

export const castStore = createStore<CastState>({
  devices: [],
  connection: { status: "idle" },
  screenInfo: null,
  settings: loadSettings(),
  platform: null,
  error: null,
});

/** Whether the extension is up, and a peer channel can be opened. */
export function hasContext(): boolean {
  return ctx !== null;
}

/** Open a channel to a peer. */
export function openPeerChannel(target: string): Promise<Channel> {
  return ctx!.openChannel({ transport: "webrtc", target });
}

/** Abort a connect that has not landed yet. */
export function cancelPeerChannel(): Promise<void> {
  return ctx ? ctx.cancelOpenChannel().catch(() => { }) : Promise.resolve();
}

export function initCast(context: ExtensionContext): void {
  ctx = context;
  castStore.set({ devices: context.getKnownDevices() });
  context.subscriptions.push(
    context.onDeviceSeen((devices) => castStore.set({ devices })),
    context.onChannel(serve)
  );
  void getHostPlatform().then((platform) => castStore.set({ platform }));
}

//#endregion
//#region Layout

/** Host side: the single peer we are streaming to. */
let share: { channel: Channel; stream: ScreenStream } | null = null;
/** Whether we currently hold the window in fullscreen for a watch. */
let fullscreenOn = false;

/**
 * Set layout depends on watching or sharing.
 * 
 * @param watching true will be in fullscreen layout
 */
export function setLayout(watching: boolean): void {
  ctx?.setLayout(watching ? "fullscreen" : "withSidebar");
}

/** Android only: hold the window in fullscreen (landscape + immersive). */
export async function applyFullscreen(on: boolean): Promise<void> {
  if (on === fullscreenOn) return;
  if (on && castStore.get().platform !== "android") return;
  fullscreenOn = on;

  try {
    await setFullscreen(on);
  } catch (err) {
    castStore.set({ error: String(err) });
  }
}

//#endregion
//#region Host side

/** Host side: batches are injected in order. */
let injectChain: Promise<unknown> = Promise.resolve();
/** Whether the peer's input backend is up. */
let injecting = false;

/** Drive the peer with a viewer's input batch. */
function drive(batch: InputEvent[]): void {
  injectChain = injectChain
    .then(async () => {
      if (!injecting) {
        await startInput();
        injecting = true;
      }
      await injectInput(batch);
    })
    .catch((err) => {
      injecting = false;
      castStore.set({ error: String(err) });
    });
}

/** Let go of everything the viewer left pressed. */
function releaseInputs(): void {
  injectChain = injectChain
    .then(async () => {
      if (injecting) await releaseInput();
    })
    .catch(() => { });
}

/** Share the screen. */
async function serve(channel: Channel): Promise<void> {
  if (share) {
    // Close the other channels since RC should be one-to-one.
    channel.close();
    return;
  }

  let closed = false;
  channel.onclose = () => {
    closed = true;
    releaseInputs();
    if (share?.channel === channel) stopSharing();
  };

  let options: StreamOptions = {};
  channel.onmessage = (ev) => {
    // data type: capture options
    const next = parseRequest(ev.data);
    if (next) {
      options = next;
      void share?.stream.configure(options).catch(() => { });
      return;
    }

    // data type: input
    const batch = parseInput(ev.data);
    if (batch) drive(batch);
  };

  try {
    const stream = await startScreenStream(channel, options);
    if (closed) {
      void stream.stop().catch(() => { });
      return;
    }
    share = { channel, stream };
    castStore.set({ screenInfo: stream.info, error: null });

    // A request that landed while the stream was starting still has to apply.
    void stream.configure(options).catch(() => { });
  } catch (err) {
    channel.close();
    castStore.set({ error: describe(err) });
  }
}

/** Stop streaming. */
export function stopSharing(): void {
  if (!share) return;
  const stopped = share;
  share = null;
  castStore.set({ screenInfo: null });
  void stopped.stream.stop().catch(() => { });
  stopped.channel.close();
}

/** Read a viewer's options off the channel. */
function parseRequest(data: unknown): StreamOptions | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as {
      cast?: { cursor?: unknown; resolutionScale?: unknown };
    };
    if (parsed.cast) {
      const { cursor, resolutionScale } = parsed.cast;
      return {
        cursor: cursor === "off" || cursor === "composite" || cursor === "raw" ? cursor : "off",
        resolutionScale:
          typeof resolutionScale === "number" ? resolutionScale : 1,
      };
    }
  } catch {
    // not ours
  }
  return null;
}

/** Read a viewer's input batch off the channel. */
function parseInput(data: unknown): InputEvent[] | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { input?: unknown };
    if (Array.isArray(parsed.input)) return parsed.input as InputEvent[];
  } catch {
    // not ours
  }
  return null;
}

//#endregion

/** Turn a capture failure from the host into something worth showing. */
function describe(err: unknown): string {
  const m = String(err).toLowerCase();
  if (m.includes("denied")) return "Screen capture was denied";
  if (m.includes("cancel")) return "Screen capture was cancelled";
  if (m.includes("unsupported")) return "This platform can't share its screen yet";
  return String(err);
}
