"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { currentReturnPath } from "@/lib/safe-url";
import { useAuth } from "./AuthProvider";

const NAV = [
  { href: "/", label: "Search" },
  { href: "/chat", label: "Chat" },
  { href: "/agents", label: "Agents" },
  { href: "/changes", label: "Changes" },
  { href: "/connections", label: "Connections" },
  { href: "/activity", label: "Activity" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { ready, user, displayName, signIn, signOut } = useAuth();

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
          <Link href="/" className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-brand">
            <span className="text-xl font-bold tracking-tight">Nexus</span>
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Brain</span>
          </Link>
          <nav aria-label="Main navigation" className="order-last flex w-full items-center gap-1 sm:order-none sm:w-auto">
            {NAV.map((item) => {
              const isCurrent = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:text-slate-900 aria-[current=page]:bg-slate-900 aria-[current=page]:text-white dark:text-slate-300 dark:hover:text-white dark:aria-[current=page]:bg-white dark:aria-[current=page]:text-slate-900"
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            {!ready ? null : user ? (
              <>
                <span className="hidden text-slate-500 sm:inline">{displayName}</span>
                <button type="button" onClick={() => void signOut()} className="font-medium text-slate-700 underline-offset-4 hover:underline dark:text-slate-200">
                  Sign out
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void signIn(currentReturnPath())} className="font-medium text-brand underline-offset-4 hover:underline">
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-6 py-12">
        {children}
      </main>
    </div>
  );
}

/** Renders children only for signed-in users; otherwise a sign-in prompt. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, user, signIn } = useAuth();
  if (!ready) {
    return (
      <p role="status" className="text-slate-500">
        Loading…
      </p>
    );
  }
  if (!user) {
    return (
      <section className="max-w-xl">
        <h1 className="text-4xl font-bold tracking-tight">Sign in to your workspace</h1>
        <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
          Nexus Brain searches the tools you connect, using your own access.
        </p>
        <button
          type="button"
          onClick={() => void signIn(currentReturnPath())}
          className="mt-8 rounded-md bg-brand px-5 py-2.5 font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Sign in
        </button>
      </section>
    );
  }
  return <>{children}</>;
}
