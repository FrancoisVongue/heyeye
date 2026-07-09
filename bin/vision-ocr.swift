// Apple Vision OCR: путь к картинке → JSON {width,height,lines,words} в пикселях (top-left).
// Крутится на Neural Engine/GPU, on-device, миллисекунды. Без Python. Замена tesseract.js.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: vision-ocr <image>\n".data(using: .utf8)!); exit(1) }
guard let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("{\"error\":\"load\"}"); exit(1) }
let W = CGFloat(cg.width), H = CGFloat(cg.height)

let req = VNRecognizeTextRequest()
req.recognitionLevel = (args.count > 2 && args[2] == "fast") ? .fast : .accurate
req.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { print("{\"error\":\"perform\"}"); exit(1) }

// нормализованный (низ-лево) прямоугольник → пиксели (верх-лево)
func px(_ r: CGRect) -> [Int] { [Int(r.minX * W), Int((1 - r.maxY) * H), Int(r.width * W), Int(r.height * H)] }
func esc(_ s: String) -> String {
  var o = ""; for c in s.unicodeScalars { switch c { case "\"": o += "\\\""; case "\\": o += "\\\\"; case "\n", "\r", "\t": o += " "; default: o.unicodeScalars.append(c) } }; return o
}

var lines: [String] = [], words: [String] = []
for obs in (req.results as? [VNRecognizedTextObservation] ?? []) {
  guard let cand = obs.topCandidates(1).first else { continue }
  let conf = Int(cand.confidence * 100), s = cand.string
  let b = px(obs.boundingBox)
  lines.append("{\"text\":\"\(esc(s))\",\"box\":[\(b[0]),\(b[1]),\(b[2]),\(b[3])],\"conf\":\(conf)}")
  s.enumerateSubstrings(in: s.startIndex..<s.endIndex, options: .byWords) { sub, range, _, _ in
    guard let word = sub, let rectObs = try? cand.boundingBox(for: range) else { return }
    let wb = px(rectObs.boundingBox)
    words.append("{\"text\":\"\(esc(word))\",\"box\":[\(wb[0]),\(wb[1]),\(wb[2]),\(wb[3])],\"conf\":\(conf)}")
  }
}
print("{\"width\":\(Int(W)),\"height\":\(Int(H)),\"lines\":[\(lines.joined(separator: ","))],\"words\":[\(words.joined(separator: ","))]}")
