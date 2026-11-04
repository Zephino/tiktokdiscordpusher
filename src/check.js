// =============================================================================
// check.js — a small test tool that checks TikTok WITHOUT starting the Discord bot.
//
// Usage:  npm run check -- bob
// (The `--` tells npm "pass everything after this to the script".)
//
// Handy for figuring out whether a problem is on the TikTok side or the Discord side.
// =============================================================================

import 'dotenv/config'; // load .env so TIKTOK_SESSIONID works here too
import { getLiveStatus, normalizeUsername } from './tiktok.js';

// process.argv is the list of words on the command line:
// [0] = path to node, [1] = path to this script, [2] = the first thing you typed.
const username = normalizeUsername(process.argv[2]);
if (!username) {
  console.error('Usage: npm run check -- <tiktok username>');
  process.exit(1);
}

// "Top-level await" — allowed here because package.json sets "type": "module".
try {
  console.log(await getLiveStatus(username)); // prints the whole result object
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
