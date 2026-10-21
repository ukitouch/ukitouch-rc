import { React, Button } from "./host";
import { castStore, setPad } from "./main";
import type { PadButton } from "./main";

const { useRef, useState, useSyncExternalStore } = React;

//#region Labels

/** Simple labels for some keys. */
const KEY_LABELS: Record<string, string> = {
  ControlLeft: "LCtrl",
  ControlRight: "RCtrl",
  ShiftLeft: "LShift",
  ShiftRight: "RShift",
  AltLeft: "LAlt",
  AltRight: "RAlt",
  MetaLeft: "LMeta",
  MetaRight: "RMeta",
  Escape: "Esc",
  Backspace: "⌫",
  Enter: "↵",
  Tab: "Tab",
  CapsLock: "Caps",
  Space: "Space",
  Insert: "Ins",
  Delete: "Del",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowRight: "→",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  ContextMenu: "Menu",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
  NumpadDecimal: ".",
  NumpadEnter: "↵",
  NumLock: "Num",
};

/** One code's label. */
function codeLabel(code: string): string {
  return (
    KEY_LABELS[code] ??
    code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num")
  );
}

/** One button's label. */
export function padLabel(codes: readonly string[]): string {
  return codes.map(codeLabel).join("+");
}

const MODIFIERS = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

//#endregion
//#region Catalog

/** Extra words the search matches. */
const TERMS: Record<string, string[]> = {
  ControlLeft: ["control"],
  ControlRight: ["control"],
  ShiftLeft: ["shift"],
  ShiftRight: ["shift"],
  AltLeft: ["option"],
  AltRight: ["option", "altgr"],
  MetaLeft: ["meta", "win", "windows", "cmd", "command", "super"],
  MetaRight: ["meta", "win", "windows", "cmd", "command", "super"],
  Escape: ["escape"],
  Enter: ["return"],
  NumpadEnter: ["return"],
  Delete: ["del"],
  Insert: ["ins"],
  PageUp: ["page up"],
  PageDown: ["page down"],
  ArrowUp: ["up"],
  ArrowDown: ["down"],
  ArrowLeft: ["left"],
  ArrowRight: ["right"],
  Minus: ["dash", "hyphen"],
  Equal: ["plus"],
  Semicolon: ["semicolon"],
  Quote: ["apostrophe"],
  Backquote: ["grave", "tilde"],
  Period: ["dot"],
  Slash: ["slash"],
  NumpadAdd: ["plus"],
  NumpadSubtract: ["minus", "dash"],
  NumpadMultiply: ["times", "star"],
  NumpadDivide: ["slash"],
};

const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => `Key${c}`);
const digits = [..."0123456789"].map((d) => `Digit${d}`);
const numpad = [..."0123456789"].map((d) => `Numpad${d}`);

/** The grouped picker's keys. */
const GROUPS: { label: string; codes: string[] }[] = [
  {
    label: "Modifiers",
    codes: [
      "ControlLeft",
      "ShiftLeft",
      "AltLeft",
      "MetaLeft",
      "ControlRight",
      "ShiftRight",
      "AltRight",
      "MetaRight",
    ],
  },
  {
    label: "Function",
    codes: ["Escape", "Tab", "CapsLock", "Space", "Enter", "Backspace", "Delete", "Insert"],
  },
  {
    label: "Navigation",
    codes: [
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ],
  },
  { label: "Letters", codes: letters },
  {
    label: "Digits & symbols",
    codes: [
      ...digits,
      "Minus",
      "Equal",
      "BracketLeft",
      "BracketRight",
      "Backslash",
      "Semicolon",
      "Quote",
      "Backquote",
      "Comma",
      "Period",
      "Slash",
    ],
  },
  { label: "Function keys", codes: Array.from({ length: 12 }, (_, i) => `F${i + 1}`) },
  {
    label: "Numpad",
    codes: [
      ...numpad,
      "NumpadAdd",
      "NumpadSubtract",
      "NumpadMultiply",
      "NumpadDivide",
      "NumpadDecimal",
      "NumpadEnter",
      "NumLock",
    ],
  },
];

