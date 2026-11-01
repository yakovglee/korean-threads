import "server-only";
import { isStepCount, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { chatModel, costOf, embedPosts, recordUsage } from "@/lib/ai";
import type { Student } from "@/lib/auth";
import { catalogForPrompt, getCatalog, resolveConstructions, type Construction } from "@/lib/catalog";
import { findFragments, fragmentsForPrompt, type Fragment } from "@/lib/knowledge";
import { searchDictionary } from "@/lib/krdict";
import { createQuiz } from "@/lib/quiz";
import { createAdminClient } from "@/lib/supabase/server";
import type { AnswerEvent, Level, PostView, WordSpan } from "@/lib/types";
import { analyzeWords } from "@/lib/words";

const POST_SEPARATOR = /\n[ \t]*-{3,}[ \t]*\n/;
const META_OPEN = "<meta>";
const DICTIONARY_TITLE = "한국어기초사전";

const LEVEL_GUIDE: Record<Level, string> = {
  초급: "Объясняй просто, без лингвистических терминов. Примеры — короткие бытовые фразы. После каждого корейского примера давай романизацию в скобках.",
  중급: "Можно глубже: оттенки значения, сравнение с похожими конструкциями. Примеры средней сложности. Романизацию не пиши.",
  고급: "Объясняй глубоко: нюансы, стиль, устная и письменная речь, редкие употребления. Примеры — как из новостей, сериалов, рабочей переписки. Романизацию не пиши.",
};

function instructions(level: Level, fragments: Fragment[], catalog: Construction[]): string {
  return `Ты пишешь от имени аккаунта «문법 · Грамматика». Он объясняет корейский язык короткими постами, как текстовый блогер. Персонажа у тебя нет: не представляйся и не рассказывай о себе.

## Ученик
Уровень: ${level}. ${LEVEL_GUIDE[level]}
Обращайся на «ты».

## Формат ответа
- Ответ — тред из 3–6 коротких постов. Пост — 1–4 предложения, до 500 знаков.
- Посты разделяй строкой, на которой стоит только ---
- Первый пост цепляет: суть в одной фразе, ситуация или вопрос. Дальше — правило, примеры, частые ошибки.
- Каждый корейский пример сразу с переводом на русский.
- 1–2 эмодзи на пост, лёгкий юмор, живые примеры из жизни в Корее. Без сленга ради сленга.
- Пиши по-русски. Без заголовков, таблиц и списков; конструкцию можно выделить **так**.

## О чём можно спрашивать
Любые вопросы о корейском: грамматика, разница между похожими конструкциями, лексика, естественность фразы. Если ученик прислал своё корейское предложение на проверку — найди ошибки, дай исправленный вариант и объясни.
Если вопрос не про корейский язык, вежливо откажи одним постом и предложи спросить что-нибудь про корейский.
Уточнение относится ко всему треду; если ученик цитирует пост, отвечай именно на него.

## Учебники ученика
Ниже фрагменты из учебников ученика, пронумерованные [1], [2]… Опирайся на них в первую очередь. Номера в постах не ставь: источники ученик увидит под тредом.
Если во фрагментах нет ответа, начни первый пост словами «В твоих учебниках этого нет, объясняю по общим знаниям».

${fragmentsForPrompt(fragments)}

## Словарь
Если вопрос о значении или употреблении слова, сначала вызови инструмент lookup_word и сверься со словарём ${DICTIONARY_TITLE}. До вызова инструмента ничего не пиши.

## Служебный блок
После последнего поста с новой строки добавь блок, ученик его не увидит:
<meta>{"tags": ["-더라고요"], "words": [], "sources": [1, 2], "general": false, "offTopic": false}</meta>
- tags — 0–3 конструкции, о которых тред, только имена из каталога ниже, как они там написаны;
- words — слова в словарной форме, если вопрос про слова (например, "기대하다");
- sources — номера фрагментов, на которые ты опирался;
- general — true, если объяснял по общим знаниям, без учебников;
- offTopic — true, если вопрос не про корейский.

## Каталог конструкций
${catalogForPrompt(catalog)}`;
}

type ThreadPost = { id: string; author: string; body: string; answer_id: string | null; quote_post_id: string | null };

// Тред для модели: посты ученика — сообщения user, каждый ответ бота — одно сообщение assistant.
function toMessages(posts: ThreadPost[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const post of posts) {
    if (post.author === "student") {
      const quoted = post.quote_post_id ? posts.find((p) => p.id === post.quote_post_id) : null;
      const content = quoted ? `Цитирую пост:\n«${quoted.body}»\n\n${post.body}` : post.body;
      messages.push({ role: "user", content });
    } else {
      const prev = messages.at(-1);
      if (prev?.role === "assistant" && typeof prev.content === "string") prev.content += `\n---\n${post.body}`;
      else messages.push({ role: "assistant", content: post.body });
    }
  }
  return messages;
}

type Meta = { tags: string[]; words: string[]; sources: number[]; general: boolean; offTopic: boolean };

export function parseMeta(raw: string): Meta | null {
  const json = raw
    .replace(/<\/meta>[\s\S]*$/, "")
    .replace(/^```(?:json)?|```$/g, "")
    .trim();
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    return {
      tags: strings(v.tags),
      words: strings(v.words).filter((w) => /[가-힣]/.test(w)),
      sources: Array.isArray(v.sources) ? v.sources.filter((n): n is number => typeof n === "number") : [],
      general: v.general === true,
      offTopic: v.offTopic === true,
    };
  } catch {
    return null;
  }
}

