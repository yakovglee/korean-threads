// Распознавание страниц встроенным OCR macOS (Vision): PNG уходит в бинарник scripts/vision-ocr.swift, ответ — JSON.
// Бинарник собирается из исходника один раз на процесс, если его нет или он старше исходника.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { nfc } from '../ko'

export interface VisionLine { t: string; c: number; x: number; y: number; w: number; h: number } // t — текст в NFC; x, y, w, h — доли страницы 0–1 от левого верхнего угла
export interface VisionPage { lines: VisionLine[] } // строки в порядке, который дал Vision
export type VisionOcr = (imagePng: Buffer) => Promise<VisionPage>

const execFileAsync = promisify(execFile)

// Сборка по ключу «бинарник»: одна на процесс, даже если клиентов несколько
const builds = new Map<string, Promise<void>>()

function isStale(bin: string, source: string): boolean {
  if (!existsSync(bin)) return true
  return statSync(bin).mtimeMs < statSync(source).mtimeMs
}

async function ensureBinary(bin: string, source: string): Promise<void> {
  if (!isStale(bin, source)) return
  let pending = builds.get(bin)
  if (!pending) {
    pending = (async () => {
      mkdirSync(dirname(bin), { recursive: true })
      try {
        await execFileAsync('swiftc', ['-O', source, '-o', bin], { maxBuffer: 16 * 1024 * 1024 })
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? ''
        throw new Error(`swiftc не собрал ${source}: ${stderr.trim() || (err as Error).message}`)
      }
    })()
    builds.set(bin, pending)
    // при ошибке сборки запоминать её не надо: следующий вызов соберёт заново
    pending.catch(() => builds.delete(bin))
  }
  await pending
}

// PNG в stdin, в stdout одна строка JSON; ненулевой код выхода — ошибка с stderr
function runOcr(bin: string, imagePng: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { out += d })
    child.stderr.on('data', (d: string) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`vision-ocr завершился с кодом ${code}: ${err.trim()}`))
    })
    // если процесс упал раньше, чем принял вход, запись в stdin даёт EPIPE: ошибку покажет код выхода
    child.stdin.on('error', () => {})
    child.stdin.end(imagePng)
  })
}

export function appleVision(opts: { bin?: string; source?: string } = {}): VisionOcr {
  const bin = opts.bin ?? join(process.cwd(), 'data/bin/vision-ocr')
  const source = opts.source ?? join(process.cwd(), 'scripts/vision-ocr.swift')
  return async (imagePng: Buffer): Promise<VisionPage> => {
    await ensureBinary(bin, source)
    const raw = await runOcr(bin, imagePng)
    const parsed = JSON.parse(raw.trim()) as { lines?: unknown }
    if (!parsed || !Array.isArray(parsed.lines)) throw new Error('vision-ocr: в ответе нет поля lines')
    const lines = (parsed.lines as VisionLine[]).map((l) => ({
      t: nfc(l.t),
      c: l.c,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
    }))
    return { lines }
  }
}
