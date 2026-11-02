"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";

const POLL_MS = 30_000;

/** How many things are waiting for the person, shown on the Agents link. */
export function NotificationBadge() {
  const { api } = useAuth();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    const load = async () => {
      // A missed count is not worth interrupting anyone for, and the next one will correct it.
      const result = await api.notifications().catch(() => null);
      if (isCurrent && result) setUnread(result.unread);
    };
    void load();
    // Nothing to show on a hidden tab, so it stops asking.
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [api]);

  if (unread === 0) return null;
  return (
    <span className="ml-1.5 inline-block min-w-5 rounded-full bg-brand px-1.5 text-center text-xs font-semibold text-white">
      {unread}
      <span className="sr-only"> waiting for you</span>
    </span>
  );
}
