"""
Analyses a layer recording made by tools/scripts/audio-layers.mjs.

  python tools/audio/analyze.py <folder> [--png]
  python tools/audio/analyze.py <before> --compare <after> --layer rainPatter [--part menu] [--out file.png]

Prints (and writes to <folder>/report.txt):
  1. level of every layer in every part of the session (RMS, dBFS; "." = silent),
  2. per layer: peak, DC offset, samples at full scale, the strongest narrow spectral peaks (a steady tone
     stands out of the smoothed spectrum), how many short clicks per second it has and how "pitched" they are
     (share of a click's energy in its strongest 200 Hz band: a sine ping is near 1, a noise tick near 0.1),
     and whether the layer repeats (autocorrelation of its loudness curve),
  3. with --png: spectrograms <folder>/<layer>.png (6 s of the menu above 6 s of cruising, 0-12 kHz).
--compare prints the click / tone numbers of one layer in both recordings and writes one picture with the
spectrogram and the waveform of each (before above after).
"""
import json
import os
import sys
import struct
import wave
import zlib

import numpy as np

SILENT = -75.0


def load(path):
    with wave.open(path, 'rb') as w:
        n, ch, sr = w.getnframes(), w.getnchannels(), w.getframerate()
        x = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float32) / 32768.0
    return (x.reshape(-1, ch) if ch > 1 else x.reshape(-1, 1)), sr


def db(v):
    return 20 * np.log10(max(v, 1e-9))


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


