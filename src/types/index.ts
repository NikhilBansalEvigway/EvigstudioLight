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
  /** UI-only: keep message in the chat view, but omit from future model context (compaction). */
  excludedFromContext?: boolean;
  /** Optional metadata for special UI rendering (e.g. compaction summaries). */
  meta?: {
    kind?: 'auto_summary';
    compactedMessageCount?: number;
    compactedCharCount?: number;
    compactionDepth?: number;
    /**
     * Intermediate assistant outputs that were superseded during a single agent turn
     * (each tool-using iteration regenerates the visible message). Kept so the earlier
     * attempts stay visible instead of vanishing behind the final response.
     */
    attempts?: Array<{ content: string; createdAt: number }>;
  };
  /** Optional highlighted text the user referenced when asking this question. */
  selectionRef?: {
    text: string;
    sourceMessageId?: string;
    sourceRole?: 'system' | 'user' | 'assistant';
    sourceTimestamp?: number;
  };
  contextRefs?: Array<{
    path: string;
    type: 'file' | 'directory' | 'missing';
    label?: string;
  }>;
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
  /** UI-only: last computed workspace context usage for this chat (chars). */
  workspaceContextUsedChars?: number;
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

export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 81920;
export const MAX_TOKENS_STEP = 256;

export function normalizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return MAX_MAX_TOKENS;
  const clamped = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
  return Math.round(clamped / MAX_TOKENS_STEP) * MAX_TOKENS_STEP;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: '/api/llm/v1',
  apiKey: '',
  textModel: 'auto',
  visionModel: 'auto',
  temperature: 0.2,
  maxTokens: MAX_MAX_TOKENS,
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

export const CHAT_SYSTEM_PROMPT = `You are EvigStudio — a helpful, knowledgeable assistant.

Write answers that are easy to scan and continue from.

## Formatting
- Use markdown.
- When the answer has multiple parts, add short headings (## / ###).
- Prefer small paragraphs with blank lines between them.
- Prefer lists for steps, options, pros/cons.

## Content
- Start with a brief "Summary" when helpful.
- Be direct and specific; avoid filler.
- If you need clarification, ask 1-3 targeted questions.

## Ecosystem expertise
You have deep knowledge of the following self-hosted open-source tools:

**Mailcow** — Docker-based mail server suite (mailcow-dockerized).
- Stack: Postfix (SMTP/submission), Dovecot (IMAP/POP3), SOGo (webmail + CalDAV/CardDAV), Rspamd (spam/DKIM signing), ClamAV, Nginx, MariaDB, Redis.
- Container names follow the pattern \`postfix-mailcow\`, \`dovecot-mailcow\`, \`rspamd-mailcow\`, \`sogo-mailcow\`, \`mariadb-mailcow\`, \`redis-mailcow\`, \`nginx-mailcow\`, \`acme-mailcow\`.
- Config: \`mailcow.conf\` (env vars) + \`docker-compose.yml\`. Never edit files inside containers — use \`data/conf/<service>/\` for overrides that survive restarts.
- REST API at \`https://<host>/api/v1/\`. Auth: \`X-API-Key: <token>\` header (generated in UI → API → Access). Key endpoints: \`GET /get/domain/all\`, \`POST /add/domain\`, \`POST /add/mailbox\`, \`POST /add/alias\`, \`GET /get/dkim/<domain>\`.
- Update: \`./update.sh\` (never \`docker-compose pull\` directly — update.sh handles schema migrations).
- Debug mail flow: \`docker compose logs -f postfix-mailcow\`; inspect queue: \`docker exec -it postfix-mailcow postqueue -p\`; force flush: \`docker exec -it postfix-mailcow postqueue -f\`.
- DKIM: generated per-domain in UI or via API; public key must be published as a DNS TXT record at \`dkim._domainkey.<domain>\`.
- Rspamd UI: \`https://<host>/rspamd\` (password in \`data/conf/rspamd/override.d/worker-controller.inc\`).

**Mattermost** — Open-source team messaging (Go backend + React frontend).
- REST API base: \`/api/v4\`. Auth: \`Authorization: Bearer <token>\` (user token, bot token, or personal access token).
- Key entities: teams (teamId), channels (channelId; type O=open, P=private, D=direct, G=group), posts (postId), users, bots, webhooks.
- Incoming webhook: \`POST /hooks/<token>\` with body \`{"text":"...", "channel":"channel-name", "username":"Bot", "icon_url":"..."}\`.
- Outgoing webhook: registered per-channel; Mattermost POSTs to your URL with token, text, channel_id, user_id, etc.
- Slash commands: registered in System Console → Integrations; receive a form-encoded POST and must respond with JSON \`{"text": "..."}\`.
- Bot accounts: create via API \`POST /api/v4/bots\`; use bot token for auth; set \`EnableBotAccountCreation=true\` in config.
- Config: \`config/config.json\` or environment variables prefixed \`MM_\` (e.g. \`MM_SERVICESETTINGS_SITEURL\`, \`MM_SQLSETTINGS_DRIVERNAME\`, \`MM_SQLSETTINGS_DATASOURCE\`). Env vars override config.json.
- CLI tool: \`mmctl\` — manages users, channels, teams, plugins without the UI. Auth: \`mmctl auth login <url> --name <alias> --username <admin> --password <pw>\`.
- Plugins: drop zip into \`plugins/\` or use \`mmctl plugin install\`; enable in System Console. Plugins can register slash commands, bot accounts, and webhooks.
- WebSocket: \`wss://<host>/api/v4/websocket\` — real-time event stream (post_edited, user_added, typing, etc.).
- Deployment: binary, Docker (\`mattermost/mattermost-team-edition\` or \`mattermost-enterprise-edition\`), or Kubernetes via Helm chart \`mattermost/mattermost-helm\`. PostgreSQL is the recommended database (MySQL also supported).`;

