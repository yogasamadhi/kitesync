import AppKit
import Foundation
import Security
import ServiceManagement

let command = CommandLine.arguments.dropFirst().first

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

func securityMessage(_ status: OSStatus) -> String {
    if let value = SecCopyErrorMessageString(status, nil) {
        return value as String
    }
    return "Keychain error \(status)"
}

func keychainQuery(account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.kitesync.node.open-secret",
        kSecAttrAccount as String: account,
    ]
}

if command == "--keychain-read" || command == "--keychain-write" {
    guard CommandLine.arguments.count == 3 else {
        fail("Keychain helper requires exactly one account argument")
    }
    let account = CommandLine.arguments[2]
    let query = keychainQuery(account: account)
    if command == "--keychain-read" {
        var result: CFTypeRef?
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { exit(44) }
        guard status == errSecSuccess else { fail(securityMessage(status)) }
        guard let data = result as? Data, let secret = String(data: data, encoding: .utf8) else {
            fail("Keychain item does not contain UTF-8 data")
        }
        FileHandle.standardOutput.write(Data(secret.utf8))
        exit(0)
    }

    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { fail("Keychain secret must not be empty") }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    // Concurrent `open` processes must converge on the first secret instead of rotating it.
    guard status == errSecSuccess || status == errSecDuplicateItem else {
        fail(securityMessage(status))
    }
    exit(0)
}

let service = SMAppService.agent(plistName: "com.kitesync.node.plist")

func serviceStatus(_ status: SMAppService.Status) -> String {
    switch status {
    case .enabled:
        return "enabled"
    case .requiresApproval:
        return "requires-approval"
    case .notRegistered:
        return "not-registered"
    case .notFound:
        return "not-found"
    @unknown default:
        return "unknown"
    }
}

if command == "--service-status" {
    print(serviceStatus(service.status))
    exit(0)
}

if command == "--service-install" || command == "--service-remove" {
    do {
        if command == "--service-install", service.status == .notRegistered {
            try service.register()
        } else if command == "--service-remove",
                  service.status != .notRegistered,
                  service.status != .notFound {
            try service.unregister()
        }
        print(serviceStatus(service.status))
        exit(0)
    } catch {
        fail(error.localizedDescription)
    }
}

do {
    if service.status == .notRegistered {
        try service.register()
    }
} catch {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "无法启动 KiteSync 后台服务"
    alert.informativeText = error.localizedDescription
    alert.runModal()
    exit(1)
}

if service.status == .requiresApproval {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "请允许 KiteSync 在后台运行"
    alert.informativeText = "请在系统设置的“通用 > 登录项”中允许 KiteSync，然后再次打开应用。"
    alert.addButton(withTitle: "打开系统设置")
    alert.addButton(withTitle: "稍后")
    if alert.runModal() == .alertFirstButtonReturn {
        SMAppService.openSystemSettingsLoginItems()
    }
    exit(0)
}

guard let runtime = Bundle.main.url(forResource: "kitesync", withExtension: nil) else {
    exit(1)
}

for _ in 0..<60 {
    let process = Process()
    process.executableURL = runtime
    // The managed flag prevents the CLI from spawning an unmanaged competing service while
    // SMAppService is still bringing its registered agent online.
    process.arguments = ["open", "--managed"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus == 0 { exit(0) }
    } catch {
        // The agent may still be starting; retry below.
    }
    Thread.sleep(forTimeInterval: 0.5)
}

NSApplication.shared.activate(ignoringOtherApps: true)
let alert = NSAlert()
alert.messageText = "KiteSync 尚未就绪"
alert.informativeText = "后台服务未能启动，请检查“登录项”设置后重试。"
alert.runModal()
exit(1)
