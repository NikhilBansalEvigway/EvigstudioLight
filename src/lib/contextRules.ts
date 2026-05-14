export type ContextRules = {
  allowedExtensions: string[];
  allowedBasenames: string[];
  allowDotEnv: boolean;
};

export const DEFAULT_CONTEXT_RULES: ContextRules = {
  allowedExtensions: [
    '.m', '.vhd', '.vhdl',
    '.txt', '.md', '.json',
    '.v', '.sv',
    '.py',
    '.c', '.h', '.cpp', '.hpp',
    '.ts', '.tsx', '.js', '.jsx',
    '.css', '.scss', '.html',
    '.xml', '.yaml', '.yml', '.toml', '.cfg', '.ini',
    '.sh', '.ps1', '.bat',
    '.java', '.kt', '.go', '.rs', '.php', '.sql',
  ],
  allowedBasenames: ['Dockerfile', 'Makefile', 'CMakeLists.txt'],
  allowDotEnv: true,
};

function normalizeExt(ext: string): string {
  const trimmed = ext.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('.')) return trimmed.toLowerCase();
  return `.${trimmed.toLowerCase()}`;
}

export function normalizeContextRules(value: unknown): ContextRules {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const allowedExtensions = Array.isArray(raw.allowedExtensions)
    ? raw.allowedExtensions.filter((v): v is string => typeof v === 'string').map(normalizeExt).filter(Boolean)
    : DEFAULT_CONTEXT_RULES.allowedExtensions;
  const allowedBasenames = Array.isArray(raw.allowedBasenames)
    ? raw.allowedBasenames.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : DEFAULT_CONTEXT_RULES.allowedBasenames;
  const allowDotEnv = typeof raw.allowDotEnv === 'boolean' ? raw.allowDotEnv : DEFAULT_CONTEXT_RULES.allowDotEnv;

  return {
    allowedExtensions: [...new Set(allowedExtensions)].slice(0, 200),
    allowedBasenames: [...new Set(allowedBasenames)].slice(0, 200),
    allowDotEnv,
  };
}

export function isAllowedContextFileName(name: string, rules: ContextRules): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (rules.allowedBasenames.includes(trimmed)) return true;
  if (rules.allowDotEnv && (trimmed === '.env' || trimmed.startsWith('.env.'))) return true;
  const dot = trimmed.lastIndexOf('.');
  const ext = dot >= 0 ? trimmed.slice(dot).toLowerCase() : '';
  return !!ext && rules.allowedExtensions.includes(ext);
}

export function isAllowedContextPath(path: string, rules: ContextRules): boolean {
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return isAllowedContextFileName(name, rules);
}
