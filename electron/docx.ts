import { Worker } from 'node:worker_threads';

// Raw text only: no rendered HTML, downloaded assets, or external-file access.
// Parsing runs outside Electron's main thread and retains the former textutil deadline.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { inflateRawSync } = require('node:zlib');
function validateArchive(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Choose a valid, unencrypted DOCX document');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('The DOCX archive is incomplete or invalid');
  const entries = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || entries !== buffer.readUInt16LE(end + 8) || !entries || entries > 2000 || centralOffset + centralSize > end) throw new Error('The DOCX archive has an unsupported structure');
  let offset = centralOffset, inflatedTotal = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > centralOffset + centralSize || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The DOCX archive directory is invalid');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10), compressedSize = buffer.readUInt32LE(offset + 20), expandedSize = buffer.readUInt32LE(offset + 24), localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 1) throw new Error('Password-protected DOCX documents are not supported');
    if (method !== 0 && method !== 8) throw new Error('The DOCX archive compression is unsupported');
    inflatedTotal += expandedSize;
    if (expandedSize > 64000000 || inflatedTotal > 64000000) throw new Error('The expanded DOCX document must be smaller than 64 MB');
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The DOCX archive member is invalid');
    const payloadOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (payloadOffset + compressedSize > centralOffset) throw new Error('The DOCX archive member is incomplete');
    const payload = buffer.subarray(payloadOffset, payloadOffset + compressedSize);
    // Verify actual expansion against declared sizes before Mammoth inflates any XML.
    const expanded = method === 8 ? inflateRawSync(payload, { maxOutputLength: Math.max(1, expandedSize) }) : payload;
    if (expanded.length !== expandedSize) throw new Error('The DOCX archive member has an invalid expanded size');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  if (offset !== centralOffset + centralSize) throw new Error('The DOCX archive directory is incomplete');
}
(async () => {
  try {
    const buffer = Buffer.from(workerData.data); validateArchive(buffer);
    const mammoth = require(workerData.modulePath);
    const result = await mammoth.extractRawText({ buffer });
    if (typeof result.value !== 'string') throw new Error('The DOCX parser returned invalid text');
    if (Buffer.byteLength(result.value, 'utf8') > 2000000) throw new Error('The extracted DOCX text must be smaller than 2 MB');
    parentPort.postMessage({ text: result.value });
  } catch (error) { parentPort.postMessage({ error: String(error.message || error).slice(0, 500) }); }
})();
`;

export async function extractDocxText(buffer: Buffer, timeoutMs = 15000): Promise<string> {
  if (buffer.length > 10_000_000) throw new Error('Each document must be smaller than 10 MB');
  const data = Uint8Array.from(buffer);
  const worker = new Worker(workerSource, { eval: true, workerData: { data: data.buffer, modulePath: require.resolve('mammoth') }, transferList: [data.buffer], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, text?: string) => { if (settled) return; settled = true; if (error) reject(error); else resolve(text!); };
      timer = setTimeout(() => { finish(new Error('DOCX text extraction timed out after 15 seconds')); void worker.terminate(); }, timeoutMs);
      worker.once('message', (result: unknown) => {
        if (!result || typeof result !== 'object') { finish(new Error('The DOCX parser returned invalid data')); return; }
        if ('error' in result && typeof result.error === 'string') { finish(new Error(result.error)); return; }
        if ('text' in result && typeof result.text === 'string') finish(undefined, result.text);
        else finish(new Error('The DOCX parser returned no text'));
      });
      worker.once('error', error => finish(new Error(`DOCX text extraction failed: ${error.message}`)));
      worker.once('exit', code => { if (!settled) finish(new Error(`DOCX text extraction stopped unexpectedly (${code})`)); });
    });
  } finally { if (timer) clearTimeout(timer); await worker.terminate(); }
}
