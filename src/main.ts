import {
  createStore,
  getHostInfo,
  nativeCall,
  setFullscreen,
} from "./host";
import type { InputMode } from "./input";
import type {
  Channel,
  DeviceRecord,
  Disposable,
  NetContext,
  HostPlatform,
  InputEvent,
  ScreenInfo,
  Started,
  StreamOptions,
} from "./ukitouch";

//#region Settings

/** Cast only or remote control. */
export type CastMode = "cast" | "control";

/**
 * One button on the control pad.
 */
export interface PadButton {
  /** Key codes for this pad, for example ["ControlLeft", "KeyC"] */
  codes: string[];
  /** Label of the button. */
  label?: string;
}

export interface ViewerSettings {
  /** see {@link CastMode}, cast only or remote control. */
  mode: CastMode;
  /** see {@link InputMode}, cursor or touch. */
  inputMode: InputMode;
  /** Cast mode: whether ask the host to capture the cursor. */
  cursor: boolean;
  /** Height of the resolution. */
  height: number | null;
  /** The buttons the control pad offers. */
  pad: PadButton[];
}

const SETTINGS_KEY = "yatouch.viewer.settings";
const DEFAULTS: ViewerSettings = {
  mode: "cast",
  inputMode: "cursor",
  cursor: true,
  height: null,
  pad: [],
};

/** Viewer side: re-send the running watch's stream options, or null if none. */
let optionsSink: (() => void) | null = null;

/** Register an {@link optionsSink} */
export function setOptionsSink(sink: (() => void) | null): void {
  optionsSink = sink;
}

/** Read a stored pad. */
function readPad(saved: unknown): PadButton[] {
  if (!Array.isArray(saved)) return DEFAULTS.pad;

  const pad: PadButton[] = [];
  for (const entry of saved) {
    const raw = Array.isArray(entry)
      ? ({ codes: entry } as { codes?: unknown; label?: unknown })
      : (entry as { codes?: unknown; label?: unknown });
    const { codes, label } = raw;
    if (!Array.isArray(codes) || !codes.every((c) => typeof c === "string")) continue;
    pad.push({ codes, label: typeof label === "string" ? label : undefined });
  }
  return pad;
}

function loadSettings(): ViewerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as
      | Partial<ViewerSettings>
      | null;
    const pad = saved?.pad;
    return {
      mode: saved?.mode === "control" ? "control" : "cast",
      inputMode: saved?.inputMode === "touch" ? "touch" : "cursor",
      cursor: typeof saved?.cursor === "boolean" ? saved.cursor : DEFAULTS.cursor,
      height: typeof saved?.height === "number" ? saved.height : DEFAULTS.height,
      pad: readPad(pad),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Put a change to our own settings to the peer. */
function applySettings(patch: Partial<ViewerSettings>): void {
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

/** Replace the control pad's buttons. */
export function setPad(pad: PadButton[]): void {
  applySettings({ pad });
}

//#endregion
//#region State

let ctx: NetContext | null = null;

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
  settings: ViewerSettings;
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

export function initCast(context: NetContext): void {
  ctx = context;
  castStore.set({ devices: context.getKnownDevices() });
  context.subscriptions.push(
    context.onDeviceSeen((devices) => castStore.set({ devices })),
    context.onChannel(serve)
  );
  void getHostInfo().then((i) => castStore.set({ platform: i.platform }));
}

//#endregion
//#region Layout

/** Host side: the single peer we are streaming to. */
let share: { channel: Channel; id: number; pipe: Disposable } | null = null;
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

interface HostSettings {
  /** Experimental: smooth motion for the pointer. */
  smooth: boolean;
}

const HOST_SETTINGS_KEY = "yatouch.host.settings";
const HOST_DEFAULTS: HostSettings = { smooth: false };

function loadHostSettings(): HostSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_SETTINGS_KEY) ?? "{}") as
      | Partial<HostSettings>
      | null;
    return {
      smooth:
        typeof saved?.smooth === "boolean" ? saved.smooth : HOST_DEFAULTS.smooth,
    };
  } catch {
    return { ...HOST_DEFAULTS };
  }
}

let hostSettings: HostSettings = loadHostSettings();

/** Experimental: smooth motion for the pointer. */
export function getSmoothPointer(): boolean {
  return hostSettings.smooth;
}

/** Experimental: smooth motion for the pointer. */
export function setSmoothPointer(on: boolean): void {
  hostSettings = { ...hostSettings, smooth: on };
  localStorage.setItem(HOST_SETTINGS_KEY, JSON.stringify(hostSettings));
  if (injecting) {
    void nativeCall("ukitouch.input", "input_configure", {
      options: { smooth: on },
    }).catch(() => { });
  }
}

/** Host side: batches are injected in order. */
let injectChain: Promise<unknown> = Promise.resolve();
/** Whether the peer's input backend is up. */
let injecting = false;

/** Drive the peer with a viewer's input batch. */
function drive(batch: InputEvent[]): void {
  injectChain = injectChain
    .then(async () => {
      if (!injecting) {
        const { smooth } = hostSettings;
        await nativeCall("ukitouch.input", "input_start", {
          options: { smooth },
        }).catch(() => nativeCall("ukitouch.input", "input_start"));
        injecting = true;
      }
      await nativeCall("ukitouch.input", "input_inject", { events: batch });
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
      if (injecting) await nativeCall("ukitouch.input", "input_release");
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
    if (share?.channel === channel) stop();
  };

  let options: StreamOptions = {};
  channel.onmessage = (ev) => {
    // data type: capture options
    const next = parseRequest(ev.data);
    if (next) {
      options = next;
      configure(options);
      return;
    }

    // data type: input
    const batch = parseInput(ev.data);
    if (batch) drive(batch);
  };

  let started: Started | null = null;
  try {
    started = await nativeCall<Started>("ukitouch.capture", "start_screen_stream", {
      options,
    });
    if (closed) {
      void stopStream(started.id);
      return;
    }

    const pipe = await ctx!.bindPipe(channel, started.addr);
    if (closed) {
      pipe.dispose();
      void stopStream(started.id);
      return;
    }

    share = { channel, id: started.id, pipe };
    castStore.set({
      screenInfo: { width: started.width, height: started.height },
      error: null,
    });

    // A request that landed while the stream was starting still has to apply.
    configure(options);
  } catch (err) {
    if (started) void stopStream(started.id);
    channel.close();
    castStore.set({ error: describe(err) });
  }
}

/** Put the latest capture options to the running stream. */
function configure(options: StreamOptions): void {
  if (!share) return;
  void nativeCall("ukitouch.capture", "stream_configure", {
    id: share.id,
    options,
  }).catch(() => { });
}

/** Stop a stream. */
async function stopStream(id: number): Promise<unknown> {
  return nativeCall("ukitouch.capture", "stop_screen_stream", { id }).catch(
    () => { }
  );
}

/** Host side: stop and close the channel. */
export function stop(): void {
  if (!share) return;
  const stopped = share;
  share = null;
  castStore.set({ screenInfo: null });
  stopped.pipe.dispose();
  void stopStream(stopped.id);
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
