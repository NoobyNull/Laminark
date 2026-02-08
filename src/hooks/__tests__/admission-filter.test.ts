import { describe, it, expect } from 'vitest';
import { shouldAdmit } from '../admission-filter.js';
import { isNoise, NOISE_PATTERNS } from '../noise-patterns.js';

// =============================================================================
// Noise Patterns Unit Tests
// =============================================================================

describe('noise-patterns', () => {
  describe('NOISE_PATTERNS', () => {
    it('exports pattern categories', () => {
      expect(NOISE_PATTERNS).toBeDefined();
      expect(NOISE_PATTERNS.BUILD_OUTPUT).toBeDefined();
      expect(NOISE_PATTERNS.PACKAGE_INSTALL).toBeDefined();
      expect(NOISE_PATTERNS.LINTER_WARNING).toBeDefined();
      expect(NOISE_PATTERNS.EMPTY_OUTPUT).toBeDefined();
    });

    it('each category contains RegExp arrays', () => {
      for (const [, patterns] of Object.entries(NOISE_PATTERNS)) {
        expect(Array.isArray(patterns)).toBe(true);
        for (const p of patterns) {
          expect(p).toBeInstanceOf(RegExp);
        }
      }
    });
  });

  describe('isNoise', () => {
    it('detects BUILD_OUTPUT noise', () => {
      const result = isNoise('npm WARN deprecated glob@7.2.3');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('BUILD_OUTPUT');
    });

    it('detects npm ERR as BUILD_OUTPUT', () => {
      const result = isNoise('npm ERR! code ENOENT');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('BUILD_OUTPUT');
    });

    it('detects webpack compiled as BUILD_OUTPUT', () => {
      const result = isNoise('webpack compiled successfully in 2.3s');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('BUILD_OUTPUT');
    });

    it('detects tsc error as BUILD_OUTPUT', () => {
      const result = isNoise('src/index.ts(5,3): error TS2304: Cannot find name');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('BUILD_OUTPUT');
    });

    it('detects PACKAGE_INSTALL noise', () => {
      const result = isNoise('added 42 packages in 3.2s');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('PACKAGE_INSTALL');
    });

    it('detects "up to date" as PACKAGE_INSTALL', () => {
      const result = isNoise('up to date, audited 150 packages in 1s');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('PACKAGE_INSTALL');
    });

    it('detects audited packages as PACKAGE_INSTALL', () => {
      const result = isNoise('audited 523 packages in 2.5s');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('PACKAGE_INSTALL');
    });

    it('detects removed packages as PACKAGE_INSTALL', () => {
      const result = isNoise('removed 3 packages in 0.5s');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('PACKAGE_INSTALL');
    });

    it('detects LINTER_WARNING noise', () => {
      const result = isNoise('42 problems (10 errors, 32 warnings)');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('LINTER_WARNING');
    });

    it('detects eslint output as LINTER_WARNING', () => {
      const result = isNoise('/src/foo.ts\n  1:1  warning  ...\n  2:5  warning  ...\n  3:3  warning  ...');
      expect(result.isNoise).toBe(true);
      expect(result.category).toBe('LINTER_WARNING');
    });

    it('detects EMPTY_OUTPUT noise', () => {
      expect(isNoise('').isNoise).toBe(true);
      expect(isNoise('').category).toBe('EMPTY_OUTPUT');
    });

    it('detects whitespace-only as EMPTY_OUTPUT', () => {
      expect(isNoise('   \n  \t  ').isNoise).toBe(true);
      expect(isNoise('   \n  \t  ').category).toBe('EMPTY_OUTPUT');
    });

    it('detects "OK" as EMPTY_OUTPUT', () => {
      expect(isNoise('OK').isNoise).toBe(true);
      expect(isNoise('OK').category).toBe('EMPTY_OUTPUT');
    });

    it('detects "Success" as EMPTY_OUTPUT', () => {
      expect(isNoise('Success').isNoise).toBe(true);
      expect(isNoise('Success').category).toBe('EMPTY_OUTPUT');
    });

    it('detects "Done" as EMPTY_OUTPUT', () => {
      expect(isNoise('Done').isNoise).toBe(true);
      expect(isNoise('Done').category).toBe('EMPTY_OUTPUT');
    });

    it('detects "undefined" as EMPTY_OUTPUT', () => {
      expect(isNoise('undefined').isNoise).toBe(true);
      expect(isNoise('undefined').category).toBe('EMPTY_OUTPUT');
    });

    it('detects "null" as EMPTY_OUTPUT', () => {
      expect(isNoise('null').isNoise).toBe(true);
      expect(isNoise('null').category).toBe('EMPTY_OUTPUT');
    });

    it('returns not noise for meaningful content', () => {
      const result = isNoise('git commit -m "feat: add auth"');
      expect(result.isNoise).toBe(false);
      expect(result.category).toBeUndefined();
    });

    it('returns not noise for error messages with context', () => {
      const result = isNoise('Error: Cannot read property "id" of undefined\n  at UserService.getUser (src/user.ts:42)');
      expect(result.isNoise).toBe(false);
    });
  });
});

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

      it('rejects Bash BUILD_OUTPUT noise', () => {
        expect(shouldAdmit('Bash', '[Bash] $ npm test\nnpm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported')).toBe(false);
      });

      it('rejects Bash PACKAGE_INSTALL noise', () => {
        expect(shouldAdmit('Bash', '[Bash] $ npm install\nadded 42 packages in 3.2s')).toBe(false);
      });

      it('rejects Bash LINTER_WARNING noise', () => {
        expect(shouldAdmit('Bash', '[Bash] $ eslint .\n42 problems (10 errors, 32 warnings)\n  warning: no-unused-vars\n  warning: no-console\n  warning: prefer-const')).toBe(false);
      });

      it('rejects empty Bash output', () => {
        expect(shouldAdmit('Bash', '')).toBe(false);
      });

      it('rejects whitespace-only Bash output', () => {
        expect(shouldAdmit('Bash', '   \n  ')).toBe(false);
      });

      it('rejects "OK" Bash output', () => {
        expect(shouldAdmit('Bash', 'OK')).toBe(false);
      });

      it('rejects "Success" Bash output', () => {
        expect(shouldAdmit('Bash', 'Success')).toBe(false);
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
