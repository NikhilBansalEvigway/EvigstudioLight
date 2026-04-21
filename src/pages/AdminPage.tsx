import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth, type AuthUser } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Pencil, Plus, Search, Trash2 } from 'lucide-react';

type UserRow = Pick<AuthUser, 'id' | 'email' | 'displayName' | 'role'> & { createdAt?: string };

type GroupRow = { id: string; name: string; description: string | null };

type AuditRow = {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: AuditMetadata | null;
  actor?: AuditMetadata['actor'];
  target?: AuditMetadata['target'];
  access?: AuditMetadata['access'];
  change?: AuditMetadata['change'];
  result?: AuditMetadata['result'];
  details?: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
};

type AuditSummary = {
  total: number;
  success: number;
  denied: number;
  error: number;
  chatReads: number;
  loginFailures: number;
  adminChanges: number;
  llmQueries: number;
  topActions: Array<{ action: string; total: number }>;
  retentionDays: number;
  window: { start: string | null; end: string | null };
};

type AuditMetadata = {
  actor?: {
    id?: string;
    email?: string;
    displayName?: string;
    role?: string;
  } | null;
  target?: {
    type?: string;
    id?: string | null;
    label?: string | null;
    ownerDisplayName?: string | null;
    groupName?: string | null;
  } | null;
  context?: {
    method?: string;
    route?: string;
    ip?: string | null;
    userAgent?: string | null;
  } | null;
  access?: {
    mode?: string | null;
    reason?: string | null;
    privacy?: string | null;
    isOwner?: boolean;
    groupName?: string | null;
  } | null;
  change?: {
    fields?: string[];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  } | null;
  result?: {
    status?: 'success' | 'denied' | 'error';
    code?: number | null;
    reason?: string | null;
  } | null;
  details?: Record<string, unknown> | null;
};

const AUDIT_ACTION_FILTERS = [
  { value: 'all', label: 'All actions' },
  { value: 'auth.', label: 'Auth' },
  { value: 'chat.', label: 'Chats' },
  { value: 'group.', label: 'Groups' },
  { value: 'admin.', label: 'Admin' },
  { value: 'llm.', label: 'LLM' },
  { value: 'audit.', label: 'Audit' },
];

const AUDIT_RESOURCE_FILTERS = [
  { value: 'all', label: 'All resources' },
  { value: 'user', label: 'user' },
  { value: 'group', label: 'group' },
  { value: 'chat', label: 'chat' },
  { value: 'group_workspace', label: 'group_workspace' },
  { value: 'llm_proxy', label: 'llm_proxy' },
  { value: 'audit_log', label: 'audit_log' },
];

const AUDIT_RESULT_FILTERS = [
  { value: 'all', label: 'All results' },
  { value: 'success', label: 'success' },
  { value: 'denied', label: 'denied' },
  { value: 'error', label: 'error' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readAuditMetadata(value: unknown): AuditMetadata {
  return isRecord(value) ? (value as AuditMetadata) : {};
}

function prettifyReason(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/_/g, ' ');
}

function auditActorLabel(log: AuditRow, metadata: AuditMetadata): string {
  const actor = metadata.actor;
  if (actor?.displayName) return actor.email ? `${actor.displayName} (${actor.email})` : actor.displayName;
  if (actor?.email) return actor.email;
  if (log.userId) return log.userId;
  return 'System / anonymous';
}

function auditTargetLabel(log: AuditRow, metadata: AuditMetadata): string {
  const target = metadata.target;
  if (target?.label) return target.id ? `${target.label} (${target.id})` : target.label;
  if (log.resourceId) return `${log.resourceType} ${log.resourceId}`;
  return log.resourceType;
}

function auditSummary(log: AuditRow, metadata: AuditMetadata): string {
  const fields = metadata.change?.fields ?? [];
  if (fields.length > 0) {
    return `Changed ${fields.join(', ')}`;
  }
  if (metadata.result?.reason) {
    return prettifyReason(metadata.result.reason);
  }
  if (log.action === 'chat.read' && metadata.access?.mode) {
    return `${metadata.access.mode}${metadata.access?.privacy ? ` · ${metadata.access.privacy}` : ''}`;
  }
  if (typeof metadata.details?.model === 'string') {
    return `Model ${metadata.details.model}`;
  }
  if (typeof metadata.details?.name === 'string') {
    return String(metadata.details.name);
  }
  return 'No additional summary';
}

function getResultBadgeClass(status?: 'success' | 'denied' | 'error'): string {
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (status === 'denied') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  if (status === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactDisplayValue(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => compactDisplayValue(item))
      .filter((item) => item !== null);
    return items.length > 0 ? items : null;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, compactDisplayValue(item)] as const)
      .filter(([, item]) => item !== null);
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }
  return value;
}

