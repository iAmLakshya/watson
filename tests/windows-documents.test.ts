import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDocxText } from '../electron/docx';
import { extractDocument } from '../electron/documents';

const fixturePath = join(process.cwd(), 'tests/fixtures/knowledge.docx');
const localRequire = createRequire(import.meta.url);
// Resolve the parser's declared ZIP dependency rather than relying on npm hoisting.
const JSZip = createRequire(localRequire.resolve('mammoth'))('jszip');
async function document(xml: string, relationships?: string) {
  const zip = await JSZip.loadAsync(await readFile(fixturePath)); zip.file('word/document.xml', xml);
  if (relationships) zip.file('word/_rels/document.xml.rels', relationships);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const root = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;

test('portable DOCX extraction preserves Unicode, paragraphs, tables, and link text without creating HTML', async () => {
  const buffer = await document(root('<w:p><w:r><w:t>Owner: Priya — 東京 &amp; Zürich.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Budget</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>₹500</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Reference label</w:t></w:r></w:hyperlink></w:p>'), '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>');
  const directory = await mkdtemp(join(tmpdir(), 'watson-portable-docx-')); const path = join(directory, 'knowledge.docx');
  try { await writeFile(path, buffer); const result = await extractDocument(path); assert.equal(result.type, 'docx'); assert.match(result.text, /Priya — 東京 & Zürich/); assert.match(result.text, /Budget/); assert.match(result.text, /₹500/); assert.match(result.text, /Reference label/); assert.doesNotMatch(result.text, /javascript:|<a|<w:/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('portable DOCX extraction reports empty, corrupt, and encrypted documents instead of returning fabricated text', async () => {
  await assert.rejects(extractDocxText(Buffer.from('not an Office Open XML ZIP')), /valid, unencrypted DOCX/);
  const empty = await document(root('<w:p/>')); const directory = await mkdtemp(join(tmpdir(), 'watson-empty-docx-'));
  try { const path = join(directory, 'empty.docx'); await writeFile(path, empty); await assert.rejects(extractDocument(path), /no readable text/); }
  finally { await rm(directory, { recursive: true, force: true }); }
  const encrypted = await readFile(fixturePath); const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central >= 0); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(extractDocxText(encrypted), /Password-protected/);
});
test('DOCX expansion limits validate actual inflate size and declared archive size before document parsing', async () => {
  const huge = await readFile(fixturePath); const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); huge.writeUInt32LE(64000001, central + 24);
  await assert.rejects(extractDocxText(huge), /expanded DOCX document must be smaller than 64 MB/);
  const falseSize = await readFile(fixturePath); falseSize.writeUInt32LE(1, central + 24);
  await assert.rejects(extractDocxText(falseSize), /Buffer larger|invalid expanded size/);
});
test('DOCX parsing deadlines terminate the worker rather than leaving main-process work running', async () => {
  const buffer = await readFile(fixturePath); const started = Date.now();
  await assert.rejects(extractDocxText(buffer, 1), /timed out/); assert.ok(Date.now() - started < 1000);
});
