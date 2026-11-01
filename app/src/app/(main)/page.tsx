import Link from "next/link";
import { AskForm } from "@/components/ask-form";
import { TagChip, tagLabel } from "@/components/tag-chip";
import { listTags, listThreads } from "@/lib/threads";
import { LEVELS, type Level } from "@/lib/types";

function when(iso: string) {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(new Date(iso));
}

export default async function FeedPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const tag = typeof params.tag === "string" ? params.tag : undefined;
  const level = LEVELS.includes(params.level as Level) ? (params.level as Level) : undefined;
  const [threads, tags] = await Promise.all([listThreads({ tag, level }), listTags()]);

  const levelHref = (l?: Level) => {
    const q = new URLSearchParams();
    if (tag) q.set("tag", tag);
    if (l) q.set("level", l);
    return q.size ? `/?${q}` : "/";
  };

  return (
    <div className="space-y-6">
      <AskForm />

      {(tags.length > 0 || tag || level) && (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            {[undefined, ...LEVELS].map((l) => (
              <Link
                key={l ?? "all"}
                href={levelHref(l)}
                className={`rounded-full px-3 py-1 text-sm ${level === l ? "bg-foreground text-background" : "bg-surface text-muted"}`}
              >
                {l ?? "Все уровни"}
              </Link>
            ))}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <TagChip key={`${t.kind}:${t.value}`} tag={t} active={t.value === tag} />
              ))}
            </div>
          )}
        </div>
      )}

      {threads.length === 0 ? (
        <p className="py-10 text-center text-muted">
          {tag || level ? "По этому фильтру тредов нет." : "Здесь появятся твои треды. Задай первый вопрос 👆"}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {threads.map((t) => (
            <li key={t.id}>
              <Link href={`/t/${t.id}`} className="block py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium">{t.title}</p>
                  <span className="shrink-0 text-xs text-muted">{when(t.updatedAt)}</span>
                </div>
                {t.preview && <p className="mt-1 line-clamp-2 text-sm text-muted">{t.preview.replaceAll("**", "")}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {t.tags.map((x) => (
                    <span key={`${x.kind}:${x.value}`} className="rounded-full bg-surface px-2 py-0.5">
                      {tagLabel(x)}
                    </span>
                  ))}
                  <span>{t.postCount} пост.</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
