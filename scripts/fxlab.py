#!/usr/bin/env python3
"""Compare Move's Drum Sampler against LiveChopper's plugin.c (docs/PLAN.md,
step 4). Run with build/.venv/bin/python (scripts/setup_analysis_env.sh).

    fxlab.py split   <take.wav> <Song.abl> <outdir>
    fxlab.py render  <outdir>
    fxlab.py compare <outdir> [--gain G]
    fxlab.py all     <take.wav> <Song.abl> <outdir> [--gain G]

split cuts a take recorded with Schwung's Quantized Sampler (Move->Schwung
on) into one piece per pad, in pad order, and saves each pad's Drum Sampler
settings from the Set. render plays the same test sound with the same
settings through plugin.c (scripts/fx_render.c). compare measures both the
same way and writes plots and a summary.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import urllib.parse

import numpy as np
from scipy.io import wavfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAVS = os.path.join(REPO, "build", "test_wavs")
RENDER = os.path.join(REPO, "build", "fx_render")
RATE = 44100
DEFAULT_GAIN = 0.8465       # Set 28's dry path (PLAN "Move's dry path")
ONSET_LEVEL = 200           # |sample| that starts a piece
ONSET_GAP_S = 0.25          # ... after at least this much quieter signal
EDGE = 2000                 # frames left out at each end of the residual

# Move's Effect_Type and field order (src/drum_rack.mjs EFFECTS), with the
# effects that are neutral at some setting: (field, neutral value).
EFFECTS = [
    ("Stretch", "Effect_StretchFactor", "Effect_StretchGrainSize", ("Effect_StretchFactor", 1.0)),
    ("Loop", "Effect_LoopOffset", "Effect_LoopLength", None),
    ("Pitch Env", "Effect_PitchEnvelopeAmount", "Effect_PitchEnvelopeDecay", ("Effect_PitchEnvelopeAmount", 0.0)),
    ("Punch", "Effect_PunchAmount", "Effect_PunchTime", ("Effect_PunchAmount", 0.0)),
    ("8-bit", "Effect_EightBitResamplingRate", "Effect_EightBitFilterDecay", None),
    ("FM", "Effect_FmAmount", "Effect_FmFrequency", ("Effect_FmAmount", 0.0)),
    ("Ring Mod", "Effect_RingModAmount", "Effect_RingModFrequency", ("Effect_RingModAmount", 0.0)),
    ("Sub Osc", "Effect_SubOscAmount", "Effect_SubOscFrequency", ("Effect_SubOscAmount", 0.0)),
    ("Noise", "Effect_NoiseAmount", "Effect_NoiseFrequency", ("Effect_NoiseAmount", 0.0)),
]
FILTER_TYPES = ["Lowpass 12dB", "Lowpass", "Highpass", "Peak"]   # src/drum_rack.mjs


def read_mono(path):
    r, v = wavfile.read(path)
    if r != RATE:
        sys.exit("%s: %d Hz, expected %d" % (path, r, RATE))
    v = v.astype(float)
    return v[:, 0] if v.ndim > 1 else v


def write_mono(path, v):
    wavfile.write(path, RATE, np.clip(np.round(v), -32768, 32767).astype(np.int16))


# ---------------------------------------------------------------- split

def drum_pads(song):
    """Each Drum Rack pad that has a sample: (note, sample file, params)."""
    pads = []

    def walk(devices):
        for d in devices:
            if d.get("kind") == "drumRack":
                for c in d.get("chains", []):
                    cells = [x for x in c.get("devices", []) if x.get("kind") == "drumCell"]
                    note = c.get("drumZoneSettings", {}).get("receivingNote")
                    if not cells or note is None:
                        continue
                    uri = cells[0].get("deviceData", {}).get("sampleUri")
                    if not uri:
                        continue
                    params = {}
                    for k, v in cells[0].get("parameters", {}).items():
                        params[k] = v.get("value") if isinstance(v, dict) else v
                    name = urllib.parse.unquote(uri.rsplit("/", 1)[-1])
                    pads.append((note, name, params))
            for c in d.get("chains", []):
                walk(c.get("devices", []))

    for t in song.get("tracks", []):
        walk(t.get("devices", []))
    return sorted(pads, key=lambda p: p[0])


def onsets(v):
    loud = np.flatnonzero(np.abs(v) > ONSET_LEVEL)
    out, last = [], -10 ** 9
    for i in loud:
        if i - last > ONSET_GAP_S * RATE:
            out.append(int(i))
        last = i
    return out


def cmd_split(take, song_path, outdir):
    os.makedirs(outdir, exist_ok=True)
    v = read_mono(take)
    pads = drum_pads(json.load(open(song_path)))
    # Only test sounds can be rendered: other samples (a kit's leftovers)
    # aren't expected in the take.
    for note, name, _ in pads:
        if not os.path.exists(os.path.join(WAVS, name)):
            print("  skipping pad %d: %s isn't a test sound" % (note, name))
    pads = [pd for pd in pads if os.path.exists(os.path.join(WAVS, pd[1]))]
    ons = onsets(v)
    if len(ons) != len(pads):
        sys.exit("split: %d onsets (at %s s) but %d pads with samples (notes %s)" % (
            len(ons), [round(o / RATE, 2) for o in ons], len(pads), [p[0] for p in pads]))
    pieces = []
    for k, ((note, name, params), on) in enumerate(zip(pads, ons)):
        end = ons[k + 1] if k + 1 < len(ons) else len(v)
        start = max(0, on - 32)          # the attack ramp is under the threshold
        piece = v[start:end]
        src_path = os.path.join(WAVS, name)
        src = read_mono(src_path) if os.path.exists(src_path) else None
        # Trailing silence goes, but never into the length of the sound.
        loud = np.flatnonzero(np.abs(piece) > 2)
        keep = max(loud[-1] + 1 if len(loud) else len(piece), 0 if src is None else len(src) + 64)
        piece = piece[:min(keep, len(piece))]
        fname = "%02d_%s" % (k + 1, name)
        write_mono(os.path.join(outdir, fname), piece)
        if src is not None and np.count_nonzero(src[:int(0.02 * RATE)]) > 10:
            n = int(0.02 * RATE)
            a = src[:n]
            best = max(np.dot(a, piece[lag:lag + n]) / (np.linalg.norm(a) * np.linalg.norm(piece[lag:lag + n]) + 1e-9)
                       for lag in range(0, 64) if len(piece) >= lag + n)
            if best < 0.5:
                print("  warning: %s doesn't look like %s (correlation %.2f)" % (fname, name, best))
        elif src is None:
            print("  warning: no source %s in build/test_wavs" % name)
        for key in ("Voice_PlaybackStart", "Voice_PlaybackLength"):
            if key in params and abs(params[key] - (0.0 if key.endswith("Start") else 1.0)) > 1e-6:
                print("  warning: pad %d has %s = %s (render plays the whole file)" % (note, key, params[key]))
        pieces.append({"piece": fname, "note": note, "sample": name, "start": start,
                       "frames": len(piece), "params": params})
        print("%-22s note %d at %7.3f s, %.2f s, %s%s" % (
            fname, note, start / RATE, len(piece) / RATE, params.get("Effect_Type"),
            "" if params.get("Voice_PitchToEnvelopeModulation") is None
            else ", PitchToEnvelopeModulation %s" % params["Voice_PitchToEnvelopeModulation"]))
    json.dump({"take": os.path.abspath(take), "set": os.path.abspath(song_path), "pieces": pieces},
              open(os.path.join(outdir, "pads.json"), "w"), indent=1)


# ---------------------------------------------------------------- render

def effect_index(params):
    t = params.get("Effect_Type", "Stretch")
    for i, e in enumerate(EFFECTS):
        if e[0].lower() == str(t).lower():
            return i
    sys.exit("render: unknown Effect_Type %r" % t)


def db10(linear):
    return int(round(200 * math.log10(max(linear, 1e-6))))


def dsp_settings(p):
    """The pad's Drum Sampler settings as plugin.c params, in order."""
    s = []
    s.append("attack_us=%d" % round(p.get("Voice_Envelope_Attack", 0.0001) * 1e6))
    hold = p.get("Voice_Envelope_Hold", 60.0)
    s.append("hold_us=%d" % (-1 if hold >= 60.0 else round(hold * 1e6)))
    s.append("decay_us=%d" % round(p.get("Voice_Envelope_Decay", 0.05) * 1e6))
    s.append("gate=%d" % (1 if p.get("Voice_Envelope_Mode") == "A-S-R" else 0))
    s.append("transpose=%d" % p.get("Voice_Transpose", 0))
    s.append("detune=%d" % round(p.get("Voice_Detune", 0.0) * 100))
    s.append("gain_db10=%d" % db10(p.get("Voice_Gain", 1.0)))
    ftype = p.get("Voice_Filter_Type", "Lowpass")
    s.append("filter_type=%d" % (FILTER_TYPES.index(ftype) if ftype in FILTER_TYPES else 1))
    s.append("filter_hz10=%d" % round(p.get("Voice_Filter_Frequency", 22000.0) * 10))
    s.append("filter_res=%d" % round(p.get("Voice_Filter_Resonance", 0.0) * 1000))
    s.append("filter_peak_db10=%d" % db10(p.get("Voice_Filter_PeakGain", 1.0)))
    i = effect_index(p)
    name, fa, fb, _ = EFFECTS[i]
    s.append("effect=%d" % i)
    s.append("fx=%.9g %.9g" % (p.get(fa, 0.0), p.get(fb, 0.0)))
    if name == "8-bit":
        s.append("crush_hz=%d" % round(p.get(fa, 14080.0)))
        s.append("crush_decay=%.9g" % p.get(fb, 5.0))
    else:
        s.append("crush_hz=0")
    return s


