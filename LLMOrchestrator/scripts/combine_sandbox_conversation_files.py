from __future__ import annotations

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "SANDBOX_CONVERSATION_PIPELINE_FILES.md"


FILE_GROUPS: list[tuple[str, list[str]]] = [
    (
        "App Entry And Routing",
        [
            "openhands/server/app.py",
            "openhands/server/listen.py",
            "openhands/app_server/v1_router.py",
        ],
    ),
    (
        "Frontend Conversation Start",
        [
            "frontend/src/routes/home.tsx",
            "frontend/src/components/features/home/repo-selection-form.tsx",
            "frontend/src/hooks/mutation/use-create-conversation.ts",
            "frontend/src/api/conversation-service/v1-conversation-service.api.ts",
            "frontend/src/hooks/query/use-task-polling.ts",
            "frontend/src/routes/conversation.tsx",
            "frontend/src/hooks/query/use-active-conversation.ts",
            "frontend/src/hooks/query/use-user-conversation.ts",
            "frontend/src/stores/conversation-store.ts",
            "frontend/src/hooks/use-handle-plan-click.ts",
            "frontend/src/hooks/use-handle-ask-click.ts",
        ],
    ),
    (
        "Frontend Live Conversation Maintenance",
        [
            "frontend/src/contexts/websocket-provider-wrapper.tsx",
            "frontend/src/contexts/conversation-websocket-context.tsx",
            "frontend/src/hooks/use-websocket.ts",
            "frontend/src/utils/websocket-url.ts",
            "frontend/src/hooks/use-send-message.ts",
            "frontend/src/wrapper/event-handler.tsx",
            "frontend/src/hooks/use-handle-ws-events.ts",
            "frontend/src/stores/use-event-store.ts",
            "frontend/src/utils/handle-event-for-ui.ts",
            "frontend/src/components/features/chat/chat-interface.tsx",
        ],
    ),
    (
        "Frontend Terminal VSCode Served App",
        [
            "frontend/src/components/features/conversation/conversation-tabs/conversation-tabs.tsx",
            "frontend/src/components/features/terminal/terminal.tsx",
            "frontend/src/hooks/use-terminal.ts",
            "frontend/src/stores/command-store.ts",
            "frontend/src/hooks/query/use-unified-vscode-url.ts",
            "frontend/src/utils/vscode-url-helper.ts",
            "frontend/src/routes/vscode-tab.tsx",
            "frontend/src/hooks/query/use-unified-active-host.ts",
            "frontend/src/routes/served-tab.tsx",
            "frontend/src/components/v1/chat/event-message-components/user-assistant-event-message.tsx",
        ],
    ),
    (
        "Backend Conversation Start Orchestration",
        [
            "openhands/app_server/app_conversation/app_conversation_router.py",
            "openhands/app_server/app_conversation/live_status_app_conversation_service.py",
            "openhands/app_server/app_conversation/app_conversation_service_base.py",
            "openhands/app_server/app_conversation/app_conversation_models.py",
            "openhands/app_server/app_conversation/sql_app_conversation_start_task_service.py",
            "openhands/app_server/app_conversation/sql_app_conversation_info_service.py",
            "openhands/app_server/config.py",
        ],
    ),
    (
        "Backend Sandbox Proxy Webhook Event Persistence",
        [
            "openhands/app_server/sandbox/sandbox_router.py",
            "openhands/app_server/sandbox/sandbox_service.py",
            "openhands/app_server/sandbox/docker_sandbox_service.py",
            "openhands/app_server/sandbox/sandbox_models.py",
            "openhands/app_server/event_callback/webhook_router.py",
            "openhands/app_server/event/event_router.py",
            "openhands/app_server/event/event_service_base.py",
            "openhands/app_server/event/filesystem_event_service.py",
            "openhands/app_server/event_callback/sql_event_callback_service.py",
            "openhands/app_server/utils/conversation_debug_log.py",
        ],
    ),
    (
        "Runtime Plugin Exposure",
        [
            "openhands/runtime/plugins/vscode/__init__.py",
            "openhands/runtime/base.py",
            "openhands/runtime/impl/docker/docker_runtime.py",
            "openhands/app_server/app_conversation/skill_loader.py",
        ],
    ),
    (
        "Legacy Bridge Files",
        [
            "frontend/src/api/conversation-service/conversation-service.api.ts",
            "frontend/src/hooks/query/use-conversation-config.ts",
            "openhands/server/routes/manage_conversations.py",
            "openhands/server/routes/conversation.py",
        ],
    ),
    (
        "External Image Wrapper Reference",
        [
            "agent-server/Dockerfile",
        ],
    ),
]


def detect_language(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".py": "python",
        ".ts": "ts",
        ".tsx": "tsx",
        ".js": "js",
        ".jsx": "jsx",
        ".sh": "bash",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".toml": "toml",
        ".md": "md",
        ".json": "json",
        ".dockerfile": "dockerfile",
    }.get(suffix, "")


def render_file(relative_path: str) -> str:
    path = ROOT / relative_path
    if not path.exists():
        return f"## {relative_path}\n\nMISSING: `{relative_path}`\n"

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")

    language = detect_language(path)
    return (
        f"## {relative_path}\n\n"
        f"Path: `{relative_path}`\n\n"
        f"```{language}\n{content}\n```\n"
    )


def build_document() -> str:
    lines: list[str] = [
        "# Sandbox Conversation Pipeline Files",
        "",
        "This file is generated by `scripts/combine_sandbox_conversation_files.py`.",
        "",
    ]

    for group_name, files in FILE_GROUPS:
        lines.append(f"# {group_name}")
        lines.append("")
        for relative_path in files:
            lines.append(render_file(relative_path).rstrip())
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Combine sandbox conversation pipeline files into one Markdown file."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output file path. Default: {DEFAULT_OUTPUT}",
    )
    args = parser.parse_args()

    output_path = args.output
    if not output_path.is_absolute():
        output_path = ROOT / output_path

    output_path.write_text(build_document(), encoding="utf-8")
    print(f"Wrote combined file to {output_path}")


if __name__ == "__main__":
    main()
