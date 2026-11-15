export type ModelRole = 'write' | 'light' | 'vision' | 'verify' | 'embed'

export interface Config {
  openrouterKey: string | undefined
  krdictApiKey: string | undefined
  analyzerUrl: string
  analyzerSecret: string | undefined
  models: Record<ModelRole, string>
  databaseUrl: string
  tz: string
  examDate: string | null
  ownerPasswordHash: string | undefined
  sessionSecret: string | undefined
  publicFeed: boolean
  kbSourceDir: string | undefined
}

const DEFAULT_MODELS: Record<ModelRole, string> = {
  write: 'anthropic/claude-sonnet-5.5',
  light: 'anthropic/claude-haiku-5.5',
  vision: 'google/gemini-3.8-flash',
  verify: 'google/gemini-3.8-flash',
  embed: 'baai/bge-m3',
}

const DEFAULT_ANALYZER_URL = 'http://127.0.0.1:8000'
const DEFAULT_TZ = 'Asia/Jayapura'
const EXAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Пустая строка в переменной считается как «не задана».
// Тип шире NodeJS.ProcessEnv: Next подмешивает туда обязательный NODE_ENV, и {} не проходит.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const get = (key: string): string | undefined => env[key]?.trim() || undefined
  const examDate = get('EXAM_DATE')

  return {
    openrouterKey: get('OPENROUTER_API_KEY'),
    krdictApiKey: get('KRDICT_API_KEY'),
    analyzerUrl: get('ANALYZER_URL') ?? DEFAULT_ANALYZER_URL,
    analyzerSecret: get('ANALYZER_SECRET'),
    models: {
      write: get('MODEL_WRITE') ?? DEFAULT_MODELS.write,
      light: get('MODEL_LIGHT') ?? DEFAULT_MODELS.light,
      vision: get('MODEL_VISION') ?? DEFAULT_MODELS.vision,
      verify: get('MODEL_VERIFY') ?? DEFAULT_MODELS.verify,
      embed: get('MODEL_EMBED') ?? DEFAULT_MODELS.embed,
    },
    databaseUrl: get('DATABASE_URL') ?? '',
    tz: get('APP_TZ') ?? DEFAULT_TZ,
    examDate: examDate && EXAM_DATE_RE.test(examDate) ? examDate : null,
    ownerPasswordHash: get('OWNER_PASSWORD_HASH'),
    sessionSecret: get('SESSION_SECRET'),
    // выключатель публичного доступа: лента открыта, только если переменная не задана или явно включена;
    // любое другое значение, включая опечатку, закрывает ленту
    publicFeed: ['on', 'true', '1', 'yes'].includes((get('PUBLIC_FEED') ?? 'on').toLowerCase()),
    kbSourceDir: get('KB_SOURCE_DIR'),
  }
}
