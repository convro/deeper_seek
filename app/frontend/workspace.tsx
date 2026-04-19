import React, { useState, useEffect, useCallback } from 'react';
import { listJobs, listJobFiles, readJobFile } from './api';
import type { WorkspaceJob } from './state';

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','tiff','tif']);
const BINARY_EXTS = new Set(['zip','tar','gz','bz2','xz','7z','rar','pdf','exe','bin','dmg','iso','whl','deb','rpm','mp4','mp3','wav','avi','mov','mkv','db','sqlite']);

function fileExt(name: string) { return name.split('.').pop()?.toLowerCase() ?? ''; }
function isImage(name: string) { return IMAGE_EXTS.has(fileExt(name)); }
function isBinary(name: string) { return BINARY_EXTS.has(fileExt(name)) || IMAGE_EXTS.has(fileExt(name)); }

interface FileItem { path: string; name: string; type: 'file' | 'dir'; size?: number | null; }

function fmtSize(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${Math.round(b / 1024)}KB`;
  return `${Math.round(b / 1048576)}MB`;
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return '📄';
  if (['py'].includes(ext))                return '🐍';
  if (['js','ts','tsx','jsx'].includes(ext)) return '📜';
  if (['json'].includes(ext))              return '{}';
  if (['md','txt'].includes(ext))          return '📝';
  if (['sh','bash'].includes(ext))         return '⚙';
  if (['html','css'].includes(ext))        return '🌐';
  if (['png','jpg','gif','svg','webp'].includes(ext)) return '🖼';
  if (['zip','tar','gz'].includes(ext))    return '📦';
  if (['csv','tsv'].includes(ext))         return '📊';
  return '📄';
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Workspace() {
  const [jobs,         setJobs]         = useState<WorkspaceJob[]>([]);
  const [selectedJob,  setSelectedJob]  = useState<WorkspaceJob | null>(null);
  const [files,        setFiles]        = useState<FileItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [content,      setContent]      = useState('');
  const [viewMode,     setViewMode]     = useState<'text' | 'image' | 'binary'>('text');
  const [loading,      setLoading]      = useState(false);
  const [copied,       setCopied]       = useState(false);

  // Mobile navigation state: which panel is currently visible
  const [mobilePanel,  setMobilePanel]  = useState<'jobs' | 'files' | 'viewer'>('jobs');

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    try { const d = await listJobs(); setJobs(d.jobs || []); } catch {}
  };

  const selectJob = async (job: WorkspaceJob) => {
    setSelectedJob(job);
    setSelectedFile(null);
    setContent('');
    setMobilePanel('files');
    try { const d = await listJobFiles(job.job_id); setFiles(d.files || []); } catch {}
  };

  const selectFile = async (f: FileItem) => {
    if (f.type === 'dir') return;
    setSelectedFile(f);
    setContent('');
    setMobilePanel('viewer');

    if (isImage(f.name)) {
      setViewMode('image');
      return;
    }
    if (isBinary(f.name)) {
      setViewMode('binary');
      return;
    }

    setViewMode('text');
    setLoading(true);
    try {
      const d = await readJobFile(selectedJob!.job_id, f.path);
      setContent(d.content || '');
    } catch {
      setContent('Could not load file.');
    } finally {
      setLoading(false);
    }
  };

  const copyContent = useCallback(() => {
    navigator.clipboard?.writeText(content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className="ws-root">

      {/* ── Jobs list ─────────────────────────────────────────────────── */}
      <div className={`ws-panel ws-jobs ${mobilePanel === 'jobs' ? 'ws-mobile-show' : ''}`}>
        <div className="ws-panel-hdr">
          <span>Workspaces</span>
          {jobs.length > 0 && <span className="ws-count">{jobs.length}</span>}
        </div>
        <div className="ws-scroll">
          {jobs.length === 0 && (
            <div className="ws-empty-msg">
              Workspaces will appear here when the AI creates them for projects.
            </div>
          )}
          {jobs.map(j => (
            <div
              key={j.job_id}
              className={`ws-job-item ${selectedJob?.job_id === j.job_id ? 'ws-active' : ''}`}
              onClick={() => selectJob(j)}
            >
              <div className="ws-job-id">{j.job_id}</div>
              {j.description && (
                <div className="ws-job-desc">{j.description}</div>
              )}
              {j.created_at && (
                <div className="ws-job-meta">{relTime(j.created_at)}</div>
              )}
              <span className="ws-chevron">›</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── File tree ─────────────────────────────────────────────────── */}
      {selectedJob && (
        <div className={`ws-panel ws-files ${mobilePanel === 'files' ? 'ws-mobile-show' : ''}`}>
          <div className="ws-panel-hdr">
            <button className="ws-back-btn" onClick={() => setMobilePanel('jobs')}>‹</button>
            <span className="ws-panel-hdr-title">{selectedJob.job_id}</span>
          </div>
          <div className="ws-file-scroll">
            {files.length === 0 && (
              <div className="ws-empty-msg">No files yet.</div>
            )}
            {files.map(f => {
              const depth = f.path.split('/').length - 1;
              const isDir = f.type === 'dir';
              return (
                <div
                  key={f.path}
                  className={`ws-file-row ${isDir ? 'ws-is-dir' : 'ws-is-file'} ${selectedFile?.path === f.path ? 'ws-active' : ''}`}
                  style={{ paddingLeft: depth * 14 + 10 }}
                  onClick={() => selectFile(f)}
                >
                  <span className="ws-file-icon">{isDir ? '▸' : fileIcon(f.name)}</span>
                  <span className="ws-file-name">{f.name}</span>
                  {!isDir && f.size != null && (
                    <span className="ws-file-size">{fmtSize(f.size)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── File viewer ───────────────────────────────────────────────── */}
      <div className={`ws-viewer ${mobilePanel === 'viewer' ? 'ws-mobile-show' : ''}`}>
        {!selectedJob && (
          <div className="ws-placeholder">
            <div className="ws-placeholder-icon">📁</div>
            <div>Open a workspace from the sidebar to browse files</div>
          </div>
        )}

        {selectedJob && !selectedFile && (
          <div className="ws-placeholder">
            <div className="ws-placeholder-icon">📄</div>
            <div>Select a file to view its contents</div>
          </div>
        )}

        {selectedFile && (
          <>
            <div className="ws-viewer-hdr">
              <button className="ws-back-btn ws-back-mobile" onClick={() => setMobilePanel('files')}>
                ‹ Files
              </button>
              <span className="ws-viewer-icon">{fileIcon(selectedFile.name)}</span>
              <span className="ws-viewer-path" title={selectedFile.path}>{selectedFile.path}</span>
              {selectedFile.size != null && (
                <span className="ws-file-size">{fmtSize(selectedFile.size)}</span>
              )}
              {viewMode === 'text' && (
                <button className={`ws-copy-btn ${copied ? 'ws-copy-done' : ''}`} onClick={copyContent}>
                  {copied
                    ? <><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg> Copied</>
                    : <><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg> Copy</>
                  }
                </button>
              )}
              {(viewMode === 'image' || viewMode === 'binary') && (
                <a
                  className="ws-download-btn"
                  href={`/api/download/workspace/${selectedJob!.job_id}/${selectedFile.path}`}
                  download={selectedFile.name}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.779a.749.749 0 1 1 1.06-1.06l1.97 1.97Z"/></svg>
                  Download
                </a>
              )}
            </div>
            <div className="ws-viewer-body">
              {viewMode === 'image' && (
                <div className="ws-image-preview">
                  <img
                    src={`/api/preview/workspace/${selectedJob!.job_id}/${selectedFile.path}`}
                    alt={selectedFile.name}
                    className="ws-preview-img"
                  />
                </div>
              )}
              {viewMode === 'binary' && (
                <div className="ws-binary-info">
                  <div className="ws-binary-icon">📦</div>
                  <div className="ws-binary-name">{selectedFile.name}</div>
                  {selectedFile.size != null && (
                    <div className="ws-binary-size">{fmtSize(selectedFile.size)}</div>
                  )}
                  <a
                    className="ws-binary-download-btn"
                    href={`/api/download/workspace/${selectedJob!.job_id}/${selectedFile.path}`}
                    download={selectedFile.name}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.779a.749.749 0 1 1 1.06-1.06l1.97 1.97Z"/></svg>
                    Download {selectedFile.name}
                  </a>
                </div>
              )}
              {viewMode === 'text' && (
                loading
                  ? <div className="ws-loading">Loading…</div>
                  : <pre className="ws-code">{content}</pre>
              )}
            </div>
          </>
        )}
      </div>

    </div>
  );
}
