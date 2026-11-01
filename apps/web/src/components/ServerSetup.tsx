"use client";

import { useState, type FormEvent } from "react";
import type { Connection } from "@/lib/api";
import { setupGuideFor } from "@/lib/setup-guides";

type Props = {
  connection: Connection;
  isBusy: boolean;
  onSave: (serverId: string, app: { clientId: string; clientSecret: string }) => void;
};

const FIELD =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";

/** Guides an admin through creating a service's sign-in app, once for the whole company. */
export function ServerSetup({ connection, isBusy, onSave }: Props) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const guide = setupGuideFor(connection.serverId, connection.redirectUrl);

  if (!guide) return <p className="text-sm text-slate-500">This service can't be set up from here yet.</p>;

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(connection.redirectUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (clientId.trim() && clientSecret.trim()) {
      onSave(connection.serverId, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    }
  }

  return (
    <div className="rounded-md bg-slate-100 p-4 dark:bg-slate-900">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {connection.setup === "configured"
          ? "Changing this asks everyone in your workspace to connect again."
          : "You only do this once. Everyone in your workspace then just clicks Connect."}
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
        {guide.steps.map((step) => (
          <li key={step.text}>
            {step.text}{" "}
            {step.href && (
              <a href={step.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline underline-offset-4">
                {step.linkLabel}
              </a>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-4 text-sm">
        <p className="font-medium">Redirect address</p>
        {guide.note && <p className="text-slate-500">{guide.note}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-slate-950">{connection.redirectUrl}</code>
          <button type="button" onClick={() => void copyRedirect()} className="font-medium underline underline-offset-4">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="mt-4 grid gap-3">
        <label className="text-sm font-medium">
          {guide.idLabel}
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} className={FIELD} />
        </label>
        <label className="text-sm font-medium">
          {guide.secretLabel}
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            className={FIELD}
          />
        </label>
        <div>
          <button
            type="submit"
            disabled={isBusy || !clientId.trim() || !clientSecret.trim()}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
          >
            {isBusy ? "Saving…" : "Save and connect"}
          </button>
          <p className="mt-2 text-sm text-slate-500">The secret is stored encrypted and is never shown again.</p>
        </div>
      </form>
    </div>
  );
}
