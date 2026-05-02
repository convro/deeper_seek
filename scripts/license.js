#!/usr/bin/env node
'use strict';

/**
 * scripts/license.js — CLI for managing DeeperSeek registration licenses.
 *
 * Usage:
 *   node scripts/license.js                     # generate 1 license
 *   node scripts/license.js 5                   # generate 5 licenses
 *   node scripts/license.js --list              # list all licenses + status
 *   node scripts/license.js --revoke DS-XXXX-…  # revoke an UNUSED license
 *
 * Licenses are stored in runtime/licenses.json (chmod 0600).
 * Each license can be consumed exactly once during registration.
 */

const path = require('path');
const authService = require(path.join(__dirname, '..', 'app', 'backend', 'auth.service'));

const args = process.argv.slice(2);

function printHelp() {
  console.log('DeeperSeek license manager');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/license.js                       generate 1 license');
  console.log('  node scripts/license.js <N>                   generate N licenses');
  console.log('  node scripts/license.js --list                list all licenses');
  console.log('  node scripts/license.js --revoke <KEY>        revoke an unused license');
  console.log('  node scripts/license.js --help                show this help');
}

function cmdGenerate(n) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(authService.generateLicense());
  if (n === 1) {
    console.log(keys[0]);
  } else {
    console.log(`Generated ${n} licenses:`);
    keys.forEach(k => console.log('  ' + k));
  }
}

function cmdList() {
  const all = authService.listLicenses();
  if (all.length === 0) {
    console.log('(no licenses yet — generate one with `node scripts/license.js`)');
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('LICENSE KEY', 26) + pad('STATUS', 10) + pad('USED BY', 20) + 'CREATED');
  console.log('─'.repeat(90));
  all.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  for (const l of all) {
    const status = l.used ? 'used' : 'free';
    console.log(
      pad(l.key, 26) +
      pad(status, 10) +
      pad(l.usedBy || '—', 20) +
      l.createdAt,
    );
  }
  const free = all.filter(l => !l.used).length;
  console.log(`\n${all.length} total, ${free} unused.`);
}

function cmdRevoke(key) {
  if (!key) {
    console.error('Error: --revoke requires a license key.');
    process.exit(1);
  }
  const { ok, reason } = authService.revokeLicense(key);
  if (ok) {
    console.log(`Revoked license: ${key}`);
  } else {
    console.error(`Could not revoke: ${reason}`);
    process.exit(1);
  }
}

// ── dispatch ────────────────────────────────────────────────────────────
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args[0] === '--list' || args[0] === '-l') {
  cmdList();
} else if (args[0] === '--revoke') {
  cmdRevoke(args[1]);
} else if (args.length === 0) {
  cmdGenerate(1);
} else {
  const n = parseInt(args[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    console.error('Error: expected a positive integer (1-1000).');
    printHelp();
    process.exit(1);
  }
  cmdGenerate(n);
}