// Делит поток текста на посты по строке «---» и отрезает служебный блок.
export class PostSplitter {
  private pending = "";
  meta = "";
  private inMeta = false;

  push(delta: string): string[] {
    if (this.inMeta) {
      this.meta += delta;
      return [];
    }
    this.pending += delta;
    const at = this.pending.indexOf(META_OPEN);
    if (at >= 0) {
      this.meta = this.pending.slice(at + META_OPEN.length);
      this.pending = this.pending.slice(0, at);
      this.inMeta = true;
      return this.drain(true);
    }
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const bodies: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = POST_SEPARATOR.exec(this.pending))) {
      bodies.push(this.pending.slice(0, m.index));
      this.pending = this.pending.slice(m.index + m[0].length);
    }
    if (final) {
      bodies.push(this.pending);
      this.pending = "";
    }
    return bodies.map((b) => b.trim()).filter(Boolean);
  }
}

type DictionaryHit = { word: string; quote: string };

export function toPostView(row: {
  id: string;
  author: string;
  body: string;
  answer_id: string | null;
  quote_post_id: string | null;
  words: unknown;
  created_at: string;
}): PostView {
  return {
    id: row.id,
    author: row.author as PostView["author"],
    body: row.body,
    answerId: row.answer_id,
    quotePostId: row.quote_post_id,
    words: (row.words as WordSpan[] | null) ?? null,
    createdAt: row.created_at,
  };
}

