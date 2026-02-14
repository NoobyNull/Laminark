import { describe, it, expect } from 'vitest';
import { shouldAdmit } from '../admission-filter.js';

// =============================================================================
// Admission Filter Tests
// =============================================================================

describe('admission-filter', () => {
  describe('shouldAdmit', () => {
    // -------------------------------------------------------------------------
    // High-signal tools: Write and Edit are ALWAYS admitted
    // -------------------------------------------------------------------------

    describe('Write tool (always admitted)', () => {
      it('admits Write tool with normal content', () => {
        expect(shouldAdmit('Write', '[Write] Created src/index.ts\nimport express from "express"')).toBe(true);
      });

      it('admits Write tool even with content matching noise patterns', () => {
        // Write tool creating a webpack config -- content mentions "webpack" but should NOT be rejected
        expect(shouldAdmit('Write', '[Write] Created webpack.config.js\nmodule.exports = { webpack compiled }')).toBe(true);
      });

      it('admits Write tool with npm-related content', () => {
        expect(shouldAdmit('Write', '[Write] Created package.json\nnpm WARN deprecated')).toBe(true);
      });

      it('admits Write tool with linter config content', () => {
        expect(shouldAdmit('Write', '[Write] Created .eslintrc.json\n{ "rules": {} }')).toBe(true);
      });
    });

    describe('Edit tool (always admitted)', () => {
      it('admits Edit tool with normal content', () => {
        expect(shouldAdmit('Edit', '[Edit] Modified src/foo.ts: replaced "old" with "new"')).toBe(true);
      });

      it('admits Edit tool even with content matching noise patterns', () => {
        expect(shouldAdmit('Edit', '[Edit] Modified webpack.config.js: webpack compiled successfully')).toBe(true);
      });

      it('admits Edit tool with build output content', () => {
        expect(shouldAdmit('Edit', '[Edit] Modified build.ts: npm WARN something')).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Bash tool: subject to noise filtering
    // -------------------------------------------------------------------------

    describe('Bash tool (noise filtered)', () => {
      it('admits meaningful Bash output', () => {
        expect(shouldAdmit('Bash', '[Bash] $ git commit -m "feat: add auth"')).toBe(true);
      });

      it('admits Bash output with errors that provide context', () => {
        expect(shouldAdmit('Bash', '[Bash] $ npm test\nFAILED src/auth.test.ts\nExpected: 200\nReceived: 401')).toBe(true);
      });

      // Noise pattern filtering has moved to HaikuProcessor (post-storage classification).
      // Content that was previously rejected by regex noise patterns is now admitted
      // and classified by Haiku after storage.

      it('admits Bash BUILD_OUTPUT (noise classified post-storage by Haiku)', () => {
        expect(shouldAdmit('Bash', '[Bash] $ npm test\nnpm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported')).toBe(true);
      });

      it('admits Bash PACKAGE_INSTALL (noise classified post-storage by Haiku)', () => {
        expect(shouldAdmit('Bash', '[Bash] $ npm install\nadded 42 packages in 3.2s')).toBe(true);
      });

      it('admits Bash LINTER_WARNING (noise classified post-storage by Haiku)', () => {
        expect(shouldAdmit('Bash', '[Bash] $ eslint .\n42 problems (10 errors, 32 warnings)\n  warning: no-unused-vars\n  warning: no-console\n  warning: prefer-const')).toBe(true);
      });

      it('rejects empty Bash output', () => {
        expect(shouldAdmit('Bash', '')).toBe(false);
      });

      it('rejects whitespace-only Bash output', () => {
        expect(shouldAdmit('Bash', '   \n  ')).toBe(false);
      });

      it('admits "OK" Bash output (noise classified post-storage by Haiku)', () => {
        expect(shouldAdmit('Bash', 'OK')).toBe(true);
      });

      it('admits "Success" Bash output (noise classified post-storage by Haiku)', () => {
        expect(shouldAdmit('Bash', 'Success')).toBe(true);
      });

      it('rejects very long content without decision/error indicators', () => {
        // Content over 5000 chars with no meaningful indicators -> reject
        const longContent = '[Bash] $ cat package.json\n' + '{"dependencies": {"a": "1.0.0"}, '.repeat(200);
        expect(longContent.length).toBeGreaterThan(5000);
        expect(shouldAdmit('Bash', longContent)).toBe(false);
      });

      it('admits long content if it contains error indicators', () => {
        const longContent = '[Bash] $ npm test\n' + 'x'.repeat(5000) + '\nError: test failed';
        expect(shouldAdmit('Bash', longContent)).toBe(true);
      });

      it('admits long content if it contains decision indicators', () => {
        const longContent = '[Bash] $ git log\n' + 'x'.repeat(5000) + '\ndecided to use JWT instead of sessions';
        expect(shouldAdmit('Bash', longContent)).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Read tool: admitted (low signal but useful)
    // -------------------------------------------------------------------------

    describe('Read tool', () => {
      it('admits Read tool output', () => {
        expect(shouldAdmit('Read', '[Read] src/config.ts')).toBe(true);
      });

      it('rejects empty Read output', () => {
        expect(shouldAdmit('Read', '')).toBe(false);
      });
    });

    // -------------------------------------------------------------------------
    // Other tools
    // -------------------------------------------------------------------------

    describe('other tools', () => {
      it('admits Glob tool output', () => {
        expect(shouldAdmit('Glob', '[Glob] pattern=*.ts in src/')).toBe(true);
      });

      it('admits Grep tool output', () => {
        expect(shouldAdmit('Grep', '[Grep] pattern=TODO in src/')).toBe(true);
      });

      it('rejects empty output for any tool', () => {
        expect(shouldAdmit('Glob', '')).toBe(false);
        expect(shouldAdmit('Grep', '')).toBe(false);
      });

      it('rejects Laminark self-referential MCP tools', () => {
        expect(shouldAdmit('mcp__laminark__save_memory', '[mcp__laminark__save_memory] {"content": "test"}')).toBe(false);
        expect(shouldAdmit('mcp__laminark__recall', '[mcp__laminark__recall] {"query": "test"}')).toBe(false);
      });
    });
  });
});
