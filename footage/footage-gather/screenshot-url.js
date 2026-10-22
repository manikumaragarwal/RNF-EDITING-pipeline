#!/usr/bin/env node
'use strict';

/**
 * screenshot-url.js — screenshot any remote URL to PNG with puppeteer-core +
 * system Chrome. Handles cookie/consent banners, lazy-loaded images (autoscroll),
 * and caps very tall/infinite pages so captures don't explode.
 *
 *   node screenshot-url.js <url> <out-prefix> [--mode both|hero|full] [--width 1440]
 *
 * Produces <out-prefix>-hero.png (above the fold) and/or <out-prefix>-full.png.
 * Exported as screenshotUrl(url, outPrefix, {browser, mode, width, maxHeight}).
 */

const path = require('path');
const { launch } = require('./lib/chrome');
const { ensureDir } = require('./lib/util');

const CONSENT_RE =
  /^(accept all|accept|i agree|agree|got it|allow all|allow cookies|ok, got it|accept cookies|continue)$/i;

async function dismissConsent(page) {
  try {
    await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const nodes = [...document.querySelectorAll('button, [role="button"], a, div')];
      for (const n of nodes) {
        const t = (n.innerText || n.textContent || '').trim();
        if (t && t.length < 30 && re.test(t)) {
          n.click();
          return;
        }
      }
    }, CONSENT_RE.source);
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    /* best effort */
  }
}

async function autoScroll(page, maxHeight) {
  await page.evaluate(async (cap) => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight || total >= cap) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  }, maxHeight);
  await new Promise((r) => setTimeout(r, 800));
}

async function screenshotUrl(url, outPrefix, opts = {}) {
  const mode = opts.mode || 'both';
  const width = opts.width || 1440;
  const maxHeight = opts.maxHeight || 6000;

  const browser = opts.browser || (await launch());
  const ownsBrowser = !opts.browser;
  const out = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch {
      // proceed with whatever rendered
    }
    await dismissConsent(page);
    await new Promise((r) => setTimeout(r, 600));

    ensureDir(path.dirname(outPrefix));

    if (mode === 'hero' || mode === 'both') {
      const heroPath = `${outPrefix}-hero.png`;
      await page.screenshot({ path: heroPath, type: 'png' }); // viewport only
      out.push(heroPath);
    }

    if (mode === 'full' || mode === 'both') {
      await autoScroll(page, maxHeight);
      const fullPath = `${outPrefix}-full.png`;
      const docHeight = await page.evaluate(
        () => document.documentElement.scrollHeight
      );
      if (docHeight > maxHeight) {
        // clip instead of fullPage to avoid enormous/failed captures
        await page.screenshot({
          path: fullPath,
          type: 'png',
          clip: { x: 0, y: 0, width, height: maxHeight },
        });
      } else {
        await page.screenshot({ path: fullPath, type: 'png', fullPage: true });
      }
      out.push(fullPath);
    }

    await page.close();
    return out;
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

module.exports = { screenshotUrl };

if (require.main === module) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const url = positional[0];
  const prefix = positional[1] || 'shot';
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'both';
  const width = args.includes('--width') ? parseInt(args[args.indexOf('--width') + 1], 10) : 1440;
  if (!url) {
    console.error('Usage: screenshot-url.js <url> <out-prefix> [--mode both|hero|full] [--width N]');
    process.exit(1);
  }
  screenshotUrl(url, path.resolve(prefix), { mode, width })
    .then((files) => console.log(JSON.stringify({ success: true, files }, null, 2)))
    .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
