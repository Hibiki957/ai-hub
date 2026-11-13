import Foundation

/// A presentation of the existing inventory, never a second source of preferences.
@MainActor
struct ToolLauncherCatalog {
    enum Kind: String, CaseIterable, Identifiable {
        case terminal, desktop, web, project
        var id: String { rawValue }
        var title: String {
            switch self {
            case .terminal: return "终端"
            case .desktop: return "桌面应用"
            case .web: return "网页应用"
            case .project: return "项目"
            }
        }
        var symbol: String {
            switch self {
            case .terminal: return "terminal"
            case .desktop: return "macwindow"
            case .web: return "globe"
            case .project: return "folder"
            }
        }
        var searchTerms: String {
            switch self {
            case .terminal: return "终端 CLI TUI 命令行"
            case .desktop: return "桌面 App 应用"
            case .web: return "网页 PWA Web"
            case .project: return "项目 目录 文件夹"
            }
        }
    }
    enum Destination {
        case terminal(CLIEntry), desktop(AppEntry), web(AppEntry), project(Project)
    }
    struct Item: Identifiable {
        let id: String
        let rawName: String
        let title: String
        let kind: Kind
        let sectionID: String
        let sectionTitle: String
        let icon: SidebarIconSource
        let destination: Destination
        func matches(_ query: String) -> Bool {
            let terms = query.split(whereSeparator: { $0.isWhitespace })
            let haystack = [rawName, title, sectionID, sectionTitle, kind.searchTerms].joined(separator: " ")
            return terms.allSatisfy { haystack.localizedStandardContains(String($0)) }
        }
    }
    struct Section: Identifiable {
        let id: String
        let title: String
        let items: [Item]
    }
    let sections: [Section]
    var items: [Item] { sections.flatMap(\.items) }

    init(model: AppModel) {
        sections = model.visibleSections.compactMap { reference in
            let sectionID = reference.rawTitle
            let title = model.sectionDisplayName(sectionID)
            @MainActor func item(_ id: String, _ raw: String, _ kind: Kind, _ icon: SidebarIconSource, _ destination: Destination) -> Item {
                Item(id: kind.rawValue + ":" + id, rawName: raw,
                     title: kind == .project ? raw : model.displayName(raw), kind: kind,
                     sectionID: sectionID, sectionTitle: title, icon: icon, destination: destination)
            }
            let entries: [Item]
            switch reference.kind {
            case .cli:
                entries = model.visibleCLIEntries.map { item($0.id, $0.name, .terminal, .cli($0.name), .terminal($0)) }
            case .apps:
                entries = model.visibleAppEntries.map { item($0.id, $0.name, .desktop, .path($0.appPath), .desktop($0)) }
            case .projects:
                entries = model.projects.map { item($0.id, $0.name, .project, .path($0.path), .project($0)) }
            case .pwa(let group):
                entries = (model.pwaSections.first { $0.title == group }?.items ?? []).map {
                    item($0.id, $0.name, .web, .path($0.appPath), .web($0))
                }
            }
            return entries.isEmpty ? nil : Section(id: sectionID, title: title, items: entries)
        }
    }
    func filtered(query: String, kind: Kind? = nil) -> [Section] {
        sections.compactMap { section in
            let items = section.items.filter { (kind == nil || $0.kind == kind) && $0.matches(query) }
            return items.isEmpty ? nil : Section(id: section.id, title: section.title, items: items)
        }
    }
}
