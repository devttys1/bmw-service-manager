// The Mac app: starts the web app (its own Python, in Resources) and shows a small window
// with its state, Open in browser, and a pretend-car switch. Quitting stops the server.
// Built by packaging/build.sh; nothing here needs Xcode beyond swiftc.
import AppKit
import SwiftUI

@main
struct LauncherApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var server = Server.shared

    var body: some Scene {
        WindowGroup("BMW Service Manager") {
            LauncherView()
                .environmentObject(server)
                .frame(width: 460)
                .fixedSize()
                .onAppear { server.start() }
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { Server.shared.stop() }
}

/// The web app's process: started, watched and stopped.
final class Server: ObservableObject {
    static let shared = Server()

    enum State: Equatable {
        case starting
        case running(URL)
        case stopped(String)
    }

    @Published private(set) var state: State = .starting
    @Published private(set) var log: [String] = []
    @Published var simulate = UserDefaults.standard.bool(forKey: "simulate") {
        didSet {
            UserDefaults.standard.set(simulate, forKey: "simulate")
            openedBrowser = false  // the page open now still points at the other car
            restart()
        }
    }

    private var process: Process?
    private var openedBrowser = false
    private var buffer = ""

    var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    func start() {
        guard process == nil else { return }
        guard let res = Bundle.main.resourceURL else { return }
        let arm = sysctlFlag("hw.optional.arm64")  // Apple silicon, even when run under Rosetta
        let python = res.appendingPathComponent("runtime/\(arm ? "macos-arm64" : "macos-x86_64")/python/bin/python3")
        let p = Process()
        p.executableURL = python
        p.arguments = ["-I", "-u", res.appendingPathComponent("app/start.py").path, "--no-browser", "--exit-with-parent"]
            + (simulate ? ["--simulate"] : [])
        p.currentDirectoryURL = res
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let text = String(decoding: h.availableData, as: UTF8.self)
            DispatchQueue.main.async { self?.received(text) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.process === proc else { return }
                self.process = nil
                if case .running = self.state, self.log.contains(where: { $0.contains("already running") }) { return }
                self.state = .stopped(self.log.last(where: { !$0.isEmpty }) ?? "It stopped (code \(proc.terminationStatus)).")
            }
        }
        state = .starting
        log = []
        do {
            try p.run()
            process = p
        } catch {
            state = .stopped("Couldn't start: \(error.localizedDescription)")
        }
    }

    func stop() {
        guard let p = process else { return }
        process = nil
        p.terminate()
        p.waitUntilExit()
    }

    func restart() {
        stop()
        start()
    }

    func openInBrowser() {
        if case .running(let url) = state { NSWorkspace.shared.open(url) }
    }

    private func received(_ text: String) {
        buffer += text
        var lines = buffer.components(separatedBy: "\n")
        buffer = lines.removeLast()
        for line in lines {
            log.append(line)
            if log.count > 200 { log.removeFirst(log.count - 200) }
            // "...open http://127.0.0.1:8800/" or "...already running at http://127.0.0.1:8800/"
            if let r = line.range(of: #"http://127\.0\.0\.1:\d+/"#, options: .regularExpression), let url = URL(string: String(line[r])) {
                state = .running(url)
                if !openedBrowser {
                    openedBrowser = true
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func sysctlFlag(_ name: String) -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname(name, &value, &size, nil, 0) == 0 && value == 1
    }
}

struct LauncherView: View {
    @EnvironmentObject private var server: Server
    @State private var showLog = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 3) {
                    Text("BMW Service Manager").font(.title2.weight(.semibold))
                    status
                }
            }
            HStack {
                Button {
                    server.openInBrowser()
                } label: {
                    Text("Open in browser").frame(minWidth: 140)
                }
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
                .disabled(!running)
                Spacer()
                Toggle("Pretend car", isOn: $server.simulate)
                    .toggleStyle(.switch)
                    .help("Try everything with a simulated car before you plug in")
            }
            Text("Keep this app open while you use BMW Service Manager in your browser. Quit it (⌘Q) to stop.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("Details", isExpanded: $showLog) {
                ScrollView {
                    Text(server.log.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 120)
            }
            .font(.callout)
            Text("Version \(server.version)").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(20)
    }

    private var running: Bool {
        if case .running = server.state { return true }
        return false
    }

    @ViewBuilder private var status: some View {
        switch server.state {
        case .starting:
            Label("Starting…", systemImage: "circle.dotted").foregroundStyle(.orange)
        case .running(let url):
            Label {
                Text("Running at \(url.absoluteString)") + Text(server.simulate ? " with a pretend car" : "")
            } icon: {
                Image(systemName: "circle.fill").foregroundStyle(.green)
            }
            .foregroundStyle(.secondary)
        case .stopped(let why):
            VStack(alignment: .leading, spacing: 4) {
                Label("Stopped", systemImage: "exclamationmark.circle.fill").foregroundStyle(.red)
                Text(why).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                Button("Start again") { server.restart() }.controlSize(.small)
            }
        }
    }
}
