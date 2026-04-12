import React, { useState, useEffect } from 'react';

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

// ── Preview modal ─────────────────────────────────────────────────────────

interface PreviewModalProps {
  /** URL served from backend (workspace files, relative assets work) */
  src?: string;
  /** Inline HTML string (for code-block preview) */
  html?: string;
  title?: string;
  onClose: () => void;
}

export function PreviewModal({ src, html, title, onClose }: PreviewModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="preview-backdrop" onClick={onClose}>
      <div className="preview-modal" onClick={e => e.stopPropagation()}>
        <div className="preview-modal-header">
          <span className="preview-modal-title">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 6, opacity: 0.7 }}>
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Zm1.5 0v9h11v-9h-11Z"/>
              <path d="M3 5.25a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 5.25Zm2.5 0a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 5.5 5.25Z"/>
            </svg>
            {title || 'Preview'}
          </span>
          <div className="preview-modal-actions">
            {src && (
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="preview-newtab-btn"
                title="Open in new tab"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/>
                </svg>
                New tab
              </a>
            )}
            <button className="preview-close-btn" onClick={onClose} title="Close (Esc)">✕</button>
          </div>
        </div>
        <div className="preview-modal-body">
          {src
            ? <iframe
                src={src}
                className="preview-iframe"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                title={title}
              />
            : <iframe
                srcDoc={html}
                className="preview-iframe"
                sandbox="allow-scripts allow-popups allow-forms"
                title={title}
              />
          }
        </div>
      </div>
    </div>
  );
}

// ── Code block with copy + optional HTML preview ──────────────────────────

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const isHtml = /^html$/i.test(lang);

  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <pre>
        {lang && <span className="code-lang">{lang}</span>}
        <div className="code-btn-row">
          {isHtml && (
            <button className="code-preview-btn" onClick={() => setShowPreview(true)} title="Preview HTML">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>
                <path d="M8 4.5a.5.5 0 0 1 .5.5v2.5H11a.5.5 0 0 1 0 1H8a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z"/>
              </svg>
              Preview
            </button>
          )}
          <button className="copy-btn" onClick={copy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <code>{text}</code>
      </pre>
      {showPreview && (
        <PreviewModal
          html={text}
          title="HTML Preview"
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
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
