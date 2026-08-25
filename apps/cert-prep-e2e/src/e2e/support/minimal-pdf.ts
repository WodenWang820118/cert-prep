export function minimalPdf(...pageTexts: string[]): Buffer {
  const objects = new Map<number, Buffer>();
  const pageIds: number[] = [];
  let nextId = 4;

  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(
    3,
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  );

  for (const pageText of pageTexts) {
    const pageId = nextId;
    const contentId = nextId + 1;
    nextId += 2;
    pageIds.push(pageId);
    const content = pdfPageStream(pageText);
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
        content,
        Buffer.from('\nendstream'),
      ]),
    );
  }

  const kids = pageIds.map((pageId) => `${pageId} 0 R`).join(' ');
  objects.set(
    2,
    Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`),
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets = new Map<number, number>([[0, 0]]);
  let length = parts[0]?.length ?? 0;
  for (const objectId of [...objects.keys()].sort((left, right) => left - right)) {
    const object = objects.get(objectId);
    if (object === undefined) {
      continue;
    }
    offsets.set(objectId, length);
    const value = Buffer.concat([
      Buffer.from(`${objectId} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(value);
    length += value.length;
  }

  const xrefOffset = length;
  const maxId = Math.max(...objects.keys());
  const xref = [
    `xref\n0 ${maxId + 1}\n`,
    '0000000000 65535 f \n',
    ...Array.from({ length: maxId }, (_value, index) => {
      const objectId = index + 1;
      return `${String(offsets.get(objectId) ?? 0).padStart(10, '0')} 00000 n \n`;
    }),
    `trailer << /Root 1 0 R /Size ${maxId + 1} >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ];
  parts.push(Buffer.from(xref.join('')));
  return Buffer.concat(parts);
}

function pdfPageStream(text: string): Buffer {
  if (text.length === 0) {
    return Buffer.from('q 1 1 1 rg 0 0 1 1 re f Q');
  }
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
  return Buffer.from(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`);
}
