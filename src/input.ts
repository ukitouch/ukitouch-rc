import type { Channel, InputEvent, MouseButton, Point } from "./yatouch";

//#region Magics

/** Pixels of wheel delta that make one notch on the host. */
const WHEEL_STEP = 25;

/** host pixels a finger scroll has to travel for one notch. */
const WHEEL_PIXELS = 32;

/** The threshould tells a tap or a gesture. */
const GESTURE_THRESHOLD = 8;

/** How long a tap stays armed for the next touch to start a drag (touchpad-like). */
const DRAG_ARM_MS = 200;

/** How long a pad button has to be held before it stays down. */
const PAD_HOLD_MS = 400;

//#endregion

/**
 * RC's mouse input mode.
 */
export type InputMode = "cursor" | "touch";

/** DOM button numbers. */
const BUTTONS: Record<number, MouseButton> = {
  0: "left",
  1: "middle",
  2: "right",
  3: "back",
  4: "forward",
};

/** Maps the viewer's positions onto the host's screen. */
export interface ScreenMap {
  /**
   * The host's coordinates under the viewer position.
   * 
   * @param clamp whether to send if the pointer goes outside the area
   */
  toHost(clientX: number, clientY: number, clamp: boolean): Point | undefined;
  /** A client-space delta in the host's pixels. */
  hostDelta(from: Point, to: Point): Point | undefined;
  /** Round a point onto the host's screen. */
  clampHost(p: Point): Point;
  /** The host cursor's last recorded position. */
  cursor(): Point | null;
  /** The center of the host's screen. */
  center(): Point;
}

/** Pointer event's prop. */
export interface PointerLike {
  clientX: number;
  clientY: number;
  pointerId: number;
  button: number;
  pointerType: string;
  preventDefault(): void;
}

/** Pointer's handling callbacks. */
export interface InputHandlers {
  onPointerDown(e: PointerLike): void;
  onPointerMove(e: PointerLike): void;
  onPointerUp(e: PointerLike): void;
  onPointerCancel(e: PointerLike): void;
  /** A pad button went down.. */
  padDown(index: number, codes: string[]): void;
  /** A pad button came up. */
  padUp(index: number): void;
  /** A pad button's gesture was taken over by something else. */
  padCancel(index: number): void;
  /** Watch the pad buttons being held down on the host by index. */
  onPad(handler: (held: readonly number[]) => void): void;
  dispose(): void;
}

/** The gesture works directly on the picture. */
export interface PictureGesture {
  /** The beginning of the gesture. */
  begin: null;
  /** Pan the picture. */
  pan: { from: Point; to: Point };
  /** Zoom the picture. */
  zoom: { from: Point; to: Point; factor: number };
  /** The cursor's position. */
  cursor: Point;
}

export interface InputOptions {
  channel: Channel;
  map: ScreenMap;
  /** Get current {@link InputMode}. */
  mode: () => InputMode;
  /**
   * Whether currently in controlling mode.
   * 
   * TODO: should it be state strings?
   */
  control: () => boolean;
  /** The field the keyboard and IME write into. */
  keys: HTMLTextAreaElement;
}

const middle = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/** A tap. */
const tap = (code: string): InputEvent[] => [
  { kind: "key", code, pressed: true },
  { kind: "key", code, pressed: false },
];

export class ViewerInput extends EventTarget implements InputHandlers {
  //#region PGesture

