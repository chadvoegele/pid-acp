# Vision

Expose Pi Durable through ACP with minimal integration code and clear ownership.

# Design Choices

Defer to upstream behavior, including existing bugs, and pursue fixes upstream rather than adding local workarounds.
Favor readable happy paths and explicit control flow, with one owner per responsibility.
Handle rare edge cases only when their value justifies added complexity and maintenance.

# Development

- Build before running or typechecking tests; they import built `dist` files and declarations.
- Reserve stdout for ACP; exclude credentials and transcripts from diagnostics.
- Leave execution, persistence, and recovery to Durable; closing an ACP attachment must preserve native work.
- Map prompt responses from native submission outcomes, independently of notification delivery.
- Inject providers for deterministic tests while exercising real native tools.
- Use temporary workspaces and harmless commands for live tests.
- Record test results and live evidence in merge requests, not repository documents.