def psd(x, sr, n=8192):
    """Averaged power spectrum (Hann, half overlap)."""
    if len(x) < n:
        return None, None
    win = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    k = 0
    for s in range(0, len(x) - n + 1, n // 2):
        acc += np.abs(np.fft.rfft(x[s:s + n] * win)) ** 2
        k += 1
    return np.fft.rfftfreq(n, 1 / sr), acc / max(k, 1)


def tonal_peaks(x, sr, top=3, fmax=16000.0):
    """Narrow peaks that stand out of the spectrum smoothed over a third of an octave: (Hz, dB above it)."""
    f, p = psd(x, sr)
    if f is None:
        return []
    pdb = 10 * np.log10(p + 1e-20)
    out = []
    lo = np.searchsorted(f, 40.0)
    hi = np.searchsorted(f, fmax)
    # smoothed reference: median in a band of +-1/6 octave
    ref = np.empty_like(pdb)
    for i in range(lo, hi):
        a = np.searchsorted(f, f[i] / 1.122)
        b = max(np.searchsorted(f, f[i] * 1.122), a + 3)
        ref[i] = np.median(pdb[a:b])
    prom = pdb[lo:hi] - ref[lo:hi]
    idx = np.argsort(prom)[::-1]
    used = []
    for i in idx:
        fi = f[lo + i]
        if any(abs(fi - u) < max(30.0, 0.03 * u) for u in used):
            continue
        used.append(fi)
        out.append((float(fi), float(prom[i])))
        if len(out) >= top:
            break
    return out


def clicks(x, sr):
    """Short events: (per second, median pitchedness, median centre frequency in Hz)."""
    if rms(x) < 10 ** (SILENT / 20):
        return 0.0, 0.0, 0.0
    hop = int(sr * 0.001)
    n = len(x) // hop
    e = np.sqrt(np.mean(np.square(x[:n * hop].reshape(n, hop), dtype=np.float64), axis=1))
    k = 40
    pad = np.pad(e, (k, k), mode='edge')
    base = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(n)])
    thr = np.maximum(base * 3.0, 10 ** (-66 / 20))
    peaks = [i for i in range(1, n - 1) if e[i] > thr[i] and e[i] >= e[i - 1] and e[i] > e[i + 1]]
    w = int(sr * 0.006)
    win = np.hanning(w)
    pitched, centre = [], []
    for i in peaks[:4000]:
        s = max(0, i * hop - w // 4)
        seg = x[s:s + w]
        if len(seg) < w:
            continue
        sp = np.abs(np.fft.rfft(seg * win)) ** 2
        fr = np.fft.rfftfreq(w, 1 / sr)
        tot = sp.sum() + 1e-20
        j = int(np.argmax(sp))
        band = (fr > fr[j] - 100) & (fr < fr[j] + 100)
        pitched.append(sp[band].sum() / tot)
        centre.append(fr[j])
    dur = len(x) / sr
    return len(peaks) / dur, float(np.median(pitched)) if pitched else 0.0, float(np.median(centre)) if centre else 0.0


def repeats(x, sr):
    """Does the loudness curve repeat? (lag in s, correlation) of the best lag between 1.5 and 15 s; the slow
    trend (louder / quieter over seconds) is taken out first, so only the pattern of the events counts."""
    hop = int(sr * 0.01)
    n = len(x) // hop
    if n < 3200:
        return 0.0, 0.0
    e = np.sqrt(np.mean(np.square(x[:n * hop].reshape(n, hop), dtype=np.float64), axis=1))
    k = 50
    c = np.cumsum(np.pad(e, (k, k), mode='edge'))
    e = e - (c[2 * k:] - c[:-2 * k]) / (2 * k)
    if np.std(e) < 1e-7:
        return 0.0, 0.0
    best = (0.0, 0.0)
    for lag in range(150, min(1500, n // 2)):
        a, b = e[:-lag], e[lag:]
        r = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-20))
        if r > best[1]:
            best = (lag * 0.01, r)
    return best


def write_png(path, img):
    """img: uint8 array (h, w, 3)."""
    h, w, _ = img.shape
    raw = b''.join(b'\x00' + img[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def spectrogram(x, sr, width=900, height=260, fmax=12000.0, lo=-110.0, hi=-40.0):
    """Picture of |STFT| in dB: time left to right, 0..fmax bottom to top; black = lo dB, bright = hi dB."""
    n = 2048
    hop = max(1, (len(x) - n) // width)
    win = np.hanning(n)
    cols = []
    for i in range(width):
        seg = x[i * hop:i * hop + n]
        if len(seg) < n:
            seg = np.pad(seg, (0, n - len(seg)))
        cols.append(20 * np.log10(np.abs(np.fft.rfft(seg * win)) / (n / 4) + 1e-12))
    S = np.array(cols).T
    kmax = int(fmax / (sr / n))
    rows = np.linspace(0, kmax - 1, height).astype(int)
    v = np.clip((S[rows][::-1] - lo) / (hi - lo), 0, 1)
    img = np.stack([np.clip(v * 2.2, 0, 1), np.clip(v * 2.2 - 0.6, 0, 1), np.clip(v * 3 - 2, 0, 1) + 0.25 * (1 - v) * v], axis=2)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def waveform(x, width=900, height=120, full=1.0):
    """Min / max per column; the frame is +-full."""
    img = np.full((height, width, 3), 16, np.uint8)
    step = max(1, len(x) // width)
    for i in range(width):
        seg = x[i * step:(i + 1) * step]
        if not len(seg):
            continue
        a = int((1 - min(1, seg.max() / full)) * (height - 1) / 2)
        b = int((1 - max(-1, seg.min() / full)) * (height - 1) / 2)
        img[a:b + 1, i] = (120, 220, 255)
    img[height // 2] = np.maximum(img[height // 2], 70)
    return img


def part_of(folder, layer, part, seconds):
    meta = json.load(open(os.path.join(folder, 'marks.json'), encoding='utf-8'))
    x, sr = load(os.path.join(folder, layer + '.wav'))
    t = {m['name']: m['t'] for m in meta['marks']}
    a = int((t[part] + 0.4) * sr)
    return x.mean(axis=1)[a:a + int(seconds * sr)], sr


def compare(before, after, layer, part, out_path):
    rows = []
    full = 0.0
    segs = []
    for folder in (before, after):
        x, sr = part_of(folder, layer, part, 6.0)
        segs.append((x, sr))
        full = max(full, float(np.max(np.abs(x))))
    for (x, sr), tag in zip(segs, ('before', 'after')):
        cps, pit, cf = clicks(x, sr)
        tp = tonal_peaks(x, sr)
        r = rms(x)
        pk = float(np.max(np.abs(x)))
        f, p = psd(x, sr)
        share = 100 * p[(f >= 2000) & (f < 6000)].sum() / p.sum()
        print(f'{layer} in "{part}", {tag}: RMS {db(r):.1f} dBFS, peak {db(pk):.1f} dBFS (crest {db(pk) - db(r):.1f} dB), clicks {cps:.0f}/s, '
              f'pitched {pit:.2f}, around {cf:.0f} Hz, energy 2-6 kHz {share:.0f} %, strongest tones ' + ', '.join(f'{a:.0f} Hz +{b:.0f} dB' for a, b in tp))
        rows += [spectrogram(x, sr), waveform(x, full=full * 1.05)]
    gap = np.full((6, rows[0].shape[1], 3), 255, np.uint8)
    write_png(out_path, np.concatenate([rows[0], rows[1], gap, rows[2], rows[3]], axis=0))
    print('picture (before above after; spectrogram 0-12 kHz, then waveform on a common scale):', out_path)


def main():
    folder = sys.argv[1]
    png = '--png' in sys.argv
    arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    if '--compare' in sys.argv:
        layer = arg('--layer', 'rainPatter')
        compare(folder, arg('--compare'), layer, arg('--part', 'menu'), arg('--out', os.path.join(arg('--compare'), f'compare-{layer}.png')))
        return
    meta = json.load(open(os.path.join(folder, 'marks.json'), encoding='utf-8'))
    marks = meta['marks']
    names = [f[:-4] for f in sorted(os.listdir(folder)) if f.endswith('.wav')]
    order = ['master', 'engine', 'road', 'ambience', 'sfx', 'ui', 'rainShower', 'rainPatter', 'spray', 'rumble', 'wind', 'skid', 'brake', 'scrape', 'nitro']
    names = [n for n in order if n in names] + [n for n in names if n not in order]
    segs = [(marks[i]['name'], marks[i]['t'], marks[i + 1]['t']) for i in range(len(marks) - 1)]
    lines = []
    out = lines.append
    out('LEVEL (RMS dBFS) per part of the session')
    out('layer        ' + ' '.join(f'{s[0][:7]:>7}' for s in segs))
    data = {}
    for name in names:
        x, sr = load(os.path.join(folder, name + '.wav'))
        data[name] = (x, sr)
        row = []
        for _, a, b in segs:
            seg = x[int(a * sr):int(b * sr)]
            v = db(rms(seg))
            row.append('      .' if v < SILENT else f'{v:7.1f}')
        out(f'{name:<12} ' + ' '.join(row))
    out('')
    out('PER LAYER (whole recording unless a part is named)')
    for name in names:
        x, sr = data[name]
        m = x.mean(axis=1)
        end = int(marks[-1]['t'] * sr)
        m = m[:end]
        peak = float(np.max(np.abs(x[:end]))) if end else 0.0
        st = meta['stats'].get(name, {})
        if rms(m) < 10 ** (SILENT / 20):
            out(f'{name:<12} silent')
            continue
        # the loudest part of this layer is the one to look at for tones and clicks
        best = max(segs, key=lambda s: rms(m[int(s[1] * sr):int(s[2] * sr)]))
        part = m[int(best[1] * sr):int(best[2] * sr)]
        tp = tonal_peaks(part, sr)
        cps, pit, cf = clicks(part, sr)
        lag, corr = repeats(m, sr)
        out(f'{name:<12} peak {db(peak):6.1f} dBFS (float peak {st.get("floatPeak", 0):.3f}, at full scale {st.get("samplesAtFullScale", 0)}), '
            f'DC {m.mean():+.5f}; in "{best[0]}": tones ' + ', '.join(f'{f:.0f} Hz +{p:.0f} dB' for f, p in tp)
            + f'; clicks {cps:.0f}/s, pitched {pit:.2f}, around {cf:.0f} Hz; repeats every {lag:.2f} s (r={corr:.2f})')
        if name == 'master' and x.shape[1] == 2:
            L, R = x[:end, 0].astype(np.float64), x[:end, 1].astype(np.float64)
            c = float(np.dot(L, R) / (np.linalg.norm(L) * np.linalg.norm(R) + 1e-20))
            out(f'{"":<12} left/right correlation {c:+.2f}')
    text = '\n'.join(lines)
    print(text)
    with open(os.path.join(folder, 'report.txt'), 'w', encoding='utf-8') as f:
        f.write(text + '\n')
    if png:
        t = {m['name']: m['t'] for m in marks}
        for name in names:
            x, sr = data[name]
            m = x.mean(axis=1)
            if rms(m) < 10 ** (SILENT / 20):
                continue
            rows = []
            for key in ('menu', 'cruise'):
                a0 = int((t.get(key, 0) + 0.4) * sr)
                rows.append(spectrogram(m[a0:a0 + 6 * sr], sr))
            write_png(os.path.join(folder, name + '.png'), np.concatenate([rows[0], np.full((6, rows[0].shape[1], 3), 255, np.uint8), rows[1]], axis=0))


main()
