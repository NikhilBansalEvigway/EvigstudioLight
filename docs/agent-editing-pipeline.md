# Agent Editing Pipeline

This document explains what happens when a user prompts EvigStudio to create or edit files, based on the current AI coding agent implementation. It also highlights why existing-file patching can fail and what should be improved.

## Main Code Paths

- `src/components/ChatPane.tsx`: owns the chat turn, context injection, agent loop, patch auto-apply, and workspace writes.
- `src/types/index.ts`: contains `AGENT_SYSTEM_PROMPT`, patch format instructions, and agent settings.
- `src/lib/agentTools.ts`: parses and executes agent tool markers such as `*** Read File`, `*** Write File`, `*** Delete Path`, and `*** Rename File`.
- `src/lib/patchApply.ts`: parses model patch blocks and applies unified-diff hunks to existing file content.
- `src/lib/fsWorkspace.ts`: reads, writes, deletes, renames, and resolves workspace paths using the browser File System Access API.
- `src/components/ChatMessage.tsx`: displays assistant output, agent action badges, and manual patch actions in chat mode.
- `src/components/DiffViewer.tsx`: previews manual patch results in chat mode.

## High-Level Flow

1. User opens a workspace folder.
2. User sends a prompt in agent mode.
3. `ChatPane.handleSend` creates a user message and calls `runAssistantTurn`.
4. `runAssistantTurn` builds a system prompt and workspace context.
5. The prompt is sent to the configured local LLM through `chatCompletion`.
6. The LLM may request more context using agent tool markers.
7. The app executes read/list tools and sends results back to the model for another iteration.
8. The final assistant response may contain patch blocks.
9. `parsePatches` extracts patch operations from the response.
10. `applyPatchToWorkspace` reads the current file, applies the patch, and writes the result back to disk.
11. The file tree and editor state are refreshed.
12. Success or failure is shown through toasts and action badges.

## Context Construction

`ChatPane.buildContextMessages` prepares workspace context before calling the model.

It includes:

- Project tree from `serializeFileTree`.
- Key files such as `package.json`, `tsconfig.json`, `vite.config.ts`, `README.md`, and `.env.example`.
- Recently patched files from `patchedPathsRef`.
- User-selected context files and `@mentioned` files.

Current size limits:

- Project tree: `30_000` chars.
- Auto-included files: `2_000` chars.
- Explicit files: `8_000` chars.
- Total context: `120_000` chars.

Important implication: existing-file patches are only as reliable as the file context given to the model. If the model receives a truncated or stale section, it may generate hunks that do not match the current file.

## Agent Tool Loop

The system prompt tells the model to request missing context with markers like:

```text
*** Read File: src/App.tsx
*** Read File: src/components/FileTree.tsx#L120-L240
*** List Directory: src/components
```

`agentTools.parseToolCalls` extracts these markers. `executeAgentTools` then performs the requested reads/lists through `fsWorkspace`.

If the model requested only read/list tools, `runAssistantTurn` sends tool results back to the model and continues the loop. This is controlled by:

- `settings.agentLoop`
- `settings.agentMaxIterations`

Note: the current loop code uses `agentMaxIterations`, but does not appear to check `settings.agentLoop` before enabling the multi-step loop. If the UI exposes `agentLoop` as a setting, this is a behavioral mismatch worth fixing.

## Direct File Operations

The model can emit direct file operation markers:

```text
*** Write File: path/to/file.ext
full contents here
*** End Write

*** Delete Path: path/to/file.ext
*** Rename File: old/path.ext -> new/path.ext
```

These are parsed by `agentTools.parseToolCalls` and executed by `executeAgentTools`.

Use cases:

- `Write File`: best for new files or explicit full-file replacement.
- `Delete Path`: removes a file or directory.
- `Rename File`: renames or moves a file.

