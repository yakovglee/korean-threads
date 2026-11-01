// Usage: ocr <image> [<image> ...]
// Prints recognized text for each image, lines in reading order.
import Foundation
import Vision
import AppKit

func run(_ cg: CGImage, _ langs: [String], auto: Bool) -> [VNRecognizedTextObservation] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = langs
    req.usesLanguageCorrection = true
    req.automaticallyDetectsLanguage = auto
    try? VNImageRequestHandler(cgImage: cg).perform([req])
    return req.results ?? []
}

func isHangul(_ c: Character) -> Bool {
    c.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) || (0x3131...0x318E).contains($0.value) }
}
func isLatin(_ c: Character) -> Bool {
    c.unicodeScalars.contains { ("a"..."z").contains($0) || ("A"..."Z").contains($0) }
}

struct Token { let text: Substring; let box: CGRect }

// Space-separated words of a recognized line, each with its box (normalized, origin bottom-left).
func tokens(_ c: VNRecognizedText) -> [Token] {
    let s = c.string
    var out: [Token] = []
    var i = s.startIndex
    while i < s.endIndex {
        if s[i] == " " { i = s.index(after: i); continue }
        let e = s[i...].firstIndex(of: " ") ?? s.endIndex
        if let b = try? c.boundingBox(for: i..<e)?.boundingBox { out.append(Token(text: s[i..<e], box: b)) }
        i = e
    }
    return out
}

// Words of the Russian pass whose centre falls inside `box`.
func russianWords(in box: CGRect, _ ru: [Token]) -> [Token] {
    ru.filter {
        $0.box.midX > box.minX && $0.box.midX < box.maxX &&
        $0.box.midY > box.minY && $0.box.midY < box.maxY
    }.sorted { $0.box.minX < $1.box.minX }
}

// A word like "빨래-CTpKt;" (Korean model garbles the Cyrillic) and the same word from the
// Russian pass, "6ap-стирка;" (Russian model garbles the Hangul). Join them at the separator.
func mergeWord(_ ko: Substring, _ ru: String) -> String? {
    let a = Array(ko)
    guard let firstK = a.firstIndex(where: isHangul), let lastK = a.lastIndex(where: isHangul) else { return nil }
    let latinBefore = a[..<firstK].contains(where: isLatin)
    let latinAfter = a[(lastK + 1)...].contains(where: isLatin)
    if latinAfter && !latinBefore {
        var j = lastK + 1
        while j < a.count && !a[j].isLetter { j += 1 }
        let sep = String(a[(lastK + 1)..<j])
        guard !sep.isEmpty, let r = ru.range(of: sep) else { return nil }
        return String(a[...lastK]) + sep + String(ru[r.upperBound...])
    }
    if latinBefore && !latinAfter {
        var j = firstK
        while j > 0 && !a[j - 1].isLetter { j -= 1 }
        let sep = String(a[j..<firstK])
        guard !sep.isEmpty, let r = ru.range(of: sep, options: .backwards) else { return nil }
        return String(ru[..<r.lowerBound]) + sep + String(a[firstK...])
    }
    return nil
}

// Reads one region of the page with the Russian model alone.
func reread(_ box: CGRect, in cg: CGImage) -> String? {
    let W = CGFloat(cg.width), H = CGFloat(cg.height)
    let pad = box.height * H * 0.3
    let rect = CGRect(x: box.minX * W - pad, y: (1 - box.maxY) * H - pad,
                      width: box.width * W + 2 * pad, height: box.height * H + 2 * pad)
        .intersection(CGRect(x: 0, y: 0, width: W, height: H))
    guard let crop = cg.cropping(to: rect) else { return nil }
    let text = run(crop, ["ru-RU", "en-US"], auto: false)
        .sorted { $0.boundingBox.minX < $1.boundingBox.minX }
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: " ")
    return text.isEmpty ? nil : text
}

// Vision reads a mixed line ("한국어 문장. – русский перевод") with the Korean model and turns the
// Cyrillic into Latin garbage. A run of whole non-Hangul words is cropped and re-read in Russian;
// a word glued to Hangul ("빨래-CTpKt;") is merged with its reading from the full-page Russian pass.
func fixMixedLine(_ cand: VNRecognizedText, in cg: CGImage, _ ru: () -> [Token]) -> String {
    let s = cand.string
    guard s.contains(where: isHangul), s.contains(where: isLatin) else { return s }
    let toks = tokens(cand)
    var out = ""
    var done = s.startIndex
    var k = 0
    while k < toks.count {
        let t = toks[k]
        if t.text.contains(where: isHangul) {
            if t.text.contains(where: isLatin) {
                let words = russianWords(in: t.box.insetBy(dx: -t.box.height * 0.2, dy: 0), ru())
                if !words.isEmpty,
                   let fixed = mergeWord(t.text, words.map { String($0.text) }.joined(separator: " ")) {
                    out += s[done..<t.text.startIndex] + fixed
                    done = t.text.endIndex
                }
            }
            k += 1
            continue
        }
        var e = k
        while e + 1 < toks.count && !toks[e + 1].text.contains(where: isHangul) { e += 1 }
        let span = toks[k...e]
        if span.contains(where: { $0.text.contains(where: isLatin) }),
           let fixed = reread(span.dropFirst().reduce(t.box) { $0.union($1.box) }, in: cg) {
            out += s[done..<t.text.startIndex] + fixed
            done = span.last!.text.endIndex
        }
        k = e + 1
    }
    return out + s[done...]
}

func recognize(_ path: String) -> String {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return "<!-- OCR failed: cannot load \(path) -->"
    }
    var ruCache: [Token]?
    let ru = { () -> [Token] in
        if ruCache == nil {
            ruCache = run(cg, ["ru-RU", "en-US"], auto: false).flatMap { o in
                o.topCandidates(1).first.map(tokens) ?? []
            }
        }
        return ruCache!
    }
    let obs = run(cg, ["ko-KR", "ru-RU", "en-US"], auto: true).compactMap { o -> (CGRect, String)? in
        guard let c = o.topCandidates(1).first else { return nil }
        return (o.boundingBox, fixMixedLine(c, in: cg, ru))
    }
    // Group boxes whose vertical centers overlap into one visual row, then order rows top-down, boxes left-right.
    var rows: [[(CGRect, String)]] = []
    for item in obs.sorted(by: { $0.0.midY > $1.0.midY }) {
        if let i = rows.firstIndex(where: { row in
            let r = row[0].0
            return abs(r.midY - item.0.midY) < min(r.height, item.0.height) * 0.5
        }) {
            rows[i].append(item)
        } else {
            rows.append([item])
        }
    }
    return rows.map { $0.sorted { $0.0.minX < $1.0.minX }.map { $0.1 }.joined(separator: " ") }
               .joined(separator: "\n")
}

for path in CommandLine.arguments.dropFirst() {
    print(recognize(path))
    print("\u{1E}") // record separator between pages
}
