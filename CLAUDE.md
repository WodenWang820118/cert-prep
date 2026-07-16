<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `pnpm nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Claude Profile MCP Servers

- `claude-deepseek-mcp` and `claude-glm-mcp` are Codex MCP servers, not shell CLI wrappers. Use the `mcp__claude_deepseek_mcp` and `mcp__claude_glm_mcp` tool namespaces when a second-opinion review, plan critique, or adversarial evaluation is requested. `claude-deepseek` and `claude-glm` are user CLI wrappers only; do not route Codex MCP calls through those names.
- If the namespace is not already available in the active tool list, use `tool_search` to lazy-load it before falling back to any shell command. Only use a CLI fallback when the MCP server is unavailable and the user has approved or explicitly requested that fallback.
- Prefer `Agent` tool calls for multi-step review, critique, or adversarial evaluation prompts, and ask for a user-visible structured report. Do not request hidden chain-of-thought.
- Required report fields for reviews are `publicReasoningSummary`, `evidenceChecked`, `findings`, `blockers`, `risks`, `missingDecisions`, `suggestedMarkdownSection`, and `writeRecommendation`.
- Relay the structured report in the Codex session before or alongside any file write that depends on it.

# Antigravity MCP Server

- `agy_mcp` is the Codex MCP server for Antigravity CLI. Use it for second-opinion review, plan critique, adversarial evaluation, or repository-grounded planning; use this general MCP name consistently.
- If the namespace is not already available in the active tool list, use `tool_search` to lazy-load `agy_mcp` before falling back to any shell command.
- Prefer `mode=review` for code review and `mode=planning` for implementation planning. Keep it read-only unless the user explicitly authorizes writes.
- AGY has the global `grill-me` skill installed at `~/.gemini/config/skills/grill-me/SKILL.md`. When the user asks to be grilled or to stress-test a plan, ask `agy_mcp` to use `grill-me` and return user-visible questions or a concise report.
