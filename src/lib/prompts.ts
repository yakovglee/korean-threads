// Подсказки для генерации постов (банк и чат) и JSON-схемы ответа модели (RawThread с обязательными полями).
// Подсказки написаны по-русски, текст постов — по-корейски. Пустое значение в схеме — null, в код уходит как «нет поля».

export const BANK_SCHEMA_NAME = 'bank_thread'

export const BANK_SYSTEM = [
  'Ты пишешь ленту корейских постов для подготовки к экзамену TOPIK II (уровень 4급). Читает их русскоязычный ученик, который раскрывает незнакомые слова касанием.',
  '',
  'Требования к тексту:',
  '- Живой естественный корейский, как люди пишут в соцсетях. Не учебный диалог и не упражнение: никаких «안녕하세요! 저는 …» ради грамматики.',
  '- Стиль выбирай сам: либо Threads (короткие реплики в 1–3 предложения, разные авторы, ответы друг на друга, диалог или ветка), либо заметка на 3–6 абзацев с заголовком в title.',
  '- В треде от 1 до 4 постов. У каждого поста свой автор: authorName — корейское имя, authorHandle — латиницей, без @.',
  '- Все абзацы на корейском (lang всегда "ko"). Никакой разметки (звёздочек, markdown, квадратных скобок), никаких переводов, пояснений, хэштегов и эмодзи в тексте.',
  '- Уровень слов и грамматики не выше 4급. Слова 5–6급 не используй, кроме подтяжки, если она передана. Слов вне обычной учебной лексики как можно меньше.',
  '',
  'Цели:',
  '- Каждая цель (слово или конструкция из списка) должна встретиться в тексте хотя бы в одном посте и быть употреблена в том значении, на которое указывают её подсказка и русское значение.',
  '- Конструкцию употребляй в форме, по которой её можно узнать в тексте (например, -거든 — в виде 거든요 или 거든 после глагола или прилагательного).',
  '- Подтяжка (если передана): её слово используй один раз, в одном посте, и укажи его в stretchLemma. В остальных постах stretchLemma: null.',
  '',
  'Вопросы в checks: один на каждую цель.',
  '- stem — предложение на корейском с одним пропуском «___» на месте цели (слова или формы конструкции).',
  '- options — 4 разных варианта; один верный (answerIndex от 0 до 3), остальные — другие слова или формы, которые в этом предложении не подходят.',
  '- Вопрос проверяет именно цель, а не случайное слово предложения.',
  '',
  'title и stretchLemma ставь null, если они не нужны. Ответ — только JSON по схеме, без пояснений.',
].join('\n')

// Все поля обязательны (строгая схема): отсутствующее значение — null
export const BANK_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          authorName: { type: 'string' },
          authorHandle: { type: 'string' },
          title: { type: ['string', 'null'] },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lang: { type: 'string', enum: ['ko'] },
                text: { type: 'string' },
              },
              required: ['lang', 'text'],
              additionalProperties: false,
            },
          },
          stretchLemma: { type: ['string', 'null'] },
        },
        required: ['authorName', 'authorHandle', 'title', 'paragraphs', 'stretchLemma'],
        additionalProperties: false,
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
        },
        required: ['stem', 'options', 'answerIndex'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts', 'checks'],
  additionalProperties: false,
}

export interface PromptTarget {
  kind: 'vocab' | 'grammar'
  headword: string
  pos: string
  hint: string
  gloss?: string
  explanation?: string
  examples: string[]
}

export interface PromptFragment { source: string; text: string }

export interface BankPrompt {
  targets: PromptTarget[]
  stretch?: PromptTarget
  fragments: PromptFragment[]
  // ошибки прошлой попытки: в повтор идут как есть
  errors?: string[]
}

export function bankUserPrompt(p: BankPrompt): string {
  const out: string[] = ['Цели треда:']
  for (const t of p.targets) out.push(targetLine(t))
  if (p.stretch) {
    out.push('', 'Подтяжка (одно слово 5–6급, используй один раз и укажи в stretchLemma):', targetLine(p.stretch))
  }
  out.push(...fragmentLines(p.fragments, 'Фрагменты из учебника и грамматики (для точности значения, текст не копируй):'))
  out.push(...errorLines(p.errors))
  return out.join('\n')
}