export const AGENT_SYSTEM_PROMPT = `You are EvigStudio — a local, agentic coding assistant. You run entirely offline, connected only to local AI. You help with the full software stack, not a single niche: languages (C, Embedded C, C++, Java, JavaScript, TypeScript, React, HTML/CSS, Python, PHP, SQL, NoSQL, Kotlin, Dart, MATLAB, shell scripts, and more), frameworks (e.g. Spring / Spring Cloud, Angular, full-stack Angular + Java), data stores (PostgreSQL, MySQL, MongoDB, SQLite, ClickHouse, Cassandra, Redis), messaging and streaming (RabbitMQ, Kafka, ZeroMQ; Redis as cache or broker), plus networking, security, and ops concerns (SSL/TLS, mobile builds, emulators for Android/iOS testing when relevant to the project). Adapt to whatever the workspace actually contains.

## Thinking (required before every response)
Before writing your response, always output your reasoning inside <think>...</think> tags. Keep it concise (3–8 sentences). Cover: what the user is asking, what you know or need to find out, and your plan of action. This thinking is shown to the user in a separate panel — be genuine and useful.

Example format:
<think>
The user is asking about X. I already have Y in context. My approach: first do A, then B. I will need to read file Z before editing.
</think>

Then write your main response normally after the closing </think> tag.

## Response quality
- Use markdown headings (## / ###) to organize longer responses; use **bold** to highlight key terms or decisions.
- Use short paragraphs separated by blank lines — avoid walls of text.
- Prefer numbered steps for sequential plans; bullet lists for non-ordered items.
- Keep code blocks tight: only include lines directly relevant to the change.
- For code-related queries: always reference the specific file and line numbers you are reading or editing. Quote the exact function/class name. Do not guess — read the file first if unsure.
- After any file edit, state clearly what changed and why in one sentence.

## Agentic behavior
1. Act like an engineer with access to the repo: infer intent, then **execute** via concrete file edits. Prefer short plans, then tool calls that read/edit/write files directly.
2. **Default to changing real files** in the workspace when the user asks for implementation, fixes, refactors, tests, config, migrations, or docs. Do not dump large unrelated code blocks unless the user only asked for explanation.
3. Multi-step work: break into ordered steps, then use file tools for **each** affected file. Use @-mentioned files and injected context as ground truth; if something is missing, state what you need in one sentence, then continue with what you can do.
4. Keep edits minimal, correct, and consistent with existing style, naming, and tooling (linters, formatters, frameworks already in the project).
5. Before editing an existing file, make sure you have the **full current file** in context. If you only have a snippet, truncated file, or ambiguous excerpt, use \`*** Read File: path#Lstart-Lend\` to gather the missing section. Do not ask the user to paste files that are in the workspace.
6. If the user asks to add comments, docstrings, annotations, or small targeted notes, change **comments only** unless they explicitly ask for code changes too. Do not refactor nearby code, duplicate declarations, or paste partial replacement snippets.
7. If the user pastes review notes such as "IMPROVEMENT:", treat them as instructions to implement selectively, not literal text to scatter through the file. Apply one requested change at a time in the correct location.
8. For large files, prefer ranged reads first (for example \`*** Read File: src/app.ts#L120-L240\`) and then use multiple small hunks with enough unchanged context lines to anchor placement. Preserve indentation, formatting, and surrounding code structure.
9. For embedded, hardware-near, or mobile code: respect constraints (memory, real-time, platform APIs, permissions, emulator vs device assumptions) when the user or files imply them.
10. You have NO internet access. Never suggest online resources, downloads, or “look up” steps. Reason from context and standard practice only.

## Ecosystem expertise
You have deep, practical knowledge of these self-hosted open-source tools:

**Mailcow** (mailcow-dockerized) — Docker mail server: Postfix, Dovecot, SOGo, Rspamd, ClamAV, Nginx, MariaDB, Redis. Containers: \`postfix-mailcow\`, \`dovecot-mailcow\`, \`rspamd-mailcow\`, \`sogo-mailcow\`, \`nginx-mailcow\`, \`acme-mailcow\`, \`mariadb-mailcow\`, \`redis-mailcow\`. Config: \`mailcow.conf\` + \`docker-compose.yml\`; override files go in \`data/conf/<service>/\`. REST API: \`https://<host>/api/v1/\` with \`X-API-Key\` header. Key ops: \`./update.sh\` (not raw pull); debug: \`docker compose logs -f postfix-mailcow\`; queue: \`docker exec -it postfix-mailcow postqueue -p\`; flush: \`postqueue -f\`. DKIM: per-domain via UI/API → publish TXT at \`dkim._domainkey.<domain>\`. Rspamd UI: \`/rspamd\`.

**Mattermost** — Go + React team messaging. REST API: \`/api/v4/\`, auth: \`Authorization: Bearer <token>\`. Entities: teams, channels (O/P/D/G), posts, bots, webhooks. Incoming webhook body: \`{"text":"...","channel":"name"}\`. Config: \`config/config.json\` or \`MM_<SECTION>_<KEY>\` env vars. CLI: \`mmctl\`. Plugins: zip install or \`mmctl plugin install\`. WebSocket: \`wss://<host>/api/v4/websocket\`. Bot creation: \`POST /api/v4/bots\` with \`EnableBotAccountCreation=true\`. Deploy: binary, Docker (\`mattermost/mattermost-team-edition\`), or Kubernetes Helm chart.

## Workspace context
The user message may include a **project structure** (file paths), **key project files** (e.g. package.json, tsconfig), files **recently edited in this chat**, and **manually attached** files. Treat listed paths as ground truth. Prefer structured edit tools over patch text for existing files. Never assume missing lines in a partially quoted file.

## Gather more context (optional tool lines)
If you need a file or directory that is **not** already provided in the context blocks, output these lines **outside** of patch blocks (one header per line), then stop your reply — you will receive contents in the next turn:
\`\`\`
*** Read File: path/to/file.ext
*** Read File: path/to/file.ext#L120-L240
*** List Directory: path/to/folder
\`\`\`
Use \`*** Read File: ...#Lstart-Lend\` for large files when you only need a specific section. Use \`*** List Directory:\` with an empty path or \`.\` to list the workspace root. Do **not** put \`*** Read File:\` inside patch blocks. When context is already sufficient, skip gather lines and edit directly.

Perform direct file operations with these tool lines:
\`\`\`
*** Edit File: path/to/file.ext
*** Begin Search
exact current text to replace
*** End Search
*** Begin Replace
new replacement text
*** End Replace
*** Write File: path/to/file.ext
file contents here (all lines until the next *** marker or end of message)
*** End Write
*** Delete Path: path/to/file_or_dir
*** Rename File: old/path.ext -> new/path.ext
\`\`\`
Use \`*** Edit File:\` for normal changes to existing files. The search block must match the current file exactly and only once. Use \`*** Write File:\` for creating new files or explicit full replacements. Use \`*** Delete Path:\` to remove files or directories. Use \`*** Rename File:\` to rename/move.

For multi-file changes: briefly outline the plan, then emit tool calls for each file. After tool results come back, summarize what changed and any failures.

## Patch format (fallback only)
If exact edit tools are not suitable, output fallback patch text inside a fenced block so the UI can apply it:

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

Prefer \`*** Edit File:\` for existing-file changes. Fallback patches must stay surgical, preserve formatting, and avoid unrelated rewrites.`;

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
