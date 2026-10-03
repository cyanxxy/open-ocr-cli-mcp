import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { OcrMachineResult } from './protocol';

export const MCP_ARTIFACT_CHUNK_BYTES = 64 * 1024;
export const MCP_ARTIFACT_REGISTRY_LIMIT = 10_000;

interface RegisteredArtifact {
  path: string;
  mediaType: string;
  identity: Stats;
}

export interface McpArtifactChunk {
  uri: string;
  mediaType: string;
  text: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  eof: boolean;
}

/** Only files written by this server may be read through MCP. Never enumerate them. */
export class McpArtifactRegistry {
  private readonly artifacts = new Map<string, RegisteredArtifact>();

  constructor(private readonly capacity = MCP_ARTIFACT_REGISTRY_LIMIT) {}

  async remember(result: OcrMachineResult): Promise<string[]> {
    const warnings: string[] = [];
    if (!('documents' in result)) return warnings;
    for (const document of result.documents) {
      for (const artifact of document.artifacts) {
        const uri = pathToFileURL(artifact.path).href;
        // A resume manifest is user-editable. Its paths cannot grant read
        // access to arbitrary pre-existing files. A skipped result may reuse
        // access already granted by a live extraction in this process.
        if (document.status !== 'succeeded' && document.status !== 'partial') {
          if (document.status === 'skipped' && !this.artifacts.has(uri)) {
            warnings.push(`Resumed artifact ${artifact.path} was not written by this MCP process; read it with a local filesystem tool.`);
          }
          continue;
        }
        this.artifacts.delete(uri);
        // Reopening a replaced FIFO must not block the process. NOFOLLOW and
        // the later fstat also refuse symlinks and non-regular files.
        try {
          const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const identity = await file.stat();
            if (!identity.isFile()) throw new Error('An OCR artifact is no longer a regular file.');
            this.artifacts.set(uri, { path: artifact.path, mediaType: artifact.mediaType, identity });
            if (this.artifacts.size > this.capacity) {
              const oldest = this.artifacts.keys().next().value;
              if (oldest !== undefined) this.artifacts.delete(oldest);
            }
          } finally {
            await file.close();
          }
        } catch {
          // A missing/replaced output must not discard other useful output or
          // tell the client to repeat a successfully billed extraction.
          warnings.push(`MCP could not retain artifact ${artifact.path}; inspect the saved output with a local filesystem tool.`);
        }
      }
    }
    return warnings;
  }

  async read(uri: string, offset = 0, maxBytes = MCP_ARTIFACT_CHUNK_BYTES): Promise<McpArtifactChunk> {
    const artifact = this.artifacts.get(uri);
    if (!artifact) {
      throw new Error('Artifact URI is not retained by this MCP process. Use a file:// link from a recent OCR result, or read its path with a local filesystem tool.');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.identity.size) {
      throw new Error('offset must be a byte offset between 0 and totalBytes; use nextOffset from the previous read.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > MCP_ARTIFACT_CHUNK_BYTES) {
      throw new Error(`maxBytes must be an integer between 4 and ${MCP_ARTIFACT_CHUNK_BYTES}.`);
    }
    const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await file.stat();
      const expected = artifact.identity;
      if (!current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino
        || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
        this.artifacts.delete(uri);
        throw new Error('Artifact changed since OCR completed; use a local filesystem tool to inspect the current file.');
      }
      // Read one lookahead byte to detect a code point split at the boundary.
      // Every returned continuation therefore starts on a UTF-8 boundary.
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, current.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let end = Math.min(bytesRead, maxBytes);
      if (bytesRead > end) {
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
      }
      let text: string;
      try {
        // Keep a literal BOM: dropping one at the start of a later chunk would
        // silently change document content when the caller joins the chunks.
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end));
      } catch {
        throw new Error('Artifact is not valid UTF-8 at this offset; use nextOffset from the previous read.');
      }
      const after = await file.stat();
      if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs) {
        this.artifacts.delete(uri);
        throw new Error('Artifact changed while reading; use a local filesystem tool to inspect the current file.');
      }
      return { uri, mediaType: artifact.mediaType, text, offset, nextOffset: offset + end, totalBytes: current.size, eof: offset + end === current.size };
    } finally {
      await file.close();
    }
  }
}
