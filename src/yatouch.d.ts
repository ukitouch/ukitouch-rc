import type { ComponentType, ReactNode } from "react";

/** A handle that can be released to free a subscription or listener. */
export interface Disposable {
  dispose(): void;
}

/** Host platforms, matched against an extension's platform matrix. */
export type HostPlatform = "windows" | "linux" | "android";

/** Shell layout an extension can request via `setLayout`. */
export type Layout = "withSidebar" | "fullscreen";

/** Host system info reported by the hello handshake. */
export interface HelloInfo {
  name?: string | null;
  platform?: string | null;
  os?: string | null;
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
  online: boolean | null;
  meta: Record<string, unknown>;
}

/** USB device reported by the backend. */
export interface UsbDevice {
  serial: string;
  state: string;
}

/**
 * API the host hands to an extension's logic layer (`activate`).
 */
export interface ExtensionContext {
  readonly subscriptions: Disposable[];
  setLayout(layout: Layout): void;
  openChannel(request: OpenSpec): Promise<Channel>;
  onChannel(handler: (channel: Channel) => void): Disposable;
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
  /** Always `"rgba"`. */
  format: "rgba";
  /** The screen's own size, when it is sending us a scaled version. */
  source?: ScreenSize;
}

/** A changed rectangle, in screen pixels. */
export interface Damage {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle's pixels, exactly `width * height * 4` bytes, row-major RGBA. */
export interface DamageFrame extends Damage {
  data: Uint8Array;
}

/** What a caller can ask of a screen source. */
export interface CaptureOptions {
  /** Include the pointer in the frames. */
  cursor?: boolean;
}

/** What a caller can ask of a stream. */
export interface StreamOptions extends CaptureOptions {
  /** Fraction of the screen to send, up to 1. */
  resolutionScale?: number;
}

/** Reasons capture could not start or stopped on its own. */
export type CaptureFailure = "denied" | "cancelled" | "unsupported";

/** Result of trying to start a monitor. */
export type StartResult =
  | { ok: true; monitor: ScreenMonitor }
  | { ok: false; reason: CaptureFailure; detail?: string };

/** A running screen source. */
export interface ScreenMonitor {
  readonly info: ScreenInfo;
  onDamage(handler: (frames: DamageFrame[]) => void): Disposable;
  onStop(handler: (reason?: string) => void): Disposable;
  resync(): Promise<void>;
  configure(options: CaptureOptions): Promise<void>;
  stop(): Promise<void>;
}

/** A running screen stream to a peer. */
export interface ScreenStream {
  readonly id: number;
  /** Shape of the screen being sent. */
  readonly info: ScreenInfo;
  /** Change how the screen is captured; the peer is told the new shape. */
  configure(options: StreamOptions): Promise<void>;
  /** Stop sending. */
  stop(): Promise<void>;
}

/** Where a `PinchArea`'s content sits after a gesture, in area pixels. */
export interface PinchTransform {
  scale: number;
  x: number;
  y: number;
}

/** What an extension declares. */
export interface ExtensionDefinition {
  id: string;
  title?: string;
  icon?: ReactNode;
  platforms?: HostPlatform[];
  activate?: (ctx: ExtensionContext) => void | (() => void);
  component?: ComponentType;
}

/** The runtime surface exposed on `window.yatouch`. */
export interface YatouchRuntime {
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
    }>;
  };
  defineExtension(def: ExtensionDefinition): void;
  getHostPlatform(): Promise<HostPlatform>;
  getHostInfo(): Promise<HelloInfo>;
  /** Hold the app fullscreen (Android only). */
  setFullscreen(on: boolean): Promise<void>;
  /** Read the system clipboard as plain text. */
  readClipboardText(): Promise<string>;
  /** Write plain text to the system clipboard. */
  writeClipboardText(text: string): Promise<void>;
  refreshUsbDevices(): Promise<void>;
  usbStore: Store<{ devices: UsbDevice[] }>;
  createStore<T extends object>(initial: T): Store<T>;
  /** Start capturing the screen. */
  createScreenMonitor(options?: CaptureOptions): Promise<StartResult>;
  /** Stream the screen onto an open channel. */
  startScreenStream(
    channel: Channel,
    options?: StreamOptions
  ): Promise<ScreenStream>;
  showToast(message: string, kind?: ToastKind): void;
}

declare global {
  interface Window {
    /** Runtime entry point for installed (zip) extensions. */
    yatouch: YatouchRuntime;
  }
}
