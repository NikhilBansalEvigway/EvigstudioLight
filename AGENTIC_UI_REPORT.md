# EvigStudio Agentic UX Report

## What Changed

### 1. Agent Transparency
- Added a dedicated `Agent Activity` panel in the chat pane.
- Tool execution now appears as a live timeline with running, success, and error states.
- Workspace mutations now produce clearer success feedback such as `File updated`.
- Assistant thinking blocks now render in a more distinct thought container.

### 2. Chat Readability
- User and assistant messages now have clearer visual separation through softer bubbles, borders, and depth.
- Assistant responses can show a compact execution badge like `File updated` or `Workspace changes`.

### 3. Composer Improvements
- Attached images now preview directly in the composer surface before send.
- Mentioned files now appear as context chips in the composer surface, with quick remove controls.
- Selection references stay visible inside the composer until sent or removed.

### 4. Layout Improvements
- Collapsing the left sidebar now switches to an icon rail instead of fully removing navigation.
- Resize handles are easier to hit but visually quieter until hover.
- Status bar and sidebar glass styling were strengthened for better depth when a background is active.

### 5. Context Awareness
- Added an `Active Context Budget` indicator directly in the chat pane.
- The file tree now highlights the currently open file when it is also being referenced in the conversation.

## User Stories

### Story 1: "I want to know what the agent is doing"
When I ask EvigStudio to change code, I can now see a live activity feed showing whether it is thinking, searching the workspace, reading files, or updating files.

### Story 2: "I want cleaner conversations"
When I read a long thread, I can more easily tell which messages are mine, which are the assistant's, and which content is internal reasoning versus the final answer.

### Story 3: "I want confidence before I send context"
When I attach images or mention files with `@`, I see those items as visible chips/previews in the composer before sending.

### Story 4: "I don't want navigation to disappear"
When I collapse the chat list, I still keep a slim icon rail for quick access to chats, files, settings, and admin.

### Story 5: "I need to understand what the model knows"
When I work in long coding conversations, I can now see a compact context budget indicator and how many references are active.

### Story 6: "I want conversation-to-code linkage"
When the current conversation refers to the file I have open, that file now gets highlighted in the tree so the relationship is easier to track.

## Verification Notes
- Host-side `npm run build` and `npm test` could not run initially because local Node dependencies were not installed.
- Docker-based verification was attempted next.
- Docker frontend build and Docker test setup were blocked during `npm ci` by an `electron` install network timeout.
