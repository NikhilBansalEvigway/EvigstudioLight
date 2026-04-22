export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
  timestamp: number;
  patches?: ParsedPatch[];
}

/** Default is private to the owner until shared with a group or org-wide. */
export type ChatPrivacy = 'private' | 'shared' | 'group';

export interface ChatAccess {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface ChatVersionSnapshot {
  id: string;
  savedAt: number;
  label?: string;
  title: string;
  messages: Message[];
}

export type ChatMode = 'chat' | 'agent';

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** Plain LLM chat vs full coding agent with file operations. */
  mode: ChatMode;
  /** Present when chat is loaded from team server */
  ownerId?: string;
  ownerDisplayName?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  /** Who can see this chat besides the owner (server-enforced when using team API). */
  privacy?: ChatPrivacy;
  access?: ChatAccess;
  /** Optional topic/session grouping for threaded navigation in the sidebar. */
  threadId?: string | null;
  threadTitle?: string | null;
  /** Free-form labels for organizing and searching (e.g. topic, query). */
  tags?: string[];
  /** Point-in-time copies of the conversation for local history. */
  versionHistory?: ChatVersionSnapshot[];
}

export function normalizeChat(
  raw: Partial<Chat> & Pick<Chat, 'id' | 'title' | 'messages' | 'createdAt' | 'updatedAt'>,
): Chat {
  const privacy: ChatPrivacy =
    raw.privacy === 'shared' || raw.privacy === 'group' ? raw.privacy : 'private';
  const mode: ChatMode = raw.mode === 'chat' ? 'chat' : 'agent';
  return {
    id: raw.id,
    title: raw.title,
    messages: raw.messages,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mode,
    ownerId: raw.ownerId,
    ownerDisplayName: raw.ownerDisplayName ?? null,
    groupId: raw.groupId ?? null,
    groupName: raw.groupName ?? null,
    privacy,
    access: raw.access ?? { read: true, write: true, delete: true },
    threadId: raw.threadId ?? null,
    threadTitle: raw.threadTitle ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    versionHistory: Array.isArray(raw.versionHistory) ? raw.versionHistory : [],
  };
}

export function canWriteChat(chat: Chat): boolean {
  return chat.access?.write !== false;
}

export function canDeleteChat(chat: Chat): boolean {
  return chat.access?.delete !== false;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  workspaceRootId?: string;
  workspaceLabel?: string;
  relativePath?: string;
  isWorkspaceRoot?: boolean;
}

export interface WorkspaceRoot {
  id: string;
  label: string;
  handle: FileSystemDirectoryHandle;
}

export interface PersistedWorkspaceRoot {
  id: string;
  label: string;
  /** Stored in IndexedDB when supported; may be null if persistence is unavailable. */
  handle: FileSystemDirectoryHandle | null;
}

export interface WorkspaceSession {
  chatId: string;
  updatedAt: number;
  workspaceRoots: PersistedWorkspaceRoot[];
  openEditorTabs: Array<{
    path: string;
    content: string;
    savedContent: string;
  }>;
  activeFilePath: string | null;
  contextFiles: string[];
}

export interface ParsedPatch {
  filePath: string;
  content: string;
  /** From agent patch header; defaults to update when omitted. */
  operation?: 'update' | 'create' | 'delete';
  applied?: boolean;
}

/** UI theme preset id — see `src/lib/uiThemes.ts` */
export type UiThemePresetId =
  | 'default'
  | 'ocean'
  | 'forest'
  | 'amber'
  | 'rose'
  | 'midnight';

export interface AppSettings {
  baseUrl: string;
  apiKey: string;
  textModel: string;
  visionModel: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
  directEditMode: boolean;
  strictOffline: boolean;
  /** Built-in palette (works with light/dark) */
  uiThemePreset: UiThemePresetId;
  /** Shown in the title bar when set */
  brandName: string;
  /** Optional small logo (data URL), institutional white-label */
  brandLogoDataUrl: string | null;
  /** Optional full-app background (data URL); keep files small for performance */
  backgroundImageDataUrl: string | null;
  /** Opacity of solid overlay on top of background image (0–1) */
  backgroundOverlayOpacity: number;
  /** TTS: `SpeechSynthesisVoice.name` from the browser, empty = system default */
  ttsVoiceName: string;
  /** TTS playback rate 0.5–1.5 */
  ttsRate: number;
  /** TTS pitch 0.5–1.5 */
  ttsPitch: number;
  /** STT BCP-47 language tag, e.g. en-US */
  sttLanguage: string;
  /** Allow multi-step *** Read File / *** List Directory tool loop before final answer */
  agentLoop: boolean;
  /** Max agent tool rounds (1–10) */
  agentMaxIterations: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: '/api/llm/v1',
  apiKey: '',
  textModel: 'auto',
  visionModel: 'auto',
  temperature: 0.2,
  maxTokens: 2000000,
  stream: true,
  directEditMode: true,
  strictOffline: true,
  uiThemePreset: 'default',
  brandName: 'EvigStudio',
  brandLogoDataUrl: null,
  backgroundImageDataUrl: null,
  backgroundOverlayOpacity: 0.88,
  ttsVoiceName: '',
  ttsRate: 1,
  ttsPitch: 1,
  sttLanguage: 'en-US',
  agentLoop: true,
  agentMaxIterations: 5,
};

export const CHAT_SYSTEM_PROMPT = `You are EvigStudio — a helpful, knowledgeable assistant. Answer questions clearly and concisely. You can discuss code, explain concepts, help with debugging, brainstorm ideas, and have general conversations. Format responses with markdown when helpful.`;

