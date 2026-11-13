# Reused projects

No additional Rovai service, copied Paperclip backend, Redis or microservice runtime is installed by Hub.

| Project | Usage | License/reference |
|---|---|---|
| Paperclip | Existing 0.3.1 server via its HTTP API; sole task authority | [MIT](https://github.com/paperclipai/paperclip/blob/master/LICENSE) |
| Rovai AI | Interaction reference for continuous work, visible execution and handoff; no source copied | [Repository](https://github.com/murray17/rovai-ai) |
| LangGraph.js | In-process orchestration with official SQLite checkpointer | [MIT](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE) |
| React Flow | Workflow rendering, navigation and node positioning | [MIT](https://github.com/xyflow/xyflow/blob/main/LICENSE) |
| react-rnd | Movable/resizable work windows | [MIT](https://github.com/bokuweb/react-rnd/blob/master/LICENSE) |
| Fastify, React, Vite | HTTP/auth plugin ecosystem and client build | Individual package license files preserved in installed dependencies |
| Node.js 22.23.1 | Hub-owned runtime copy of an existing installation; no client configuration or credentials copied | Bundled Node LICENSE preserved beside the private executable |
| New API | Existing user-managed service accessed over HTTP; no source copied or service upgraded | [AGPL-3.0](https://github.com/QuantumNous/new-api/blob/main/LICENSE) |

Exact JavaScript dependency versions and transitive integrity checks are pinned in package-lock.json. Copying or redistributing upstream source remains subject to its own notices; an HTTP integration is not a claim to own that source.
