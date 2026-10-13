import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import pdfParse from 'pdf-parse';
import { extractDocxText } from './docx';
export async function extractDocument(path: string) {
  const size = (await stat(path)).size; if (size > 10_000_000) throw new Error('Each document must be smaller than 10 MB'); const type = extname(path).toLowerCase(); if (!['.txt', '.md', '.pdf', '.docx'].includes(type)) throw new Error('Choose a TXT, Markdown, PDF, or DOCX file');
  const buffer = await readFile(path); if (buffer.length > 10_000_000) throw new Error('Each document must be smaller than 10 MB');
  const text = type === '.docx' ? await extractDocxText(buffer) : type === '.pdf' ? (await pdfParse(buffer)).text : buffer.toString('utf8');
  if (!text.trim()) throw new Error('The document contains no readable text. Scanned PDFs require OCR before import.');
  return { text, size, type: type.slice(1) };
}
