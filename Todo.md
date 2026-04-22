# EvigStudio Next Todo

## Highest Priority

1. Add focused tests for the riskiest shared features
   - Chat access and lock rules: `server/src/routes/chats.ts`, `server/src/rbac.ts`
   - Auth/session behavior: `server/src/routes/auth.ts`
   - Workspace file operations: `src/lib/fsWorkspace.ts`, especially rename and delete paths

## Regression Coverage

## Completed

- `Remember me` no longer stores the raw password in `localStorage`.
- Login now remembers only the email on the client and sends `rememberMe` to the backend.
- The auth server now records remember-me logins in audit data and only makes the cookie persistent when the checkbox is enabled.
- Workspace rename now supports files, folders, and workspace-relative moves instead of only same-folder file renames.
- File tree folder rows now expose rename/move actions, and open editor/context path references stay in sync after moves.
- Agent tool reads now support large-file ranged requests like `*** Read File: src/file.ts#L120-L240`.
- Added parser coverage for ranged read tool syntax in `src/test/agentTools.test.ts`.
- Editor tabs now track dirty state, warn before closing unsaved work, support save-all, and register a browser unload warning while edits are unsaved.
- Sidebar discovery now includes mine/shared/team/locked filters plus visibility badges for private/shared/team chats and read-only state.
- Shared team workspace references are now visible in the main app Context pane, with copy actions for the stored paths.

## Already Done From The Old List

- File search in the file tree already exists in `src/components/FileTree.tsx`.
- Clickable file badges after agent edits already exist in `src/components/ChatMessage.tsx` and `src/components/ChatPane.tsx`.
- Password change already exists for self-service and admin flows in `src/pages/AdminPage.tsx` and `server/src/routes/auth.ts`.
- A `Remember me` checkbox exists already, but it needs a security/behavior fix rather than a fresh implementation.