Risk: `Write File` can replace an existing file without diff-level verification. The system prompt says patches should be used for surgical edits, but the runtime does not strongly enforce that distinction for write tools.

## Patch Format

The agent is instructed to emit patches like:

```diff
*** Begin Patch
*** Update File: src/example.ts
@@ -10,3 +10,4 @@
 context line
-old line
+new line
 context line
*** End Patch
```

Supported patch operations are:

- `*** Update File:` for existing-file unified-diff hunks.
- `*** Create File:` for new files.
- `*** Delete File:` for deletes.

`patchApply.parsePatches` extracts patch blocks from the assistant response. It also supports some fallback parsing when the model omits the outer `Begin Patch` / `End Patch` wrapper.

## Patch Application

`ChatPane.applyPatchToWorkspace` performs the actual write:

1. Resolve open workspace roots.
2. Read the current file with `readWorkspaceFile`.
3. Call `applyPatch(original, patch)`.
4. Write the result with `writeWorkspaceFile`.
5. Sync the editor tab content.

For `update` patches, `applyPatch` requires real unified-diff hunks for existing files. Whole-file update bodies are rejected with:

```text
Unsafe update patch for existing file: use @@ hunks instead of full-file replacement
```

`applyUnifiedDiff` tries to be tolerant:

- It uses hunk line numbers as hints, not absolute truth.
- It searches around the expected location.
- It can relocate hunks when line numbers drift.
- It tries exact, trim-end, trim, and collapsed-whitespace comparisons.
- It detects already-applied hunks as no-ops.

Patch context mismatch still happens when the old lines in the patch cannot be safely matched against the current file.

## Why Existing-File Patches Fail

Common failure message:

```text
Some patches failed: path/to/file.py: Patch context mismatch at line 5
```

This means the patch engine could not find the expected old/context lines in the file currently on disk.

Main causes:

- The model generated a patch from truncated context.
- The model generated a patch from stale context.
- The file changed after context was read but before the patch applied.
- The model invented nearby lines or normalized formatting incorrectly.
- The hunk has too little stable context.
- The hunk has ambiguous context that appears in multiple places.
- The model emits invalid unified diff syntax, especially blank lines without a prefix.
- A direct editor tab has unsaved changes while the file on disk is different.
- The same assistant response contains multiple hunks where an earlier hunk changes the anchor area for a later hunk.

## Current Strengths

- Existing-file updates reject unsafe full-file replacement bodies.
- Patch application can relocate hunks when line numbers drift.
- Whitespace-tolerant matching handles some formatting differences.
- Already-applied hunks are treated as successful no-ops.
- The model can request more file context before patching.
- Recently edited files are re-injected into later turns.
- Chat mode can show patch preview before manual apply.

## Current Gaps

- Failed auto-apply does not automatically recover by re-reading the file and asking the model for a corrected patch.
- The model is told to read full current files before editing, but the runtime does not enforce this for every `Update File` patch.
- Context injection can truncate files, which is risky for surgical edits.
- `settings.agentLoop` appears unused in the decision to perform the multi-step agent loop.
- Patch failure messages shown to the user are short and do not include enough recovery guidance.
- There is no preflight check that a patch is likely to apply before the final assistant message is accepted.
- `Write File` can mutate existing files without the same safety model as patches.
- There is no file version/hash check between read context and write time.
- Dirty editor tabs may diverge from disk state used by `readWorkspaceFile`.

## Recommended Improvements

### 1. Add Automatic Patch Repair

When `applyPatchToWorkspace` fails with a context mismatch:

1. Re-read the current target file.
2. Send the failed patch, current file content, and exact error back to the model.
3. Ask for a corrected patch only for the failed file.
4. Retry once or twice with a strict limit.

This directly addresses stale or truncated context. It is likely the highest-impact improvement.

### 2. Force Read-Before-Update For Existing Files

Before accepting an `Update File` patch for a path that was not included in full context, require the model to request:

```text
*** Read File: path/to/file
```