def build_render():
    src = [os.path.join(REPO, "scripts", "fx_render.c"), os.path.join(REPO, "src", "dsp", "plugin.c")]
    if os.path.exists(RENDER) and all(os.path.getmtime(RENDER) >= os.path.getmtime(f) for f in src):
        return
    subprocess.check_call(["gcc", "-std=c11", "-O2", "-I" + os.path.join(REPO, "src", "dsp"), src[0],
                           "-o", RENDER, "-lm", "-lpthread"])


def cmd_render(outdir):
    build_render()
    meta = json.load(open(os.path.join(outdir, "pads.json")))
    for pc in meta["pieces"]:
        p = pc["params"]
        if p.get("Voice_Envelope_Mode") == "A-S-R":
            print("  warning: %s is gated; the release time isn't in the take, so ours never releases" % pc["piece"])
        settings = dsp_settings(p)
        out = os.path.join(outdir, "ours_" + pc["piece"])
        subprocess.check_call([RENDER, os.path.join(WAVS, pc["sample"]), out,
                               "%.6f" % (pc["frames"] / RATE)] + settings)
        if gain_effect(p):
            # The same pad with no effect: what the gain curve divides by.
            dry = [x for x in settings if not x.startswith(("effect=", "fx="))] + ["effect=0", "fx=1 0.1"]
            subprocess.check_call([RENDER, os.path.join(WAVS, pc["sample"]),
                                   os.path.join(outdir, "dry_" + pc["piece"]), "%.6f" % (pc["frames"] / RATE)] + dry)
        pc["settings"] = settings
        print("%-22s %s" % (pc["piece"], " ".join(settings[-3:])))
    json.dump(meta, open(os.path.join(outdir, "pads.json"), "w"), indent=1)


