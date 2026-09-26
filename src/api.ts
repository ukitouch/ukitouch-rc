import {
  createStore,
  getHostPlatform,
  setFullscreen,
  startScreenStream,
} from "./host";
import type {
  Channel,
  DeviceRecord,
  ExtensionContext,
  HostPlatform,
  ScreenInfo,
  ScreenSize,
  ScreenStream,
  StreamOptions,
} from "./yatouch";

/** What Cast does, changeable while it runs. */
export interface CastSettings {
  /** Viewer side: show the peer's pointer in the stream. */
  cursor: boolean;
  /** Viewer side: height to ask for, `null` for the peer's own. */
  height: number | null;
}

/** The connection status. */
export type Connection =
  | { status: "idle" }
  | { status: "connecting"; peerId: string }
  | { status: "connected"; peerId: string; info: ScreenInfo | null };

export interface CastState {
  devices: DeviceRecord[];
  /** The connection status of the viewer side. */
  connection: Connection;
  /** Host side: shape of the screen we are sending out. */
  sharing: ScreenInfo | null;
  settings: CastSettings;
  platform: HostPlatform | null;
  error: string | null;
}

/** Where this extension keeps its own settings. */
const SETTINGS_KEY = "yatouch.cast.settings";

const DEFAULTS: CastSettings = { cursor: true, height: null };

/** Read back what was chosen last time, ignoring anything unrecognizable. */
function loadSettings(): CastSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as
      | Partial<CastSettings>
      | null;
    return {
      cursor: typeof saved?.cursor === "boolean" ? saved.cursor : DEFAULTS.cursor,
      height: typeof saved?.height === "number" ? saved.height : DEFAULTS.height,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const castStore = createStore<CastState>({
  devices: [],
  connection: { status: "idle" },
  sharing: null,
  settings: loadSettings(),
  platform: null,
  error: null,
});

/** One WebP rectangle from a stream, positioned in screen coordinates. */
export interface StreamTile {
  x: number;
  y: number;
  width: number;
  height: number;
  /** WebP bytes. */
  data: Uint8Array;
}

/** Where incoming frames land; the view puts its canvas here. */
export interface CastViewer {
  resize(width: number, height: number): void;
  draw(tiles: StreamTile[]): void;
}

let viewer: CastViewer | null = null;

export function setViewer(v: CastViewer | null): void {
  viewer = v;
}

let ctx: ExtensionContext | null = null;
/** Viewer side: the channel we opened to watch a peer. */
let watchChannel: Channel | null = null;
/** Guards a connect in flight so a stale one cannot clobber a newer one. */
let watchSeq = 0;
/** Whether the chosen resolution has been put to this peer yet. */
let sized = false;
/** Host side: the single peer we are streaming to. */
let share: { channel: Channel; stream: ScreenStream } | null = null;
/** A frame being reassembled from its chunks. */
let pending: Pending | null = null;

export function initCast(context: ExtensionContext): void {
  ctx = context;
  castStore.set({ devices: context.getKnownDevices() });
  context.subscriptions.push(
    context.onDeviceSeen((devices) => castStore.set({ devices })),
    // The channel arriving *is* the request: one-to-one, serve it right away.
    context.onChannel(serve)
  );
  void getHostPlatform().then((platform) => castStore.set({ platform }));
}

/** Raise the sidebar-free layout while watching. The shell restores it. */
function layout(watching: boolean): void {
  ctx?.setLayout(watching ? "fullscreen" : "withSidebar");
}

/** Reset viewer state and put the layout back. */
function clearWatching(): void {
  pending = null;
  sized = false;
  castStore.set({ connection: { status: "idle" } });
  layout(false);
  void applyFullscreen(false);
}

/** Whether we currently hold the window in fullscreen for a watch. */
let fullscreenOn = false;

/** Android only: hold the window in fullscreen, or hand it back. */
async function applyFullscreen(on: boolean): Promise<void> {
  if (on === fullscreenOn) return;
  if (on && castStore.get().platform !== "android") return;
  fullscreenOn = on;
  try {
    await setFullscreen(on);
  } catch (err) {
    castStore.set({ error: String(err) });
  }
}

//#region Viewer side

/** Ask `target` to stream its screen to us. */
export async function watch(target: string, label: string): Promise<void> {
  if (!ctx) return;
  watchChannel?.close();
  watchChannel = null;
  const seq = ++watchSeq;
  castStore.set({
    connection: { status: "connecting", peerId: label },
    error: null,
  });
  try {
    const channel = await ctx.openChannel({ transport: "webrtc", target });
    if (seq !== watchSeq) {
      channel.close();
      return;
    }
    watchChannel = channel;
    sized = false;
    bindViewer(channel);
    sendOptions();
    castStore.set({
      connection: { status: "connected", peerId: label, info: null },
    });
    layout(true);
    void applyFullscreen(true);
  } catch (err) {
    if (seq !== watchSeq) return;
    castStore.set({
      connection: { status: "idle" },
      error: `connect failed: ${String(err)}`,
    });
  }
}

/** Abort a connect that has not landed yet. */
export function cancelWatch(): void {
  watchSeq++;
  void ctx?.cancelOpenChannel().catch(() => { });
  watchChannel?.close();
  watchChannel = null;
  castStore.set({ connection: { status: "idle" } });
}

/** Stop watching and drop the layout back to the sidebar. */
export function stopWatching(): void {
  watchSeq++;
  watchChannel?.close();
  watchChannel = null;
  clearWatching();
}

/** The watched screen's own size, once it has told us. */
function sourceSize(): ScreenSize | undefined {
  const { connection } = castStore.get();
  return connection.status === "connected"
    ? connection.info?.source
    : undefined;
}

/** Tell the host what the stream should contain. */
function sendOptions(): void {
  if (!watchChannel) return;
  const { cursor, height } = castStore.get().settings;
  const source = sourceSize();
  // The source is only known once the first frame arrives, so the height is
  // held as a height rather than as a fraction of something we cannot see yet.
  const scale = height && source ? Math.min(1, height / source.height) : 1;
  watchChannel.send(JSON.stringify({ cast: { cursor, resolutionScale: scale } }));
}

/** Reassemble the frame stream arriving on the channel we opened. */
function bindViewer(channel: Channel): void {
  channel.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const screen = parseScreen(ev.data);
      if (screen) {
        pending = null;
        const c = castStore.get().connection;
        if (c.status === "connected") {
          castStore.set({ connection: { ...c, info: screen } });
        }
        viewer?.resize(screen.width, screen.height);
        // Now that the peer's own size is known, the resolution we want it to
        // send can actually be worked out.
        if (!sized && screen.source) {
          sized = true;
          sendOptions();
        }
        return;
      }
      const frame = parseFrame(ev.data);
      if (frame) {
        pending = { rects: frame.rects, total: frame.total, chunks: [], have: 0 };
      }
      return;
    }

    if (!pending) return;
    const bytes = toBytes(ev.data);
    pending.chunks.push(bytes);
    pending.have += bytes.byteLength;
    if (pending.have < pending.total) return;
    const tiles = assemble(pending);
    pending = null;
    viewer?.draw(tiles);
  };

  channel.onclose = () => {
    if (watchChannel !== channel) return;
    watchChannel = null;
    clearWatching();
  };
}

