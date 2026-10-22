<!--
Maintainers: AGENTS.md is the single source of project rules, shared with Codex and other agents.
This file only imports it and adds notes that apply to Claude Code alone. Put project rules in
AGENTS.md or a .claude/rules/ file, never here. Claude Code strips this comment before loading.
-->

@AGENTS.md

## Claude Code

- Path-scoped rules in `.claude/rules/` load when you read or edit a file matching their `paths:`.
  When you plan work in an area before opening any of its files, read the rule file the area table
  in `AGENTS.md` names.
- Those paths are relative to the checkout that holds the rules. A session started in the main
  checkout that edits files in another worktree does not load them: start the session in that
  worktree, or read the rule files by hand.
- Codex and other agents read `AGENTS.md` only. When you brief one, name the rule files for the
  paths it will touch and tell it to read them.
- The review persona used by the PR Review workflow is `.claude/agents/pr-reviewer.md`.
