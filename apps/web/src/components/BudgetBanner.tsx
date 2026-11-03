"use client";

import { useEffect, useState } from "react";
import type { BudgetStatus } from "@/lib/api";
import { useAuth } from "./AuthProvider";

/** Tells a person before their AI work stops, and why it stopped. Shows nothing while within budget. */
export function BudgetBanner() {
  const { api } = useAuth();
  const [status, setStatus] = useState<BudgetStatus | null>(null);

  useEffect(() => {
    let isCurrent = true;
    // A banner is a courtesy: if the check fails, the API still enforces the limit.
    api.usageStatus().then(
      (s) => isCurrent && setStatus(s),
      () => {},
    );
    return () => {
      isCurrent = false;
    };
  }, [api]);

  if (!status || status.level === "ok") return null;
  const whose = status.limit === "person" ? "Your" : "Your company's";
  const text =
    status.level === "stop"
      ? `${whose} AI budget for this month is used up, so answers and agents are paused. An admin can raise it.`
      : status.percentUsed === null
        ? `${whose} AI budget for this month is nearly used up.`
        : `${whose} AI budget for this month is ${status.percentUsed}% used.`;
  return (
    <p
      role={status.level === "stop" ? "alert" : "status"}
      className={`mb-8 rounded-md px-4 py-3 text-sm ${
        status.level === "stop"
          ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          : "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      }`}
    >
      {text}
    </p>
  );
}
