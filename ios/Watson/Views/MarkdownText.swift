import SwiftUI

/// SwiftUI Text parses inline Markdown but does not lay out block headings/lists.
struct MarkdownText: View {
    let text: String
    private struct Block { var type: String; var text: String; var level: Int = 0 }
    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var code: [String]? = nil
        func flush() { if !paragraph.isEmpty { result.append(Block(type: "paragraph", text: paragraph.joined(separator: "\n"))); paragraph = [] } }
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") { flush(); if let body = code { result.append(Block(type: "code", text: body.joined(separator: "\n"))); code = nil } else { code = [] }; continue }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            let heading = line.prefix(while: { $0 == "#" }).count
            if (1...6).contains(heading), line.dropFirst(heading).hasPrefix(" ") { flush(); result.append(Block(type: "heading", text: String(line.dropFirst(heading + 1)), level: heading)); continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") { flush(); result.append(Block(type: "bullet", text: String(line.dropFirst(2)))); continue }
            if line == "---" || line == "***" { flush(); result.append(Block(type: "divider", text: "")); continue }
            paragraph.append(raw)
        }
        flush(); if let code { result.append(Block(type: "code", text: code.joined(separator: "\n"))) }; return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block.type {
                case "heading": Text(.init(block.text)).font(block.level == 1 ? .title2.bold() : .headline).padding(.top, 4)
                case "bullet": HStack(alignment: .firstTextBaseline, spacing: 10) { Text("•").foregroundStyle(WatsonStyle.purple); Text(.init(block.text)) }
                case "code": ScrollView(.horizontal) { Text(block.text).font(.system(.footnote, design: .monospaced)).padding(12) }.background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                case "divider": Divider()
                default: Text(.init(block.text))
                }
            }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}
