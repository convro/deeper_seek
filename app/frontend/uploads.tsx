import React, { useState, useEffect, useRef } from 'react';
import { uploadFile, listUploads } from './api';

interface UploadedFile { name: string; category: string; path: string; size: number; modified: string; }

function catIcon(cat: string) {
  if (cat === 'images') return '🖼';
  if (cat === 'zips') return '📦';
  return '📄';
}

export function Uploads() {
  const [files,     setFiles]     = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { refresh(); }, []);

  const refresh = async () => {
    try { const d = await listUploads(); setFiles(d.files || []); } catch {}
  };

  const handleFiles = async (list: FileList) => {
    setUploading(true);
    for (const f of Array.from(list)) {
      try { await uploadFile(f); } catch {}
    }
    await refresh();
    setUploading(false);
  };

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 12,
          padding: '36px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? 'var(--accent2)18' : 'var(--bg2)',
          marginBottom: 20,
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 36, marginBottom: 8 }}>📎</div>
        <div style={{ color: 'var(--text2)', fontSize: 14, fontWeight: 500 }}>
          {uploading ? 'Uploading…' : 'Drop files or click to upload'}
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 12, marginTop: 4 }}>
          Images, ZIPs, documents — give the AI files to work with
        </div>
        <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
          onChange={e => e.target.files && handleFiles(e.target.files)} />
      </div>

      {/* File list */}
      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1, marginBottom: 8 }}>
        UPLOADS ({files.length})
      </div>

      {files.length === 0 && (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>No files uploaded yet</div>
      )}

      {files.map((f, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 6,
          fontSize: 13,
        }}>
          <span style={{ fontSize: 18 }}>{catIcon(f.category)}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12 }}>
            {f.name}
          </span>
          <span style={{ color: 'var(--text3)', fontSize: 11, flexShrink: 0 }}>
            {Math.round(f.size / 1024)}KB
          </span>
          <span style={{
            background: 'var(--bg4)', color: 'var(--text3)',
            padding: '1px 7px', borderRadius: 4, fontSize: 10, flexShrink: 0,
          }}>
            {f.category}
          </span>
        </div>
      ))}
    </div>
  );
}
