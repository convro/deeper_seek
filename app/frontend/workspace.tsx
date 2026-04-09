import React, { useState, useEffect } from 'react';
import type { WorkspaceJob } from './state';
import { FileTreeItem } from './components';
import { listJobs, listJobFiles, readJobFile } from './api';

export function Workspace() {
  const [jobs, setJobs] = useState<WorkspaceJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<WorkspaceJob | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  const refresh = async () => {
    try {
      const data = await listJobs();
      setJobs(data.jobs || []);
    } catch {}
  };

  const selectJob = async (job: WorkspaceJob) => {
    setSelectedJob(job);
    setSelectedFile(null);
    setFileContent('');
    try {
      const data = await listJobFiles(job.job_id);
      setFiles(data.files || []);
    } catch {}
  };

  const selectFile = async (file: any) => {
    setSelectedFile(file);
    setLoading(true);
    try {
      const data = await readJobFile(selectedJob!.job_id, file.path);
      setFileContent(data.content || '');
    } catch {
      setFileContent('Error loading file content');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Job list */}
      <div style={{
        width: '200px',
        borderRight: '1px solid #1f2937',
        overflowY: 'auto',
        backgroundColor: '#0a0f1a',
        flexShrink: 0,
      }}>
        <div style={{ padding: '10px', borderBottom: '1px solid #1f2937', color: '#4b5563', fontSize: '11px', fontFamily: 'monospace' }}>
          WORKSPACES ({jobs.length})
        </div>
        {jobs.length === 0 && (
          <div style={{ padding: '16px', color: '#374151', fontSize: '12px', textAlign: 'center' }}>
            No workspaces yet. They're created automatically when the AI starts a project.
          </div>
        )}
        {jobs.map(job => (
          <div
            key={job.job_id}
            onClick={() => selectJob(job)}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              backgroundColor: selectedJob?.job_id === job.job_id ? '#1e3a5f' : 'transparent',
              borderBottom: '1px solid #111827',
            }}
          >
            <div style={{ color: '#60a5fa', fontSize: '11px', fontFamily: 'monospace' }}>
              {job.job_id}
            </div>
            {job.description && (
              <div style={{ color: '#6b7280', fontSize: '11px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.description}
              </div>
            )}
            {job.created_at && (
              <div style={{ color: '#374151', fontSize: '10px', marginTop: '2px' }}>
                {new Date(job.created_at).toLocaleDateString()}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* File tree */}
      {selectedJob && (
        <div style={{
          width: '220px',
          borderRight: '1px solid #1f2937',
          overflowY: 'auto',
          backgroundColor: '#0d1117',
          flexShrink: 0,
        }}>
          <div style={{ padding: '10px', borderBottom: '1px solid #1f2937', color: '#4b5563', fontSize: '11px', fontFamily: 'monospace' }}>
            FILES — {selectedJob.job_id}
          </div>
          {files.map(file => (
            <FileTreeItem
              key={file.path}
              file={file}
              onSelect={selectFile}
              selected={selectedFile?.path === file.path}
            />
          ))}
        </div>
      )}

      {/* File content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', backgroundColor: '#0d1117' }}>
        {!selectedJob && (
          <div style={{ color: '#374151', textAlign: 'center', marginTop: '60px', fontSize: '14px' }}>
            Select a workspace to explore files
          </div>
        )}
        {selectedJob && !selectedFile && (
          <div style={{ color: '#374151', textAlign: 'center', marginTop: '60px', fontSize: '14px' }}>
            Select a file to view its contents
          </div>
        )}
        {selectedFile && (
          <>
            <div style={{
              marginBottom: '10px',
              padding: '6px 10px',
              backgroundColor: '#111827',
              borderRadius: '4px',
              color: '#94a3b8',
              fontSize: '11px',
              fontFamily: 'monospace',
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span>📄 {selectedFile.path}</span>
              {selectedFile.size != null && (
                <span style={{ color: '#4b5563' }}>{Math.round(selectedFile.size / 1024)}KB</span>
              )}
            </div>
            {loading ? (
              <div style={{ color: '#4b5563', fontSize: '13px' }}>Loading...</div>
            ) : (
              <pre style={{
                backgroundColor: '#0a0f1a',
                padding: '12px',
                borderRadius: '6px',
                color: '#d1d5db',
                fontSize: '12px',
                fontFamily: 'monospace',
                lineHeight: '1.6',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {fileContent}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
