import type { Point, ScreenSize } from "./yatouch";

//#region Magics

/** The picture's max bounds. */
const MAX_SCALE = 8;

//#endregion

/** The picture's transform state. */
export interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** Cursor's coordinates on the viewer's screen. */
export interface CursorSpot {
  x: number;
  y: number;
}

export interface PictureOptions {
  canvas: HTMLCanvasElement;
  /** The HTMLElement that the picture's own transform is applied to. */
  stage: HTMLElement;
  /** The host's own screen size. */
  source: () => ScreenSize | undefined;
  /** Called with the {@link CursorSpot} to draw the cursor at, or null to clear it. */
  onCursor?: (spot: CursorSpot | null) => void;
}

/** Where the picture sits, and how the host's screen maps onto it. */
export class ViewerPicture extends EventTarget {
  //#region PView

  private readonly canvas: HTMLCanvasElement;
  /** PinchArea. */
  private readonly area: HTMLElement;
  /** The HTMLElement that the picture's own transform is applied to. */
  private readonly stage: HTMLElement;
  /** The picture's transform. */
  private readonly view: Transform = { scale: 1, x: 0, y: 0 };
  /** The picture's transform when the running gesture started. */
  private readonly base: Transform = { scale: 1, x: 0, y: 0 };
  private areaBox = { w: 0, h: 0 };
  /** The picture's layout box and its offset inside the area. */
  private pictureBox = { w: 0, h: 0, ox: 0, oy: 0 };
  private readonly observer: ResizeObserver;

  //#endregion
  //#region PHost

  /** The host's own screen size. */
  private readonly sourceSize: () => ScreenSize | undefined;
  /** The recorded host cursor's coordinates. */
  private cursorCoords: Point | null = null;
  /** Called with the {@link CursorSpot} to draw the cursor at, or null to clear it. */
  private readonly onCursor?: (spot: CursorSpot | null) => void;

  //#endregion

  constructor(options: PictureOptions) {
    super();

    const { canvas, stage, source, onCursor } = options;
    this.canvas = canvas;
    this.stage = stage;
    this.sourceSize = source;
    this.onCursor = onCursor;
    this.area = canvas.closest<HTMLElement>(".stage-area") ?? canvas;

    // Tell the driver that the area the picture sits in resized.
    this.observer = new ResizeObserver(() => this.dispatchEvent(new Event("resize")));
    this.observer.observe(this.area);
    this.observer.observe(stage);
    this.observer.observe(canvas);

    // apply instantly
    this.measure();
    this.apply(this.view);
  }

  //#region View

  /** Take the picture as it stands to be the running gesture's base. */
  begin(): void {
    this.measure();
    this.base.scale = this.view.scale;
    this.base.x = this.view.x;
    this.base.y = this.view.y;
  }

  /** Follow a drag between two client points. */
  drag(from: Point, to: Point): void {
    this.apply({
      scale: this.base.scale,
      x: this.base.x + to.x - from.x,
      y: this.base.y + to.y - from.y,
    });
  }

  /** Scale by `factor`, keeping the point under the client point `from` pinned to `to`. */
  zoom(from: Point, to: Point, factor: number): void {
    const a = this.toArea(from);
    const b = this.toArea(to);
    const scale = this.base.scale * factor;
    const ratio = scale / this.base.scale;
    this.apply({
      scale,
      x: b.x - (a.x - this.base.x) * ratio,
      y: b.y - (a.y - this.base.y) * ratio,
    });
  }

  /** Re-read the boxes and re-apply the picture. */
  refresh(): void {
    this.measure();
    this.apply(this.view);
  }

  /** Calculate the area and picture boxes. */
  measure(): void {
    this.areaBox = { w: this.area.clientWidth, h: this.area.clientHeight };
    this.pictureBox = {
      w: this.canvas.offsetWidth,
      h: this.canvas.offsetHeight,
      ox: this.canvas.offsetLeft,
      oy: this.canvas.offsetTop,
    };
  }

  /** The scale at which the picture fits inside the area. */
  containScale(): number {
    const { w, h } = this.areaBox;
    const { w: pw, h: ph } = this.pictureBox;
    return pw > 0 && ph > 0 ? Math.min(w / pw, h / ph) : 1;
  }

