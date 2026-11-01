"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { userManager } from "@/lib/auth";
import { safeReturnPath } from "@/lib/safe-url";

/** OIDC redirect target: exchanges the code (PKCE) and returns to where sign-in started. */
export default function AuthCallbackPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [failed, setFailed] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    userManager()
      .signinRedirectCallback()
      .then((user) => {
        const state = user.state as { returnTo?: string } | undefined;
        router.replace(safeReturnPath(state?.returnTo));
      })
      .catch(() => setFailed(true));
  }, [router]);

  if (!failed) {
    return (
      <p role="status" className="text-slate-500">
        Signing you in…
      </p>
    );
  }
  return (
    <div role="alert">
      <p className="text-red-700 dark:text-red-400">Sign-in failed or this link was already used.</p>
      <button
        type="button"
        onClick={() => void signIn("/")}
        className="mt-6 rounded-md bg-brand px-5 py-2.5 font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        Sign in again
      </button>
    </div>
  );
}
