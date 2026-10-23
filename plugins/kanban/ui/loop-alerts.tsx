import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { LOOP_STOPPED, type LoopStoppedPayload } from "../shared/events";

/** A desktop notification when a monitored card's loop stops for the user, shown with the permission the push plugin asked for. */
export function LoopAlerts(): null {
  const navigate = useBbNavigate();
  useRealtime(LOOP_STOPPED, (payload) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const { threadId, title, body } = payload as LoopStoppedPayload;
    // The push plugin's tag, so its notification for the same thread is replaced rather than doubled.
    const notification = new Notification(title, { body, tag: `bb-${threadId}` });
    notification.onclick = () => {
      window.focus();
      navigate.toThread(threadId);
      notification.close();
    };
  });
  return null;
}
