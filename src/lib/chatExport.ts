import type { Chat } from '@/types';
import { getMessageText } from '@/types';

function sanitizeFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'chat';
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function buildTranscriptText(chat: Chat): string {
  const lines: string[] = [
    chat.title,
    `Created: ${new Date(chat.createdAt).toISOString()} · Updated: ${new Date(chat.updatedAt).toISOString()}`,
    '',
  ];
  for (const m of chat.messages) {
    const ts = new Date(m.timestamp).toISOString();
    lines.push(`[${ts}] ${m.role.toUpperCase()}`, getMessageText(m), '');
  }
  return lines.join('\n');
}

export async function exportChatAsTxt(chat: Chat): Promise<void> {
  const text = buildTranscriptText(chat);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(chat.title)}.txt`);
}

export async function exportChatAsPdf(chat: Chat): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  let y = margin;
  const lineHeight = 14;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;

  const ensureSpace = (h: number) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeBold = (t: string) => {
    doc.setFont('helvetica', 'bold');
    const lines = doc.splitTextToSize(t, maxW);
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    }
  };

  const writeNormal = (t: string) => {
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(t, maxW);
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    }
  };

  writeBold(chat.title);
  writeNormal(`Updated ${new Date(chat.updatedAt).toLocaleString()}`);
  y += 8;

  for (const m of chat.messages) {
    writeBold(`${m.role} · ${new Date(m.timestamp).toLocaleString()}`);
    writeNormal(getMessageText(m));
    y += 6;
  }

  doc.save(`${sanitizeFilename(chat.title)}.pdf`);
}

export async function exportChatAsDocx(chat: Chat): Promise<void> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({
      text: chat.title,
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Updated ${new Date(chat.updatedAt).toLocaleString()}`,
          italics: true,
        }),
      ],
    }),
    new Paragraph({ text: '' }),
  ];

  for (const m of chat.messages) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${m.role} · ${new Date(m.timestamp).toLocaleString()}`,
            bold: true,
          }),
        ],
      }),
    );
    children.push(new Paragraph({ text: getMessageText(m) }));
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${sanitizeFilename(chat.title)}.docx`);
}
