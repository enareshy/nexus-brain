"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { describeError } from "@/lib/api";
import { readConsentParams } from "@/lib/consent";

/**
 * Landing page after the provider's consent screen (via the API's /oauth/callback).
 * Finishes the connection with the signed-in user's token, so the pending
 * authorization can only be completed by the user who started it.
 */
export default function CompleteConnectionPage() {
  const router = useRouter();
  const { ready, user, api, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    const search = window.location.search;

    if (!user) {
      // Session expired during consent: sign in, then come straight back here.
      started.current = true;
      signIn(`/connections/complete${search}`).catch(() =>
        setError("We couldn't sign you in. Start the connection again from Connections."),
      );
      return;
    }

    started.current = true;
    // Remove the one-time code from the address bar and history immediately.
    window.history.replaceState(null, "", "/connections/complete");
    const consent = readConsentParams(new URLSearchParams(search));
    if (consent.kind === "declined") {
      setError("Access was not granted. You can try connecting again.");
      return;
    }
    if (consent.kind === "invalid") {
      setError("This link is invalid or has already been used.");
      return;
    }
    api
      .complete(consent.code, consent.state)
      .then(({ serverId }) => router.replace(`/connections?connected=${encodeURIComponent(serverId)}`))
      // The one-time code is spent either way, so always point the user to a fresh start.
      .catch((e: unknown) => setError(`${describeError(e)} Start the connection again from Connections.`));
  }, [ready, user, api, router, signIn]);

  return (
    <div className="max-w-xl">
      <h1 className="text-3xl font-bold tracking-tight">{error ? "Connection not completed" : "Finishing connection…"}</h1>
      {error && (
        <>
          <p role="alert" className="mt-4 text-red-700 dark:text-red-400">{error}</p>
          <Link href="/connections" className="mt-8 inline-block font-medium text-brand underline underline-offset-4">
            Back to connections
          </Link>
        </>
      )}
    </div>
  );
}