# ---------------------------------------------------------------- compare

def neutral(p):
    rule = EFFECTS[effect_index(p)][3]
    return rule is not None and abs(p.get(rule[0], -1) - rule[1]) < 1e-6


def plain(p):
    """Dry all through: no effect, a low-pass fully open, no gain or
    transpose. Only these set the level reference."""
    return (neutral(p) and p.get("Voice_Filter_Type", "Lowpass") in ("Lowpass", "Lowpass 12dB")
            and p.get("Voice_Filter_Frequency", 22000.0) >= 21999.0
            and abs(p.get("Voice_Gain", 1.0) - 1.0) < 1e-6 and p.get("Voice_Transpose", 0) == 0)


def align(move, ours, max_lag=64, n=8192):
    """The lag (frames) that best lines ours up with move: the smallest
    residual once ours is scaled to fit, over the first n frames."""
    best, best_e = 0, float("inf")
    for lag in range(-max_lag, max_lag + 1):
        y = shift(ours, lag, min(n, len(move)))
        x = move[:len(y)]
        yy = float(np.dot(y, y))
        if yy <= 0:
            continue
        e = (float(np.dot(x, x)) - float(np.dot(x, y)) ** 2 / yy) / (float(np.dot(x, x)) + 1e-9)
        if e < best_e:
            best, best_e = lag, e
    return best