  /** Apply the picture to the displaying areas. */
  apply(t: Transform): void {
    const next = this.constrain(t);
    const scale = this.containScale() * next.scale;
    this.view.scale = next.scale;
    this.view.x = next.x;
    this.view.y = next.y;
    this.stage.style.transformOrigin = "0 0";
    this.stage.style.transform = `translate3d(${next.x - this.pictureBox.ox * scale}px, ${next.y - this.pictureBox.oy * scale}px, 0) scale(${scale})`;
    this.onCursor?.(this.cursorCoords ? this.spotOf(this.cursorCoords) : null);
  }

  /** Automatically pan the picture to keep the host's cursor in view. */
  followCursor(): void {
    if (!this.cursorCoords) return;

    const size = this.sourceSize();
    if (!size) return;
    this.measure();
    if (this.view.scale <= 1) return;

    const { w, h } = this.areaBox;
    const scale = this.containScale() * this.view.scale;
    const cx =
      this.view.x + ((this.cursorCoords.x + 0.5) / size.width) * this.pictureBox.w * scale;
    const cy =
      this.view.y + ((this.cursorCoords.y + 0.5) / size.height) * this.pictureBox.h * scale;
    let x = this.view.x;
    let y = this.view.y;
    if (cx < 0) x -= cx;
    else if (cx > w) x -= cx - w;
    if (cy < 0) y -= cy;
    else if (cy > h) y -= cy - h;
    if (x !== this.view.x || y !== this.view.y) {
      this.apply({ scale: this.view.scale, x, y });
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.stage.style.transform = "";
    this.onCursor?.(null);
  }

  //#endregion
  //#region Host

  /** Update the cursor's position. */
  host(p: Point): void {
    this.cursorCoords = p;
    this.followCursor();
    this.onCursor?.(this.spotOf(p));
  }

  /** The host cursor's last recorded position. */
  get cursor(): Point | null {
    return this.cursorCoords;
  }

  //#endregion
  //#region Helper

  /** Constrain the transform to a legal one. */
  constrain(t: Transform): Transform {
    const { w, h } = this.areaBox;
    const scale = Math.min(Math.max(t.scale, 1), MAX_SCALE);
    const fit = this.containScale() * scale;
    const spanX = this.pictureBox.w * fit;
    const spanY = this.pictureBox.h * fit;
    return {
      scale,
      x: spanX <= w ? (w - spanX) / 2 : Math.min(0, Math.max(t.x, w - spanX)),
      y: spanY <= h ? (h - spanY) / 2 : Math.min(0, Math.max(t.y, h - spanY)),
    };
  }

  /** Round a point onto the host's screen. */
  clampHost(p: Point): Point {
    const size = this.sourceSize();
    if (!size) return p;
    const limit = (n: number, max: number) =>
      Math.min(max - 1, Math.max(0, Math.round(n)));
    return { x: limit(p.x, size.width), y: limit(p.y, size.height) };
  }

  /** The center of the host's screen. */
  center(): Point {
    const size = this.sourceSize();
    return size
      ? { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) }
      : { x: 0, y: 0 };
  }

  /** Convert a client point to the area's coordinate frame. */
  toArea(p: Point): Point {
    const r = this.area.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  }

  /** Where a host position lands on the viewer's viewport. */
  spotOf(p: Point): CursorSpot | null {
    const size = this.sourceSize();
    if (!size) return null;
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + ((p.x + 0.5) / size.width) * r.width,
      y: r.top + ((p.y + 0.5) / size.height) * r.height,
    };
  }

  /**
   * The host's coordinates under the viewer position.
   * 
   * @param clamp whether to send if the pointer goes outside the area
   */
  toHost(clientX: number, clientY: number, clamp: boolean): Point | undefined {
    const size = this.sourceSize();
    if (!size) return undefined;

    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return undefined;

    const u = (clientX - r.left) / r.width;
    const v = (clientY - r.top) / r.height;
    if (!clamp && (u < 0 || u > 1 || v < 0 || v > 1)) return undefined;

    return this.clampHost({ x: u * size.width, y: v * size.height });
  }

  /** A client-space delta in the host's pixels. */
  hostDelta(from: Point, to: Point): Point | undefined {
    const size = this.sourceSize();
    const r = this.canvas.getBoundingClientRect();
    if (!size || r.width === 0 || r.height === 0) return undefined;

    return {
      x: ((to.x - from.x) / r.width) * size.width,
      y: ((to.y - from.y) / r.height) * size.height,
    };
  }

  //#endregion
}
