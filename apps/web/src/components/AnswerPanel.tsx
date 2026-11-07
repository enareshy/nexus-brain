import type { ReactNode } from "react";
import type { AnswerPart, AnswerState } from "@/lib/answer";
import { safeHttpUrl } from "@/lib/safe-url";

/** "[n]" the model typed into its text. Real citations arrive as their own parts. */
const WRITTEN_MARKER = /\[\d{1,3}\]/g;
const WRITTEN_TITLE = "Written by the AI, not a checked citation";
const QUOTES_SHOWN_PER_SOURCE = 3;

/** Shows typed "[n]" greyed out, so it is not mistaken for a linked citation. */
function renderText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(WRITTEN_MARKER)) {
    nodes.push(text.slice(from, match.index));
    nodes.push(
      <span key={match.index} title={WRITTEN_TITLE} className="text-slate-400 dark:text-slate-500">
        {match[0]}
      </span>,
    );
    from = match.index + match[0].length;
  }
  nodes.push(text.slice(from));
  return nodes;
}

function hasWrittenMarkers(parts: readonly AnswerPart[]): boolean {
  return parts.some((part) => part.kind === "text" && new RegExp(WRITTEN_MARKER.source).test(part.text));
}

/** Distinct passages cited from each source, in the order they were cited. */
function quotesBySource(parts: readonly AnswerPart[]): ReadonlyMap<number, readonly string[]> {
  const result = new Map<number, readonly string[]>();
  for (const part of parts) {
    if (part.kind !== "cite") continue;
    const seen = result.get(part.source) ?? [];
    const added = (part.quotes ?? []).filter((quote, index, all) => !seen.includes(quote) && all.indexOf(quote) === index);
    result.set(part.source, [...seen, ...added].slice(0, QUOTES_SHOWN_PER_SOURCE));
  }
  return result;
}

type Props = {
  state: AnswerState;
  /** The search results are on the page already, so they are not listed again here. */
  resultsShownElsewhere?: boolean;
};

function outcomeNote(state: AnswerState): string | null {
  if (state.status !== "done") return null;
  switch (state.outcome) {
    case "no_documents":
      return "Nothing you can access matched this question, so no answer was generated.";
    case "refused":
      return "The AI declined to answer this question. The search results are still available.";
    case "incomplete":
      return "This answer was cut off and may be incomplete.";
    case "search_only":
      return "The AI service is not available right now, so here is what the search found, without an answer. Try again in a minute.";
    default:
      return state.grounded ? null : "This answer has no citations. Check it against the sources.";
  }
}

/**
 * Renders the answer and its sources as plain text. Everything here derives from connected
 * services and is untrusted: React escapes it, and links exist only for safe URLs.
 */
export function AnswerPanel({ state, resultsShownElsewhere = false }: Props) {
  const note = outcomeNote(state);
  const quotes = quotesBySource(state.parts);
  const writtenMarkers = hasWrittenMarkers(state.parts);
  const hasText = state.parts.length > 0;
  const isSearchOnly = state.status === "done" && state.outcome === "search_only" && !resultsShownElsewhere;
  // With no answer to cite them, every result found is listed (NFR-AVAIL-01).
  const citedSources = isSearchOnly
    ? state.hits.map((_, index) => index + 1)
    : [...new Set(state.parts.flatMap((part) => (part.kind === "cite" ? [part.source] : [])))].sort((a, b) => a - b);

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
            if (part.kind === "text") return <span key={index}>{renderText(part.text)}</span>;
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
                title={part.quotes?.[0]}
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

      {writtenMarkers && (
        <p className="mt-3 text-sm text-slate-500">
          Grey numbers in brackets were written by the AI and are not checked citations. Only the linked numbers are.
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
        <ol aria-label="Sources" className="mt-5 space-y-1 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
          {citedSources.map((source) => {
            const hit = state.hits[source - 1];
            if (!hit) return null;
            const href = safeHttpUrl(hit.url);
            return (
              <li key={source} className="flex gap-2">
                <span className="font-mono text-xs text-slate-500">[{source}]</span>
                <div className="min-w-0">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                      {hit.title}
                    </a>
                  ) : (
                    <span>{hit.title}</span>
                  )}
                  {(quotes.get(source) ?? []).map((quote) => (
                    <blockquote
                      key={quote}
                      className="mt-1 break-words border-l-2 border-slate-200 pl-2 text-xs italic text-slate-600 dark:border-slate-700 dark:text-slate-400"
                    >
                      {quote}
                    </blockquote>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
