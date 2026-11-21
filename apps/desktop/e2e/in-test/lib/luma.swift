// luma — mean brightness of a region of a PNG, for checks that need a colour
// rather than text (is the title bar dark or light?).
//
//   luma <png> <x0> <y0> <x1> <y1>   JSON {width, height, luma}, where the
//                                    region is given as fractions (0…1) of the
//                                    image's width and height, top-left origin,
//                                    and luma is the mean Rec. 709 luma of its
//                                    pixels in 0…1 (sRGB values, not linearised),
//                                    as a string with three decimals
import AppKit
import Foundation

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count == 6 else { fail("usage: luma <png> <x0> <y0> <x1> <y1>", 2) }
guard let image = NSImage(contentsOfFile: args[1]),
  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("luma: cannot read \(args[1])", 2) }
let f = args[2...5].map { Double($0) ?? -1 }
guard f.allSatisfy({ $0 >= 0 && $0 <= 1 }), f[0] < f[2], f[1] < f[3] else {
  fail("luma: the region must be fractions 0…1 with x0 < x1 and y0 < y1", 2)
}

let W = cg.width
let H = cg.height
var pixels = [UInt8](repeating: 0, count: W * H * 4)
let drawn: Bool = pixels.withUnsafeMutableBytes { buf in
  guard let ctx = CGContext(
    data: buf.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return false }
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
  return true
}
guard drawn else { fail("luma: cannot draw \(args[1])", 2) }

// The bitmap's first row is the image's top row.
let x0 = Int(f[0] * Double(W))
let y0 = Int(f[1] * Double(H))
let x1 = max(x0 + 1, Int(f[2] * Double(W)))
let y1 = max(y0 + 1, Int(f[3] * Double(H)))
var sum = 0.0
var n = 0
for y in y0..<min(y1, H) {
  for x in x0..<min(x1, W) {
    let i = (y * W + x) * 4
    sum += 0.2126 * Double(pixels[i]) + 0.7152 * Double(pixels[i + 1]) + 0.0722 * Double(pixels[i + 2])
    n += 1
  }
}
guard n > 0 else { fail("luma: empty region", 2) }
// A preformatted string: a rounded Double still prints as 0.83699999999999997.
let out: [String: Any] = ["width": W, "height": H, "luma": String(format: "%.3f", sum / Double(n) / 255)]
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
