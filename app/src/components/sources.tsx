import type { SourceView } from "@/lib/types";

// «📖 Источники» под ответом: книга и страница PDF, по нажатию — цитата.
export function Sources({ sources }: { sources: SourceView[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="mb-5 ml-12 rounded-2xl bg-surface px-4 py-3 text-sm">
      <p className="font-medium">📖 Источники</p>
      <ul className="mt-2 space-y-1">
        {sources.map((s) => (
          <li key={`${s.answerId}-${s.position}`}>
            <details className="group">
              <summary className="cursor-pointer list-none text-muted hover:text-foreground">
                <span className="mr-1 inline-block transition group-open:rotate-90">›</span>
                {s.title}
                {s.page ? ` · стр. ${s.page}` : ""}
                {s.label ? ` · ${s.label}` : ""}
              </summary>
              <blockquote className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-background px-3 py-2 text-[13px] leading-relaxed">
                {s.quote}
              </blockquote>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
