'use strict';

/**
 * chrome.js — shared headless-Chrome launcher (puppeteer-core + system Chrome).
 * Mirrors findChrome() from .claude/scripts/carousel-to-png.js.
 */

const fs = require('fs');
const puppeteer = require('puppeteer-core');

function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  throw new Error('Chrome not found. Set CHROME_PATH.');
}

async function launch() {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
    ],
  });
}

module.exports = { findChrome, launch };
