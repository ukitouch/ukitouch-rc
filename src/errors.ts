import { showToast } from "./host";
import type { Channel } from "./ukitouch";

/** Show this side's error, and put it to the peer. */
export function reportError(message: string, peer?: Channel | null, fatal = false): void {
  showToast(message, "error");
  if (!peer) return;
  try {
    peer.send(JSON.stringify({ error: message, fatal }));
  } catch {
    // the channel is gone
  }
}

/** Show an error that came from the peer. */
export function showPeerError(message: string): void {
  showToast(`Error on the peer: ${message}`, "error");
}

/** A peer's error, and whether it ended the session. */
export interface PeerError {
  message: string;
  fatal: boolean;
}

/** Read a peer's error off the channel. */
export function parseError(data: unknown): PeerError | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { error?: unknown; fatal?: unknown };
    if (typeof parsed.error === "string") {
      return { message: parsed.error, fatal: parsed.fatal === true };
    }
  } catch {
    // not ours
  }
  return null;
}
