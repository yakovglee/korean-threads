import Link from "next/link";
import { BOT_NAME } from "@/components/post-card";
import { searchPosts, type SearchHit } from "@/lib/threads";

function Hit({ hit, query }: { hit: SearchHit; query: string }) {
  const body = hit.body.replaceAll("**", "");
  const needle = query.replace(/^-+/, "").toLowerCase();
  const at = hit.exact ? body.toLowerCase().indexOf(needle) : -1;
  const start = Math.max(0, at - 60);
  const snippet = at >= 0 ? body.slice(start, at + needle.length + 120) : body.slice(0, 180);

  return (
    <li>
      <Link href={`/t/${hit.threadId}`} className="block rounded-2xl px-4 py-3 hover:bg-surface">
        <p className="text-xs text-muted">
          {hit.threadTitle} · {hit.author === "bot" ? BOT_NAME : "ты"}
        </p>
        <p className="mt-1 text-sm">
          {start > 0 && "…"}
          {at >= 0 ? (
            <>
              {snippet.slice(0, at - start)}
              <mark className="rounded bg-accent-soft px-0.5 text-accent">{snippet.slice(at - start, at - start + needle.length)}</mark>
              {snippet.slice(at - start + needle.length)}
            </>
          ) : (
            snippet
          )}
          …
        </p>
      </Link>
    </li>
  );
}

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const hits = query ? await searchPosts(query) : [];
  const exact = hits.filter((h) => h.exact);
  const semantic = hits.filter((h) => !h.exact);

  return (
    <div className="space-y-6">
      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={query}
          placeholder="-더라고요 или «как сказать, что я это видел сам»"
          className="min-w-0 flex-1 rounded-xl border border-line bg-background px-4 py-2.5 outline-none focus:border-accent"
        />
        <button className="rounded-xl bg-foreground px-4 text-sm font-medium text-background">Найти</button>
      </form>
      <p className="text-sm text-muted">Ищет только по твоим тредам: и точные слова, и по смыслу.</p>

      {query && hits.length === 0 && <p className="py-6 text-center text-muted">Ничего не нашлось.</p>}
      {exact.length > 0 && (
        <section>
          <h2 className="mb-1 px-4 text-sm font-semibold">Точные совпадения</h2>
          <ul>
            {exact.map((h) => (
              <Hit key={h.postId} hit={h} query={query} />
            ))}
          </ul>
        </section>
      )}
      {semantic.length > 0 && (
        <section>
          <h2 className="mb-1 px-4 text-sm font-semibold">Похоже по смыслу</h2>
          <ul>
            {semantic.map((h) => (
              <Hit key={h.postId} hit={h} query={query} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
