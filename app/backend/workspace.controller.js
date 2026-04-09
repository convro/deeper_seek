'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.join(__dirname, '../../workspace/jobs');

function listJobs(req, res) {
  try {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      return res.json({ jobs: [] });
    }
    const jobs = fs.readdirSync(WORKSPACE_ROOT)
      .filter(d => fs.statSync(path.join(WORKSPACE_ROOT, d)).isDirectory())
      .map(jobId => {
        const metaPath = path.join(WORKSPACE_ROOT, jobId, 'context', 'meta.json');
        let meta = { job_id: jobId };
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
        return meta;
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function getJob(req, res) {
  const { jobId } = req.params;
  const jobPath = path.join(WORKSPACE_ROOT, jobId);
  if (!fs.existsSync(jobPath)) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const metaPath = path.join(jobPath, 'context', 'meta.json');
  const planPath = path.join(jobPath, 'context', 'plan.md');
  let meta = {};
  let plan = '';
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  try { plan = fs.readFileSync(planPath, 'utf-8'); } catch {}

  res.json({ job_id: jobId, meta, plan, path: jobPath });
}

function listFiles(req, res) {
  const { jobId } = req.params;
  const { subdir = '' } = req.query;
  const dirPath = path.join(WORKSPACE_ROOT, jobId, subdir);

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const files = [];
  function walk(p, rel) {
    const entries = fs.readdirSync(p);
    for (const e of entries) {
      const full = path.join(p, e);
      const relPath = path.join(rel, e);
      const stat = fs.statSync(full);
      files.push({
        path: relPath,
        name: e,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isDirectory() ? null : stat.size,
        modified: stat.mtime.toISOString(),
      });
      if (stat.isDirectory()) walk(full, relPath);
    }
  }
  walk(dirPath, subdir);
  res.json({ job_id: jobId, files });
}

function readFile(req, res) {
  const { jobId } = req.params;
  const { file_path } = req.query;
  if (!file_path) return res.status(400).json({ error: 'Missing file_path' });

  const fullPath = path.join(WORKSPACE_ROOT, jobId, file_path);
  // Prevent path traversal
  if (!fullPath.startsWith(path.join(WORKSPACE_ROOT, jobId))) {
    return res.status(403).json({ error: 'Path traversal denied' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ path: file_path, content, size: fs.statSync(fullPath).size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listJobs, getJob, listFiles, readFile };