// Ответ бота на последний пост ученика в треде. Посты сохраняются по одному и сразу уходят ученику.
export async function* generateAnswer(student: Student & { level: Level }, threadId: string): AsyncGenerator<AnswerEvent> {
  const admin = createAdminClient();
  const { data: thread } = await admin.from("threads").select("id, user_id, title").eq("id", threadId).maybeSingle();
  if (!thread || thread.user_id !== student.id) {
    yield { type: "error", message: "Тред не найден" };
    return;
  }
  const { data: posts } = await admin
    .from("posts")
    .select("id, author, body, answer_id, quote_post_id")
    .eq("thread_id", threadId)
    .order("seq");
  const last = posts?.at(-1);
  if (!posts || !last || last.author !== "student") {
    yield { type: "error", message: "В треде нет вопроса без ответа" };
    return;
  }

  yield { type: "typing" };

  const firstAnswer = !posts.some((p) => p.author === "bot");
  const quoted = last.quote_post_id ? posts.find((p) => p.id === last.quote_post_id) : null;
  const query = [firstAnswer ? null : thread.title, quoted?.body, last.body].filter(Boolean).join("\n");
  const [fragments, catalog] = await Promise.all([findFragments(query), getCatalog()]);

  const { data: answer, error: answerError } = await admin
    .from("answers")
    .insert({ thread_id: threadId, user_id: student.id, model: student.model })
    .select("id")
    .single();
  if (answerError) throw answerError;

  const dictionary: DictionaryHit[] = [];
  const saved: { id: string; body: string }[] = [];
  let needsQuiz = false;

  const save = async (body: string): Promise<PostView> => {
    const words = await analyzeWords(body);
    const { data, error } = await admin
      .from("posts")
      .insert({ thread_id: threadId, user_id: student.id, author: "bot", answer_id: answer.id, body, words })
      .select("id, author, body, answer_id, quote_post_id, words, created_at")
      .single();
    if (error) throw error;
    saved.push({ id: data.id, body: data.body });
    return toPostView(data);
  };

  try {
    const result = streamText({
      model: chatModel(student.model),
      instructions: instructions(student.level, fragments, catalog),
      messages: toMessages(posts),
      tools: {
        lookup_word: tool({
          description: `Статья словаря ${DICTIONARY_TITLE} с переводом на русский`,
          inputSchema: z.object({ word: z.string().describe("Слово в словарной форме, например 기대하다") }),
          execute: async ({ word }) => {
            try {
              const items = await searchDictionary(word);
              for (const item of items.slice(0, 1)) {
                const sense = item.senses[0];
                dictionary.push({
                  word: item.word,
                  quote: [item.word, item.pos, sense?.translation, sense?.definition].filter(Boolean).join(" · "),
                });
              }
              return items.length ? items : { error: "В словаре такого слова нет" };
            } catch {
              return { error: "Словарь сейчас недоступен" };
            }
          },
        }),
      },
      stopWhen: isStepCount(4),
      maxOutputTokens: 4000,
    });

    const splitter = new PostSplitter();
    for await (const part of result.stream) {
      if (part.type === "error") throw part.error;
      if (part.type !== "text-delta") continue;
      for (const body of splitter.push(part.text)) {
        yield { type: "post", post: await save(body) };
        yield { type: "typing" };
      }
    }
    for (const body of splitter.finish()) yield { type: "post", post: await save(body) };
    if (saved.length === 0) throw new Error("Модель вернула пустой ответ");

    const meta = parseMeta(splitter.meta);
    const steps = await result.steps;
    const usage = await result.totalUsage;
    await recordUsage({
      userId: student.id,
      model: student.model,
      kind: "answer",
      cost: steps.reduce((sum, step) => sum + costOf(step.providerMetadata), 0),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    const offTopic = meta?.offTopic ?? false;
    const general = meta?.general ?? fragments.length === 0;
    await admin.from("answers").update({ general_knowledge: general, off_topic: offTopic }).eq("id", answer.id);

    const used = meta ? fragments.filter((f) => meta.sources.includes(f.n)) : general ? [] : fragments.slice(0, 3);
    const sources = [
      ...used.map((f) => ({ title: f.title, page: f.page, label: f.label, quote: f.content })),
      ...[...new Map(dictionary.map((d) => [d.word, d])).values()].map((d) => ({
        title: DICTIONARY_TITLE,
        page: null,
        label: d.word,
        quote: d.quote,
      })),
    ];
    if (sources.length && !offTopic) {
      await admin
        .from("answer_sources")
        .insert(sources.map((s, i) => ({ ...s, answer_id: answer.id, position: i, user_id: student.id })));
    }

    const constructions = offTopic ? [] : resolveConstructions(meta?.tags ?? [], catalog);
    const tags = [
      ...constructions.map((c) => ({ kind: "construction", value: c.name, construction_id: c.id, level: c.level })),
      ...(offTopic ? [] : (meta?.words ?? [])).map((w) => ({ kind: "word", value: w, construction_id: null, level: null })),
    ];
    if (tags.length) {
      await admin
        .from("thread_tags")
        .upsert(
          tags.map((t) => ({ ...t, thread_id: threadId, user_id: student.id })),
          { onConflict: "thread_id,kind,value", ignoreDuplicates: true },
        );
    }

    await admin.from("threads").update({ updated_at: new Date().toISOString() }).eq("id", threadId);
    await embedPosts(saved);
    needsQuiz = firstAnswer && constructions.length > 0;
  } catch (error) {
    console.error("generateAnswer", error);
    // Недописанный ответ убираем целиком, чтобы вопрос можно было задать заново.
    await admin.from("answers").delete().eq("id", answer.id);
    yield { type: "error", message: "Не получилось ответить. Попробуй ещё раз." };
    return;
  }

  yield { type: "done", answerId: answer.id };

  // Квиз — один раз на тред, в конце первого ответа, и только если у треда есть теги конструкций.
  if (needsQuiz) {
    try {
      await createQuiz(student, threadId);
      yield { type: "quiz" };
    } catch (error) {
      console.error("createQuiz", error);
    }
  }
}
