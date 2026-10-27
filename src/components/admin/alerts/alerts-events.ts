/** Tiny shared signal: the Alerts page tells the admin nav badge the new unread count (no extra request). */
export const ALERTS_CHANGED_EVENT = "nc-alerts-changed";

export function announceUnread(unread: number): void {
  window.dispatchEvent(new CustomEvent<number>(ALERTS_CHANGED_EVENT, { detail: unread }));
}
