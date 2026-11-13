import AppKit
import Foundation

/// 自定义条目（用户手动添加）
struct CustomEntry: Codable, Hashable {
    let name: String
    let path: String      // CLI 命令路径 / App bundle 路径
}

/// 侧栏自定义状态（改名/隐藏/移动/新增），持久化到 JSON
struct SidebarOverrides: Codable {
    var renames: [String: String] = [:]     // 原名 → 显示名
    var hidden: [String] = []               // 隐藏的原名
    var moves: [String: String] = [:]       // PWA 原名 → 目标分组名
    var orders: [String: [String]] = [:]    // 分组名 → 组内原名顺序
    var customCLI: [CustomEntry] = []
    var customApps: [CustomEntry] = []
    var customPWAGroups: [String] = []       // 自定义 PWA 分组名
    var sectionOrder: [String] = []          // 大分区排序（原名）
    var sectionRenames: [String: String] = [:] // 大分区改名（原名 → 显示名）
    var colorOverrides: [String: String] = [:] // 条目名 → 自定义颜色 hex（如 "FF5733"）

    static var fileURL: URL {
        let dir = NSHomeDirectory() + "/Library/Application Support/AIHub"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return URL(fileURLWithPath: dir + "/sidebar.json")
    }

    static func load() -> SidebarOverrides {
        guard !AppModel.isPreview else { return SidebarOverrides() }
        guard let data = try? Data(contentsOf: fileURL),
              let o = try? JSONDecoder().decode(SidebarOverrides.self, from: data) else {
            return SidebarOverrides()
        }
        return o
    }

    func save() {
        guard !AppModel.isPreview else { return }
        if let data = try? JSONEncoder().encode(self) {
            try? data.write(to: SidebarOverrides.fileURL, options: .atomic)
        }
    }
}

/// 带输入框的系统弹窗
enum Prompt {
    /// 单输入框，返回 nil 表示取消
    @MainActor
    static func text(title: String, message: String, placeholder: String = "", initial: String = "") -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = placeholder
        field.stringValue = initial
        alert.accessoryView = field
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let v = field.stringValue.trimmingCharacters(in: .whitespaces)
        return v.isEmpty ? nil : v
    }

    /// 双输入框（名称+路径）+ 类型选择（CLI/App），返回 (name, path, isCLI)
    @MainActor
    static func entryForm() -> (String, String, Bool)? {
        let alert = NSAlert()
        alert.messageText = "添加工具"
        alert.informativeText = "CLI 填可执行文件路径；App 填 .bundle 路径"

        let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 320, height: 96))
        stack.orientation = .vertical
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)

        let typePopup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        typePopup.addItems(withTitles: ["CLI（终端运行）", "App（唤起应用）"])

        let nameField = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        nameField.placeholderString = "显示名称"
        let pathField = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        pathField.placeholderString = "路径"

        stack.addArrangedSubview(typePopup)
        stack.addArrangedSubview(nameField)
        stack.addArrangedSubview(pathField)
        alert.accessoryView = stack
        alert.addButton(withTitle: "添加")
        alert.addButton(withTitle: "取消")

        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let name = nameField.stringValue.trimmingCharacters(in: .whitespaces)
        let path = pathField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !path.isEmpty else { return nil }
        return (name, path, typePopup.indexOfSelectedItem == 0)
    }
}
