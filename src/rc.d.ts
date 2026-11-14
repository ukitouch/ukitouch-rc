/** A pixel size. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** Screen dimensions and pixel layout. */
export interface ScreenInfo {
  width: number;
  height: number;
  /** The screen's own size, will be affected by resolution on the host side. */
  source?: ScreenSize;
}

/** A changed rectangle, in screen pixels. */
export interface Damage {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How the cursor appears in the stream.
 * 
 * - `"off"` - the cursor is not sent
 * - `"composite"` - the cursor is captured into the picture
 * - `"raw"` - the cursor's image was sent, and should be drawn by viewer itself
 */
export type Cursor = "off" | "composite" | "raw";

/** What a caller can ask of a screen source. */
export interface CaptureOptions {
  /** How the pointer appears in the stream. */
  cursor?: Cursor;
}

/** What a caller can ask of a stream. */
export interface StreamOptions extends CaptureOptions {
  /** Fraction of the screen to send, up to 1. */
  resolutionScale?: number;
}

/** A started native capture stream. */
export interface Started {
  id: number;
  /** Shape of the frames the sidecar sends. */
  width: number;
  height: number;
  /** Loopback address to bridge into the channel. */
  addr: string;
}

/** A point. */
export interface Point {
  x: number;
  y: number;
}

/** A pointer button. */
export type MouseButton = "left" | "middle" | "right" | "back" | "forward";

/** A synthesized input event, in screen pixels. */
export type InputEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; at?: Point; button: MouseButton; pressed: boolean }
  | { kind: "scroll"; at?: Point; dx: number; dy: number }
  | { kind: "key"; code: string; pressed: boolean }
  | { kind: "text"; text: string };
