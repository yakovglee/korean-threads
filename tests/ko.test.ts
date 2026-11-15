import { it, expect } from 'vitest'
import { nfc, compatJamo, splitHomograph, normGrammarForm } from '../src/lib/ko'

it('splitHomograph', () => {
  expect(splitHomograph('가격02')).toEqual({ base: '가격', homograph: 2 })
  expect(splitHomograph('은1')).toEqual({ base: '은', homograph: 1 })
  expect(splitHomograph('-거든2')).toEqual({ base: '-거든', homograph: 2 })
  expect(splitHomograph('가게')).toEqual({ base: '가게', homograph: 0 })
})
it('nfc сводит NFD к NFC', () => expect(nfc('가'.normalize('NFD'))).toBe('가'))
it('compatJamo', () => expect(compatJamo('ᄇ니다')).toBe('ㅂ니다'))
it('normGrammarForm', () => expect(normGrammarForm('-거든2')).toBe('거든'))
