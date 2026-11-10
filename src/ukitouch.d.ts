import type { ComponentType, PointerEvent as ReactPointerEvent, ReactNode } from "react";

/** A handle that can be released to free a subscription or listener. */
export interface Disposable {
  dispose(): void;
}

/** Host platforms, matched against an extension's platform matrix. */
export type HostPlatform = "windows" | "linux" | "android";

/** Shell layout an extension can request via `setLayout`. */
export type Layout = "withSidebar" | "fullscreen";

/** Host system info reported by the hello handshake. */
export interface HostInfo {
  name: string | null;
  platform: HostPlatform | null;
  os: string | null;
}

/** A bidirectional data channel over some transport. */
export interface Channel {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  /**
   * Bridge a loopback TCP address into this channel.
   */
  bindPipe?(addr: string): Promise<Disposable>;
}

/** WebRTC transport open spec. */
export interface WebRtcOpenSpec {
  transport: "webrtc";
  /** The other device's id (uuid or temp id). */
  target: string;
  reliable?: boolean;
}

/** USB transport open spec. */
export interface UsbOpenSpec {
  transport: "usb";
  serial?: string;
}

/** Bluetooth transport open spec (not yet implemented). */
export interface BleOpenSpec {
  transport: "ble";
}

/** Everything an extension needs to open a channel over a transport. */
export type OpenSpec = WebRtcOpenSpec | UsbOpenSpec | BleOpenSpec;

/** Device profile from the device store. `uuid` is internal; never show it. */
export interface DeviceRecord {
  uuid: string;
  name: string | null;
  remark: string | null;
  platform: string | null;
  os: string | null;
  firstSeen: number;
  lastSeen: number | null;
  protocol: string | null;
}

/** USB device reported by the backend. */
export interface UsbDevice {
  serial: string;
  state: string;
}

/**
 * API the host hands to an extension's logic layer (`activate`).
 */
export interface NetContext {
  readonly subscriptions: Disposable[];
  setLayout(layout: Layout): void;
  openChannel(request: OpenSpec): Promise<Channel>;
  onChannel(handler: (channel: Channel) => void): Disposable;
  /** Bridge a sidecar's loopback pipe into an opened channel. */
  bindPipe(channel: Channel, addr: string): Promise<Disposable>;
  cancelOpenChannel(): Promise<void>;
  getKnownDevices(): DeviceRecord[];
  onDeviceSeen(handler: (devices: DeviceRecord[]) => void): Disposable;
}

/** Minimal in-memory store. */
export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(cb: () => void): () => void;
}

export type ToastKind = "info" | "error";

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

/** Where a `PinchArea`'s content sits after a gesture, in area pixels. */
export interface PinchTransform {
  scale: number;
  x: number;
  y: number;
}

/** What an extension declares. */
export interface ExtensionDefinition {
  title?: string;
  icon?: ReactNode;
  platforms?: HostPlatform[];
  activate?: (ctx: NetContext) => void | (() => void);
  component?: ComponentType;
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

/** The runtime surface exposed on `window.ukitouch`. */
export interface UkitouchRuntime {
  React: typeof import("react");
  components: {
    Select: ComponentType<{
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
      className?: string;
      ariaLabel?: string;
    }>;
    SearchSelect: ComponentType<{
      /** Input text (controlled). Doubles as the free-text value. */
      text: string;
      /** Id of the picked option, or null for a free-text value. */
      selectedId: string | null;
      options: readonly { id: string; label: string; hint?: string }[];
      onTextChange: (text: string) => void;
      onSelect: (option: { id: string; label: string; hint?: string }) => void;
      /** Enables the free-text "create new" row. */
      onCreate?: (query: string) => void;
      placeholder?: string;
      emptyText?: string;
      createLabel?: string;
      className?: string;
    }>;
    /** p2p peer picker: searches known devices, optionally dials a temp id. */
    PeerDeviceSearch: ComponentType<{
      devices: readonly DeviceRecord[];
      selectedUuid: string | null;
      text: string;
      onTextChange: (text: string) => void;
      onSelect: (uuid: string, label: string) => void;
      onCreate?: (query: string) => void;
      className?: string;
      placeholder?: string;
    }>;
    Button: ComponentType<{
      variant?: "primary" | "ghost" | "danger";
      className?: string;
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }>;
    Toggle: ComponentType<{
      checked: boolean;
      onChange: (checked: boolean) => void;
      ariaLabel: string;
      disabled?: boolean;
      className?: string;
    }>;
    SettingRow: ComponentType<{
      label: ReactNode;
      action?: ReactNode;
      hint?: ReactNode;
      children?: ReactNode;
    }>;
    PageHeader: ComponentType<{ title: ReactNode; subtitle?: ReactNode }>;
    SectionHeader: ComponentType<{
      children?: ReactNode;
      action?: ReactNode;
      onClick?: () => void;
      open?: boolean;
    }>;
    /** pinch-to-zoom and pan surface */
    PinchArea: ComponentType<{
      min?: number;
      max?: number;
      onCommit?: (t: PinchTransform) => void;
      className?: string;
      children?: ReactNode;
      // Take over pointer handling.
      onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
    }>;
  };
  defineExtension(def: ExtensionDefinition): void;
  getHostInfo(): Promise<HostInfo>;
  /** Hold the app fullscreen (Android only). */
  setFullscreen(on: boolean): Promise<void>;
  refreshUsbDevices(): Promise<void>;
  usbStore: Store<{ devices: UsbDevice[] }>;
  createStore<T extends object>(initial: T): Store<T>;
  /** Call a method on a native extension. */
  nativeCall<T = unknown>(
    extId: string,
    method: string,
    payload?: unknown
  ): Promise<T>;
  showToast(message: string, kind?: ToastKind): void;
}

declare global {
  interface Window {
    /** Runtime entry point for installed (zip) extensions. */
    ukitouch: UkitouchRuntime;
  }
}
