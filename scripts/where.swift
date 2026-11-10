// Prints the PDF-space bounds of a string on a page: where.swift file.pdf page "text"
import PDFKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let page = doc.page(at: Int(a[2])! - 1)!
for sel in doc.findString(a[3], withOptions: []) where sel.pages.first == page {
  let b = sel.bounds(for: page); print(String(format: "x=%.1f bottom=%.1f top=%.1f h=%.1f", b.minX, b.minY, b.maxY, b.height))
}
