// Корейские утилиты: нормализация, омонимы, совместимые джамо.

export function nfc(s: string): string {
  return s.normalize('NFC')
}

// Сочетаемые джамо U+1100–U+11FF → совместимые U+3131–U+318E.
// NFKC здесь не годится: он идёт в обратную сторону (совместимый → сочетаемый).
// Буквы заданы строками в порядке кодов сочетаемых джамо.
const JAMO_MAP = new Map<string, string>()
const addJamoRange = (start: number, letters: string): void => {
  Array.from(letters).forEach((compat, i) => JAMO_MAP.set(String.fromCodePoint(start + i), compat))
}
addJamoRange(0x1100, 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ') // начальные, U+1100–U+1112
addJamoRange(0x1161, 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ') // гласные, U+1161–U+1175
addJamoRange(0x11a8, 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ') // конечные, U+11A8–U+11C2

export function compatJamo(s: string): string {
  return s.replace(/[\u1100-\u11ff]/g, ch => JAMO_MAP.get(ch) ?? ch)
}

// «가격02» → { base: '가격', homograph: 2 }. Цифры в конце — номер омонима; без них homograph = 0.
export function splitHomograph(s: string): { base: string; homograph: number } {
  const trimmed = s.trim()
  const m = /^(\D+)(\d+)$/.exec(trimmed)
  return m ? { base: m[1], homograph: Number(m[2]) } : { base: trimmed, homograph: 0 }
}

// Ключ для сравнения конструкций: NFC, совместимые джамо, без номера омонима и без ведущих «-» и «~».
export function normGrammarForm(s: string): string {
  return splitHomograph(compatJamo(nfc(s))).base.replace(/^[-~]+/, '')
}
