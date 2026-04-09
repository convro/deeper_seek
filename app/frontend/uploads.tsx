import React, { useState, useEffect, useRef } from 'react';
import { uploadFile, listUploads } from './api';

interface UploadedFile {
  name: string;
  category: string;
  path: string;
  size: number;
  modified: string;
}

export function Uploads() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refresh();
  }, []);

  const refresh = async () => {
    try {
      const data = await listUploads();
      setFiles(data.files || []);
    } catch {}
  };

  const handleFiles = async (fileList: FileList) => {
    setUploading(true);
    for (const file of Array.from(fileList)) {
      try {
        await uploadFile(file);
      } catch {}
    }
    await refresh();
    setUploading(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  return (
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%' }}>
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? '#3b82f6' : '#374151'}`,
          borderRadius: '8px',
          padding: '32px',
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: '20px',
          backgroundColor: dragOver ? '#1e3a5f22' : 'transparent',
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: '32px', marginBottom: '8px' }}>📎</div>
        <div style={{ color: '#9ca3af', fontSize: '14px' }}>
          {uploading ? 'Uploading...' : 'Drop files here or click to upload'}
        </div>
        <div style={{ color: '#4b5563', fontSize: '11px', marginTop: '4px' }}>
          Images, ZIPs, documents — anything the AI needs to work with
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {/* File list */}
      <div style={{ color: '#4b5563', fontSize: '11px', fontFamily: 'monospace', marginBottom: '8px' }}>
        UPLOADED FILES ({files.length})
      </div>
      {files.length === 0 && (
        <div style={{ color: '#374151', fontSize: '13px' }}>No files uploaded yet</div>
      )}
      {files.map((file, i) => (
        <div key={i} style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 12px',
          backgroundColor: '#111827',
          borderRadius: '6px',
          marginBottom: '6px',
          fontSize: '12px',
          fontFamily: 'monospace',
        }}>
          <span style={{ fontSize: '16px' }}>
            {file.category === 'images' ? '🖼️' : file.category === 'zips' ? '📦' : '📄'}
          </span>
          <span style={{ color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </span>
          <span style={{ color: '#4b5563' }}>{Math.round(file.size / 1024)}KB</span>
          <span style={{
            backgroundColor: '#1f2937',
            color: '#6b7280',
            padding: '1px 6px',
            borderRadius: '3px',
            fontSize: '10px',
          }}>
            {file.category}
          </span>
        </div>
      ))}
    </div>
  );
}
