import PDFKit
for p in CommandLine.arguments.dropFirst() {
    guard let d = PDFDocument(url: URL(fileURLWithPath: p)) else { print("FAIL \(p)"); continue }
    let t = d.string ?? ""
    print("\(d.pageCount)p \(t.count)ch  \((p as NSString).lastPathComponent)")
    if CommandLine.arguments.count == 2 { print(String(t.prefix(1500))) }
}
