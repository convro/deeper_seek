import React, { useState, useEffect } from 'react';
import { listJobs, listJobFiles, readJobFile } from './api';
import type { WorkspaceJob } from './state';

interface FileItem { path: string; name: string; type: 'file' | 'dir'; size?: number | null; }

function fmtSize(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${Math.round(b / 1024)}KB`;
  return `${Math.round(b / 1048576)}MB`;
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return '📄';
  if (['py'].includes(ext))         return '🐍';
  if (['js','ts','tsx','jsx'].includes(ext)) return '📜';
  if (['json'].includes(ext))       return '{}';
  if (['md','txt'].includes(ext))   return '📝';
  if (['sh','bash'].includes(ext))  return '⚙';
  if (['html','css'].includes(ext)) return '🌐';
  if (['png','jpg','gif','svg'].includes(ext)) return '🖼';
  if (['zip','tar','gz'].includes(ext)) return '📦';
  if (['csv','tsv'].includes(ext))  return '📊';
  return '📄';
}

export function Workspace() {
  const [jobs,         setJobs]         = useState<WorkspaceJob[]>([]);
  const [selectedJob,  setSelectedJob]  = useState<WorkspaceJob | null>(null);
  const [files,        setFiles]        = useState<FileItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [content,      setContent]      = useState('');
  const [loading,      setLoading]      = useState(false);

  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, []);

  const refresh = async () => {
    try { const d = await listJobs(); setJobs(d.jobs || []); } catch {}
  };

  const selectJob = async (job: WorkspaceJob) => {
    setSelectedJob(job); setSelectedFile(null); setContent('');
    try { const d = await listJobFiles(job.job_id); setFiles(d.files || []); } catch {}
  };

  const selectFile = async (f: FileItem) => {
    if (f.type === 'dir') return;
    setSelectedFile(f); setLoading(true);
    try { const d = await readJobFile(selectedJob!.job_id, f.path); setContent(d.content || ''); }
    catch { setContent('Could not load file.'); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Jobs sidebar */}
      <div style={{
        width: 200, flexShrink: 0,
        background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1 }}>
          WORKSPACES ({jobs.length})
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {jobs.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
              Workspaces appear here when the AI creates them for projects
            </div>
          )}
          {jobs.map(j => (
            <div
              key={j.job_id}
              onClick={() => selectJob(j)}
              style={{
                padding: '9px 12px',
                cursor: 'pointer',
                background: selectedJob?.job_id === j.job_id ? 'var(--bg4)' : 'transparent',
                borderBottom: '1px solid var(--border2)',
                transition: 'background 0.1s',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{j.job_id}</div>
              {j.description && (
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.description}
                </div>
              )}
              {j.created_at && (
                <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                  {new Date(j.created_at).toLocaleDateString()}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* File tree */}
      {selectedJob && (
        <div style={{
          width: 210, flexShrink: 0,
          background: 'var(--bg2)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1 }}>
            FILES
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {files.map(f => {
              const depth = f.path.split('/').length - 1;
              return (
                <div
                  key={f.path}
                  onClick={() => selectFile(f)}
                  style={{
                    paddingLeft: depth * 12 + 10,
                    paddingRight: 10,
                    paddingTop: 4, paddingBottom: 4,
                    cursor: f.type === 'file' ? 'pointer' : 'default',
                    background: selectedFile?.path === f.path ? 'var(--bg4)' : 'transparent',
                    display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 12,
                    fontFamily: 'var(--mono)',
                    color: f.type === 'dir' ? 'var(--text2)' : 'var(--text)',
                    transition: 'background 0.1s',
                    borderBottom: '1px solid var(--border2)',
                  }}
                >
                  <span>{f.type === 'dir' ? '📂' : fileIcon(f.name)}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  {f.size != null && <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0 }}>{fmtSize(f.size)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* File content */}
      <div style={{ flex: 1, background: 'var(--bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!selectedJob && (
          <div style={{ margin: 'auto', color: 'var(--text3)', fontSize: 14, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📁</div>
            Select a workspace to explore files
          </div>
        )}
        {selectedJob && !selectedFile && (
          <div style={{ margin: 'auto', color: 'var(--text3)', fontSize: 14, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
            Select a file to view its contents
          </div>
        )}
        {selectedFile && (
          <>
            <div style={{
              padding: '8px 14px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg2)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              color: 'var(--text2)',
            }}>
              <span>{fileIcon(selectedFile.name)}</span>
              <span>{selectedFile.path}</span>
              {selectedFile.size != null && (
                <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>{fmtSize(selectedFile.size)}</span>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {loading ? (
                <div style={{ color: 'var(--text3)' }}>Loading…</div>
              ) : (
                <pre style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  fontSize: 13,
                  fontFamily: 'var(--mono)',
                  color: 'var(--text)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                }}>
                  {content}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
