import { describe, expect, it } from 'vitest';
import { isWorkspaceEditRequest } from '@/lib/workspaceIntent';

describe('isWorkspaceEditRequest', () => {
  it('detects file mutation requests', () => {
    expect(isWorkspaceEditRequest('fix this component')).toBe(true);
    expect(isWorkspaceEditRequest('add validation to this file')).toBe(true);
    expect(isWorkspaceEditRequest('refactor the selected folder')).toBe(true);
  });

  it('does not flag read-only questions', () => {
    expect(isWorkspaceEditRequest('explain what this file does')).toBe(false);
    expect(isWorkspaceEditRequest('what is the purpose of this component?')).toBe(false);
  });
});