/** Whether a code matches what has been typed into the search box. */
function matches(code: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [code, codeLabel(code), ...(TERMS[code] ?? [])]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

//#endregion
//#region Editor

/** The keys being picked. */
interface Draft {
  /** Index in the pad, or null for a new button. */
  at: number | null;
  codes: string[];
  label: string;
}

/** A grip drag in progress. */
interface Grip {
  from: number;
  /** The slot it would land in now. */
  to: number;
  /** Dragged vertical distance. */
  dy: number;
  /** The pointer's y at the start. */
  y0: number;
  /** The pointer's current y. */
  y: number;
  /** The list being scrolled. */
  box: HTMLElement;
  /** How far that list was scrolled when the drag started. */
  scroll0: number;
  /** Where the first row starts, in the scrolled content's coordinates. */
  top: number;
  height: number;
  /** From one row's top to the next. */
  step: number;
  frame: number;
}

const chevron = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

/** A copy of `list` with one entry moved from one slot to another. */
function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const grip = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.5" />
    <circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" />
    <circle cx="15" cy="18" r="1.5" />
  </svg>
);

export function KeysPanel({ onBack }: { onBack: () => void }) {
  const { pad } = useSyncExternalStore(castStore.subscribe, castStore.get).settings;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [, rerender] = useState(0);
  const grab = useRef<Grip | null>(null);

  /** The slot a row should be in after drag released. */
  function slotOf(g: Grip): number {
    const box = g.box.getBoundingClientRect();
    const y = g.y - box.top + g.box.scrollTop;
    const slot = Math.round((y - g.top - g.height / 2) / g.step);
    return Math.min(Math.max(slot, 0), pad.length - 1);
  }

  /** Put the dragged row in the slot after drag released. */
  function update() {
    const g = grab.current;
    if (!g) return;

    const last = pad.length - 1;
    const raw = g.y - g.y0 + (g.box.scrollTop - g.scroll0);
    g.to = slotOf(g);

    // don't let it past the first or last slot
    g.dy = Math.min(Math.max(raw, -g.from * g.step), (last - g.from) * g.step);
    rerender((n) => n + 1);
  }

  /** Scroll the list when drags to the its edge. */
  function tick() {
    const g = grab.current;
    if (!g) return;

    const box = g.box.getBoundingClientRect();
    const y = Math.min(Math.max(g.y, box.top), box.bottom);
    const over = box.top + g.step - y;
    const under = y - (box.bottom - g.step);
    const move = (under > 0 ? under : over > 0 ? -over : 0) / 8;
    if (move !== 0) {
      const was = g.box.scrollTop;
      g.box.scrollTop += move;
      if (g.box.scrollTop !== was) update();
    }
    g.frame = requestAnimationFrame(tick);
  }

  function startGrip(at: number, y: number, box: HTMLElement) {
    const rows = box.querySelectorAll<HTMLElement>(".keys-row");
    const first = rows[0]?.getBoundingClientRect();
    const second = rows[1]?.getBoundingClientRect();
    if (!first) return;

    grab.current = {
      from: at,
      to: at,
      dy: 0,
      y0: y,
      y,
      box,
      scroll0: box.scrollTop,
      top: first.top - box.getBoundingClientRect().top + box.scrollTop,
      height: first.height,
      step: second ? second.top - first.top : first.height,
      frame: requestAnimationFrame(tick),
    };
    rerender((n) => n + 1);
  }

  function moveGrip(y: number) {
    const g = grab.current;
    if (!g) return;
    g.y = y;
    update();
  }

  function endGrip() {
    const g = grab.current;
    grab.current = null;
    if (!g) return;
    cancelAnimationFrame(g.frame);
    rerender((n) => n + 1);
    if (g.to !== g.from) setPad(moved(pad, g.from, g.to));
  }

  function cancelGrip() {
    const g = grab.current;
    grab.current = null;
    if (g) cancelAnimationFrame(g.frame);
    rerender((n) => n + 1);
  }

  /** The offset a row will be pushed aside when the dragged row is over it. */
  function rowOffset(i: number): number {
    const g = grab.current;
    if (!g) return 0;
    if (i === g.from) return g.dy;
    if (g.from < g.to && i > g.from && i <= g.to) return -g.step;
    if (g.to < g.from && i >= g.to && i < g.from) return g.step;
    return 0;
  }

  /** New/Edit a button. */
  function open(at: number | null) {
    const button = at === null ? null : pad[at];
    setDraft({
      at,
      codes: button ? [...button.codes] : [],
      label: button?.label ?? "",
    });
    setQuery("");
  }

  /** Select a key in the editor. */
  function toggle(code: string) {
    setDraft((was) => {
      if (!was) return was;
      const codes = was.codes.includes(code)
        ? was.codes.filter((c) => c !== code)
        : MODIFIERS.has(code)
          ? [code, ...was.codes]
          : [...was.codes, code];
      return { ...was, codes };
    });
  }

  function save() {
    if (!draft || draft.codes.length === 0) return;

    const label = draft.label.trim();
    const button: PadButton = { codes: draft.codes, label: label || undefined };
    const next = [...pad];
    if (draft.at === null) next.push(button);
    else next[draft.at] = button;

    setPad(next);
    setDraft(null);
  }

  const head = (
    <div className="stage-drawer-head">
      <button
        type="button"
        className="stage-drawer-back"
        aria-label="Back"
        onClick={() => (draft ? setDraft(null) : onBack())}
      >
        {chevron}
      </button>
      <span className="stage-drawer-title">Keys</span>
      <span className="stage-peer">
        {draft ? "pick the keys" : `${pad.length} buttons`}
      </span>
    </div>
  );

  if (!draft) {
    return (
      <>
        {head}
        <div className={`stage-drawer-body${grab.current ? " keys-dragging" : ""}`}>
          {pad.length === 0 && <p className="cast-note">No buttons yet.</p>}
          {pad.map((button, i) => {
            const offset = rowOffset(i);
            const lifted = i === grab.current?.from;
            return (
              <div
                className={`keys-row${lifted ? " keys-row-dragging" : ""}`}
                key={i}
                style={{
                  transform: lifted
                    ? `translateY(${offset}px) scale(1.02)`
                    : offset
                      ? `translateY(${offset}px)`
                      : undefined,
                }}
              >
                <button
                  type="button"
                  className="keys-row-handle"
                  aria-label="Move"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const box = e.currentTarget.closest<HTMLElement>(".stage-drawer-body");
                    if (box) startGrip(i, e.clientY, box);
                  }}
                  onPointerMove={(e) => moveGrip(e.clientY)}
                  onPointerUp={endGrip}
                  onPointerCancel={cancelGrip}
                >
                  {grip}
                </button>
                <button type="button" className="keys-row-main" onClick={() => open(i)}>
                  {button.label ?? padLabel(button.codes)}
                </button>
                <button
                  type="button"
                  className="keys-row-drop"
                  aria-label="Remove"
                  onClick={() => setPad(pad.filter((_, n) => n !== i))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="stage-drawer-foot">
          <Button variant="primary" onClick={() => open(null)}>
            Add key
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="stage-drawer-body">
        <div className="keys-preview">
          {draft.codes.length > 0 ? padLabel(draft.codes) : "Tap the keys to send together"}
        </div>
        <input
          className="keys-input"
          value={draft.label}
          placeholder={draft.codes.length > 0 ? padLabel(draft.codes) : "Label"}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
        <input
          className="keys-input"
          value={query}
          placeholder="Search keys"
          onChange={(e) => setQuery(e.target.value)}
        />

        {GROUPS.map((group) => {
          const codes = group.codes.filter((code) => matches(code, query));
          if (codes.length === 0) return null;
          return (
            <div className="keys-group" key={group.label}>
              <div className="keys-group-title">{group.label}</div>
              <div className="keys-grid">
                {codes.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className={`keys-key${draft.codes.includes(code) ? " keys-key-on" : ""}`}
                    onClick={() => toggle(code)}
                  >
                    {codeLabel(code)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="stage-drawer-foot keys-actions">
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={draft.codes.length === 0}>
          Save
        </Button>
      </div>
    </>
  );
}

//#endregion
