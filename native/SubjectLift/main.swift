import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// Apple Vision 主体分割命令行：输出透明 PNG，只保留面积最大的前景实例。
struct Response: Encodable {
    let ok: Bool
    let message: String?
}

func respond(_ response: Response, exitCode: Int32) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(exitCode)
}

func fail(_ message: String, exitCode: Int32 = 1) -> Never {
    respond(Response(ok: false, message: message), exitCode: exitCode)
}

func parseArguments() -> (input: String, output: String) {
    var input: String?
    var output: String?
    var index = 1
    let args = CommandLine.arguments
    while index < args.count {
        let key = args[index]
        guard index + 1 < args.count else { break }
        let value = args[index + 1]
        if key == "--input" { input = value }
        if key == "--output" { output = value }
        index += 2
    }
    guard let input, let output else { fail("缺少 --input 或 --output 参数", exitCode: 64) }
    return (input, output)
}

/// 先应用 EXIF 方向，再交给 Vision，避免手机竖图被横着输出。
func loadUprightCGImage(_ url: URL) -> CGImage? {
    guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { return nil }
    let context = CIContext(options: [.useSoftwareRenderer: false])
    return context.createCGImage(image, from: image.extent)
}

func largestInstance(in observation: VNInstanceMaskObservation) -> Int? {
    let instances = observation.allInstances
    guard !instances.isEmpty else { return nil }
    if instances.count == 1 { return instances.first }

    let mask = observation.instanceMask
    CVPixelBufferLockBaseAddress(mask, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(mask) else { return instances.first }

    let width = CVPixelBufferGetWidth(mask)
    let height = CVPixelBufferGetHeight(mask)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(mask)
    let format = CVPixelBufferGetPixelFormatType(mask)
    var counts: [Int: Int] = [:]

    switch format {
    case kCVPixelFormatType_OneComponent8:
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let id = Int(row[x])
                if id != 0 { counts[id, default: 0] += 1 }
            }
        }
    case kCVPixelFormatType_OneComponent32Float:
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float.self)
            for x in 0..<width {
                let id = Int(row[x].rounded())
                if id != 0 { counts[id, default: 0] += 1 }
            }
        }
    default:
        return instances.first
    }
    return instances.compactMap { id in counts[id].map { (id, $0) } }.max(by: { $0.1 < $1.1 })?.0 ?? instances.first
}

let (inputPath, outputPath) = parseArguments()
let inputURL = URL(fileURLWithPath: inputPath)
let outputURL = URL(fileURLWithPath: outputPath)
guard FileManager.default.fileExists(atPath: inputURL.path) else { fail("找不到原图文件") }
guard let cgImage = loadUprightCGImage(inputURL) else { fail("这张图解不开，换一张试试") }

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do { try handler.perform([request]) } catch { fail("抠图分析失败：\(error.localizedDescription)") }
guard let observation = request.results?.first, !observation.allInstances.isEmpty,
      let instance = largestInstance(in: observation) else {
    fail("这张图没有识别到明显主体", exitCode: 2)
}

let masked: CVPixelBuffer
do {
    masked = try observation.generateMaskedImage(ofInstances: IndexSet(integer: instance), from: handler, croppedToInstancesExtent: false)
} catch {
    fail("抠图结果生成失败：\(error.localizedDescription)")
}

let context = CIContext(options: [.useSoftwareRenderer: false])
let maskedImage = CIImage(cvPixelBuffer: masked)
guard let outputImage = context.createCGImage(maskedImage, from: maskedImage.extent) else {
    fail("抠图结果解不开")
}
guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fail("写不出 PNG 文件")
}
CGImageDestinationAddImage(destination, outputImage, nil)
guard CGImageDestinationFinalize(destination) else { fail("写 PNG 文件失败") }
respond(Response(ok: true, message: nil), exitCode: 0)
