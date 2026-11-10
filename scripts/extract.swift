// Prints the text macOS PDFKit (Preview, Spotlight) extracts from given pages.
import PDFKit
let args = CommandLine.arguments
guard args.count > 1, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { print("cannot open"); exit(1) }
let pages = args.count > 2 ? args[2...].compactMap { Int($0) } : Array(1...min(doc.pageCount, 2))
for p in pages { if let page = doc.page(at: p - 1) { print("--- page \(p) ---"); print(page.string ?? "") } }
