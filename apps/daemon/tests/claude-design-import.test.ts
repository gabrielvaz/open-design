// @ts-nocheck
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importClaudeDesignZip } from '../src/claude-design-import.js';

let workdir: string;
let zipPath: string;
let projectDir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'od-claude-design-import-'));
  zipPath = path.join(workdir, 'export.zip');
  projectDir = path.join(workdir, 'project');
});

afterEach(() => {
  rmSync(workdir, { force: true, recursive: true });
});

async function writeZip(zip: JSZip): Promise<void> {
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(zipPath, buf);
}

describe('importClaudeDesignZip', () => {
  it('does not crash on a 0-byte DEFLATE entry (Node 24 RangeError regression)', async () => {
    // Regression: Node 24's `inflateRawSync` rejects `maxOutputLength: 0`
    // with a RangeError, so any empty file in a Claude Design export
    // (placeholder `.gitkeep`, empty `style.css`, etc.) crashed the whole
    // import. The fix is a one-line early return for zero-byte entries.
    const zip = new JSZip();
    zip.file('index.html', '<!doctype html><title>ok</title>');
    zip.file('empty.css', ''); // 0-byte entry, DEFLATE-compressed
    await writeZip(zip);

    const result = await importClaudeDesignZip(zipPath, projectDir);

    expect(result.entryFile).toBe('index.html');
    expect(result.files).toEqual(expect.arrayContaining(['index.html', 'empty.css']));
    const written = readFileSync(path.join(projectDir, 'empty.css'));
    expect(written.length).toBe(0);
  });

  it('accepts archives with more than 500 files', async () => {
    // Regression: `MAX_FILES = 500` rejected legitimate medium-sized
    // Claude Design exports (the reporter's archive had 561 files).
    // The byte caps still bound memory; the file-count guard is now 5000.
    const zip = new JSZip();
    zip.file('index.html', '<!doctype html><title>ok</title>');
    for (let i = 0; i < 600; i += 1) {
      zip.file(`assets/file-${i}.txt`, `n=${i}`);
    }
    await writeZip(zip);

    const result = await importClaudeDesignZip(zipPath, projectDir);
    expect(result.files.length).toBe(601);
    expect(result.entryFile).toBe('index.html');
  });

  it('still rejects archives that exceed the new file-count ceiling', async () => {
    // The ceiling is bumped, not removed: archives with thousands of
    // entries still trip the explicit guard so a hostile zip can't OOM
    // the daemon by inflating millions of tiny files.
    const zip = new JSZip();
    zip.file('index.html', '<!doctype html><title>ok</title>');
    for (let i = 0; i < 5001; i += 1) {
      zip.file(`f/${i}.txt`, `${i}`);
    }
    await writeZip(zip);

    await expect(importClaudeDesignZip(zipPath, projectDir)).rejects.toThrow(
      /too many files/,
    );
  });
});
