import { describe, expect, it } from 'vitest';
import { processMarkdown } from '@/components/ChatMessage';

describe('processMarkdown — LaTeX symbol rendering', () => {
  it('renders bare \\rightarrow in prose as an arrow', () => {
    expect(processMarkdown('A \\rightarrow B')).toContain('A → B');
  });

  it('renders the reported bug: $\\rightarrow$ inside an inline-code chip', () => {
    // Model output from the flowchart screenshot.
    const out = processMarkdown('`On Route Change $\\rightarrow$ Update Idle State`');
    expect(out).toBe('`On Route Change → Update Idle State`');
    expect(out).not.toContain('$');
    expect(out).not.toContain('\\rightarrow');
  });

  it('renders bare LaTeX commands inside an inline-code chip', () => {
    expect(processMarkdown('`Start \\to End`')).toBe('`Start → End`');
    expect(processMarkdown('`a \\times b`')).toBe('`a × b`');
  });

  it('covers the expanded symbol set (arrows, relations, greek, operators)', () => {
    const cases: Array<[string, string]> = [
      ['\\Rightarrow', '⇒'],
      ['\\leftrightarrow', '↔'],
      ['\\Leftrightarrow', '⇔'],
      ['\\uparrow', '↑'],
      ['\\downarrow', '↓'],
      ['\\leq', '≤'],
      ['\\geq', '≥'],
      ['\\neq', '≠'],
      ['\\subseteq', '⊆'],
      ['\\subset', '⊂'],
      ['\\in', '∈'],
      ['\\forall', '∀'],
      ['\\exists', '∃'],
      ['\\sum', '∑'],
      ['\\infty', '∞'],
      ['\\alpha', 'α'],
      ['\\Omega', 'Ω'],
      ['\\cdot', '·'],
      ['\\pm', '±'],
    ];
    for (const [cmd, sym] of cases) {
      expect(processMarkdown(`x ${cmd} y`)).toContain(`x ${sym} y`);
    }
  });

  it('does not partially clobber longer commands with shorter prefixes', () => {
    // \le must not eat into \leftrightarrow; \subset must not eat \subseteq.
    expect(processMarkdown('\\leftrightarrow')).toContain('↔');
    expect(processMarkdown('\\subseteq')).toContain('⊆');
    expect(processMarkdown('\\geq')).toContain('≥');
  });

  it('leaves fenced code blocks untouched', () => {
    const src = '```\nconst x = a \\times b; // $y$\n```';
    expect(processMarkdown(src)).toBe(src);
  });

  it('does not mangle shell variables inside inline code', () => {
    expect(processMarkdown('`echo $a $b`')).toBe('`echo $a $b`');
    expect(processMarkdown('`$PATH`')).toBe('`$PATH`');
  });

  it('leaves real $...$ math spans for KaTeX (not pre-converted)', () => {
    // Outside code, $...$ stays a math span so remark-math/KaTeX handles it.
    const out = processMarkdown('value $\\rightarrow$ next');
    expect(out).toContain('$\\rightarrow$');
  });
});