  /** Accumulated wheeled deltaX. */
  private accX = 0;
  /** Accumulated wheeled deltaY. */
  private accY = 0;
  private touchX = 0;
  private touchY = 0;
  /** The most pointers this gesture had down. */
  private maxFingers = 1;
  /**
   * Anchor for a relative pointer drag in cursor mode.
   * 
   * - `fingerFrom` - the finger's position when it was about to drag the cursor
   * - `cursorFrom` - the host cursor's position when the anchor was taken
   */
  private pointerMoveAnchor: { fingerFrom: Point; cursorFrom: Point } | null = null;
  /** Whether the current pointer has moved too far to be a tap. */
  private tapMoved = false;
  /** {@link MouseButton} that is currently holding. */
  private mouseHolding: MouseButton | null = null;
  /** Position of a single tap. */
  private tapFrom: Point | null = null;
  /**
   * The host button a touch is holding and dragging.
   * 
   * - `button` - {@link MouseButton}
   * - `dragging` - false means its press is still armed
   * - `timer` - release it if no next touch comes in this timer ends
   */
  private tapDrag: { button: MouseButton; dragging: boolean; timer: number } | null = null;
  /** Fingers on the screen. */
  private readonly pointers = new Map<number, { now: Point; origin?: Point }>();
  /** A picture pan's started position. */
  private panFrom: Point | null = null;
  /** The running two-finger gesture's kind. */
  private gestureKind: "none" | "pinch" | "scroll" = "none";
  /** The midpoint the running scroll moves from. */
  private scrollFrom: Point | null = null;

  //#endregion
  //#region PStatus

  private readonly channel: Channel;
  /** The pending flush's frame handle. */
  private flushFrame = 0;
  /** Whether the host cursor's position is waiting to be sent. */
  private cursorQueued = false;
  /** Maps the viewer's positions onto the host's screen. */
  private readonly map: ScreenMap;
  /** Get current {@link InputMode}. */
  private readonly mode: () => InputMode;
  /** Whether currently in controlling mode. */
  private readonly control: () => boolean;
  /** Key codes the host still has pressed. */
  private readonly keyHeld = new Set<string>();
  /** The pad buttons. */
  private readonly padButtons = new Map<number, { codes: string[]; timer: number; held: boolean }>();
  /** The field the keyboard and IME write into. */
  private readonly keys: HTMLTextAreaElement;
  /** Whether an IME is composing in that field right now. */
  private composing = false;
  /** Stops listening to that field. */
  private readonly keysStop = new AbortController();

  //#endregion

  constructor(options: InputOptions) {
    super();

    const { channel, map, mode, control, keys } = options;
    this.channel = channel;
    this.map = map;
    this.mode = mode;
    this.control = control;
    this.keys = keys;

    // keys events
    const on = { signal: this.keysStop.signal };
    keys.addEventListener("blur", () => this.releaseKeys(), on);
    keys.addEventListener("keydown", (e) => this.onKey(e, true), on);
    keys.addEventListener("keyup", (e) => this.onKey(e, false), on);
    keys.addEventListener("beforeinput", (e) => this.onEdit(e.inputType), on);
    keys.addEventListener("compositionstart", () => (this.composing = true), on);
    keys.addEventListener(
      "compositionend",
      () => {
        this.composing = false;
        this.flushKeys();
      },
      on
    );
    keys.addEventListener(
      "input",
      () => {
        if (!this.composing) this.flushKeys();
      },
      on
    );
  }

  /** Whether a gesture is currently running. */
  get interacting(): boolean {
    return this.pointers.size > 0 || this.panFrom !== null;
  }

  /** Listen to what the gestures ask of the picture. */
  on<K extends keyof PictureGesture>(
    type: K,
    handler: (detail: PictureGesture[K]) => void
  ): void {
    this.addEventListener(type, (e) => handler((e as CustomEvent<PictureGesture[K]>).detail));
  }

