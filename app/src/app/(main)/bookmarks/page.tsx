import Link from "next/link";
import { PostCard } from "@/components/post-card";
import { listBookmarks } from "@/lib/threads";

export default async function BookmarksPage() {
  const bookmarks = await listBookmarks();

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">Закладки</h1>
      {bookmarks.length === 0 ? (
        <p className="py-10 text-center text-muted">Сохраняй полезные посты значком закладки — они соберутся здесь.</p>
      ) : (
        <ul className="space-y-2">
          {bookmarks.map((b) => (
            <li key={b.post.id} className="border-b border-line pb-1">
              <Link href={`/t/${b.threadId}`} className="mb-2 block text-xs text-muted hover:text-foreground">
                {b.threadTitle}
              </Link>
              <PostCard post={b.post} bookmarked />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
