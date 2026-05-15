const EDIT_INTENT_RE = /\b(edit|change|modify|update|fix|repair|refactor|implement|add|remove|delete|rename|move|create|write|replace|apply)\b/i;

export function isWorkspaceEditRequest(text: string): boolean {
  return EDIT_INTENT_RE.test(text);
}
