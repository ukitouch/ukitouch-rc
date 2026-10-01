import { ViewerInput, type InputHandlers, type InputMode, type ScreenMap } from "./input";
import {
  applyFullscreen,
  cancelPeerChannel,
  castStore,
  hasContext,
  setLayout,
  openPeerChannel,
  setOptionsSink,
} from "./main";
import { ViewerPicture, type CursorSpot } from "./picture";
import type { Channel, Cursor, ScreenInfo, ScreenSize } from "./yatouch";

//#region Viewer

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** The HTMLElement that the picture's own transform is applied to. */
  stage: HTMLElement;
  channel: Channel;
  /** The host's own screen size. */
  source: () => ScreenSize | undefined;
  /** Get current {@link InputMode}. */
  mode: () => InputMode;
  /** Whether currently in controlling mode. */
  control: () => boolean;
  /** Called with the {@link CursorSpot} to draw on the viewer's screen. */
  onCursor?: (spot: CursorSpot | null) => void;
}

/** Bring up the picture and its input, and wire them to each other's events. */
export function createViewer(options: ViewerOptions): InputHandlers {
  const { canvas, stage, channel, source, mode, control, onCursor } = options;
  const picture = new ViewerPicture({ canvas, stage, source, onCursor });

  const map: ScreenMap = {
    toHost: (clientX, clientY, clamp) => picture.toHost(clientX, clientY, clamp),
    hostDelta: (from, to) => picture.hostDelta(from, to),
    clampHost: (p) => picture.clampHost(p),
    cursor: () => picture.cursor,
    center: () => picture.center(),
  };
  const input = new ViewerInput({ channel, map, mode, control });

  // Handle picture updating events emitted by input side.
  input.on("begin", () => picture.begin());
  input.on("pan", ({ from, to }) => picture.drag(from, to));
  input.on("zoom", ({ from, to, factor }) => picture.zoom(from, to, factor));
  input.on("cursor", (at) => picture.host(at));

  const stop = new AbortController();

  // Re-apply picture after displaying area resized.
  picture.addEventListener(
    "resize",
    () => {
      if (input.interacting) return;
      picture.refresh();
    },
    { signal: stop.signal }
  );

  canvas.addEventListener("wheel", (e) => input.onWheel(e), {
    signal: stop.signal,
    passive: false,
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault(), stop);
  canvas.addEventListener("blur", () => input.releaseKeys(), stop);
  canvas.addEventListener("keydown", (e) => input.onKey(e, true), stop);
  canvas.addEventListener("keyup", (e) => input.onKey(e, false), stop);

  return {
    onPointerDown: input.onPointerDown,
    onPointerMove: input.onPointerMove,
    onPointerUp: input.onPointerUp,
    onPointerCancel: input.onPointerCancel,
    dispose() {
      stop.abort();
      picture.dispose();
      input.dispose();
    },
  };
}

//#endregion
//#region Session

/** The viewer. */
interface CastViewer {
  resize(width: number, height: number): void;
  draw(tiles: StreamTile[]): void;
}

let viewer: CastViewer | null = null;

export function setViewer(v: CastViewer | null): void {
  viewer = v;
}

/** Where the peer's cursor image will be drawn. */
type CursorSink = (cursor: PeerCursor | null) => void;

let cursorSink: CursorSink | null = null;

export function setCursorSink(sink: CursorSink | null): void {
  cursorSink = sink;
}

/** The opened channel to watch a peer. */
let watchChannel: Channel | null = null;
/** A sequence number for the watch channel, to make sure only one channel alive. */
let watchSeq = 0;
/** Whether the chosen resolution has been put to this peer yet. */
let sized = false;
/** A frame being reassembled from its chunks. */
let pendingFrame: PendingFrame | null = null;

/** Reset viewer state and put the layout back. */
function clearWatching(): void {
  pendingFrame = null;
  sized = false;
  cursorSink?.(null);
  setOptionsSink(null);
  castStore.set({ connection: { status: "idle" } });
  setLayout(false);
  void applyFullscreen(false);
}

/**
 * Connect to a peer and request a cast.
 * 
 * @param target the peer's ID/UUID
 * @param label the peer's display name
 */
export async function requestWatch(target: string, label: string): Promise<void> {
  if (!hasContext()) return;
  watchChannel?.close();
  watchChannel = null;
  const seq = ++watchSeq;
  castStore.set({
    connection: { status: "connecting", peerId: target, label },
    error: null,
  });

  try {
    const channel = await openPeerChannel(target);
    if (seq !== watchSeq) {
      channel.close();
      return;
    }

    // bind the viewer and store the status
    watchChannel = channel;
    sized = false;
    bindViewer(channel);
    setOptionsSink(sendOptions);
    sendOptions();
    castStore.set({
      connection: { status: "connected", peerId: target, label, info: null },
    });
    setLayout(true);
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
  void cancelPeerChannel();
  watchChannel?.close();
  watchChannel = null;
  castStore.set({ connection: { status: "idle" } });
}

/** Stop watching. */
export function stopWatching(): void {
  watchSeq++;
  watchChannel?.close();
  watchChannel = null;
  clearWatching();
}

//#endregion
//#region Stream

/** Build the picture/input pair for the current watch, or null when not watching. */
export function attachViewer(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  onCursor: (spot: CursorSpot | null) => void
): InputHandlers | null {
  if (!watchChannel) return null;
  return createViewer({
    canvas,
    stage,
    channel: watchChannel,
    source: sourceSize,
    mode: () => castStore.get().settings.inputMode,
    control: () => castStore.get().settings.mode === "control",
    onCursor,
  });
}

/** The host screen's own size. */
function sourceSize(): ScreenSize | undefined {
  const { connection } = castStore.get();
  return connection.status === "connected"
    ? connection.info?.source
    : undefined;
}

/** What the peer should do with its cursor in the stream, see {@link Cursor} */
function streamCursor(): Cursor {
  const { mode, inputMode, cursor } = castStore.get().settings;
  if (mode === "control") return inputMode === "cursor" ? "raw" : "composite";
  return cursor ? "composite" : "off";
}

/** Send capture options to the host. */
function sendOptions(): void {
  if (!watchChannel) return;

  const { height } = castStore.get().settings;
  const source = sourceSize();
  const scale = height && source ? Math.min(1, height / source.height) : 1;
  watchChannel.send(
    JSON.stringify({ cast: { cursor: streamCursor(), resolutionScale: scale } })
  );
}

/** Reassemble the frame stream arriving on the channel we opened. */
function bindViewer(channel: Channel): void {
  channel.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      // data type: screen info
      const screen = parseScreen(ev.data);
      if (screen) {
        pendingFrame = null;
        const c = castStore.get().connection;
        if (c.status === "connected") {
          castStore.set({ connection: { ...c, info: screen } });
        }

        viewer?.resize(screen.width, screen.height);
        if (!sized && screen.source) {
          sized = true;
          sendOptions();
        }
        return;
      }

      // data type: cursor image
      const cursor = parseCursor(ev.data);
      if (cursor) {
        cursorSink?.(cursor);
        return;
      }

      // data type: a frame
      const frame = parseFrame(ev.data);
      if (frame) {
        pendingFrame = { rects: frame.rects, total: frame.total, chunks: [], have: 0 };
      }
      return;
    }

    // handle a frame
    if (!pendingFrame) return;
    const bytes = toBytes(ev.data);
    pendingFrame.chunks.push(bytes);
    pendingFrame.have += bytes.byteLength;

    if (pendingFrame.have < pendingFrame.total) return;
    const tiles = assemble(pendingFrame);
    pendingFrame = null;
    viewer?.draw(tiles);
  };

  channel.onclose = () => {
    if (watchChannel !== channel) return;
    watchChannel = null;
    clearWatching();
  };
}

