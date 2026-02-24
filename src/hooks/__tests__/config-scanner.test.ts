import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractTriggerHints } from '../config-scanner.js';

describe('extractTriggerHints', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts description from YAML frontmatter', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-scanner-'));
    const filePath = join(tmpDir, 'test-cmd.md');
    writeFileSync(filePath, `---
description: Systematic debugging with persistent state
---
# Debug Command

Some content here.
`);

    const hints = extractTriggerHints(filePath);

    expect(hints).toBe('Systematic debugging with persistent state');
  });

  it('extracts content from <objective> blocks', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-scanner-'));
    const filePath = join(tmpDir, 'test-cmd.md');
    writeFileSync(filePath, `# Plan Command

<objective>
Create detailed implementation plans with verification
</objective>

More content.
`);

    const hints = extractTriggerHints(filePath);

    expect(hints).toBe('Create detailed implementation plans with verification');
  });

  it('concatenates frontmatter description and objective', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-scanner-'));
    const filePath = join(tmpDir, 'test-cmd.md');
    writeFileSync(filePath, `---
description: Debug command for systematic investigation
---
# Debug

<objective>
Track errors and build resolution paths
</objective>

Body text.
`);

    const hints = extractTriggerHints(filePath);

    expect(hints).toBe('Debug command for systematic investigation Track errors and build resolution paths');
  });

  it('returns null for files without description or objective', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-scanner-'));
    const filePath = join(tmpDir, 'test-cmd.md');
    writeFileSync(filePath, '# Just a title\n\nSome body text.\n');

    const hints = extractTriggerHints(filePath);

    expect(hints).toBeNull();
  });

  it('returns null for non-existent files', () => {
    const hints = extractTriggerHints('/nonexistent/path/file.md');

    expect(hints).toBeNull();
  });
});
