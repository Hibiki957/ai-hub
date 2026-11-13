# Sidebar icon sources

Retrieved 2026-09-21. These are third-party application marks used to identify
the corresponding tools. They are not AI Hub artwork.

| Key | Source |
| --- | --- |
| aider | Aider's official organization avatar: https://github.com/Aider-AI.png (https://github.com/Aider-AI) |
| pi | https://pi.dev/favicon.svg — official press kit: https://pi.dev/press-kit |
| cmd | https://commandcode.ai/favicon/2024/android-chrome-192x192.png — linked from https://commandcode.ai/ |
| codebuddy | https://download.codebuddy.ai/web/ide/logo.svg — linked from https://www.codebuddy.ai/docs/cli/quickstart |
| codex | Installed official app: `/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png` |
| stepcode | https://www.stepfun.com/step_favicon.svg (linked from https://stepfun.com/); pixel-S recolored to brand blue #4FA8FF from StepCode's built-in `step-blue` theme |

The PNG files in `Sources/AIHub/Resources/SidebarIcons` are aspect-preserving
64 × 64 rasterizations, loaded offline and used when no matching installed app
is available. Original downloaded SVG/PNG assets are retained here as source
references; `aider.svg` is the official website's wordmark, while the sidebar
uses the square organization avatar for legibility.

Both manual install scripts copy the PNGs to `Contents/Resources/SidebarIcons`.
SwiftPM packages the same directory as a target resource.
