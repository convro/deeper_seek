'use strict';

const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

/**
 * Build a per-user subdirectory segment. For anonymous callers (open mode),
 * returns empty string which means "shared root" (legacy behavior).
 */
function userDir(req) {
  return req.user && req.user.id ? `u_${req.user.id}` : '';
}

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

  // Per-user subdirectory when auth is active
  const destDir = path.join(UPLOADS_ROOT, category, userDir(req));
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
  const userSeg  = userDir(req);                          // '' or 'u_<id>'
  const isAdmin  = req.user && req.user.role === 'admin';

  for (const category of ['images', 'zips', 'files', 'raw']) {
    const base = path.join(UPLOADS_ROOT, category);
    if (!fs.existsSync(base)) continue;

    // Admin: walk the whole category tree so they can see everything.
    // User:  only their own subdirectory + the legacy shared root (unowned).
    const roots = isAdmin
      ? [base]
      : (userSeg
          ? [path.join(base, userSeg), base]        // own + legacy root (non-u_ files)
          : [base]);

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        const full = path.join(root, entry);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          // Only admin descends into other users' dirs — already handled above.
          // For non-admin listing the category root, SKIP any u_* subdir
          // that isn't theirs.
          if (!isAdmin && root === base && entry.startsWith('u_') && entry !== userSeg) continue;
          // Otherwise skip (we don't recurse into e.g. session-keyed image dirs)
          continue;
        }
        files.push({
          name: entry,
          category,
          path: full,
          size: stat.size,
          modified: stat.mtime,
        });
      }
    }
  }

  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ files });
}

module.exports = { handleUpload, listUploads };
