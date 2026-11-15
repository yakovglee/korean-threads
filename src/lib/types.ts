export type ItemKind = 'vocab' | 'grammar'
export type Level = 1 | 2 | 3 | 4 | 5 | 6
export interface Item { id: string; kind: ItemKind; level: Level; headword: string; homograph: number; pos: string; hint: string; related: string; seq: number }
export interface Segment { text: string; itemIds: string[]; unlisted: { lemma: string; pos: string }[] } // один сегмент = одна «слово-форма» (по пробелам), без пробелов
export type Paragraph = { lang: 'ko'; segments: Segment[] } | { lang: 'ru'; text: string }
export interface Source { doc: string; page: number | null }
export interface Post { id: string; threadId: string; author: { name: string; handle: string }; title?: string; paragraphs: Paragraph[]; stretchItemId?: string; sources?: Source[] }
export interface Thread { id: string; origin: 'bank' | 'chat'; posts: Post[] }
export interface Check { id: string; source: 'exam' | 'post' | 'topik-style'; stem: string; passage?: string; options: string[]; answerIndex: number; itemIds: string[]; label?: string }
