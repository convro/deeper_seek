'use strict';

const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

async function handleUpload(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { originalname, filename, size, mimetype } = req.file;
  const uploadedPath = req.file.path;

  // Categorize file
  let category = 'files';
  if (/^image\//i.test(mimetype)) category = 'images';
  else if (/zip|tar|gz|bz2|7z|rar/i.test(originalname)) category = 'zips';

  const destDir = path.join(UPLOADS_ROOT, category);
  fs.mkdirSync(destDir, { recursive: true });

  const destPath = path.join(destDir, filename);
  fs.renameSync(uploadedPath, destPath);

  res.json({
    success: true,
    file: {
      original_name: originalname,
      stored_name: filename,
      path: destPath,
      category,
      size,
      mimetype,
    },
  });
}

function listUploads(req, res) {
  const files = [];
  for (const category of ['images', 'zips', 'files', 'raw']) {
    const dir = path.join(UPLOADS_ROOT, category);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      files.push({ name: f, category, path: fullPath, size: stat.size, modified: stat.mtime });
    }
  }
  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ files });
}

module.exports = { handleUpload, listUploads };
