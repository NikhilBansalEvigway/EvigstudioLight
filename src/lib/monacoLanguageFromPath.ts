import { getFileExtension } from '@/lib/fsWorkspace';

/** Monaco language id for syntax highlighting from file path. */
export function monacoLanguageFromPath(filePath: string): string {
  const ext = getFileExtension(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.m': 'matlab',
    '.vhd': 'vhdl',
    '.vhdl': 'vhdl',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.html': 'html',
    '.css': 'css',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shell',
    '.v': 'systemverilog',
    '.sv': 'systemverilog',
    '.txt': 'plaintext',
    '.ini': 'ini',
    '.toml': 'plaintext',
  };
  return map[ext] || 'plaintext';
}
