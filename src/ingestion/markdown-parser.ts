/**
 * Markdown section parser for knowledge ingestion.
 *
 * Splits structured markdown documents (GSD map-codebase output) into
 * discrete sections by ## headings. Each section becomes one observation
 * in the knowledge store.
 */

export interface ParsedSection {
  title: string;        // Full title: "Technology Stack > Languages" (docTitle > heading)
  heading: string;      // Just the heading text: "Languages"
  content: string;      // Everything under heading until next ## or EOF
  sourceFile: string;   // Filename: "STACK.md"
  sectionIndex: number; // 0-based index within file
}

/**
 * Parse a markdown file into discrete sections split on ## headings.
 *
 * - The # (level 1) heading is the doc title, used as prefix: "DocTitle > SectionHeading"
 * - ### subsections stay within their parent ## section (not split separately)
 * - Sections with empty content after trimming are skipped
 * - Content before the first ## heading is skipped
 * - ## inside fenced code blocks are not treated as headings
 */
export function parseMarkdownSections(
  fileContent: string,
  sourceFile: string,
): ParsedSection[] {
  const lines = fileContent.split('\n');
  const sections: ParsedSection[] = [];

  let docTitle = '';
  let currentHeading = '';
  let currentLines: string[] = [];
  let sectionIndex = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    // Track fenced code blocks to avoid splitting on ## inside them
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (inCodeBlock) {
      if (currentHeading) {
        currentLines.push(line);
      }
      continue;
    }

    // Document title (# heading) -- only match single # not ##
    if (/^# (?!#)/.test(line)) {
      docTitle = line.slice(2).trim();
      continue;
    }

    // Section heading (## heading) -- only match exactly ## not ###
    if (/^## (?!#)/.test(line)) {
      // Save previous section if any
      if (currentHeading) {
        const content = currentLines.join('\n').trim();
        if (content.length > 0) {
          sections.push({
            title: docTitle ? `${docTitle} > ${currentHeading}` : currentHeading,
            heading: currentHeading,
            content,
            sourceFile,
            sectionIndex,
          });
          sectionIndex++;
        }
      }
      currentHeading = line.slice(3).trim();
      currentLines = [];
      continue;
    }

    if (currentHeading) {
      currentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentHeading) {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        title: docTitle ? `${docTitle} > ${currentHeading}` : currentHeading,
        heading: currentHeading,
        content,
        sourceFile,
        sectionIndex,
      });
    }
  }

  return sections;
}
