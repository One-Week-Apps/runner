// Writes the last frame of a video as a PNG: `last-frame <video.mp4> <out.png>`.
// The Runner uses it on the screen recording Xcode keeps for a failing UI test: on the old code, the screen as it was.
import AVFoundation
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("usage: last-frame <video> <png>\n".data(using: .utf8)!)
    exit(2)
}

let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

let done = DispatchSemaphore(value: 0)
var status: Int32 = 1
Task {
    defer { done.signal() }
    do {
        let duration = try await asset.load(.duration)
        let time = CMTimeMaximum(.zero, CMTimeSubtract(duration, CMTime(value: 1, timescale: 10)))
        let (image, _) = try await generator.image(at: time)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return }
        try png.write(to: URL(fileURLWithPath: arguments[2]))
        status = 0
    } catch {
        FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
    }
}
done.wait()
exit(status)
