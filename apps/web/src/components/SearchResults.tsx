import Link from "next/link";
import type { SearchResult, SourceStatus } from "@/lib/api";
import { safeHttpUrl } from "@/lib/safe-url";

type Props = { result: SearchResult; query: string };

const SOURCE_PROBLEM: Record<string, string> = {
  RECONNECT_REQUIRED: "needs reconnecting",
  TIMEOUT: "was too slow to answer",
  UNAVAILABLE: "is unavailable",
};

function SourceNotice({ sources }: { sources: readonly SourceStatus[] }) {
  const failing = sources.filter((s) => !s.ok);
  if (failing.length === 0) return null;
  return (
    <div className="mb-6 rounded-md border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {failing.map((s) => (
        <p key={s.id}>
          <span className="font-semibold">{s.id}</span> {SOURCE_PROBLEM[s.error ?? ""] ?? "returned an error"}.
          {s.error === "RECONNECT_REQUIRED" && (
            <>
              {" "}
              <Link href="/connections" className="font-medium underline underline-offset-2">
                Reconnect
              </Link>
            </>
          )}
        </p>
      ))}
    </div>
  );
}

/**
 * Renders hits as plain text. Titles and snippets come from connected services and are
 * untrusted: React escapes them, and links are only rendered for safe https URLs.
 */
export function SearchResults({ result, query }: Props) {
  const searched = result.sources.length;
  if (searched === 0) {
    return (
      <p className="text-slate-500">
        No connected services to search yet.{" "}
        <Link href="/connections" className="font-medium text-brand underline underline-offset-2">
          Connect Jira
        </Link>{" "}
        to start.
      </p>
    );
  }

  return (
    <section aria-labelledby="results-heading">
      <SourceNotice sources={result.sources} />
      <h2 id="results-heading" className="mb-4 text-sm font-medium uppercase tracking-widest text-slate-500">
        {result.hits.length} {result.hits.length === 1 ? "result" : "results"} for “{query}”
      </h2>
      {result.expandedTerms && result.expandedTerms.length > 0 && (
        <p className="mb-4 text-sm text-slate-500">
          {result.hits.length > 0
            ? "No exact matches, so these results also use AI-suggested words: "
            : "No matches, even with AI-suggested words: "}
          {result.expandedTerms.join(", ")}.
        </p>
      )}
      {result.hits.length === 0 ? (
        <p className="text-slate-500">Nothing you can access matched. Try different words.</p>
      ) : (
        <ol className="space-y-6">
          {result.hits.map((hit) => {
            const href = safeHttpUrl(hit.url);
            return (
              <li key={`${hit.serverId}:${hit.externalId}`} className="group">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-slate-500">{hit.externalId}</span>
                  <span className="text-xs text-slate-400">{hit.serverId}</span>
                </div>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lg font-semibold text-slate-900 decoration-brand decoration-2 underline-offset-4 hover:underline focus-visible:underline dark:text-slate-100"
                  >
                    {hit.title}
                  </a>
                ) : (
                  <span className="text-lg font-semibold">{hit.title}</span>
                )}
                {hit.snippet && <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">{hit.snippet}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
