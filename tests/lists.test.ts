import { it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseGradeList, ingestLists, loadListCsvs, countLists } from '../src/lib/ingest/lists'
import { openTestDb } from './helpers/testDb'

// Папка книг: как в scripts/ingest-lists.ts. В CI и на чужой машине её может не быть, тогда тест пропускается.
const booksDir = process.env.KB_SOURCE_DIR || path.resolve(process.cwd(), '../books')

const VOCAB_HEADER = '전체 번호,등급별 번호,등급,어휘,품사,길잡이말,어휘교육내용개발(1-4단계),등급'
const GRAMMAR_HEADER = '전체 번호,등급별 번호,등급,분류,대표형,관련형,의미,국제통용 (2단계),문법.표현 교육내용개발(1-4단계),메모(20201030 수정)'

it('parseGradeList vocab', () => {
  const csv = '전체 번호,등급별 번호,등급,어휘,품사,길잡이말,어휘교육내용개발(1-4단계),등급\n1,1,1급,가게,명사,가게에 가다 ,초급,1급\n2,2,1급,가격02,명사,가격이 비싸다 ,초급,1급'
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:1', level: 1, headword: '가게', pos: '명사', hint: '가게에 가다', homograph: 0 })
  expect(items[1]).toMatchObject({ id: 'v:2', headword: '가격', homograph: 2 })
})

it('parseGradeList grammar', () => {
  const csv = '전체 번호,등급별 번호,등급,분류,대표형,관련형,의미,국제통용 (2단계),문법.표현 교육내용개발(1-4단계),메모(20201030 수정)\n1,1,1급,조사,이,가,,초급,초급,'
  expect(parseGradeList(csv, 'grammar').items[0]).toMatchObject({ id: 'g:1', level: 1, headword: '이', pos: '조사', related: '가' })
})

// Разделители вариантов в ячейках: U+2219, U+00B7, U+2027, U+30FB и «/».
it('parseGradeList vocab: варианты одного слова (계속02/계속01)', () => {
  const csv = `${VOCAB_HEADER}\n1,1,1급,계속02/계속01,부사/명사,,초급,1급`
  const { items, warnings } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:1', headword: '계속', homograph: 2, pos: '부사/명사', related: '계속02/계속01' })
  expect(warnings).toEqual([])
})

it('parseGradeList vocab: вариант с переводом строки после разделителя (독립적01\u2219\\n독립적02)', () => {
  const csv = `${VOCAB_HEADER}\n2,2,1급,"독립적01\u2219\n독립적02",관형사\u2219명사,,초급,1급`
  const { items, warnings } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:2', headword: '독립적', homograph: 1, pos: '관형사/명사', related: '독립적01/독립적02' })
  expect(warnings).toEqual([])
})

it('parseGradeList vocab: номер 00 значит без номера (한참00/한참)', () => {
  const csv = `${VOCAB_HEADER}\n3,3,1급,한참00/한참,부사,,초급,1급`
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:3', headword: '한참', homograph: 0, related: '한참00/한참' })
})

it('parseGradeList vocab: номер берётся у первого варианта (넷째02\u2219넷째01/넷째03)', () => {
  const csv = `${VOCAB_HEADER}\n4,4,1급,넷째02\u2219넷째01/넷째03,수사\u2219관형사/명사,,초급,1급`
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:4', headword: '넷째', homograph: 2, pos: '수사/관형사/명사', related: '넷째02/넷째01/넷째03' })
})

it('parseGradeList vocab: точка как разделитель в 품사 (수사.관형사/명사)', () => {
  const csv = `${VOCAB_HEADER}\n5,5,3급,아홉째02\u2219아홉째01/아홉째03,수사.관형사/명사,,초급,3급`
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:5', headword: '아홉째', homograph: 2, pos: '수사/관형사/명사' })
})

// Пробелы убираются только по краям вариантов; внутри слова они сохраняются.
it('parseGradeList vocab: пробелы внутри варианта сохраняются (가 보다01\u2219가 보다02)', () => {
  const csv = `${VOCAB_HEADER}\n6,6,1급,가 보다01\u2219가 보다02,동사,,초급,1급`
  const { items, warnings } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:6', headword: '가 보다', homograph: 1, related: '가 보다01/가 보다02' })
  expect(warnings).toEqual([])
})

