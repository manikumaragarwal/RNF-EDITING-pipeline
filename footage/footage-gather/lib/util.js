'use strict';

/**
 * util.js — shared helpers for the footage-gather pipeline.
 * Plain node built-ins only (https/http/fs). No external deps.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** GET a URL, following redirects, resolving to { status, body, headers }. */
function httpGet(url, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      const lib = u.startsWith('http://') ? http : https;
      const req = lib.get(
        u,
        { headers: { 'User-Agent': UA, Accept: '*/*', ...headers } },
        (res) => {
          const { statusCode, headers: h } = res;
          if (statusCode >= 300 && statusCode < 400 && h.location && left > 0) {
            res.resume();
            const next = new URL(h.location, u).toString();
            return go(next, left - 1);
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: statusCode, body: Buffer.concat(chunks), headers: h })
          );
        }
      );
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error(`timeout: ${u}`)));
    };
    go(url, maxRedirects);
  });
}

/** GET JSON. Returns parsed object or throws with context. */
async function httpGetJson(url, opts) {
  const r = await httpGet(url, opts);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = r.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${text.slice(0, 120)}...) for ${url}`);
  }
}

/** Download a URL to a local file, following redirects. Resolves to dest path. */
async function download(url, dest, { headers = {} } = {}) {
  const r = await httpGet(url, { headers });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} downloading ${url}`);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, r.body);
  return dest;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** filesystem-safe slug */
function slugify(s, max = 60) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'item';
}

/** extract a numeric tweet id from a status URL or a bare id */
function tweetIdFromUrl(input) {
  const s = String(input).trim();
  if (/^\d{1,25}$/.test(s)) return s;
  const m = s.match(/status(?:es)?\/(\d{1,25})/);
  return m ? m[1] : null;
}

/** best mp4 extension guess from a url */
function extFromUrl(url, fallback = 'bin') {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : fallback;
}

module.exports = {
  UA,
  httpGet,
  httpGetJson,
  download,
  ensureDir,
  slugify,
  tweetIdFromUrl,
  extFromUrl,
};