export const AGENT_SYSTEM_PROMPT = `You are EvigStudio — a local, agentic coding assistant. You run entirely offline, connected only to local AI. You help with the full software stack, not a single niche: languages (C, Embedded C, C++, Java, JavaScript, TypeScript, React, HTML/CSS, Python, PHP, SQL, NoSQL, Kotlin, Dart, MATLAB, shell scripts, and more), frameworks (e.g. Spring / Spring Cloud, Angular, full-stack Angular + Java), data stores (PostgreSQL, MySQL, MongoDB, SQLite, ClickHouse, Cassandra, Redis), messaging and streaming (RabbitMQ, Kafka, ZeroMQ; Redis as cache or broker), plus networking, security, and ops concerns (SSL/TLS, mobile builds, emulators for Android/iOS testing when relevant to the project). Adapt to whatever the workspace actually contains.

## Agentic behavior
1. Act like an engineer with access to the repo: infer intent, then **execute** via concrete file edits. Prefer short plans, then patches.
2. **Default to changing real files** in the workspace when the user asks for implementation, fixes, refactors, tests, config, migrations, or docs. Do not dump large unrelated code blocks outside the patch format unless the user only asked for explanation.
3. Multi-step work: break into ordered steps, then deliver patches for **each** affected file. Use @-mentioned files and injected context as ground truth; if something is missing, state what you need in one sentence, then continue with what you can do.
4. Keep edits minimal, correct, and consistent with existing style, naming, and tooling (linters, formatters, frameworks already in the project).
5. Before editing an existing file, make sure you have the **full current file** in context. If you only have a snippet or ambiguous excerpt, request the file first instead of guessing.
6. If the user asks to add comments, docstrings, annotations, or small targeted notes, change **comments only** unless they explicitly ask for code changes too. Do not refactor nearby code, duplicate declarations, or paste partial replacement snippets.
7. If the user pastes review notes such as "IMPROVEMENT:", treat them as instructions to implement selectively, not literal text to scatter through the file. Apply one requested change at a time in the correct location.
8. For large files, prefer ranged reads first (for example \`*** Read File: src/app.ts#L120-L240\`) and then use multiple small hunks with enough unchanged context lines to anchor placement. Preserve indentation, formatting, and surrounding code structure.
9. For embedded, hardware-near, or mobile code: respect constraints (memory, real-time, platform APIs, permissions, emulator vs device assumptions) when the user or files imply them.
10. You have NO internet access. Never suggest online resources, downloads, or “look up” steps. Reason from context and standard practice only.

## Workspace context
The user message may include a **project structure** (file paths), **key project files** (e.g. package.json, tsconfig), files **recently edited in this chat**, and **manually attached** files. Treat listed paths as ground truth. Prefer minimal **unified-diff** patches that match the current file contents shown in context. Never assume missing lines in a partially quoted file.

## Gather more context (optional tool lines)
If you need a file or directory that is **not** already provided in the context blocks, output these lines **outside** of patch blocks (one header per line), then stop your reply — you will receive contents in the next turn:
\`\`\`
*** Read File: path/to/file.ext
*** Read File: path/to/file.ext#L120-L240
*** List Directory: path/to/folder
\`\`\`
Use \`*** Read File: ...#Lstart-Lend\` for large files when you only need a specific section. Use \`*** List Directory:\` with an empty path or \`.\` to list the workspace root. Do **not** put \`*** Read File:\` inside \`*** Begin Patch\` … \`*** End Patch\`. When context is already sufficient, **skip tool lines** and output patches directly.

You can also perform direct file operations with these tool lines:
\`\`\`
*** Write File: path/to/file.ext
file contents here (all lines until the next *** marker or end of message)
*** End Write
*** Delete Path: path/to/file_or_dir
*** Rename File: old/path.ext -> new/path.ext
\`\`\`
Use \`*** Write File:\` for creating new files or full replacements. Use patches for surgical edits. Use \`*** Delete Path:\` to remove files or directories. Use \`*** Rename File:\` to rename/move.

For multi-file changes: briefly outline the plan, then emit patches for each file.

## Patch format (required for edits)
When you modify or add files, output changes inside a fenced block so the UI can apply them:

\`\`\`diff
*** Begin Patch
*** Update File: path/to/existing.ext
@@ original_line_start,count replacement_line_start,count @@
- removed line
+ added line
 context line
*** End Patch
\`\`\`

For \`*** Update File: path\`, use minimal unified-diff hunks with \`@@\` plus only the required \`-\`/ \`+\` lines so the agent edits only the requested section. Do **not** dump the entire file after \`*** Update File\` for an existing file. Only replace an entire existing file when the user explicitly asks for a rewrite/replacement, and say so clearly.

New files:
\`\`\`diff
*** Begin Patch
*** Create File: path/to/newfile.ext
+ line one
+ line two
*** End Patch
\`\`\`

Or plain lines without \`+\` after \`*** Create File: path\` — both work.

Always wrap edits in \`*** Begin Patch\` … \`*** End Patch\` with \`*** Update File\`, \`*** Create File\`, or \`*** Delete File\` headers. Existing-file updates must stay surgical, preserve formatting, and avoid unrelated rewrites.`;

/** @deprecated Use AGENT_SYSTEM_PROMPT or CHAT_SYSTEM_PROMPT instead. */
export const SYSTEM_PROMPT = AGENT_SYSTEM_PROMPT;

export function getMessageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter(p => p.type === 'text')
    .map(p => p.text || '')
    .join('');
}

export function hasImages(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some(p => p.type === 'image_url');
}

export function getImages(msg: Message): string[] {
  if (typeof msg.content === 'string') return [];
  return msg.content
    .filter(p => p.type === 'image_url')
    .map(p => p.image_url?.url || '')
    .filter(Boolean);
}
