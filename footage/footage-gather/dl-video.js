#!/usr/bin/env node
'use strict';

/**
 * dl-video.js — download a related video to an mp4 file.
 *  - YouTube / Vimeo / generic  -> yt-dlp (best mp4, no playlist, size-capped)
 *  - X / Twitter                 -> syndication highest-bitrate mp4 (yt-dlp's X
 *                                   extractor is unreliable here)
 *
 *   node dl-video.js <url> <out-dir> [--max 300]   # --max = max MB (yt-dlp path)
 *
 * Exported as downloadVideo(url, outDir, {maxMB}) -> { file, source, title, kind }.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fetchTweet } = require('./fetch-tweet');
const { download, ensureDir, slugify, tweetIdFromUrl } = require('./lib/util');

// Prefer a self-managed nightly yt-dlp (.claude/bin/yt-dlp) — current YouTube outpaces
// the stable /usr/local build, and only nightly extracts formats. Env override wins.
const YT_DLP = (function () {
  const cands = [
    process.env.YT_DLP_BIN,
    path.join(__dirname, '..', '..', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* skip */ } }
  return 'yt-dlp';
})();
const NODE_BIN = process.execPath || '/usr/bin/node';
// Optional YouTube cookies (datacenter IPs get bot-checked without them).
const COOKIE_CANDIDATES = [
  process.env.YT_COOKIES_FILE,
  require('path').join(process.env.RNF_SECRETS_DIR || require('path').join(__dirname, '..', '..', '.secrets'), 'yt-cookies.txt'),
].filter(Boolean);

function cookieFile() {
  for (const c of COOKIE_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

function isTwitter(url) {
  return /(^|\/\/)(www\.)?(x\.com|twitter\.com)\//.test(url) || /twitter\.com|x\.com/.test(url);
}

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 400)));
      resolve({ stdout, stderr });
    });
  });
}

async function downloadTwitterVideo(url, outDir) {
  const tweet = await fetchTweet(url);
  const vid = tweet.media.find((m) => m.kind === 'video');
  if (!vid) throw new Error('no video found in tweet');
  ensureDir(outDir);
  const name = `tweet-${tweet.id}-${slugify(tweet.author.handle.replace('@', ''), 20)}.mp4`;
  const dest = path.join(outDir, name);
  await download(vid.url, dest);
  return { file: dest, source: tweet.url, title: tweet.text.slice(0, 80), kind: 'tweet-video' };
}

async function downloadYtDlp(url, outDir, maxMB) {
  ensureDir(outDir);
  const template = path.join(outDir, '%(uploader,uploader_id)s-%(id)s.%(ext)s');
  const args = [
    '--js-runtimes', `node:${NODE_BIN}`, // YT now needs a JS runtime for extraction
    '--remote-components', 'ejs:github', // + the EJS solver for YT's n-sig JS challenge
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
    '--no-playlist',
    '--restrict-filenames',
    '--no-progress',
    '--merge-output-format', 'mp4',
    '-o', template,
    '--print', 'after_move:filepath',
  ];
  const cookies = cookieFile();
  if (cookies) args.push('--cookies', cookies);
  if (maxMB) args.push('--max-filesize', `${maxMB}M`);
  args.push(url);

  let stdout;
  try {
    ({ stdout } = await run(YT_DLP, args, 900000)); // up to 15 min for large videos
  } catch (e) {
    if (/Sign in to confirm|not a bot|cookies/i.test(e.message) && !cookies) {
      throw new Error(
        'YouTube blocked this server (bot-check on the VPS IP). Drop a Netscape ' +
          'cookies.txt at .secrets/yt-cookies.txt (or set YT_COOKIES_FILE) and retry. ' +
          'Tweet-hosted videos work without cookies.'
      );
    }
    throw e;
  }
  const printed = stdout.trim().split('\n').filter(Boolean).pop();
  let file = printed && fs.existsSync(printed) ? printed : null;
  if (!file) {
    // fallback: newest mp4 in outDir
    const mp4s = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(outDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    file = mp4s[0] || null;
  }
  if (!file) throw new Error('yt-dlp produced no mp4 (possibly filtered by --max-filesize)');
  return { file, source: url, title: path.basename(file), kind: 'video' };
}

async function downloadVideo(url, outDir, opts = {}) {
  if (isTwitter(url) && tweetIdFromUrl(url)) return downloadTwitterVideo(url, outDir);
  return downloadYtDlp(url, outDir, opts.maxMB || 300);
}

module.exports = { downloadVideo };

if (require.main === module) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const url = positional[0];
  const outDir = positional[1] || '.';
  const maxMB = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1], 10) : 300;
  if (!url) {
    console.error('Usage: dl-video.js <url> <out-dir> [--max MB]');
    process.exit(1);
  }
  downloadVideo(url, path.resolve(outDir), { maxMB })
    .then((r) => console.log(JSON.stringify({ success: true, ...r }, null, 2)))
    .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
