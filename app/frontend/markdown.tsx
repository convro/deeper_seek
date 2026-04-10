import React, { useState } from 'react';

type Block =
  | { kind: 'code';  lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'paragraph'; text: string };

function parseBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ kind: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    // Heading
    const headMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headMatch) {
      blocks.push({ kind: 'heading', level: headMatch[1].length, text: headMatch[2] });
      i++;
      continue;
    }

    // HR
    if (/^---+\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    // Table (basic)
    if (line.includes('|') && lines[i + 1]?.match(/^\|?[\s\-:|]+\|/)) {
      const headers = parseCells(line);
      i += 2; // skip separator line
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    // Empty line — skip
    if (!line.trim()) { i++; continue; }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^---+\s*$/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: 'paragraph', text: paraLines.join('\n') });
    } else {
      i++;
    }
  }

  return blocks;
}

function parseCells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim());
}

// ── Inline rendering (bold, italic, code, links) ──────────────────────────

function renderInline(text: string, key?: string | number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Pattern: **bold**, *italic*, `code`, [link](url)
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) parts.push(<strong key={idx++}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em key={idx++}>{m[3]}</em>);
    else if (m[4] !== undefined) parts.push(<code key={idx++}>{m[4]}</code>);
    else if (m[5] !== undefined) parts.push(<a key={idx++} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <React.Fragment key={key}>{parts}</React.Fragment>;
}

// ── Code block with copy button ───────────────────────────────────────────

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <pre>
      {lang && <span className="code-lang">{lang}</span>}
      <button className="copy-btn" onClick={copy}>
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <code>{text}</code>
    </pre>
  );
}

// ── Main renderer ─────────────────────────────────────────────────────────

export function Markdown({ content }: { content: string }) {
  if (!content) return null;
  const blocks = parseBlocks(content);

  return (
    <div className="md">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={i} lang={block.lang} text={block.text} />;

          case 'heading': {
            const H = `h${Math.min(block.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
            return <H key={i}>{renderInline(block.text)}</H>;
          }

          case 'hr':
            return <hr key={i} />;

          case 'list':
            return block.ordered
              ? <ol key={i}>{block.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>
              : <ul key={i}>{block.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;

          case 'table':
            return (
              <table key={i}>
                <thead>
                  <tr>{block.headers.map((h, j) => <th key={j}>{renderInline(h)}</th>)}</tr>
                </thead>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr key={j}>{row.map((cell, k) => <td key={k}>{renderInline(cell)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            );

          case 'paragraph':
            return (
              <p key={i}>
                {block.text.split('\n').map((line, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(line)}
                  </React.Fragment>
                ))}
              </p>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
