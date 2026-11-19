// Распознавание текста Vision на одной странице: PNG из stdin, в stdout одна строка JSON {"lines":[{"t","c","x","y","w","h"}]}
// Координаты нормированы 0–1, y отсчитывается от верхнего края (у Vision начало снизу, поэтому 1 - maxY).
// Ошибка: код выхода 1 и текст в stderr.
import Foundation
import ImageIO
import Vision

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty else { fail("пустой ввод: ожидается PNG в stdin") }
guard let src = CGImageSourceCreateWithData(input as CFData, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("не удалось прочитать PNG из stdin") }

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["ko-KR", "en-US"]
req.usesLanguageCorrection = true
do {
  try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
} catch {
  fail("Vision: \(error.localizedDescription)")
}

var lines: [[String: Any]] = []
for o in req.results ?? [] {
  guard let c = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  lines.append(["t": c.string, "c": Double(c.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)])
}

do {
  let data = try JSONSerialization.data(withJSONObject: ["lines": lines])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
} catch {
  fail("JSON: \(error.localizedDescription)")
}
