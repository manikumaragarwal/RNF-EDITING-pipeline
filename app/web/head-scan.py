#!/usr/bin/env python3
"""head-scan.py <video> -> prints JSON {"top":int,"chin":int,"n":int} (1920px units) or null.
Head top = first strong HORIZONTAL edge (plain wall -> hair) scanning down the central band, per frame,
then a high-end percentile across frames. Vertical wall corners / furniture edges don't trigger it
(only vertical gradients count), and wall/hair colour doesn't matter."""
import sys, json, subprocess
import numpy as np
W, H = 216, 384
def frames(video):
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', video, '-vf', f'fps=3,scale={W}:{H}:flags=area,format=gray', '-f', 'rawvideo', '-'], capture_output=True)
    buf = np.frombuffer(r.stdout, dtype=np.uint8); n = len(buf) // (W * H)
    return buf[:n * W * H].reshape(n, H, W).astype(np.float32)
x0, x1 = int(W * .30), int(W * .70)
def top_row(g):
    d = np.abs(g[3:, x0:x1] - g[:-3, x0:x1])         # vertical gradient over 3 rows
    strong = (d > 28).sum(1)                          # columns with a strong horizontal edge, per row
    need = max(6, int((x1 - x0) * 0.22))
    ok = strong >= need
    for r in range(int(H * 0.10), int(H * 0.70)):
        if ok[r:r + 2].all(): return r + 3
    return None
tops = [t for t in (top_row(g) for g in frames(sys.argv[1])) if t is not None]
if len(tops) < 5: print(json.dumps(None)); sys.exit(0)
top = float(np.percentile(np.array(tops) * (1920 / H), 20))
print(json.dumps({"top": int(round(top)), "chin": int(round(top + 470)), "n": len(tops)}))
