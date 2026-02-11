import { describe, it, expect } from 'vitest';
import { isLaminarksOwnTool, LAMINARK_PREFIXES } from '../self-referential.js';

describe('isLaminarksOwnTool', () => {
  describe('project-scoped prefix (mcp__laminark__)', () => {
    it('detects mcp__laminark__recall as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__laminark__recall')).toBe(true);
    });

    it('detects mcp__laminark__save_memory as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__laminark__save_memory')).toBe(true);
    });

    it('detects mcp__laminark__query_graph as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__laminark__query_graph')).toBe(true);
    });
  });

  describe('plugin-scoped prefix (mcp__plugin_laminark_laminark__)', () => {
    it('detects mcp__plugin_laminark_laminark__recall as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__plugin_laminark_laminark__recall')).toBe(true);
    });

    it('detects mcp__plugin_laminark_laminark__save_memory as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__plugin_laminark_laminark__save_memory')).toBe(true);
    });

    it('detects mcp__plugin_laminark_laminark__query_graph as Laminark tool', () => {
      expect(isLaminarksOwnTool('mcp__plugin_laminark_laminark__query_graph')).toBe(true);
    });
  });

  describe('non-Laminark tools', () => {
    it('rejects Write as non-Laminark', () => {
      expect(isLaminarksOwnTool('Write')).toBe(false);
    });

    it('rejects Bash as non-Laminark', () => {
      expect(isLaminarksOwnTool('Bash')).toBe(false);
    });

    it('rejects other MCP server tools', () => {
      expect(isLaminarksOwnTool('mcp__other_server__tool')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isLaminarksOwnTool('')).toBe(false);
    });

    it('rejects partial prefix match', () => {
      expect(isLaminarksOwnTool('mcp__laminark')).toBe(false);
    });

    it('rejects prefix without trailing underscore', () => {
      expect(isLaminarksOwnTool('mcp__laminark_')).toBe(false);
    });
  });
});

describe('LAMINARK_PREFIXES', () => {
  it('is a readonly array with exactly two prefixes', () => {
    expect(LAMINARK_PREFIXES).toHaveLength(2);
  });

  it('contains the project-scoped prefix', () => {
    expect(LAMINARK_PREFIXES).toContain('mcp__laminark__');
  });

  it('contains the plugin-scoped prefix', () => {
    expect(LAMINARK_PREFIXES).toContain('mcp__plugin_laminark_laminark__');
  });
});
