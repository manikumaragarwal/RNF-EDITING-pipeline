#!/usr/bin/env python3
# motion-scan.py <clip> <windowLen> — find the start time of a <windowLen>s section of the
# clip that is CONTINUOUSLY MOVING (no static title-card / frozen sub-part). Prints the start
# seconds to stdout. Used so b-roll never "stops moving" mid-window.
import sys, subprocess, numpy as np

def main():
    clip = sys.argv[1]
    win = float(sys.argv[2])
    # optional zone bounds (seconds): restrict the search to [zoneStart, zoneEnd] so different
    # b-roll segments can be forced to DIFFERENT parts of the clip (creates cuts).
    zoneStart = float(sys.argv[3]) if len(sys.argv) > 3 else None
    zoneEnd = float(sys.argv[4]) if len(sys.argv) > 4 else None
    W, H, FPS = 64, 36, 5
    # probe duration
    try:
        dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',clip],
                                    capture_output=True, text=True).stdout.strip())
    except Exception:
        print("0"); return
    if dur <= win + 0.5:
        print("0"); return
    # pull downscaled grayscale frames as raw bytes
    p = subprocess.run(['ffmpeg','-v','error','-i',clip,'-vf',f'fps={FPS},scale={W}:{H},format=gray',
                        '-f','rawvideo','-'], capture_output=True)
    buf = np.frombuffer(p.stdout, dtype=np.uint8)
    n = buf.size // (W*H)
    if n < FPS*2:
        print("0"); return
    frames = buf[:n*W*H].reshape(n, H*W).astype(np.int16)
    # per-frame motion = mean abs diff from previous frame
    mot = np.zeros(n)
    mot[1:] = np.abs(frames[1:] - frames[:-1]).mean(axis=1)
    # bin per 0.5s
    binf = max(1, FPS//2)
    nb = n // binf
    bins = mot[:nb*binf].reshape(nb, binf).mean(axis=1)  # motion per 0.5s
    bin_dt = binf / FPS
    wbins = max(1, int(round(win / bin_dt)))
    if wbins >= nb:
        print("0"); return
    best_start, best_score = 0.0, -1
    lo = 0 if zoneStart is None else max(0, int(zoneStart / bin_dt))
    hi = (nb - wbins) if zoneEnd is None else min(nb - wbins, int((zoneEnd - win) / bin_dt))
    if hi <= lo:
        lo, hi = 0, max(1, nb - wbins)  # zone too small -> fall back to whole clip
    for i in range(lo, hi):
        seg = bins[i:i+wbins]
        # score rewards a HIGH MINIMUM (no static sub-part) + decent average
        score = seg.min() * 2.0 + seg.mean()
        t = i * bin_dt
        if t < 2.0 and zoneStart is None:  # mild penalty for the very start (title cards)
            score *= 0.6
        if score > best_score:
            best_score, best_start = score, t
    # clamp so start+win stays inside the clip
    best_start = max(0.0, min(best_start, dur - win - 0.2))
    print(f"{best_start:.2f}")

if __name__ == '__main__':
    try: main()
    except Exception: print("0")
