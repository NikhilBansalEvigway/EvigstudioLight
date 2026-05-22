# Agent Diff/Approve Feature Plan (EvigStudioLight)

## Goal
When the assistant proposes code changes (create/update/delete/rename), users get an editor-like review flow:
preview a diff, approve or reject, and only then apply changes to disk.

## Current State (Relevant Pieces)
EvigStudioLight already has building blocks:
1. Patch parsing and safe application: `src/lib/patchApply.ts` (`parsePatches`, `applyPatch`).
2. Diff UI modal: `src/components/DiffViewer.tsx`.
3. Chat UI renders patch actions in chat mode: `src/components/ChatMessage.tsx` (`PatchAction`).
4. Workspace mutations live in chat: `src/components/ChatPane.tsx` (writes/deletes via `fsWorkspace`).

## Key Product Decisions
1. Default policy: never write to disk from patch text without explicit user action.
2. Agent tool writes (`*** Edit File`, `*** Write File`, etc.) should follow the same policy.
If we keep tool writes immediate, the approval feature will feel inconsistent.
3. Workspaces might not be git repos.
So the feature must work without git, using text diffs.
Optional: if a `.git/` exists, we can add git-aware affordances later.

## UX (What Users See)
1. In the assistant message, show a "Proposed changes (N)" section.
Each file row shows:
`path` + operation (create/update/delete/rename) + change count (+/-) + actions.
2. Per file actions:
`Preview` opens a diff (reuse `DiffViewer`).
`Approve` marks it approved.
`Reject` marks it rejected.
`Apply` is enabled only when approved.
3. Batch actions (sidebar/right pane "Changes"):
`Approve all`.
`Reject all`.
`Apply approved (N)`.
4. Failure states:
If apply fails due to context mismatch or file drift, show:
`Failed to apply` + error + `Preview` + `Open file`.

## Data Model
Persist proposals in chat message metadata so they survive reload and are shareable:
1. Extend `Message` with an optional `proposedPatches` array.
2. Patch entry fields:
`id` (uuid), `filePath`, `operation`, `content` (patch body), `status` (pending/approved/rejected/applied/failed), `error?`.
3. Optional snapshot fields (later):
`originalAtProposal` for stable preview even if the file changes.

## Behavior Rules
1. Collect proposals:
After assistant response completes, parse patch blocks and store as `pending` proposals.
2. Preview:
Read current file content, compute modified content by applying the patch in-memory.
3. Apply:
On apply, write/delete/rename through `fsWorkspace` and then update proposal status.
4. Never auto-apply patch text when approval mode is on.
5. Dedupe:
Avoid duplicating identical proposals if the assistant re-streams or regenerates.

## Settings
Add a single clear toggle:
`Require approval for agent edits` (default on).
Optional advanced toggle:
`Allow auto-apply` (unsafe, default off).

## Implementation Plan

### Phase 1 (MVP): Patch-Based Proposals (File-Level)
1. Parse assistant patch blocks at end-of-turn.
Store proposals on the assistant message.
2. Update `ChatMessage` patch UI:
Replace `Apply` with `Approve`, `Reject`, `Apply` (Apply gated by approval).
3. Add a "Changes" view:
Right pane tab listing proposals across the current chat.
4. Apply pipeline:
Move workspace patch writing into a shared helper so both chat and changes panel reuse it.

### Phase 2 (V1): Unify With Tool-Based Edits
1. Change agent tool execution so mutation tools do not write immediately.
Instead, convert each tool mutation into a proposal entry.
2. Keep read/list tools immediate.
3. Allow users to approve/apply tool proposals the same way as patch proposals.

### Phase 3 (V1.5): Conflict and Drift Handling
1. When apply fails, show a retry path:
`Rebase proposal on current file` (recompute proposed diff against current content).
2. Add "Open in editor" and "Copy patch" actions.

### Phase 4 (V2): Hunk-Level Approval
1. Parse unified diff hunks (`@@`) into structured hunks.
2. UI: checkbox per hunk; apply selected hunks.

### Phase 5 (Optional): Git-Aware Enhancements
Only if `.git` exists:
1. Show git status summary for applied changes.
2. Offer "Stage" and "Revert" actions using git.
3. Offer "Apply as commit" flow.

## Testing Plan
1. Unit tests:
Patch parsing and proposal dedupe.
Status transitions (pending -> approved -> applied, pending -> rejected, apply failure).
2. Integration tests:
Preview computes modified content without writing.
Apply writes expected content and updates editor buffer.
3. Manual:
1 file update.
Create file.
Delete file.
Conflicting update (context mismatch).

## Notes
This plan intentionally starts patch-based because the app already has:
`parsePatches`, `applyPatch`, and `DiffViewer`.
The biggest UX win comes from stopping silent writes and making every mutation explicit.
