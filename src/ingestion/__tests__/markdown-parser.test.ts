import { describe, it, expect } from 'vitest';
import { parseMarkdownSections } from '../markdown-parser.js';

describe('parseMarkdownSections', () => {
  it('splits file with # title and 3 ## sections into 3 ParsedSection objects', () => {
    const content = `# Technology Stack

## Languages

TypeScript is the primary language.
Node.js runtime.

## Frameworks

Express for HTTP.
React for frontend.

## Testing

Vitest for unit tests.
`;

    const sections = parseMarkdownSections(content, 'STACK.md');

    expect(sections).toHaveLength(3);

    expect(sections[0].title).toBe('Technology Stack > Languages');
    expect(sections[0].heading).toBe('Languages');
    expect(sections[0].content).toBe('TypeScript is the primary language.\nNode.js runtime.');
    expect(sections[0].sourceFile).toBe('STACK.md');
    expect(sections[0].sectionIndex).toBe(0);

    expect(sections[1].title).toBe('Technology Stack > Frameworks');
    expect(sections[1].heading).toBe('Frameworks');
    expect(sections[1].sectionIndex).toBe(1);

    expect(sections[2].title).toBe('Technology Stack > Testing');
    expect(sections[2].heading).toBe('Testing');
    expect(sections[2].sectionIndex).toBe(2);
  });

  it('handles file without # heading -- sections use heading text only', () => {
    const content = `## Overview

Some overview content.

## Details

Some detail content.
`;

    const sections = parseMarkdownSections(content, 'NOTES.md');

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('Overview');
    expect(sections[0].heading).toBe('Overview');
    expect(sections[1].title).toBe('Details');
    expect(sections[1].heading).toBe('Details');
  });

  it('skips empty sections (## heading followed immediately by another ##)', () => {
    const content = `# Doc

## Empty Section

## Has Content

Real content here.
`;

    const sections = parseMarkdownSections(content, 'TEST.md');

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Has Content');
    expect(sections[0].content).toBe('Real content here.');
  });

  it('keeps ### subsections within their parent ## section content', () => {
    const content = `# Project

## Architecture

High level overview.

### Frontend

React components.

### Backend

Express routes.

## Deployment

Docker setup.
`;

    const sections = parseMarkdownSections(content, 'ARCH.md');

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Architecture');
    expect(sections[0].content).toContain('### Frontend');
    expect(sections[0].content).toContain('React components.');
    expect(sections[0].content).toContain('### Backend');
    expect(sections[0].content).toContain('Express routes.');

    expect(sections[1].heading).toBe('Deployment');
    expect(sections[1].content).toBe('Docker setup.');
  });

  it('returns empty array for file with only prose (no ## sections)', () => {
    const content = `# Just a Title

Some general text without any level-2 headings.

More text here.
`;

    const sections = parseMarkdownSections(content, 'PROSE.md');

    expect(sections).toHaveLength(0);
  });

  it('returns empty array for empty file', () => {
    const sections = parseMarkdownSections('', 'EMPTY.md');
    expect(sections).toHaveLength(0);
  });

  it('handles trailing newlines and mixed whitespace', () => {
    const content = `# Title


## Section One

  Content with leading spaces.


## Section Two

Content with trailing space.


`;

    const sections = parseMarkdownSections(content, 'WHITESPACE.md');

    expect(sections).toHaveLength(2);
    expect(sections[0].content).toBe('Content with leading spaces.');
    expect(sections[1].content).toBe('Content with trailing space.');
  });

  it('does not split on ## inside fenced code blocks', () => {
    const content = `# Docs

## Real Section

Some explanation.

\`\`\`markdown
## This Is Not A Section

This is inside a code block.
\`\`\`

More content after code block.

## Another Real Section

Another section body.
`;

    const sections = parseMarkdownSections(content, 'CODE.md');

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Real Section');
    expect(sections[0].content).toContain('## This Is Not A Section');
    expect(sections[0].content).toContain('More content after code block.');

    expect(sections[1].heading).toBe('Another Real Section');
  });

  it('skips content before the first ## heading', () => {
    const content = `# Title

Some preamble text that comes before any section.

## First Section

Section content.
`;

    const sections = parseMarkdownSections(content, 'PREAMBLE.md');

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('First Section');
    expect(sections[0].content).toBe('Section content.');
  });
});