def shift(v, lag, n):
    """ours moved by lag frames, as n frames."""
    out = np.zeros(n)
    if lag >= 0:
        m = min(n - lag, len(v))
        if m > 0:
            out[lag:lag + m] = v[:m]
    else:
        m = min(n, len(v) + lag)
        if m > 0:
            out[:m] = v[-lag:-lag + m]
    return out


LEVEL_FLOOR = -80.0         # dBFS: quieter windows count as this


def level_db(v, win=220):
    n = len(v) // win
    r = np.sqrt(np.mean(v[:n * win].reshape(n, win) ** 2, axis=1))
    return np.maximum(20 * np.log10(np.maximum(r, 1e-9) / 32768), LEVEL_FLOOR), np.arange(n) * win / RATE


def pitch_track(v):
    """Semitones from 441 Hz between upward zero crossings: (times, st)."""
    s = np.signbit(v)
    idx = np.flatnonzero(s[:-1] & ~s[1:])
    if len(idx) < 3:
        return np.array([]), np.array([])
    t = idx + (-v[idx]) / (v[idx + 1] - v[idx])
    period = np.diff(t)
    ok = period > 0
    return (t[1:][ok] / RATE, 12 * np.log2(RATE / period[ok] / 441.0))


def ramp_position_ms(v, gain, n_src):
    """The source frame each sample came from, in ms, for position_ramp.
    Averaging neighbours first cancels Move's ring at Nyquist (PLAN "Move's
    dry path"), which a ramp this shallow would read as tens of ms."""
    v = np.convolve(v, [0.5, 0.5], mode="same")
    return (v / gain + 16000) * (n_src - 1) / 32000 / RATE * 1000


BANDS = 440 * 2 ** (np.arange(-14, 16) / 3)            # ~29 Hz .. 14 kHz, 1/3 octave


