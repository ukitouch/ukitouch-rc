import css from "./index.css";

/**
 * Put this extension's stylesheet in the document, once.
 */
export function applyStyles(): void {
  if (document.querySelector("style[data-ext='cast']")) return;
  const style = document.createElement("style");
  style.dataset.ext = "cast";
  style.textContent = css;
  document.head.appendChild(style);
}