//#endregion
//#region Protocol

/** One WebP rectangle from a stream. */
export interface StreamTile {
  x: number;
  y: number;
  width: number;
  height: number;
  /** WebP bytes. */
  data: Uint8Array;
}

/** The peer's cursor image. */
export interface PeerCursor {
  width: number;
  height: number;
  xhot: number;
  yhot: number;
  /** premultiplied RGBA */
  pixels: Uint8Array;
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
interface PendingFrame {
  rects: FrameRect[];
  total: number;
  chunks: Uint8Array[];
  have: number;
}

/** Split a frame's concatenated WebPs back out by their lengths. */
function assemble(p: PendingFrame): StreamTile[] {
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

/** Parse a screen info message. */
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

/** Parse a frame's rectangles and total length. */
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

/** Read the peer's cursor image off the stream. */
function parseCursor(text: string): PeerCursor | null {
  try {
    const parsed = JSON.parse(text) as {
      cursor?: {
        width?: unknown;
        height?: unknown;
        xhot?: unknown;
        yhot?: unknown;
        data?: unknown;
      };
    };

    const c = parsed.cursor;
    if (
      typeof c?.width === "number" &&
      typeof c.height === "number" &&
      typeof c.xhot === "number" &&
      typeof c.yhot === "number" &&
      typeof c.data === "string"
    ) {
      return {
        width: c.width,
        height: c.height,
        xhot: c.xhot,
        yhot: c.yhot,
        pixels: fromBase64(c.data),
      };
    }
  } catch {
    // not ours
  }
  return null;
}

/** Decode a base64 string into bytes. */
function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Convert a value into bytes. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}

//#endregion
