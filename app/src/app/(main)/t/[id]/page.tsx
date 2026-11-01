import { notFound } from "next/navigation";
import { deleteThread } from "@/app/actions";
import { TagChip } from "@/components/tag-chip";
import { ThreadView } from "@/components/thread-view";
import { loadQuiz } from "@/lib/quiz";
import { loadThread } from "@/lib/threads";

export default async function ThreadPage({ params, searchParams }: PageProps<"/t/[id]">) {
  const { id } = await params;
  const { new: isNew } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [thread, quiz] = await Promise.all([loadThread(id), loadQuiz(id)]);
  if (!thread) notFound();

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {thread.tags.map((t) => (
          <TagChip key={`${t.kind}:${t.value}`} tag={t} />
        ))}
        <form action={deleteThread} className="ml-auto">
          <input type="hidden" name="id" value={thread.id} />
          <button type="submit" className="text-sm text-muted hover:text-bad">
            Удалить тред
          </button>
        </form>
      </div>
      <ThreadView
        threadId={thread.id}
        posts={thread.posts}
        sources={thread.sources}
        bookmarked={thread.bookmarked}
        quiz={quiz}
        autoAsk={isNew === "1"}
      />
    </div>
  );
}
