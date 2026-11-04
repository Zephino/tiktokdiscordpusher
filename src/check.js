// Quick test without Discord:  npm run check -- <tiktok username>
import 'dotenv/config';
import { getLiveStatus, normalizeUsername } from './tiktok.js';

const username = normalizeUsername(process.argv[2]);
if (!username) {
  console.error('Usage: npm run check -- <tiktok username>');
  process.exit(1);
}
try {
  console.log(await getLiveStatus(username));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
