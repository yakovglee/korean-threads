export const LEVELS = ["초급", "중급", "고급"] as const;
export type Level = (typeof LEVELS)[number];

// Нажимаемое слово поста: [начало, конец) в тексте и словарная форма.
export type WordSpan = { s: number; e: number; l: string };

export type PostView = {
  id: string;
  author: "student" | "bot";
  body: string;
  answerId: string | null;
  quotePostId: string | null;
  words: WordSpan[] | null;
  createdAt: string;
};

export type SourceView = {
  answerId: string;
  position: number;
  title: string;
  page: number | null;
  label: string | null;
  quote: string;
};

export type TagView = {
  kind: "construction" | "word";
  value: string;
  level: Level | null;
};

// События потока ответа бота (NDJSON из /api/threads/[id]/answer).
export type AnswerEvent =
  | { type: "typing" }
  | { type: "post"; post: PostView }
  | { type: "done"; answerId: string }
  | { type: "quiz" }
  | { type: "error"; message: string };

export type QuizItemKind = "reading" | "listening" | "generated" | "own_sentence";

export type QuizItemContent = {
  instruction: string;
  passage?: string | null;
  options?: string[];
  source: string;
  construction?: string;
};

export type QuizSolution = {
  answer?: number;
  explanation?: string | null;
  script?: string | null;
  form?: string | null;
};

export type AttemptResult = {
  correct: boolean | null;
  choice: number | null;
  sentence: string | null;
  feedback: string | null;
  solution: QuizSolution | null;
};

export type QuizItemView = {
  id: string;
  batch: number;
  kind: QuizItemKind;
  content: QuizItemContent;
  attempt: AttemptResult | null;
};

export type WordCard = {
  word: string;
  translation: string | null;
  definition: string | null;
  level: string | null;
  pos: string | null;
  pronunciation: string | null;
  example: string | null;
  audioUrl: string | null;
  link: string | null;
};