or a sufficiently broad ranged read around the target section.

Possible runtime rule:

- If an `Update File` patch targets a file not in full context, reject auto-apply and trigger a read/repair loop.

### 3. Include File Version Fingerprints

When files are read into context, include a small fingerprint:

```text
### File: src/example.ts
Fingerprint: sha256:abc123...
```

At write time, re-read the file and verify the fingerprint still matches. If not, do not apply blindly. Trigger repair with the latest file.

This prevents applying patches generated against stale content.

### 4. Improve Hunk Context Requirements

Update the system prompt to require at least two or three unchanged context lines around each changed block when possible.

Better hunk:

```diff
@@ -20,6 +20,7 @@
 stable line above
 another stable line
-old line
+new line
 stable line below
 another stable line below
```

This makes matching less ambiguous than single-line patches.

### 5. Add Patch Preflight Diagnostics

Before writing, run a dry apply that reports:

- Missing old lines.
- Ambiguous anchors.
- Invalid hunk syntax.
- Already-applied status.
- Suggested file read range for repair.

Then surface better messages than `Patch context mismatch at line N`.

### 6. Respect `agentLoop`

`runAssistantTurn` should use `settings.agentLoop` when deciding whether to continue tool iterations.

Expected behavior:

- If `agentLoop` is `false`, allow one model response and do not execute read/list follow-up loops.
- If `agentLoop` is `true`, use `agentMaxIterations` as it does today.

### 7. Protect Existing Files From `Write File`

For `*** Write File:` on an existing file, require one of these:

- User explicitly requested full replacement.
- The model includes a special confirmation marker.
- The app shows a diff preview before applying.

Otherwise, force unified-diff patches for existing files.

### 8. Handle Dirty Editor Tabs

Before applying a patch to a file that is open and dirty in the editor:

- Apply against the editor buffer instead of disk, or
- Ask the user to save/discard first, or
- Show a merge warning.

This avoids patching stale disk content while the user has unsaved edits.

### 9. Add Tests For Real Failure Modes

Add tests in `src/test/patchApply.test.ts` for:

- Ambiguous single-line anchors.
- Blank lines in hunks without prefixes.
- Multiple hunks where earlier hunks shift later anchors.
- Patches generated from truncated context.
- Already-applied multi-hunk patches.
- File content changed between read and apply.

### 10. Improve User-Facing Recovery

When a patch fails, the toast or message should say something like:

```text
Patch failed because the target file changed or the model had stale context. Re-reading the file and asking the agent to repair the patch...
```

If auto-repair fails, show:

```text
Open the file, mention it with @filename, and ask the agent to retry with the current content.
```

## Suggested Target Flow

The more reliable future flow should be:

1. User asks for a create/edit.
2. App injects tree and key files.
3. Model requests any missing target files.
4. App reads exact current files and includes fingerprints.
5. Model emits small unified-diff patches.
6. App preflights patches against current file content.
7. If preflight succeeds, app writes files.
8. If preflight fails, app re-reads current files and asks model for repair.
9. App retries repaired patches with a low retry limit.
10. App reports exact changed files or exact remaining failures.

## Priority Order

1. Implement automatic patch repair after context mismatch.
2. Enforce read-before-update for existing files.
3. Add file fingerprints to context and validate before writes.
4. Respect `settings.agentLoop` in `runAssistantTurn`.
5. Improve patch failure diagnostics and user messages.
6. Add protection for `Write File` on existing files.
7. Expand tests around patch mismatch scenarios.

## Summary

The current agent pipeline is already structured around a reasonable loop: build context, let the model request more context, parse patches, apply them through a guarded patch engine, and write through the workspace API. The recurring weakness is not file startup or application restart. It is stale or incomplete edit context. The most effective fix is a runtime repair loop that automatically re-reads the current file and asks the AI coding agent to regenerate only the failed patch against the latest content.
