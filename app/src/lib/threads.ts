import "server-only";
import { after } from "next/server";
import { embedPosts, embedTexts } from "@/lib/ai";
import type { Student } from "@/lib/auth";
import { toPostView } from "@/lib/bot";
import { toVector } from "@/lib/embedding";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { Level, PostView, SourceView, TagView } from "@/lib/types";
import { analyzeWords } from "@/lib/words";

const TITLE_LENGTH = 120;
const POST_COLUMNS = "id, author, body, answer_id, quote_post_id, words, created_at";

// Пост ученика: вопрос или уточнение. Слова разбираются сразу, эмбеддинг — после ответа сервера.
export async function addStudentPost(
  student: Student,
  threadId: string,
  text: string,
  quoteId: string | null,
): Promise<PostView | null> {
  const supabase = await createClient();
  const { data: thread } = await supabase.from("threads").select("id").eq("id", threadId).maybeSingle();
  if (!thread) return null;
  if (quoteId) {
    const { data: quoted } = await supabase
      .from("posts")
      .select("id")
      .eq("id", quoteId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (!quoted) quoteId = null;
  }

  const words = await analyzeWords(text);
  const { data: post, error } = await createAdminClient()
    .from("posts")
    .insert({ thread_id: threadId, user_id: student.id, author: "student", body: text, quote_post_id: quoteId, words })
    .select(POST_COLUMNS)
    .single();
  if (error) throw error;
  after(() => embedPosts([post]));
  return toPostView(post);
}

export async function createThread(student: Student, text: string): Promise<string> {
  const title = text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text;
  const { data, error } = await createAdminClient()
    .from("threads")
    .insert({ user_id: student.id, title })
    .select("id")
    .single();
  if (error) throw error;
  await addStudentPost(student, data.id, text, null);
  return data.id;
}

export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string | null;
  postCount: number;
  tags: TagView[];
};

function tagViews(rows: { kind: string; value: string; level: Level | null }[]): TagView[] {
  return rows.map((t) => ({ kind: t.kind as TagView["kind"], value: t.value, level: t.level }));
}

// Лента: свои треды, фильтр по тегу и уровню.
export async function listThreads(filter: { tag?: string; level?: Level }): Promise<ThreadSummary[]> {
  const supabase = await createClient();
  let query = supabase.from("threads").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(100);

  if (filter.tag || filter.level) {
    let tags = supabase.from("thread_tags").select("thread_id");
    if (filter.tag) tags = tags.eq("value", filter.tag);
    if (filter.level) tags = tags.eq("level", filter.level);
    const { data } = await tags;
    query = query.in("id", [...new Set((data ?? []).map((t) => t.thread_id))]);
  }

  const { data: threads } = await query;
  if (!threads?.length) return [];
  const ids = threads.map((t) => t.id);
  const [{ data: posts }, { data: tags }] = await Promise.all([
    supabase.from("posts").select("thread_id, author, body").in("thread_id", ids).order("seq"),
    supabase.from("thread_tags").select("thread_id, kind, value, level").in("thread_id", ids),
  ]);

  return threads.map((t) => {
    const own = (posts ?? []).filter((p) => p.thread_id === t.id);
    return {
      id: t.id,
      title: t.title,
      updatedAt: t.updated_at,
      preview: own.find((p) => p.author === "bot")?.body ?? null,
      postCount: own.length,
      tags: tagViews((tags ?? []).filter((x) => x.thread_id === t.id)),
    };
  });
}

// Все теги ученика — для фильтров ленты.
export async function listTags(): Promise<TagView[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("thread_tags").select("kind, value, level").order("value");
  const unique = new Map((data ?? []).map((t) => [`${t.kind}:${t.value}`, t]));
  return tagViews([...unique.values()]);
}

export type ThreadDetail = {
  id: string;
  title: string;
  posts: PostView[];
  sources: SourceView[];
  tags: TagView[];
  bookmarked: string[];
  generalAnswers: string[];
};

export async function loadThread(id: string): Promise<ThreadDetail | null> {
  const supabase = await createClient();
  const { data: thread } = await supabase.from("threads").select("id, title").eq("id", id).maybeSingle();
  if (!thread) return null;
  const [{ data: posts }, { data: sources }, { data: tags }, { data: answers }] = await Promise.all([
    supabase.from("posts").select(POST_COLUMNS).eq("thread_id", id).order("seq"),
    supabase
      .from("answer_sources")
      .select("answer_id, position, title, page, label, quote, answers!inner(thread_id)")
      .eq("answers.thread_id", id)
      .order("position"),
    supabase.from("thread_tags").select("kind, value, level").eq("thread_id", id),
    supabase.from("answers").select("id, general_knowledge").eq("thread_id", id),
  ]);
  const postIds = (posts ?? []).map((p) => p.id);
  const { data: bookmarks } = postIds.length
    ? await supabase.from("bookmarks").select("post_id").in("post_id", postIds)
    : { data: [] };

  return {
    id: thread.id,
    title: thread.title,
    posts: (posts ?? []).map(toPostView),
    sources: (sources ?? []).map((s) => ({
      answerId: s.answer_id,
      position: s.position,
      title: s.title,
      page: s.page,
      label: s.label,
      quote: s.quote,
    })),
    tags: tagViews(tags ?? []),
    bookmarked: (bookmarks ?? []).map((b) => b.post_id),
    generalAnswers: (answers ?? []).filter((a) => a.general_knowledge).map((a) => a.id),
  };
}

export type BookmarkView = { post: PostView; threadId: string; threadTitle: string; savedAt: string };

export async function listBookmarks(): Promise<BookmarkView[]> {
  const supabase = await createClient();
  const { data: bookmarks } = await supabase
    .from("bookmarks")
    .select("post_id, created_at")
    .order("created_at", { ascending: false });
  if (!bookmarks?.length) return [];
  const { data: posts } = await supabase
    .from("posts")
    .select(`${POST_COLUMNS}, thread_id`)
    .in("id", bookmarks.map((b) => b.post_id));
  const { data: threads } = await supabase
    .from("threads")
    .select("id, title")
    .in("id", [...new Set((posts ?? []).map((p) => p.thread_id))]);
  const titleOf = new Map((threads ?? []).map((t) => [t.id, t.title]));
  const postOf = new Map((posts ?? []).map((p) => [p.id, p]));

  return bookmarks.flatMap((b) => {
    const p = postOf.get(b.post_id);
    return p ? [{ post: toPostView(p), threadId: p.thread_id, threadTitle: titleOf.get(p.thread_id) ?? "", savedAt: b.created_at }] : [];
  });
}

export type SearchHit = { postId: string; threadId: string; threadTitle: string; body: string; author: string; exact: boolean };

// Поиск по своим тредам: точное вхождение и по смыслу.
export async function searchPosts(query: string): Promise<SearchHit[]> {
  const q = query.trim().replace(/^-+/, "");
  if (!q) return [];
  let embedding: string | undefined;
  try {
    embedding = toVector((await embedTexts([query]))[0]);
  } catch (error) {
    console.error("searchPosts embedding", error);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_posts", { query: q, query_embedding: embedding });
  if (error) throw error;
  return data.map((r) => ({
    postId: r.post_id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    body: r.body,
    author: r.author,
    exact: r.exact,
  }));
}
