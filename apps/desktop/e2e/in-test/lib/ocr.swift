// ocr — recognise text in a PNG with the Vision framework.
//
//   ocr <png>          JSON {width, height, items:[{text, x, y, w, h}]}, pixel
//                      coordinates with a top-left origin
//   ocr <png> <query>  JSON {width, height, match:{text, x, y, w, h}} for the
//                      first line containing <query> (case-insensitive), boxed
//                      to the matched substring; exit 1 when nothing matches
import AppKit
import Foundation
import Vision

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: ocr <png> [query]", 2) }
guard let image = NSImage(contentsOfFile: args[1]),
  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("ocr: cannot read \(args[1])", 2) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
  try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
  fail("ocr: \(error)", 2)
}

let W = Double(cg.width)
let H = Double(cg.height)

func box(_ r: CGRect) -> [String: Double] {
  ["x": r.minX * W, "y": (1 - r.maxY) * H, "w": r.width * W, "h": r.height * H]
}

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  print("")
}

let observations = request.results ?? []
if args.count >= 3 {
  let query = args[2]
  for obs in observations {
    guard let cand = obs.topCandidates(1).first,
      let range = cand.string.range(of: query, options: .caseInsensitive)
    else { continue }
    let rect = (try? cand.boundingBox(for: range))??.boundingBox ?? obs.boundingBox
    var match: [String: Any] = ["text": cand.string]
    for (k, v) in box(rect) { match[k] = v }
    emit(["width": W, "height": H, "match": match])
    exit(0)
  }
  exit(1)
}

var items: [[String: Any]] = []
for obs in observations {
  guard let cand = obs.topCandidates(1).first else { continue }
  var item: [String: Any] = ["text": cand.string]
  for (k, v) in box(obs.boundingBox) { item[k] = v }
  items.append(item)
}
emit(["width": W, "height": H, "items": items])