const PAGE_SIZES = [10, 20, 50];

export default function AdminPage() {
  const { user, serverAvailable } = useAuth();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(20);
  const [userSearchInput, setUserSearchInput] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [usersForPicker, setUsersForPicker] = useState<UserRow[]>([]);
  const [groupsForPicker, setGroupsForPicker] = useState<GroupRow[]>([]);

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupTotal, setGroupTotal] = useState(0);
  const [groupPage, setGroupPage] = useState(1);
  const [groupPageSize, setGroupPageSize] = useState(20);
  const [groupSearchInput, setGroupSearchInput] = useState('');
  const [groupQuery, setGroupQuery] = useState('');

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditMetrics, setAuditMetrics] = useState<AuditSummary | null>(null);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize, setAuditPageSize] = useState(50);
  const [auditSearchInput, setAuditSearchInput] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditActionPrefix, setAuditActionPrefix] = useState('all');
  const [auditResourceType, setAuditResourceType] = useState('all');
  const [auditResultStatus, setAuditResultStatus] = useState('all');
  const [auditStart, setAuditStart] = useState('');
  const [auditEnd, setAuditEnd] = useState('');
  const [auditRetentionDays, setAuditRetentionDays] = useState<number | null>(null);

  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [addMemberGroupId, setAddMemberGroupId] = useState('');
  const [addMemberUserId, setAddMemberUserId] = useState('');
  const [wsGroupId, setWsGroupId] = useState('');
  const [wsLabel, setWsLabel] = useState('');
  const [wsPath, setWsPath] = useState('');

  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserDisplayName, setNewUserDisplayName] = useState('');
  const [newUserRole, setNewUserRole] = useState<AuthUser['role']>('developer');

  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState<AuthUser['role']>('developer');

  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);

  const [editGroup, setEditGroup] = useState<GroupRow | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupDescription, setEditGroupDescription] = useState('');
  const [deleteGroup, setDeleteGroup] = useState<GroupRow | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setUserQuery(userSearchInput.trim()), 350);
    return () => window.clearTimeout(t);
  }, [userSearchInput]);

  useEffect(() => {
    const t = window.setTimeout(() => setGroupQuery(groupSearchInput.trim()), 350);
    return () => window.clearTimeout(t);
  }, [groupSearchInput]);

  useEffect(() => {
    const t = window.setTimeout(() => setAuditQuery(auditSearchInput.trim()), 350);
    return () => window.clearTimeout(t);
  }, [auditSearchInput]);

  useEffect(() => {
    setUserPage(1);
  }, [userQuery]);

  useEffect(() => {
    setGroupPage(1);
  }, [groupQuery]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditQuery, auditActionPrefix, auditResourceType, auditResultStatus]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditStart, auditEnd]);

  const loadUsers = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(userPage),
      pageSize: String(userPageSize),
    });
    if (userQuery) params.set('q', userQuery);
    const r = await fetch(`/api/admin/users?${params}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { users: UserRow[]; total: number };
    setUsers(d.users);
    setUserTotal(d.total);
  }, [userPage, userPageSize, userQuery]);

  const loadUsersPicker = useCallback(async () => {
    const r = await fetch('/api/admin/users?page=1&pageSize=500', { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { users: UserRow[] };
    setUsersForPicker(d.users);
  }, []);

  const loadGroupsPicker = useCallback(async () => {
    const r = await fetch('/api/groups?page=1&pageSize=500', { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { groups: GroupRow[] };
    setGroupsForPicker(d.groups);
  }, []);

  const loadGroups = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(groupPage),
      pageSize: String(groupPageSize),
    });
    if (groupQuery) params.set('q', groupQuery);
    const r = await fetch(`/api/groups?${params}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { groups: GroupRow[]; total: number };
    setGroups(d.groups);
    setGroupTotal(d.total);
  }, [groupPage, groupPageSize, groupQuery]);

  const loadAudit = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(auditPage),
      pageSize: String(auditPageSize),
    });
    if (auditQuery) params.set('q', auditQuery);
    if (auditActionPrefix !== 'all') params.set('action', auditActionPrefix);
    if (auditResourceType !== 'all') params.set('resourceType', auditResourceType);
    if (auditResultStatus !== 'all') params.set('result', auditResultStatus);
    if (auditStart) params.set('start', new Date(auditStart).toISOString());
    if (auditEnd) params.set('end', new Date(auditEnd).toISOString());
    const r = await fetch(`/api/admin/audit?${params}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { logs: AuditRow[]; total: number; retentionDays?: number };
    setAudit(d.logs);
    setAuditTotal(d.total);
    if (typeof d.retentionDays === 'number') setAuditRetentionDays(d.retentionDays);
  }, [auditPage, auditPageSize, auditQuery, auditActionPrefix, auditResourceType, auditResultStatus, auditStart, auditEnd]);

  const loadAuditSummary = useCallback(async () => {
    const params = new URLSearchParams();
    if (auditQuery) params.set('q', auditQuery);
    if (auditActionPrefix !== 'all') params.set('action', auditActionPrefix);
    if (auditResourceType !== 'all') params.set('resourceType', auditResourceType);
    if (auditResultStatus !== 'all') params.set('result', auditResultStatus);
    if (auditStart) params.set('start', new Date(auditStart).toISOString());
    if (auditEnd) params.set('end', new Date(auditEnd).toISOString());
    const r = await fetch(`/api/admin/audit/summary?${params}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = (await r.json()) as { summary: AuditSummary };
    setAuditMetrics(d.summary);
    setAuditRetentionDays(d.summary.retentionDays);
  }, [auditQuery, auditActionPrefix, auditResourceType, auditResultStatus, auditStart, auditEnd]);

  useEffect(() => {
    if (!user || !serverAvailable || user.role !== 'admin') return;
    void loadUsersPicker();
    void loadGroupsPicker();
  }, [user, serverAvailable, loadUsersPicker, loadGroupsPicker]);

  useEffect(() => {
    if (!user || !serverAvailable || user.role !== 'admin') return;
    void loadUsers();
    void loadGroups();
  }, [user, serverAvailable, user.role, loadUsers, loadGroups]);

  useEffect(() => {
    if (!user || !serverAvailable) return;
    if (user.role !== 'admin' && user.role !== 'auditor') return;
    void loadAudit();
    void loadAuditSummary();
  }, [user, serverAvailable, user.role, loadAudit, loadAuditSummary]);

  const downloadAudit = async (format: 'json' | 'csv') => {
    const params = new URLSearchParams({ format });
    if (auditQuery) params.set('q', auditQuery);
    if (auditActionPrefix !== 'all') params.set('action', auditActionPrefix);
    if (auditResourceType !== 'all') params.set('resourceType', auditResourceType);
    if (auditResultStatus !== 'all') params.set('result', auditResultStatus);
    if (auditStart) params.set('start', new Date(auditStart).toISOString());
    if (auditEnd) params.set('end', new Date(auditEnd).toISOString());

    const r = await fetch(`/api/admin/audit/export?${params}`, { credentials: 'include' });
    if (!r.ok) {
      toast.error('Could not export audit log');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'csv' ? 'audit-log-export.csv' : 'audit-log-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Audit export ready (${format.toUpperCase()})`);
  };

  if (!serverAvailable || !user) {
    return <Navigate to="/" replace />;
  }
  if (user.role !== 'admin' && user.role !== 'auditor') {
    return <Navigate to="/" replace />;
  }

  const userTotalPages = Math.max(1, Math.ceil(userTotal / userPageSize));
  const groupTotalPages = Math.max(1, Math.ceil(groupTotal / groupPageSize));
  const auditTotalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));

  const changeRole = async (userId: string, role: AuthUser['role']) => {
    const r = await fetch(`/api/admin/users/${userId}/role`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!r.ok) {
      toast.error('Could not update role');
      return;
    }
    toast.success('Role updated');
    void loadUsers();
    void loadUsersPicker();
  };

  const submitNewUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserEmail.trim() || !newUserPassword || !newUserDisplayName.trim()) return;
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: newUserEmail.trim(),
        password: newUserPassword,
        displayName: newUserDisplayName.trim(),
        role: newUserRole,
      }),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      toast.error(data.error || 'Could not create user');
      return;
    }
    toast.success('User created');
    setAddUserOpen(false);
    setNewUserEmail('');
    setNewUserPassword('');
    setNewUserDisplayName('');
    setNewUserRole('developer');
    void loadUsers();
    void loadUsersPicker();
  };

  const submitEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    const body: Record<string, string> = {
      email: editEmail.trim(),
      displayName: editDisplayName.trim(),
      role: editRole,
    };
    if (editPassword.trim().length >= 8) body.password = editPassword;
    const r = await fetch(`/api/admin/users/${editUser.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      toast.error(data.error || 'Could not update user');
      return;
    }
    toast.success('User updated');
    setEditUser(null);
    setEditPassword('');
    void loadUsers();
    void loadUsersPicker();
  };

  const confirmDeleteUser = async () => {
    if (!deleteUser) return;
    const r = await fetch(`/api/admin/users/${deleteUser.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      toast.error(data.error || 'Could not delete user');
      return;
    }
    toast.success('User deleted');
    setDeleteUser(null);
    void loadUsers();
    void loadUsersPicker();
  };

  const openEditUser = (u: UserRow) => {
    setEditUser(u);
    setEditEmail(u.email);
    setEditDisplayName(u.displayName);
    setEditRole(u.role);
    setEditPassword('');
  };

  const createGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    const r = await fetch('/api/groups', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: groupName.trim(),
        description: groupDescription.trim() || undefined,
      }),
    });
    if (!r.ok) {
      toast.error('Could not create group');
      return;
    }
    toast.success('Group created');
    setGroupName('');
    setGroupDescription('');
    void loadGroups();
    void loadGroupsPicker();
  };

  const submitEditGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editGroup) return;
    const r = await fetch(`/api/groups/${editGroup.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editGroupName.trim(),
        description: editGroupDescription.trim() || null,
      }),
    });
    if (!r.ok) {
      toast.error('Could not update group');
      return;
    }
    toast.success('Group updated');
    setEditGroup(null);
    void loadGroups();
  };

  const confirmDeleteGroup = async () => {
    if (!deleteGroup) return;
    const r = await fetch(`/api/groups/${deleteGroup.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!r.ok) {
      toast.error('Could not delete group');
      return;
    }
    toast.success('Group deleted');
    setDeleteGroup(null);
    void loadGroups();
    void loadGroupsPicker();
  };

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addMemberGroupId || !addMemberUserId) return;
    const r = await fetch(`/api/groups/${addMemberGroupId}/members`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: addMemberUserId, roleInGroup: 'member' }),
    });
    if (!r.ok) {
      toast.error('Could not add member');
      return;
    }
    toast.success('Member added');
    setAddMemberUserId('');
  };

  const addWorkspaceShare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsGroupId || !wsLabel.trim() || !wsPath.trim()) return;
    const r = await fetch(`/api/groups/${wsGroupId}/workspaces`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: wsLabel.trim(), rootPath: wsPath.trim() }),
    });
    if (!r.ok) {
      toast.error('Could not add workspace entry');
      return;
    }
    toast.success('Workspace path recorded for the team');
    setWsLabel('');
    setWsPath('');
  };

  const PaginationBar = ({
    page,
    totalPages,
    total,
    pageSize,
    onPage,
    onPageSize,
  }: {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    onPage: (p: number) => void;
    onPageSize: (n: number) => void;
  }) => (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {total} total · page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">Rows</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger className="h-8 w-[72px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">Administration</h1>
      </div>

      <Tabs defaultValue={user.role === 'auditor' ? 'audit' : 'users'}>
        <TabsList className="mb-4 flex-wrap h-auto gap-1">
          {user.role === 'admin' && (
            <>
              <TabsTrigger value="users">Users &amp; roles</TabsTrigger>
              <TabsTrigger value="groups">Groups</TabsTrigger>
            </>
          )}
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        {user.role === 'admin' && (
          <TabsContent value="users" className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Search by email or name. Create, edit, or remove users; change roles from the table or edit dialog.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search users…"
                  value={userSearchInput}
                  onChange={(e) => setUserSearchInput(e.target.value)}
                  className="pl-8 h-9 text-xs"
                />
              </div>
              <Button type="button" size="sm" className="gap-1" onClick={() => setAddUserOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add user
              </Button>
            </div>

            <PaginationBar
              page={userPage}
              totalPages={userTotalPages}
              total={userTotal}
              pageSize={userPageSize}
              onPage={setUserPage}
              onPageSize={(n) => {
                setUserPageSize(n);
                setUserPage(1);
              }}
            />

            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50">
                  <tr>
                    <th className="text-left p-2">Email</th>
                    <th className="text-left p-2">Name</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-right p-2 w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-t border-border">
                      <td className="p-2 align-middle">{u.email}</td>
                      <td className="p-2 align-middle">{u.displayName}</td>
                      <td className="p-2 align-middle max-w-[200px]">
                        <Select value={u.role} onValueChange={(v) => void changeRole(u.id, v as AuthUser['role'])}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="developer">developer</SelectItem>
                            <SelectItem value="tester">tester</SelectItem>
                            <SelectItem value="auditor">auditor</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2 align-middle text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Edit user"
                          onClick={() => openEditUser(u)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          title="Delete user"
                          onClick={() => setDeleteUser(u)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users.length === 0 && (
                <div className="p-6 text-center text-muted-foreground text-xs">No users match this search.</div>
              )}
            </div>
          </TabsContent>
        )}

        {user.role === 'admin' && (
          <TabsContent value="groups" className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search groups…"
                  value={groupSearchInput}
                  onChange={(e) => setGroupSearchInput(e.target.value)}
                  className="pl-8 h-9 text-xs"
                />
              </div>
            </div>

            <PaginationBar
              page={groupPage}
              totalPages={groupTotalPages}
              total={groupTotal}
              pageSize={groupPageSize}
              onPage={setGroupPage}
              onPageSize={(n) => {
                setGroupPageSize(n);
                setGroupPage(1);
              }}
            />

            <form onSubmit={createGroup} className="flex flex-wrap gap-2 items-end border border-border rounded-md p-4">
              <div className="space-y-1">
                <Label>Team name</Label>
                <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} className="w-64 h-9 text-xs" />
              </div>
              <div className="space-y-1 flex-1 min-w-[200px]">
                <Label>Description (optional)</Label>
                <Input
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                  className="h-9 text-xs"
                  placeholder="Short description"
                />
              </div>
              <Button type="submit" size="sm">
                Create group
              </Button>
            </form>

            <div className="border border-border rounded-md divide-y divide-border">
              {groups.map((g) => (
                <div key={g.id} className="p-3 text-xs flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{g.name}</div>
                    {g.description && <div className="text-muted-foreground mt-0.5">{g.description}</div>}
                    <div className="text-[10px] text-muted-foreground mt-1 font-mono">{g.id}</div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      onClick={() => {
                        setEditGroup(g);
                        setEditGroupName(g.name);
                        setEditGroupDescription(g.description ?? '');
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-destructive"
                      onClick={() => setDeleteGroup(g)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {groups.length === 0 && <div className="p-4 text-muted-foreground">No groups match this search.</div>}
            </div>

            <form onSubmit={addMember} className="space-y-2 border border-border rounded-md p-4">
              <div className="text-sm font-medium">Add member to group</div>
              <div className="flex flex-wrap gap-2">
                <Select value={addMemberGroupId} onValueChange={setAddMemberGroupId}>
                  <SelectTrigger className="w-56 h-9 text-xs">
                    <SelectValue placeholder="Group" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupsForPicker.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={addMemberUserId} onValueChange={setAddMemberUserId}>
                  <SelectTrigger className="w-56 h-9 text-xs">
                    <SelectValue placeholder="User" />
                  </SelectTrigger>
                  <SelectContent>
                    {usersForPicker.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.displayName} ({u.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" size="sm">
                  Add
                </Button>
              </div>
            </form>

            <form onSubmit={addWorkspaceShare} className="space-y-2 border border-border rounded-md p-4">
              <div className="text-sm font-medium">Group workspace paths (shared reference)</div>
              <p className="text-[11px] text-muted-foreground">
                Store a label and path (UNC, Docker volume, or server folder) so the team knows where shared assets live.
              </p>
              <div className="flex flex-col gap-2 max-w-lg">
                <Select value={wsGroupId} onValueChange={setWsGroupId}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Group" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupsForPicker.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input placeholder="Label e.g. Main repo" value={wsLabel} onChange={(e) => setWsLabel(e.target.value)} />
                <Input placeholder="Path e.g. \\fileserver\projects\acme" value={wsPath} onChange={(e) => setWsPath(e.target.value)} />
                <Button type="submit" size="sm" className="w-fit">
                  Save workspace reference
                </Button>
              </div>
            </form>
          </TabsContent>
        )}

        <TabsContent value="audit" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search audit (actor, target, reason, metadata…)"
                value={auditSearchInput}
                onChange={(e) => setAuditSearchInput(e.target.value)}
                className="pl-8 h-9 text-xs"
              />
            </div>
            <Select value={auditActionPrefix} onValueChange={setAuditActionPrefix}>
              <SelectTrigger className="h-9 w-[150px] text-xs">
                <SelectValue placeholder="Action family" />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_ACTION_FILTERS.map((item) => (
                  <SelectItem key={item.label} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={auditResourceType} onValueChange={setAuditResourceType}>
              <SelectTrigger className="h-9 w-[170px] text-xs">
                <SelectValue placeholder="Resource" />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_RESOURCE_FILTERS.map((item) => (
                  <SelectItem key={item.label} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={auditResultStatus} onValueChange={setAuditResultStatus}>
              <SelectTrigger className="h-9 w-[140px] text-xs">
                <SelectValue placeholder="Result" />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_RESULT_FILTERS.map((item) => (
                  <SelectItem key={item.label} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="datetime-local"
              value={auditStart}
              onChange={(e) => setAuditStart(e.target.value)}
              className="h-9 w-[210px] text-xs"
            />
            <Input
              type="datetime-local"
              value={auditEnd}
              onChange={(e) => setAuditEnd(e.target.value)}
              className="h-9 w-[210px] text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => {
                setAuditStart('');
                setAuditEnd('');
                setAuditActionPrefix('all');
                setAuditResourceType('all');
                setAuditResultStatus('all');
                setAuditSearchInput('');
              }}
            >
              Reset filters
            </Button>
          </div>
          {auditMetrics && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="text-muted-foreground">Events</div>
                <div className="mt-1 text-lg font-semibold">{auditMetrics.total}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  success {auditMetrics.success} · denied {auditMetrics.denied} · error {auditMetrics.error}
                </div>
              </div>
              <div className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="text-muted-foreground">Access</div>
                <div className="mt-1 text-lg font-semibold">{auditMetrics.chatReads}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">chat reads in current filter window</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="text-muted-foreground">Risk Signals</div>
                <div className="mt-1 text-lg font-semibold">{auditMetrics.loginFailures}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">login failures · admin changes {auditMetrics.adminChanges}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="text-muted-foreground">LLM / Retention</div>
                <div className="mt-1 text-lg font-semibold">{auditMetrics.llmQueries}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  llm queries · retention {auditRetentionDays ?? auditMetrics.retentionDays} days
                </div>
              </div>
            </div>
          )}
          {auditMetrics && auditMetrics.topActions.length > 0 && (
            <div className="rounded-md border border-border bg-card p-3 text-xs">
              <div className="mb-2 font-medium">Top actions</div>
              <div className="flex flex-wrap gap-2">
                {auditMetrics.topActions.map((item) => (
                  <span key={item.action} className="rounded-full border border-border bg-muted px-2 py-1 text-[11px]">
                    {item.action} · {item.total}
                  </span>
                ))}
              </div>
            </div>
          )}
          <PaginationBar
            page={auditPage}
            totalPages={auditTotalPages}
            total={auditTotal}
            pageSize={auditPageSize}
            onPage={setAuditPage}
            onPageSize={(n) => {
              setAuditPageSize(n);
              setAuditPage(1);
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" type="button" className="gap-1" onClick={() => void downloadAudit('json')}>
              <Download className="h-3.5 w-3.5" />
              Export JSON
            </Button>
            <Button variant="outline" size="sm" type="button" className="gap-1" onClick={() => void downloadAudit('csv')}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={() => { void loadAudit(); void loadAuditSummary(); }}>
              Refresh
            </Button>
          </div>
          <div className="space-y-2">
            {audit.map((log) => {
              const metadata = readAuditMetadata(log.metadata);
              const actorLabel = auditActorLabel(log, metadata);
              const targetLabel = auditTargetLabel(log, metadata);
              const status = log.result?.status ?? metadata.result?.status;
              const actorBlock = compactDisplayValue(log.actor ?? metadata.actor ?? (log.userId ? { userId: log.userId } : null));
              const targetBlock = compactDisplayValue(
                log.target ?? metadata.target ?? { type: log.resourceType, id: log.resourceId ?? undefined },
              );
              const accessResultBlock = compactDisplayValue({
                access: log.access ?? metadata.access ?? null,
                result: log.result ?? metadata.result ?? null,
              });
              const changeBlock = compactDisplayValue(log.change ?? metadata.change ?? null);
              const contextBlock = compactDisplayValue({ context: metadata.context ?? null, ip: log.ip ?? null });
              const detailsBlock = compactDisplayValue(log.details ?? metadata.details ?? null);
              const metadataBlock = compactDisplayValue(log.metadata);

              return (
                <details key={log.id} className="rounded-md border border-border bg-card p-3 text-xs">
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${getResultBadgeClass(status)}`}>
                            {status ?? 'n/a'}
                          </span>
                          <span className="font-mono text-muted-foreground">{log.createdAt}</span>
                          <span className="font-semibold text-primary">{log.action}</span>
                        </div>
                        <div className="text-foreground break-all">
                          <span className="font-medium">{actorLabel}</span>
                          <span className="text-muted-foreground"> on </span>
                          <span className="font-medium">{targetLabel}</span>
                        </div>
                        <div className="text-muted-foreground">
                          {auditSummary(log, metadata)}
                          {metadata.context?.route ? ` · ${metadata.context.route}` : ''}
                          {metadata.context?.method ? ` · ${metadata.context.method}` : ''}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground sm:text-right">
                        <div>{log.resourceType}</div>
                        {metadata.result?.code != null && <div>HTTP {metadata.result.code}</div>}
                      </div>
                    </div>
                  </summary>

                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="space-y-2">
                      {actorBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Actor</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(actorBlock)}</pre>
                        </div>
                      )}
                      {targetBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Target</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(targetBlock)}</pre>
                        </div>
                      )}
                      {accessResultBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Access / Result</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(accessResultBlock)}</pre>
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      {changeBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Change</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(changeBlock)}</pre>
                        </div>
                      )}
                      {contextBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Request Context</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(contextBlock)}</pre>
                        </div>
                      )}
                      {detailsBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Details</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(detailsBlock)}</pre>
                        </div>
                      )}
                      {metadataBlock && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Raw Metadata</div>
                          <pre className="rounded bg-muted p-2 text-[10px] whitespace-pre-wrap break-all">{renderJson(metadataBlock)}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                </details>
              );
            })}
            {audit.length === 0 && <div className="rounded-md border border-border p-4 text-muted-foreground">No entries.</div>}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={addUserOpen} onOpenChange={setAddUserOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitNewUser} className="space-y-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                type="email"
                required
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                required
                value={newUserDisplayName}
                onChange={(e) => setNewUserDisplayName(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label>Password</Label>
              <Input
                type="password"
                required
                minLength={8}
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={newUserRole} onValueChange={(v) => setNewUserRole(v as AuthUser['role'])}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="developer">developer</SelectItem>
                  <SelectItem value="tester">tester</SelectItem>
                  <SelectItem value="auditor">auditor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setAddUserOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editUser} onOpenChange={(o) => !o && setEditUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
          </DialogHeader>
          {editUser && (
            <form onSubmit={submitEditUser} className="space-y-3">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  required
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label>Display name</Label>
                <Input
                  required
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label>New password (leave blank to keep)</Label>
                <Input
                  type="password"
                  minLength={8}
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  className="h-9 text-xs"
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-1">
                <Label>Role</Label>
                <Select value={editRole} onValueChange={(v) => setEditRole(v as AuthUser['role'])}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">admin</SelectItem>
                    <SelectItem value="developer">developer</SelectItem>
                    <SelectItem value="tester">tester</SelectItem>
                    <SelectItem value="auditor">auditor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditUser(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <strong>{deleteUser?.email}</strong> and cannot be undone. Related data may be removed per database rules.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteUser()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editGroup} onOpenChange={(o) => !o && setEditGroup(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit group</DialogTitle>
          </DialogHeader>
          {editGroup && (
            <form onSubmit={submitEditGroup} className="space-y-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  required
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label>Description</Label>
                <Input
                  value={editGroupDescription}
                  onChange={(e) => setEditGroupDescription(e.target.value)}
                  className="h-9 text-xs"
                  placeholder="Optional"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditGroup(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteGroup} onOpenChange={(o) => !o && setDeleteGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteGroup?.name}</strong>? Members and workspace links for this group will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteGroup()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