//#endregion
//#region Host side

/** A peer opened a "cast" channel: send it our screen. */
async function serve(channel: Channel): Promise<void> {
  if (share) {
    // One-to-one: a second viewer gets nothing.
    channel.close();
    return;
  }
  let closed = false;
  channel.onclose = () => {
    closed = true;
    if (share?.channel === channel) stopSharing();
  };

  // The viewer owns what its stream contains and says so as soon as the channel
  // is up. Anything it sends after that reconfigures the running stream.
  let options: StreamOptions = {};
  channel.onmessage = (ev) => {
    const next = parseRequest(ev.data);
    if (!next) return;
    options = next;
    void share?.stream.configure(options).catch(() => { });
  };

  try {
    const stream = await startScreenStream(channel, options);
    if (closed) {
      void stream.stop().catch(() => { });
      return;
    }
    share = { channel, stream };
    castStore.set({ sharing: stream.info, error: null });
    // A request that landed while the stream was starting still has to apply.y
    void stream.configure(options).catch(() => { });
  } catch (err) {
    channel.close();
    castStore.set({ error: describe(err) });
  }
}

/** Stop streaming our screen. */
export function stopSharing(): void {
  if (!share) return;
  const stopped = share;
  share = null;
  castStore.set({ sharing: null });
  void stopped.stream.stop().catch(() => { });
  stopped.channel.close();
}

/** Put a change to our own settings to the peer. */
function applySettings(patch: Partial<CastSettings>): void {
  const settings = { ...castStore.get().settings, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  castStore.set({ settings });
  sendOptions();
}

/** Show the peer's pointer in the stream we are watching. */
export function setCursor(on: boolean): void {
  applySettings({ cursor: on });
}

/** Ask the peer for a screen no taller than `height`, or its own for `null`. */
export function setResolution(height: number | null): void {
  applySettings({ height });
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
        cursor: cursor === true,
        resolutionScale:
          typeof resolutionScale === "number" ? resolutionScale : 1,
      };
    }
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

/** A rectangle's place in a frame's concatenated WebPs. */
interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  len: number;
}

/** A frame being reassembled from its chunks. */
interface Pending {
  rects: FrameRect[];
  total: number;
  chunks: Uint8Array[];
  have: number;
}

/** Split a frame's concatenated WebPs back out by their lengths. */
function assemble(p: Pending): StreamTile[] {
  const blob = new Uint8Array(p.total);
  let off = 0;
  for (const part of p.chunks) {
    blob.set(part, off);
    off += part.byteLength;
  }
  let cursor = 0;
  return p.rects.map((r) => {
    const tile: StreamTile = {
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      data: blob.subarray(cursor, cursor + r.len),
    };
    cursor += r.len;
    return tile;
  });
}

function parseScreen(text: string): ScreenInfo | null {
  try {
    const parsed = JSON.parse(text) as {
      screen?: {
        width?: number;
        height?: number;
        source?: { width?: number; height?: number };
      };
    };
    const { width, height, source } = parsed.screen ?? {};
    if (typeof width === "number" && typeof height === "number") {
      const info: ScreenInfo = { width, height, format: "rgba" };
      if (typeof source?.width === "number" && typeof source.height === "number") {
        info.source = { width: source.width, height: source.height };
      }
      return info;
    }
  } catch {
    // not ours
  }
  return null;
}

function parseFrame(text: string): { rects: FrameRect[]; total: number } | null {
  try {
    const parsed = JSON.parse(text) as { frame?: FrameRect[]; total?: number };
    if (Array.isArray(parsed.frame) && typeof parsed.total === "number") {
      return { rects: parsed.frame, total: parsed.total };
    }
  } catch {
    // not ours
  }
  return null;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}