  private emit<K extends keyof PictureGesture>(type: K, detail: PictureGesture[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private send(events: InputEvent[]): void {
    this.channel.send(JSON.stringify({ input: events }));
  }

  /** Flush pending sends. */
  private flush(): void {
    // Coalesce this frame's pending sends into one flush
    if (!this.flushFrame) this.flushFrame = requestAnimationFrame(() => {
      this.flushFrame = 0;

      // cursor movement
      const move = this.cursorQueued ? this.map.cursor() : null;

      // scrolling
      const scrollX = Math.trunc(this.touchX / WHEEL_PIXELS);
      const scrollY = Math.trunc(this.touchY / WHEEL_PIXELS);
      const scroll = scrollX !== 0 || scrollY !== 0 ? { x: scrollX, y: scrollY } : null;
      if (!move && !scroll) return;

      if (this.channel.bufferedAmount > 0) {
        this.flush();
        return;
      }

      const events: InputEvent[] = [];
      if (move) {
        this.cursorQueued = false;
        events.push({ kind: "move", x: move.x, y: move.y });
      }

      if (scroll) {
        this.touchX -= scroll.x * WHEEL_PIXELS;
        this.touchY -= scroll.y * WHEEL_PIXELS;
        events.push({ kind: "scroll", dx: -scroll.x, dy: -scroll.y });
      }

      this.send(events);
    });
  }

  /** Releases for everything the host still has down. */
  private releaseKeys(): void {
    const events = [...this.keyHeld].map((code) => ({
      kind: "key" as const,
      code,
      pressed: false,
    }));
    this.keyHeld.clear();

    for (const down of this.padButtons.values()) clearTimeout(down.timer);
    if (this.padButtons.size > 0) {
      this.padButtons.clear();
      this.emitPad();
    }

    if (events.length > 0) this.send(events);
  }

  /** A pad button went down. */
  padDown(index: number, codes: string[]): void {
    if (!this.control() || codes.length === 0) return;

    const down = this.padButtons.get(index);
    if (down) {
      // already down
      if (down.held) this.releasePad(index);
      return;
    }

    const entry = { codes, held: false, timer: 0 };
    this.padButtons.set(index, entry);
    entry.timer = window.setTimeout(() => {
      entry.held = true;
      for (const code of codes) this.keyHeld.add(code);
      this.send(codes.map((code): InputEvent => ({ kind: "key", code, pressed: true })));
      this.emitPad();
    }, PAD_HOLD_MS);
  }

  /** A pad button came up. */
  padUp(index: number): void {
    const down = this.padButtons.get(index);
    if (!down || down.held) return;
    clearTimeout(down.timer);
    this.padButtons.delete(index);

    const { codes } = down;
    this.send([
      ...codes.map((code): InputEvent => ({ kind: "key", code, pressed: true })),
      ...[...codes].reverse().map((code): InputEvent => ({ kind: "key", code, pressed: false })),
    ]);
  }

  /** A pad button's gesture was taken over, drop the tap. */
  padCancel(index: number): void {
    const down = this.padButtons.get(index);
    if (!down || down.held) return;
    clearTimeout(down.timer);
    this.padButtons.delete(index);
  }

  /** Let a held pad button go. */
  private releasePad(index: number): void {
    const down = this.padButtons.get(index);
    if (!down?.held) return;
    this.padButtons.delete(index);

    const events: InputEvent[] = [];
    for (const code of [...down.codes].reverse()) {
      events.push({ kind: "key", code, pressed: false });
      this.keyHeld.delete(code);
    }
    this.send(events);
    this.emitPad();
  }

  /** Listen to the pad buttons being held. */
  onPad(handler: (held: readonly number[]) => void): void {
    this.addEventListener("pad", (e) => handler((e as CustomEvent<number[]>).detail));
  }

  private emitPad(): void {
    const held = [...this.padButtons]
      .filter(([, down]) => down.held)
      .map(([index]) => index);
    this.dispatchEvent(new CustomEvent<number[]>("pad", { detail: held }));
  }

  /** Type what the field has collected, and flush it. */
  private flushKeys(): void {
    const text = this.keys.value;
    if (!text) return;

    this.keys.value = "";
    this.typeText(text);
  }

  /** Type a string on the host. */
  private typeText(text: string): void {
    if (!this.control() || text === "") return;

    const events: InputEvent[] = [];
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (i > 0) events.push(...tap("Enter"));
      if (line) events.push({ kind: "text", text: line });
    });
    this.send(events);
  }

  /**
   * Type the key an edit stands for.
   *
   * @param inputType a `beforeinput`'s {@link InputEvent.inputType}
   */
  private onEdit(inputType: string): void {
    if (!this.control()) return;

    const code =
      inputType === "deleteContentBackward"
        ? "Backspace"
        : inputType === "deleteContentForward"
          ? "Delete"
          : inputType === "insertLineBreak" || inputType === "insertParagraph"
            ? "Enter"
            : null;
    if (code) this.send(tap(code));
  }