function targetLine(t: PromptTarget): string {
  const what = t.kind === 'grammar' ? 'конструкция' : 'слово'
  const parts = [
    `${what} ${t.headword}`,
    t.pos ? `часть речи: ${t.pos}` : '',
    t.hint ? `подсказка: ${t.hint}` : '',
    t.gloss ? `значение: ${t.gloss}` : '',
    t.explanation ? `пояснение: ${t.explanation}` : '',
    t.examples.length > 0 ? `примеры: ${t.examples.join(' / ')}` : '',
  ]
  return `- ${parts.filter(s => s !== '').join('; ')}`
}

// ---- чат: ответ на вопрос ученика, тред без вопросов ----

export const CHAT_SCHEMA_NAME = 'chat_thread'

export const CHAT_SYSTEM = [
  'Ты отвечаешь ученику в чате ленты корейских постов. Ученик готовится к экзамену TOPIK II (уровень 4급) и пишет по-русски или по-корейски. Его сообщение — вопрос про слово, конструкцию, фразу или ситуацию («объясни -거든», «как извиниться перед начальником»). Ответ — тред из 1–4 постов; объяснения всегда по-русски.',
  '',
  'Требования к ответу:',
  '- Абзац с lang "ru" — объяснение по-русски: значение, отличие от похожих форм, когда употребляется.',
  '- Абзац с lang "ko" — пример по-корейски: живая естественная фраза, как в разговоре или соцсетях, а не учебный диалог.',
  '- В ko-абзаце только корейский текст, без перевода и пояснений. Никакой разметки (звёздочек, markdown, квадратных скобок), эмодзи и хэштегов.',
  '- Слова и грамматика — в пределах 4급, где это возможно. Более сложную лексику объясняй в ru-абзаце.',
  '- Фрагменты из учебника и базы знаний (если переданы) — для точности значения; текст не копируй.',
  '- Поле fragments каждого поста — номера фрагментов из подсказки (цифры в квадратных скобках: [1], [2] …), на которые опирается этот пост. Номеров, которых нет в подсказке, не придумывай. Если пост ни на что не опирается, fragments — пустой список [].',
  '',
  'Вопросов (checks) не придумывай: в ответе их нет.',
  'authorName — короткое имя автора ответа, authorHandle — латиницей, без @. title — короткий заголовок или null.',
  '',
  'Ответ — только JSON по схеме, без пояснений.',
].join('\n')

// Все поля обязательны (строгая схема): отсутствующее значение — null. Подтяжки в чате нет, вопросов нет.
// fragments — всегда список номеров фрагментов из подсказки, пустой, если опоры нет (не null).
export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          authorName: { type: 'string' },
          authorHandle: { type: 'string' },
          title: { type: ['string', 'null'] },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lang: { type: 'string', enum: ['ko', 'ru'] },
                text: { type: 'string' },
              },
              required: ['lang', 'text'],
              additionalProperties: false,
            },
          },
          fragments: { type: 'array', items: { type: 'integer' } },
        },
        required: ['authorName', 'authorHandle', 'title', 'paragraphs', 'fragments'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts'],
  additionalProperties: false,
}

export interface ChatPrompt {
  message: string
  fragments: PromptFragment[]
  // ошибки прошлой попытки: в повтор идут как есть
  errors?: string[]
}

export function chatUserPrompt(p: ChatPrompt): string {
  return [
    'Сообщение ученика:',
    p.message,
    ...fragmentLines(p.fragments, 'Фрагменты из базы знаний (для точности значения, текст не копируй):'),
    ...errorLines(p.errors),
  ].join('\n')
}

// Блок фрагментов; без фрагментов блока нет
function fragmentLines(fragments: PromptFragment[], header: string): string[] {
  if (fragments.length === 0) return []
  return ['', header, ...fragments.map((f, i) => `[${i + 1}] ${f.source}: ${f.text}`)]
}

// Блок ошибок прошлой попытки; без ошибок блока нет
function errorLines(errors: string[] | undefined): string[] {
  if (!errors || errors.length === 0) return []
  return ['', 'Прошлый ответ не прошёл проверку. Исправь все ошибки и верни тред целиком:', ...errors.map(e => `- ${e}`)]
}