// Битые байты в исходном файле декодируются в U+FFFD: строка даёт одно предупреждение, запись остаётся в items.
it('parseGradeList: строка с U+FFFD даёт одно предупреждение, запись попадает в items', () => {
  const csv = `${VOCAB_HEADER}\n7,7,1급,가게,명사,가게에 \ufffd다,초급,1급`
  const { items, warnings } = parseGradeList(csv, 'vocab')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('строка 2')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ id: 'v:7', headword: '가게' })
})

// Заголовок в NFD (так отдаёт macOS) находит колонки так же, как в NFC.
it('parseGradeList: заголовок в NFD разбирается', () => {
  const header = VOCAB_HEADER.normalize('NFD')
  const csv = `${header}\n8,8,1급,가게,명사,가게에 가다,초급,1급`
  const { items } = parseGradeList(csv, 'vocab')
  expect(items[0]).toMatchObject({ id: 'v:8', headword: '가게', pos: '명사', hint: '가게에 가다' })
})

// Шесть особых записей из 대표형 (строки реального файла). U+00AD — мягкий перенос вместо дефиса.
it('parseGradeList grammar: особые записи (скобки, X1(1), U+00AD, хвостовая запятая)', () => {
  const csv = [
    GRAMMAR_HEADER,
    '50,5,2급,조사,에서부터(서부터),,,,초급,',
    '61,16,2급,연결어미,-다가1(1),"-다5, 다가도",중단,중급,초급,',
    '114,24,3급,연결어미,-다가1(2),"-다5, 다가도",중단,중급,중급,',
    '238,14,5급,종결어미,\u00ad으려고2,"\u00ad려고2, \u00ad려고요, \u00ad으려고요",의심,중급,,',
    '256,32,5급,표현,-기에 앞서(서),,,고급,,',
    '300,20,6급,연결어미,"-을망정,","-ㄹ망정 <유의> -ㄹ지언정, -을지언정",,최상급,,',
  ].join('\n')
  const { items, warnings } = parseGradeList(csv, 'grammar')
  expect(items.map(i => ({ id: i.id, headword: i.headword, homograph: i.homograph, related: i.related }))).toEqual([
    { id: 'g:50', headword: '에서부터', homograph: 0, related: '서부터' },
    { id: 'g:61', headword: '-다가', homograph: 1, related: '-다5, 다가도' },
    { id: 'g:114', headword: '-다가', homograph: 1, related: '-다5, 다가도' },
    { id: 'g:238', headword: '-으려고', homograph: 2, related: '-려고2, -려고요, -으려고요' },
    { id: 'g:256', headword: '-기에 앞서', homograph: 0, related: '-기에 앞서서' },
    { id: 'g:300', headword: '-을망정', homograph: 0, related: '-ㄹ망정 <유의> -ㄹ지언정, -을지언정' },
  ])
  expect(warnings).toEqual([])
})

it.skipIf(!existsSync(booksDir))('ingestLists на реальных файлах: 5690 слов и 224 конструкции на уровнях 1–4', async () => {
  const { vocabCsv, grammarCsv } = await loadListCsvs(booksDir)
  const db = await openTestDb()

  const first_run = await ingestLists(db, vocabCsv, grammarCsv)
  expect(first_run.warnings).toEqual([])
  const first = await countLists(db)
  expect(first).toEqual({ vocabAll: 10635, grammarAll: 336, vocab14: 5690, grammar14: 224 })

  const headwords = await db.query<{ headword: string }>('select headword from items')
  const badHeadwords = headwords.map(r => r.headword).filter(h => !/^[가-힣ㄱ-ㆎ -]+$/.test(h))
  expect(badHeadwords.length, badHeadwords.slice(0, 5).join(', ')).toBe(0)

  const second_run = await ingestLists(db, vocabCsv, grammarCsv)
  expect(second_run.warnings).toEqual([])
  expect(await countLists(db)).toEqual(first)
}, 60_000)