def band_levels(v, nfft=4096, hop=1024):
    frames = max(1, (len(v) - nfft) // hop)
    win = np.hanning(nfft)
    f = np.fft.rfftfreq(nfft, 1 / RATE)
    out = np.zeros((len(BANDS), frames))
    for j in range(frames):
        spec = np.abs(np.fft.rfft(v[j * hop:j * hop + nfft] * win)) ** 2
        for i, fc in enumerate(BANDS):
            sel = (f >= fc / 2 ** (1 / 6)) & (f < fc * 2 ** (1 / 6))
            out[i, j] = 10 * np.log10(spec[sel].sum() + 1e-9)
    return out, np.arange(frames) * hop / RATE


def interp_err(t1, y1, t2, y2):
    if len(t1) < 2 or len(t2) < 2:
        return None
    lo, hi = max(t1[0], t2[0]), min(t1[-1], t2[-1])
    if hi <= lo:
        return None
    t = np.linspace(lo, hi, 400)
    return np.interp(t, t1, y1) - np.interp(t, t2, y2)


# ---------------------------------------------------------------- gain curves
# Effects that only change the level (Punch): their gain over time, Move's
# and ours, each against the same pad rendered dry by plugin.c.

GAIN_EFFECTS = ("Punch",)
GAIN_FLOOR = 1e-4           # -80 dB: the curve stops where dry is quieter than this


def gain_effect(p):
    return str(p.get("Effect_Type")) in GAIN_EFFECTS and not neutral(p)


def gain_curve_sine(x, dry, lag, win=100, hop=10):
    """x's gain against dry over one 441 Hz cycle (100 frames), so the
    cosine's phase doesn't matter, every hop frames: (ms from note-on to
    the window's centre, dB)."""
    n = min(len(x), len(dry))

    def rms(v):
        c = np.concatenate([[0.0], np.cumsum(v[:n] ** 2)])
        return np.sqrt((c[win::hop] - c[:-win:hop][:len(c[win::hop])]) / win)
    rx, rd = rms(x), rms(dry)
    ok = rd > GAIN_FLOOR * 32768
    t = (np.arange(len(rd)) * hop + win / 2 - lag) / RATE * 1000
    return t[ok], 20 * np.log10(np.maximum(rx[ok], 1e-9) / rd[ok])


def gain_curve_clicks(x, dry, lag, half=24):
    """x's gain against dry at each click: the RMS over the frames around
    it (Move's Nyquist ring included): (ms, dB). The click on frame 0 is
    lost under the attack ramp in both, so the curve starts at 100 ms: it
    shows whether later clicks are ducked, the sine shows the onset."""
    d = np.abs(dry)
    big = np.flatnonzero(d > 0.25 * d.max())
    peaks = [i for i in big if half <= i < len(dry) - half and d[i] == d[i - half:i + half + 1].max()]
    t, g = [], []
    for i in peaks:
        a, b = x[i - half:i + half + 1], dry[i - half:i + half + 1]
        t.append((i - lag) / RATE * 1000)
        g.append(20 * np.log10(max(np.sqrt(np.mean(a ** 2)), 1e-9) / np.sqrt(np.mean(b ** 2))))
    return np.array(t), np.array(g)


def gain_shape(t, g, end_ms):
    """Punch's shape, measured on a gain curve up to end_ms (before Move's
    end fade): the level at the start (0-2 ms), the deepest point and when,
    the level it settles at (the last 100 ms), when it is halfway down from
    the start to the deepest point, and how long after the deepest point
    it is 50 % and 90 % of the way back up to the settled level."""
    keep = t <= end_ms
    t, g = t[keep], g[keep]
    if len(g) < 2:
        return None
    first = g[t <= 2.0]
    start = float(np.median(first)) if len(first) else float(g[0])
    k = int(np.argmin(g))
    low, settled = float(g[k]), float(np.median(g[t >= t[-1] - 100]))
    out = {"start_db": start, "min_db": low, "min_ms": float(t[k]), "settled_db": settled,
           "down50_ms": None, "up50_ms": None, "up90_ms": None}
    if start - low > 0.5:
        down = np.flatnonzero(g[:k + 1] <= (start + low) / 2)
        out["down50_ms"] = float(t[down[0]]) if len(down) else None
    if settled - low > 0.5:
        for frac, key in ((0.5, "up50_ms"), (0.9, "up90_ms")):
            up = np.flatnonzero(g[k:] >= low + frac * (settled - low))
            out[key] = float(t[k + up[0]] - t[k]) if len(up) else None
    return out


def stats(e):
    if e is None or len(e) == 0:
        return None
    return {"rms": float(np.sqrt(np.mean(e ** 2))), "max": float(np.max(np.abs(e)))}


def cmd_compare(outdir, gain_arg):
    meta = json.load(open(os.path.join(outdir, "pads.json")))
    plots = os.path.join(outdir, "plots")
    os.makedirs(plots, exist_ok=True)
    data = []
    for pc in meta["pieces"]:
        move = read_mono(os.path.join(outdir, pc["piece"]))
        ours = read_mono(os.path.join(outdir, "ours_" + pc["piece"]))
        lag = align(move, ours)
        dry_path = os.path.join(outdir, "dry_" + pc["piece"])
        dry = shift(read_mono(dry_path), lag, len(move)) if os.path.exists(dry_path) else None
        pc["dry"] = dry
        data.append((pc, move, shift(ours, lag, len(move)), lag))

    # The level: from the dry pieces when the Set has any.
    num = den = 0.0
    for pc, move, ours, _ in data:
        if plain(pc["params"]) and pc["sample"] in ("sine_441.wav", "position_ramp.wav", "sweep.wav"):
            sl = slice(EDGE, len(move) - EDGE)
            num += float(np.dot(move[sl], ours[sl]))
            den += float(np.dot(ours[sl], ours[sl]))
    gain = gain_arg if gain_arg else (num / den if den > 0 else DEFAULT_GAIN)
    print("gain %.5f (%.2f dB, %s)" % (gain, 20 * math.log10(gain),
          "given" if gain_arg else ("from the dry pieces" if den > 0 else "Set 28's")))

    rows = []
    for pc, move, ours_raw, lag in data:
        ours = ours_raw * gain
        name = pc["sample"].rsplit(".", 1)[0]
        row = {"piece": pc["piece"], "effect": pc["params"].get("Effect_Type"), "lag": lag}
        lm, tl = level_db(move)
        lo, _ = level_db(ours)
        loud = (lm > -60) | (lo > -60)
        row["level_db"] = stats((lm - lo)[loud])
        # The steady middle: EDGE in from the start and from where the
        # first of the two stops sounding (Move's end fade stays out).
        last = min(np.flatnonzero(np.abs(x) > 50)[-1] if np.any(np.abs(x) > 50) else len(x)
                   for x in (move, ours))
        sl = slice(EDGE, max(EDGE + 1, last - EDGE))
        row["residual_lsb"] = float(np.sqrt(np.mean((move[sl] - ours[sl]) ** 2)))

        panels = ["wave", "zoom", "level"]
        extra = {}
        if name == "sine_441":
            extra["pitch"] = (pitch_track(move), pitch_track(ours))
            row["pitch_st"] = stats(interp_err(*extra["pitch"][0], *extra["pitch"][1]))
            panels.append("pitch")
        if name == "position_ramp":
            n_src = len(read_mono(os.path.join(WAVS, pc["sample"])))
            pm = ramp_position_ms(move, gain, n_src)
            po = ramp_position_ms(ours_raw, 1.0, n_src)
            # Away from the attack and Move's end fade (PLAN "Move's dry path").
            on = np.zeros(len(move), bool)
            sounding = np.flatnonzero(np.abs(move) > 50)
            if len(sounding):
                on[sounding[0] + 10:max(sounding[0] + 10, sounding[-1] - 600)] = True
            row["position_ms"] = stats((pm - po)[on]) if on.any() else None
            extra["position"] = (pm, po, on)
            panels.append("position")
        if name in ("noise_white", "sweep"):
            bm, tb = band_levels(move)
            bo, _ = band_levels(ours)
            live = np.maximum(bm, bo) > max(bm.max(), bo.max()) - 60
            row["bands_db"] = stats((bm - bo)[live])
            extra["bands"] = (bm, bo, tb)
            panels += ["bands_move", "bands_ours"]
        if gain_effect(pc["params"]) and pc["dry"] is not None:
            curve = gain_curve_clicks if name == "click_train" else gain_curve_sine
            dry = pc["dry"]
            gm = curve(move / gain, dry, lag)
            go = curve(ours_raw, dry, lag)
            # Up to 20 ms before the sound ends, clear of Move's end fade.
            loud = np.flatnonzero(np.abs(dry) > 50)
            end_ms = ((loud[-1] if len(loud) else len(dry)) - lag) / RATE * 1000 - 20
            row["gain"] = {"move": gain_shape(*gm, end_ms), "ours": gain_shape(*go, end_ms),
                           "settings": [pc["params"].get(k) for k in EFFECTS[effect_index(pc["params"])][1:3]]}
            row["gain_db"] = stats(interp_err(*gm, *go))
            extra["gain"] = (gm, go, curve is gain_curve_clicks)
            panels.append("gain")
            np.savetxt(os.path.join(plots, pc["piece"].rsplit(".", 1)[0] + "_gain.txt"),
                       np.column_stack(gm), fmt="%.3f", header="Move: ms from note-on, dB against dry")
        rows.append(row)

        fig, axes = plt.subplots(len(panels), 1, figsize=(12, 2.4 * len(panels)))
        t = np.arange(len(move)) / RATE
        for ax, kind in zip(axes, panels):
            if kind == "wave":
                ax.plot(t, move, lw=0.4, label="Move")
                ax.plot(t, ours, lw=0.4, alpha=0.7, label="ours x %.3f" % gain)
                ax.legend(loc="upper right", fontsize=7)
                ax.set_title("%s  (%s)" % (pc["piece"], ", ".join(pc.get("settings", [])[-3:])), fontsize=9)
            elif kind == "zoom":
                z = min(len(move), int(0.05 * RATE))
                ax.plot(t[:z] * 1000, move[:z], lw=0.6)
                ax.plot(t[:z] * 1000, ours[:z], lw=0.6, alpha=0.7)
                ax.set_xlabel("ms", fontsize=7)
            elif kind == "level":
                ax.plot(tl, lm, lw=0.6)
                ax.plot(tl, lo, lw=0.6, alpha=0.7)
                ax.set_ylabel("dBFS", fontsize=7)
                ax.set_ylim(max(-100, min(lm.min(), lo.min()) - 3), 3)
            elif kind == "pitch":
                (tm, sm), (to, so) = extra["pitch"]
                ax.plot(tm, sm, lw=0.6)
                ax.plot(to, so, lw=0.6, alpha=0.7)
                ax.set_ylabel("st from 441 Hz", fontsize=7)
            elif kind == "position":
                pm, po, on = extra["position"]
                ax.plot(t[on], pm[on], ",", ms=1)
                ax.plot(t[on], po[on], ",", ms=1, alpha=0.7)
                ax.set_ylabel("source ms", fontsize=7)
            elif kind == "gain":
                (tm, gm), (to, go), points = extra["gain"]
                style = dict(marker="o", ms=3, lw=0.8) if points else dict(lw=0.8)
                ax.plot(tm, gm, label="Move", **style)
                ax.plot(to, go, alpha=0.7, label="ours", **style)
                ax.axhline(0, color="k", lw=0.5)
                ax.set_xscale("symlog", linthresh=10)
                ax.set_xlim(left=0)
                ax.set_xlabel("ms from note-on", fontsize=7)
                ax.set_ylabel("dB against dry", fontsize=7)
                ax.legend(loc="lower right", fontsize=7)
            elif kind in ("bands_move", "bands_ours"):
                bm, bo, tb = extra["bands"]
                b = bm if kind == "bands_move" else bo
                ax.imshow(b, aspect="auto", origin="lower", vmin=bm.max() - 60, vmax=bm.max(),
                          extent=[tb[0], tb[-1] + 1024 / RATE, 0, len(BANDS)])
                ax.set_yticks([0, 10, 20, 29], ["%d" % BANDS[i] for i in (0, 10, 20, 29)])
                ax.set_ylabel(("Move" if kind == "bands_move" else "ours") + " Hz", fontsize=7)
            ax.tick_params(labelsize=7)
            ax.grid(alpha=0.3)
        plt.tight_layout()
        plt.savefig(os.path.join(plots, pc["piece"].rsplit(".", 1)[0] + ".png"), dpi=80)
        plt.close(fig)

    def f(s, unit):
        return "-" if not s else "%.2f/%.2f%s" % (s["rms"], s["max"], unit)
    print("%-22s %-9s %4s %16s %12s %16s %16s %14s" % (
        "piece", "effect", "lag", "level rms/max", "residual", "pitch rms/max", "position", "bands"))
    for r in rows:
        print("%-22s %-9s %4d %16s %10.1f LSB %16s %16s %14s" % (
            r["piece"], r["effect"], r["lag"], f(r["level_db"], " dB"), r["residual_lsb"],
            f(r.get("pitch_st"), " st"), f(r.get("position_ms"), " ms"), f(r.get("bands_db"), " dB")))
    shaped = [r for r in rows if "gain" in r]
    if shaped:
        def g(s, k, fmt):
            return "-" if not s or s.get(k) is None else fmt % s[k]
        print("\ngain against dry, dB (Move / ours): at the start, deepest and when, settled; ms: halfway down,"
              " then 50 % and 90 % back up to settled after the deepest point")
        cols = (("start_db", "%.1f"), ("min_db", "%.1f"), ("min_ms", "%.0f"), ("settled_db", "%.1f"),
                ("down50_ms", "%.0f"), ("up50_ms", "%.0f"), ("up90_ms", "%.0f"))
        print("%-22s %-15s" % ("piece", "settings") + "".join(" %13s" % k for k, _ in cols))
        for r in shaped:
            m, o = r["gain"]["move"], r["gain"]["ours"]
            print("%-22s %-15s" % (r["piece"], " ".join("%.4g" % v for v in r["gain"]["settings"])) + "".join(
                " %13s" % ("%s / %s" % (g(m, k, f), g(o, k, f))) for k, f in cols))
    json.dump({"gain": gain, "rows": rows}, open(os.path.join(outdir, "compare.json"), "w"), indent=1)
    print("plots in", plots)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split"); s.add_argument("take"); s.add_argument("song"); s.add_argument("outdir")
    s = sub.add_parser("render"); s.add_argument("outdir")
    s = sub.add_parser("compare"); s.add_argument("outdir"); s.add_argument("--gain", type=float)
    s = sub.add_parser("all"); s.add_argument("take"); s.add_argument("song"); s.add_argument("outdir")
    s.add_argument("--gain", type=float)
    a = ap.parse_args()
    if a.cmd in ("split", "all"):
        cmd_split(a.take, a.song, a.outdir)
    if a.cmd in ("render", "all"):
        cmd_render(a.outdir)
    if a.cmd in ("compare", "all"):
        cmd_compare(a.outdir, a.gain)


if __name__ == "__main__":
    main()
