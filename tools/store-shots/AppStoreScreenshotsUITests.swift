//
//  AppStoreScreenshotsUITests.swift
//  Template from One Week Apps Runner (tools/store-shots): copy it into your UI test target and fill `screens`.
//  Captures the raw App Store screenshots, one per key screen and language, with the VoiceOver reading order
//  next to each image. Skipped unless APPSTORE_SCREENSHOTS_DIR is set, so regular test runs are unchanged.
//

import XCTest

final class AppStoreScreenshotsUITests: XCTestCase {

    private let timeout: TimeInterval = 10

    /// One entry per screenshot: a file name and how to reach the screen from a fresh launch.
    private let screens: [(name: String, launchArguments: [String], open: (XCUIApplication) -> Void)] = [
        ("1_home", [], { _ in }),
    ]

    private var outputDirectory: URL? {
        guard let path = ProcessInfo.processInfo.environment["APPSTORE_SCREENSHOTS_DIR"], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(outputDirectory == nil, "APPSTORE_SCREENSHOTS_DIR is not set")
    }

    func testCaptureFrench() throws {
        try captureAll(language: "fr", locale: "fr_FR")
    }

    func testCaptureEnglish() throws {
        try captureAll(language: "en", locale: "en_US")
    }

    private func captureAll(language: String, locale: String) throws {
        for screen in screens {
            let app = XCUIApplication()
            app.launchArguments = screen.launchArguments + ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
            app.launch()
            screen.open(app)
            sleep(1)
            try save(app: app, name: "\(language)_\(screen.name)")
            app.terminate()
        }
    }

    /// UI tests run on the main thread.
    private func save(app: XCUIApplication, name: String) throws {
        try MainActor.assumeIsolated { try write(app: app, name: name) }
    }

    @MainActor
    private func write(app: XCUIApplication, name: String) throws {
        guard let directory = outputDirectory else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: directory.appendingPathComponent("\(name).png"))
        let reading = AITaskerCapture.voiceOverOrder(of: app).joined(separator: "\n")
        try reading.write(to: directory.appendingPathComponent("\(name).txt"), atomically: true, encoding: .utf8)
    }
}