  //#region Gesture

  /** Whether a gesture can pan the picture. */
  private canPan(): boolean {
    return !this.control() || this.mode() === "touch";
  }

  /** Start reading the pointers as they stand. */
  private startGesture(): void {
    // confirm the picture
    this.emit("begin", null);

    // reset the gesture
    for (const p of this.pointers.values()) p.origin = p.now;
    this.scrollFrom = null;
    this.touchX = 0;
    this.touchY = 0;
  }

  private pointerUp(e: PointerLike, cancelled: boolean): void {
    // Cursor mode should be a simple mouse up.
    if (e.pointerType == "cursor") {
      this.onMouseUp(e, cancelled);
      return;
    }

    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.tapDrag?.dragging) {
        const button = this.tapDrag.button;
        this.tapDrag = null;

        // Close the click and hold a new press the same way.
        const at = this.map.cursor()!;
        this.send([{ kind: "button", at, button, pressed: false }]);
        if (!this.tapMoved) this.arm(at, button);
      } else if (this.control() && !cancelled && !this.tapMoved && this.gestureKind === "none") {
        // This event should be a single click.
        const from = this.tapFrom ?? { x: e.clientX, y: e.clientY };
        const p = this.canPan() ? this.map.toHost(from.x, from.y, false) : this.map.cursor();
        const button: MouseButton =
          this.maxFingers >= 3 ? "middle" : this.maxFingers >= 2 ? "right" : "left";
        if (p) {
          if (this.canPan()) this.click(p, button);
          else this.arm(p, button);
        }
      }
      this.pointerMoveAnchor = null;
      this.tapFrom = null;
      this.tapMoved = false;
      this.gestureKind = "none";
      this.maxFingers = 1;
      return;
    }

    if (this.pointers.size === 1) {
      // One finger left takes over where it stands, the tap keeps its origin.
      const [id] = [...this.pointers.keys()];
      const p = this.pointers.get(id)!.now;
      this.tapMoved = false;
      if (this.canPan()) {
        this.pointerMoveAnchor = null;
        this.startGesture();
      } else if (this.control()) {
        this.pointerMoveAnchor = {
          fingerFrom: p,
          cursorFrom: this.map.cursor() ?? this.map.center(),
        };
      }
      return;
    }

    // Three or more left: the pair starts over.
    this.gestureKind = this.control() ? "none" : "pinch";
    this.startGesture();
  }

  /** Hold a button to decide a tap click or turn into a drag. */
  private arm(at: Point, button: MouseButton): void {
    if (this.tapDrag) clearTimeout(this.tapDrag.timer);
    this.send([{ kind: "button", at, button, pressed: true }]);
    this.tapDrag = {
      button,
      dragging: false,
      timer: window.setTimeout(() => this.releaseArm(), DRAG_ARM_MS),
    };
  }

  /** Release the armed press. */
  private releaseArm(): void {
    const drag = this.tapDrag;
    if (!drag || drag.dragging) return;

    clearTimeout(drag.timer);
    this.tapDrag = null;
    const at = this.map.cursor();
    if (at) {
      this.send([{ kind: "button", at, button: drag.button, pressed: false }]);
    }
  }

  /** Mark a tap as having moved too far. */
  private markTapMoved(e: PointerLike): void {
    if (!this.tapFrom) return;

    if (Math.hypot(e.clientX - this.tapFrom.x, e.clientY - this.tapFrom.y) > GESTURE_THRESHOLD) {
      this.tapMoved = true;
    }
  }

  //#endregion
  //#region Input handler

  /** A click at one spot. */
  private click(at: Point, button: MouseButton = "left"): void {
    this.send([
      { kind: "button", at, button, pressed: true },
      { kind: "button", at, button, pressed: false },
    ]);
  }

  /** Move the host's cursor and let the viewer keep up with it. */
  private moveTo(p: Point): void {
    this.emit("cursor", p);
    this.cursorQueued = true;
    this.flush();
  }

  readonly onPointerDown = (e: PointerLike): void => {
    if (e.pointerType !== "touch") {
      this.onMouseDown(e);
      return;
    }
    e.preventDefault();

    const p = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, { now: p });
    if (this.pointers.size === 1) {
      this.gestureKind = this.control() ? "none" : "pinch";
      this.startGesture();
      this.tapFrom = p;
      this.tapMoved = false;
      this.maxFingers = 1;
      if (!this.canPan()) {
        this.pointerMoveAnchor = {
          fingerFrom: p,
          cursorFrom: this.map.cursor() ?? this.map.center(),
        };
        this.emit("cursor", this.pointerMoveAnchor.cursorFrom);
        if (this.tapDrag && !this.tapDrag.dragging) {
          clearTimeout(this.tapDrag.timer);
          this.tapDrag.dragging = true;
        }
      }
      return;
    }

    this.cursorQueued = false;
    this.pointerMoveAnchor = null;
    this.tapMoved = false;
    this.maxFingers = Math.max(this.maxFingers, this.pointers.size);
    this.releaseArm();
    this.gestureKind = this.control() ? "none" : "pinch";
    this.startGesture();
  };

  readonly onPointerMove = (e: PointerLike): void => {
    if (e.pointerType !== "touch") {
      this.onMouseMove(e);
      return;
    }

    const entry = this.pointers.get(e.pointerId);
    if (!entry) return;

    const p = { x: e.clientX, y: e.clientY };
    entry.now = p;

    // single finger
    if (this.pointers.size === 1) {
      this.markTapMoved(e);
      const anchor = this.pointerMoveAnchor;
      if (anchor) {
        const d = this.map.hostDelta(anchor.fingerFrom, p);
        if (!d) return;
        this.moveTo(this.map.clampHost({
          x: anchor.cursorFrom.x + d.x,
          y: anchor.cursorFrom.y + d.y,
        }));
        return;
      }
      const o = entry.origin;
      if (o && this.canPan()) {
        this.emit("pan", { from: o, to: p });
      }
      return;
    }

    // two fingers
    if (this.pointers.size === 2) {
      // get and calculate original span
      const ids = [...this.pointers.keys()].slice(0, 2);
      const cur = ids.map((id) => this.pointers.get(id)!.now);
      const ori = ids.map((id) => this.pointers.get(id)!.origin!);
      const fromSpan = distance(ori[0], ori[1]);
      if (fromSpan < 1) return;

      const nowSpan = distance(cur[0], cur[1]);
      const fromMid = middle(ori[0], ori[1]);
      const nowMid = middle(cur[0], cur[1]);

      const spread = Math.abs(nowSpan - fromSpan);
      const travel = distance(nowMid, fromMid);

      if (this.gestureKind === "none") {
        // First cross over the threshould will be the final kind.
        if (spread > GESTURE_THRESHOLD && spread >= travel) this.gestureKind = "pinch";
        else if (travel > GESTURE_THRESHOLD) this.gestureKind = "scroll";
        else return;
      }

      if (this.gestureKind === "pinch") {
        this.emit("zoom", { from: fromMid, to: nowMid, factor: nowSpan / fromSpan });
        return;
      }

      // kind scroll
      if (!this.control()) return;
      if (!this.scrollFrom) {
        this.scrollFrom = nowMid;
        return;
      }

      const d = this.map.hostDelta(this.scrollFrom, nowMid);
      if (!d) return;

      this.touchX += d.x;
      this.touchY += d.y;
      this.scrollFrom = nowMid;
      this.flush();
    }

    // multi-fingers
    if (this.pointers.size > 2) {
      const o = entry.origin;
      if (o && Math.hypot(p.x - o.x, p.y - o.y) > GESTURE_THRESHOLD) this.tapMoved = true;
    }
  };

  readonly onPointerUp = (e: PointerLike): void => this.pointerUp(e, false);

  readonly onPointerCancel = (e: PointerLike): void => this.pointerUp(e, true);

  private onMouseDown(e: PointerLike): void {
    const toPeer = !this.canPan();
    e.preventDefault();
    if (e.button !== 0) {
      if (!toPeer) return;
      const p = this.map.toHost(e.clientX, e.clientY, false);
      if (!p) return;
      this.cursorQueued = false;
      this.mouseHolding = BUTTONS[e.button] ?? "left";
      this.emit("cursor", p);
      this.send([{ kind: "button", at: p, button: this.mouseHolding, pressed: true }]);
      return;
    }
    if (toPeer) {
      const p = this.map.toHost(e.clientX, e.clientY, false);
      if (!p) return;
      this.cursorQueued = false;
      this.mouseHolding = "left";
      this.emit("cursor", p);
      this.send([{ kind: "button", at: p, button: "left", pressed: true }]);
      return;
    }
    this.emit("begin", null);
    this.panFrom = { x: e.clientX, y: e.clientY };
    this.tapFrom = { x: e.clientX, y: e.clientY };
    this.tapMoved = false;
  }

  private onMouseMove(e: PointerLike): void {
    if (this.panFrom) {
      this.markTapMoved(e);
      this.emit("pan", { from: this.panFrom, to: { x: e.clientX, y: e.clientY } });
      return;
    }
    if (!this.mouseHolding) return;
    const p = this.map.toHost(e.clientX, e.clientY, true);
    if (!p) return;
    this.moveTo(p);
  }

  private onMouseUp(e: PointerLike, cancelled = false): void {
    if (this.panFrom) {
      const tap = !this.tapMoved && !cancelled && this.control() && this.canPan();
      this.panFrom = null;
      this.tapFrom = null;
      this.tapMoved = false;
      if (tap) {
        const p = this.map.toHost(e.clientX, e.clientY, false);
        if (p) this.click(p);
      }
      return;
    }
    if (!this.mouseHolding) return;
    const button = this.mouseHolding;
    const p = this.map.toHost(e.clientX, e.clientY, true);
    if (!p) return;
    this.cursorQueued = false;
    this.mouseHolding = null;
    this.emit("cursor", p);
    this.send([{ kind: "button", at: p, button, pressed: false }]);
  }

  onWheel(e: WheelEvent): void {
    if (!this.control()) return;
    const p = this.map.toHost(e.clientX, e.clientY, false);
    if (!p) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? WHEEL_STEP : 1;
    this.accX += e.deltaX * scale;
    this.accY += e.deltaY * scale;
    const dx = Math.trunc(this.accX / WHEEL_STEP);
    const dy = Math.trunc(this.accY / WHEEL_STEP);
    if (dx === 0 && dy === 0) return;
    this.accX -= dx * WHEEL_STEP;
    this.accY -= dy * WHEEL_STEP;
    this.cursorQueued = false;
    this.send([{ kind: "scroll", at: p, dx, dy }]);
  }

  private onKey(e: KeyboardEvent, pressed: boolean): void {
    if (!this.control()) return;
    // What an IME sends while it composes is not ours to forward.
    if (e.isComposing || e.keyCode === 229) return;
    // A character on keyboard that needs a `shift` should be an unknown char.
    if (e.key.length === 1 || (e.keyCode >= 32 && e.keyCode < 127)) return;
    // A soft keyboard names a special key in `key` alone, with no `code`.
    const code = e.code || e.key;
    if (!code || code === "Unidentified") return;
    // The host's own repeat is the one that should show.
    if (pressed && e.repeat) return;
    e.preventDefault();

    if (pressed) this.keyHeld.add(code);
    else this.keyHeld.delete(code);
    this.send([{ kind: "key", code, pressed }]);
  }

  //#endregion

  dispose(): void {
    this.keysStop.abort();
    if (this.tapDrag) clearTimeout(this.tapDrag.timer);
    for (const down of this.padButtons.values()) clearTimeout(down.timer);
    this.padButtons.clear();

    if (this.flushFrame) cancelAnimationFrame(this.flushFrame);
    this.flushFrame = 0;
    this.cursorQueued = false;
    this.pointers.clear();
  }
}
