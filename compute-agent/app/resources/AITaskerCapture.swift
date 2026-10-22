//
//  AITaskerCapture.swift
//  Provided and kept up to date by One Week Apps Runner: do not edit, it will be replaced.
//

import XCTest

enum AITaskerCapture {

    /// Attaches a screenshot to the running test, named `nodeId` and kept even when the test passes,
    /// along with the screen's VoiceOver reading order (attachment `<nodeId>-voiceover`).
    /// Callable from any test: UI tests run on the main thread.
    static func captureScreen(nodeId: String, action: String) {
        MainActor.assumeIsolated { capture(nodeId: nodeId, action: action) }
    }

    @MainActor
    private static func capture(nodeId: String, action: String) {
        let app = XCUIApplication()
        XCTContext.runActivity(named: action) { activity in
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = nodeId
            attachment.lifetime = .keepAlways
            activity.add(attachment)

            let reading = XCTAttachment(string: voiceOverOrder(of: app).joined(separator: "\n"))
            reading.name = "\(nodeId)-voiceover"
            reading.lifetime = .keepAlways
            activity.add(reading)
        }
    }

    private static let roles: [XCUIElement.ElementType: String] = [
        .staticText: "", .button: "bouton", .link: "lien", .image: "image", .switch: "interrupteur",
        .slider: "réglable", .textField: "champ de texte", .secureTextField: "champ sécurisé",
        .searchField: "recherche", .tab: "onglet", .segmentedControl: "sélecteur",
    ]

    /// VoiceOver's order, approximated like Accessibility Inspector: each read element, top to bottom then left to right.
    /// Roles are in French, as VoiceOver reads them to French-speaking developers.
    @MainActor
    static func voiceOverOrder(of app: XCUIApplication) -> [String] {
        guard let root = try? app.snapshot() else { return [] }
        var read: [(frame: CGRect, text: String)] = []
        func visit(_ node: XCUIElementSnapshot) {
            let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if let role = roles[node.elementType], !label.isEmpty, !node.frame.isEmpty, node.frame.intersects(root.frame) {
                read.append((node.frame, role.isEmpty ? label : "\(label), \(role)"))
                return
            }
            node.children.forEach(visit)
        }
        visit(root)
        return read
            .sorted { abs($0.frame.minY - $1.frame.minY) > 8 ? $0.frame.minY < $1.frame.minY : $0.frame.minX < $1.frame.minX }
            .map(\.text)
    }
}
