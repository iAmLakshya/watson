import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument } from '../electron/documents';
test('DOCX import extracts real Office Open XML text with the portable parser', async () => {
  const result = await extractDocument(join(process.cwd(), 'tests/fixtures/knowledge.docx')); assert.equal(result.type, 'docx'); assert.match(result.text, /Watson DOCX import fixture: owner Priya\./); assert.ok(result.size > 0);
});
test('knowledge imports preserve text, reject empty files, and cap document size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watson-documents-')); const path = join(directory, 'knowledge.md');
  try { await writeFile(path, '# Knowledge\n\nOwner: Priya\n'); const result = await extractDocument(path); assert.equal(result.type, 'md'); assert.equal(result.text, '# Knowledge\n\nOwner: Priya\n'); await writeFile(path, ''); await assert.rejects(extractDocument(path), /no readable text/); await writeFile(path, Buffer.alloc(10000001)); await assert.rejects(extractDocument(path), /smaller than 10 MB/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
