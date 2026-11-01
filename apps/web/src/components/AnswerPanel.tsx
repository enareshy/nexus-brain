import type { AnswerState } from "@/lib/answer";
import { safeHttpUrl } from "@/lib/safe-url";

type Props = { state: AnswerState };

function outcomeNote(state: AnswerState): string | null {
  if (state.status !== "done") return null;
  switch (state.outcome) {
    case "no_documents":
      return "Nothing you can access matched this question, so no answer was generated.";
    case "refused":
      return "The AI declined to answer this question. The search results are still available.";
    case "incomplete":
      return "This answer was cut off and may be incomplete.";
    default:
      return state.grounded ? null : "This answer has no citations. Check it against the sources.";
  }
}

/**
 * Renders the answer and its sources as plain text. Everything here derives from connected
 * services and is untrusted: React escapes it, and links exist only for safe URLs.
 */
export function AnswerPanel({ state }: Props) {
  const note = outcomeNote(state);
  const hasText = state.parts.length > 0;
  const citedSources = [
    ...new Set(state.parts.flatMap((part) => (part.kind === "cite" ? [part.source] : []))),
  ].sort((a, b) => a - b);

  return (
    <section
      aria-labelledby="answer-heading"
      className="mb-12 rounded-lg border-l-4 border-brand bg-white px-6 py-5 shadow-sm dark:bg-slate-900"
    >
      <h2 id="answer-heading" className="font-mono text-xs uppercase tracking-[0.2em] text-brand">
        AI answer
      </h2>

      {state.status === "streaming" && !hasText && (
        <p className="mt-3 text-slate-500">Reading your sources…</p>
      )}

      {hasText && (
        <p className="mt-3 whitespace-pre-wrap text-lg leading-relaxed">
          {state.parts.map((part, index) => {
            if (part.kind === "text") return <span key={index}>{part.text}</span>;
            const hit = state.hits[part.source - 1];
            const href = hit ? safeHttpUrl(hit.url) : null;
            const label = `[${part.source}]`;
            return href ? (
              <a
                key={index}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Source ${part.source}: ${hit?.title}`}
                className="mx-0.5 align-super font-mono text-xs font-semibold text-brand hover:underline"
              >
                {label}
              </a>
            ) : (
              <sup key={index} className="mx-0.5 font-mono text-xs">
                {label}
              </sup>
            );
          })}
        </p>
      )}

      {note && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{note}</p>}
      {state.status === "done" && state.truncatedDocuments > 0 && (
        <p className="mt-2 text-sm text-slate-500">
          {state.truncatedDocuments === 1 ? "One long document was" : `${state.truncatedDocuments} long documents were`} only partly read.
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-3 text-red-700 dark:text-red-400">
          {state.error}
        </p>
      )}

      {citedSources.length > 0 && (
        <ol className="mt-5 space-y-1 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
          {citedSources.map((source) => {
            const hit = state.hits[source - 1];
            if (!hit) return null;
            const href = safeHttpUrl(hit.url);
            return (
              <li key={source} className="flex gap-2">
                <span className="font-mono text-xs text-slate-500">[{source}]</span>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                    {hit.title}
                  </a>
                ) : (
                  <span>{hit.title}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
