// rnf-paths — every machine-specific location the RNF pipeline touches, in one place.
// Defaults assume this repo layout (app/, footage/, assets/). Override any of them with env
// vars (see config/rnf.env.example). Nothing here holds a secret; keys come from env only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.RNF_HOME || path.resolve(WEB, '..', '..');
export const SFX = process.env.RNF_SFX_DIR || path.join(REPO, 'assets', 'sfx-pack');           // Riser, Cash Register, bg-music/
export const SEED_ROOT = process.env.RNF_ASSETS_DIR || path.join(REPO, 'assets', 'game-assets'); // <slug>/{gameplay,broll/posters,broll/screenshots}
export const STEAM_EXTRACT = path.join(REPO, 'footage', 'rnf-footage', 'steam-extract.js');
export const SECRETS = process.env.RNF_SECRETS_DIR || path.join(REPO, '.secrets');               // gitignored: gemini.env, yt-cookies*.txt
export const GEMINI_ENV = process.env.RNF_GEMINI_ENV || path.join(SECRETS, 'gemini.env');
export const YTDLP = process.env.YTDLP || 'yt-dlp';
export const ARCHIVE = process.env.RNF_ARCHIVE_DIR || path.join(REPO, 'archive');
// rclone remote:folder for delivery. Empty string = skip upload, keep final.mp4 locally.
export const DRIVE_DEST = process.env.RNF_DRIVE_DEST ?? '';
