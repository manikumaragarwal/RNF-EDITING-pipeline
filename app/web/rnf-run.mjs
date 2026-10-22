// Detached runner for the rnf auto-editor. Invoked by server.mjs as:
//   setsid nohup node rnf-run.mjs <prepare|finalize> <projectId> [placements.json] &
// so long renders survive session/shell teardown. Writes progress to the project's
// status.json (the UI polls it). Never blocks the HTTP server process.
import fs from 'node:fs';
import { prepare, finalize, addPosterToFinal, projDir, setStatus } from './rnf-auto.mjs';

const [, , cmd, id, placementsFile] = process.argv;
(async () => {
  try {
    if (cmd === 'prepare') await prepare(id);
    else if (cmd === 'finalize') {
      let placements = null;
      if (placementsFile && fs.existsSync(placementsFile)) { try { placements = JSON.parse(fs.readFileSync(placementsFile, 'utf8')); } catch {} }
      const fr = await finalize(id, placements);
      if (fr && fr.qcHold) process.stdout.write('HELD by QC: ' + fr.qcHold.join(', ') + ' — not delivered\n');
    } else if (cmd === 'poster') {
      const r = await addPosterToFinal(id);
      if (r && r.qcHold) process.stdout.write('HELD by QC: ' + r.qcHold.join(', ') + ' — not delivered\n');
      else if (r && r.uploadError) process.stdout.write('poster added but Drive upload FAILED: ' + r.uploadError + '\n');
      else process.stdout.write('poster added: ' + (r.driveLink || '(no link)') + '\n');
    }
    else throw new Error('unknown cmd ' + cmd);
    process.exit(0);
  } catch (e) {
    try { setStatus(id, { stage: 'error', done: true, error: String(e.message || e).slice(0, 400) }); } catch {}
    process.stderr.write('rnf-run ' + cmd + ' failed: ' + String(e && e.stack || e) + '\n');
    process.exit(1);
  }
})();
