#!/usr/bin/env python3
"""Compare Move's Drum Sampler against LiveChopper's plugin.c (docs/PLAN.md,
step 4). Run with build/.venv/bin/python (tools/fxlab/setup_env.sh).

    fxlab.py split   <take.wav> <Song.abl> <outdir>
    fxlab.py split   <take.wav> --like <outdir>:NN,NN,... <outdir>
    fxlab.py render  <outdir>
    fxlab.py compare <outdir> [--gain G]
    fxlab.py all     <take.wav> <Song.abl> <outdir> [--gain G]
    fxlab.py check   <outdir> [--gain G] [--ours-take <preview outdir>]
    fxlab.py refs    <outdir> [--dest tests/move_refs] [--seed N] [--name envelope]
    fxlab.py refs-check [tests/move_refs]
    fxlab.py accept-set <effect> --seed N [--pads 8]
    fxlab.py make-set <spec.json> <outdir> [--install root@192.168.4.45]
    fxlab.py device-check <outdir>... [--host root@192.168.4.45]
    fxlab.py ab make  <outdir> <preview outdir> [--seed N]
    fxlab.py ab score <preview outdir>/ab <answers> [--accept N,N,...]

split cuts a take recorded with Schwung's Quantized Sampler (Move->Schwung
on) into one piece per pad, in pad order, and saves each pad's Drum Sampler
settings from the Set. render plays the same test sound with the same
settings through plugin.c (tools/fxlab/fx_render.c). compare measures both the
same way and writes plots and a summary.

check is the gate for "this effect matches Move" (docs/PLAN.md step 4,
"When an effect is done"): it renders a split acceptance Set with today's
plugin.c and passes or fails every pad on every metric that applies. refs
then saves Move's measured curves to tests/move_refs/, and refs-check (run
by scripts/test.sh) holds plugin.c to them without the recordings.
accept-set draws an acceptance Set's settings at random. make-set writes a
Move Set from a spec (tools/fxlab/sets/): 16 pads at exact settings and a
clip that plays them in order, so a take is one press of Play; --install
puts it on the Move. device-check
renders the same pads on the Move with plugin.c built as build.sh builds
dsp.so, and requires them to match the host's renders: what check measures
on the host is then what the Move plays.

ab is the last step (PLAN "When an effect is done", "Listening A/B"): make
writes one WAV a pad of Move's piece and the preview's, level-matched by
each take's dry pads, A then B in a hidden random order (the key is
key.json: don't open it before scoring). score takes one character a pair,
"." for no difference heard or "A"/"B" for the one heard as Move, and
passes when no difference was heard that --accept doesn't list.
"""
import argparse
import contextlib
import io
import json
import math
import os
import random
import shlex
import shutil
import subprocess
import sys
import urllib.parse

import numpy as np
from scipy.io import wavfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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


def clip_releases(song):
    """{note: seconds held} from the Set's clips, for pads played exactly
    once (a generated Set's clip): when a Gate pad was let go."""
    tempo = float(song.get("tempo", 120.0))
    seen = {}
    for t in song.get("tracks", []):
        for slot in t.get("clipSlots", []):
            for n in ((slot or {}).get("clip") or {}).get("notes", []):
                seen.setdefault(n["noteNumber"], []).append(n["duration"] * 60 / tempo)
    return {k: v[0] for k, v in seen.items() if len(v) == 1}


def onsets(v):
    loud = np.flatnonzero(np.abs(v) > ONSET_LEVEL)
    out, last = [], -10 ** 9
    for i in loud:
        if i - last > ONSET_GAP_S * RATE:
            out.append(int(i))
        last = i
    return out


def like_pads(spec):
    """Pads copied from pieces of an existing split Set, for a take played
    in LiveChopper (which has no Set): "<outdir>:NN,NN,..."."""
    folder, _, which = spec.rpartition(":")
    pieces = json.load(open(os.path.join(folder, "pads.json")))["pieces"]
    pads, names = [], []
    for k, nn in enumerate(which.split(",")):
        match = [pc for pc in pieces if pc["piece"].startswith("%02d_" % int(nn))]
        if not match:
            sys.exit("split: %s has no piece %s" % (folder, nn))
        pads.append((k + 1, match[0]["sample"], match[0]["params"]))
        names.append(match[0]["piece"])
    return pads, {"dir": os.path.abspath(folder), "pieces": names}


def cmd_split(take, song_path, outdir, like=None):
    os.makedirs(outdir, exist_ok=True)
    v = read_mono(take)
    if like:
        pads, like_meta = like_pads(like)
        releases = {}
    else:
        song = json.load(open(song_path))
        pads, like_meta, releases = drum_pads(song), None, clip_releases(song)
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
        if params.get("Voice_Envelope_Mode") == "A-S-R" and note in releases:
            pieces[-1]["release_s"] = releases[note]
        print("%-22s note %d at %7.3f s, %.2f s, %s%s" % (
            fname, note, start / RATE, len(piece) / RATE, params.get("Effect_Type"),
            "" if params.get("Voice_PitchToEnvelopeModulation") is None
            else ", PitchToEnvelopeModulation %s" % params["Voice_PitchToEnvelopeModulation"]))
    meta = {"take": os.path.abspath(take), "set": os.path.abspath(song_path) if song_path else None,
            "pieces": pieces}
    if like_meta:
        meta["like"] = like_meta
    json.dump(meta, open(os.path.join(outdir, "pads.json"), "w"), indent=1)


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


def piece_settings(pc):
    """dsp_settings for a split piece, and for a Gate pad whose Set's clip
    let go of it, fx_render's release at that time."""
    s = dsp_settings(pc["params"])
    if pc["params"].get("Voice_Envelope_Mode") == "A-S-R" and "release_s" in pc:
        s.append("release=%.6f" % pc["release_s"])
    return s


def build_render():
    src = [os.path.join(REPO, "tools", "fxlab", "fx_render.c"), os.path.join(REPO, "src", "dsp", "plugin.c")]
    if os.path.exists(RENDER) and all(os.path.getmtime(RENDER) >= os.path.getmtime(f) for f in src):
        return
    subprocess.check_call(["gcc", "-std=c11", "-O2", "-I" + os.path.join(REPO, "src", "dsp"), src[0],
                           "-o", RENDER, "-lm", "-lpthread"])


def dry_settings(settings):
    """The same plugin.c settings with no effect."""
    return [x for x in settings if not x.startswith(("effect=", "fx="))] + ["effect=0", "fx=1 0.1"]


def render_pad(sample, settings, frames, out, quiet=False):
    subprocess.check_call([RENDER, os.path.join(WAVS, sample), out, "%.6f" % (frames / RATE)] + settings,
                          stdout=subprocess.DEVNULL if quiet else None)


def cmd_render(outdir, quiet=False):
    build_render()
    meta = json.load(open(os.path.join(outdir, "pads.json")))
    for pc in meta["pieces"]:
        p = pc["params"]
        settings = piece_settings(pc)
        if p.get("Voice_Envelope_Mode") == "A-S-R" and "release_s" not in pc:
            print("  warning: %s is gated; the release time isn't in the take, so ours never releases" % pc["piece"])
        render_pad(pc["sample"], settings, pc["frames"], os.path.join(outdir, "ours_" + pc["piece"]))
        if gain_effect(p):
            # The same pad with no effect: what the gain curve divides by.
            render_pad(pc["sample"], dry_settings(settings), pc["frames"], os.path.join(outdir, "dry_" + pc["piece"]))
        pc["settings"] = settings
        if not quiet:
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


def stats(e):
    if e is None or len(e) == 0:
        return None
    return {"rms": float(np.sqrt(np.mean(e ** 2))), "max": float(np.max(np.abs(e)))}


def effect_name(p):
    return EFFECTS[effect_index(p)][0]


def fx_value(p, which):
    """The effect's first (0) or second (1) setting."""
    return p.get(EFFECTS[effect_index(p)][1 + which], 0.0)


# ---------------------------------------------------------------- gain curves
# Effects that only change the level: their gain over time, Move's and
# ours, each against the same pad rendered dry by plugin.c.

GAIN_FLOOR = 1e-4           # -80 dB: the curve stops where dry is quieter than this
SLOW_HZ = 20                # Ring Mod and FM below this are a level or pitch wobble
FM_DEPTH = 10               # Move's FM swings the read rate by Amount x 10 (Set 34)


def gain_effect(p):
    name = effect_name(p)
    return not neutral(p) and (name == "Punch" or (name == "Ring Mod" and fx_value(p, 1) < SLOW_HZ))


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


# ---------------------------------------------------------------- metrics
# What "matches Move" means (docs/PLAN.md step 4, "When an effect is
# done"): each metric is a curve over time from note-on, Move's against
# ours, with rms and max limits from hearing: level 0.5 dB, pitch 5
# cents, timing 1 ms, spectrum 1 dB per 1/3-octave band.

SINES = ("sine_441.wav", "sine_441_quiet.wav")
START_MS = 1.0              # metrics start past the attack ramp (4 frames)
END_MARGIN_MS = 20          # ... and stop this long before the sound does (Move's end fade)
STORE_MS = 1.0              # stored curves keep a point a ms
BAND_NFFT, BAND_HOP = 4096, 1024
BAND_LIVE_DB = 40           # bands compared: within this of the loudest,
BAND_FLOOR_DB = 80          # ... and no quieter than this below a full-scale sine


def uses_gain(p, sample):
    return sample in SINES and gain_effect(p)


def fm_reverses(p):
    """Slow FM deep enough to stop the read and run it backwards. There a
    zero-crossing pitch is undefined around the stops (a frame of drift
    reads as hundreds of cents), and the narrow low bands swing by 20 dB
    from one window to the next, so the sine pads compare the spectrum
    averaged over the sound and the position_ramp pads hold the timing."""
    return effect_name(p) == "FM" and fx_value(p, 1) < SLOW_HZ and fx_value(p, 0) * FM_DEPTH >= 1


def uses_pitch(p, sample):
    name = effect_name(p)
    return sample in SINES and (neutral(p) or name in ("Punch", "Pitch Env")
                                or (name == "FM" and fx_value(p, 1) < SLOW_HZ and not fm_reverses(p)))


def uses_position(p, sample):
    name = effect_name(p)
    return sample == "position_ramp.wav" and (neutral(p) or name in ("Loop", "Pitch Env")
                                              or (name == "FM" and fx_value(p, 1) < SLOW_HZ))


def curve_gain(x, c):
    return gain_curve_sine(x, c["dry"], 0)


def curve_pitch(x, c):
    s, st = pitch_track(x)
    return s * 1000, st * 100


def curve_position(x, c):
    v = ramp_position_ms(x, 1.0, c["n_src"])
    return np.arange(len(v)) / RATE * 1000, v


def curve_bands(x, c):
    """Band levels a window at a time; for fm_reverses, one column: their
    power average over the windows ending by end_ms."""
    b, tb = band_levels(x, BAND_NFFT, BAND_HOP)
    t = tb * 1000
    if c.get("params") and fm_reverses(c["params"]):
        keep = t + BAND_NFFT / RATE * 1000 <= c["end_ms"]
        if keep.any():
            b = 10 * np.log10(np.mean(10 ** (b[:, keep] / 10), axis=1, keepdims=True))
            t = np.zeros(1)
    return t, b


# name, unit, rms limit, max limit, applies(params, sample), curve(x, context)
METRICS = [
    ("gain", "dB", 0.5, 1.5, uses_gain, curve_gain),
    ("pitch", "ct", 5.0, 15.0, uses_pitch, curve_pitch),
    ("position", "ms", 1.0, 2.0, uses_position, curve_position),
    ("bands", "dB", 1.0, 3.0, lambda p, s: True, curve_bands),
]

_band_fs = []


def band_fs_db():
    """The band level of a full-scale sine, for the bands' floor."""
    if not _band_fs:
        x = 32767 * np.sin(2 * np.pi * 1000 * np.arange(BAND_NFFT + BAND_HOP) / RATE)
        _band_fs.append(float(band_levels(x, BAND_NFFT, BAND_HOP)[0].max()))
    return _band_fs[0]


def store_curve(name, t, v, end_ms):
    """A curve as saved: from START_MS (bands: from note-on) to end_ms, a
    point a ms (bands: every frame whose window ends by end_ms)."""
    if name == "bands":
        keep = t + BAND_NFFT / RATE * 1000 <= end_ms
        return {"t": np.round(t[keep], 3).tolist(), "v": np.round(v[:, keep], 2).tolist()}
    keep = (t >= START_MS) & (t <= end_ms)
    t, v = t[keep], v[keep]
    if len(t):
        first = np.flatnonzero(np.diff(np.floor(t / STORE_MS), prepend=-1) > 0)
        t, v = t[first], v[first]
    return {"t": np.round(t, 3).tolist(), "v": np.round(v, 3).tolist()}


def curve_error(name, ref, t, v):
    """A stored (Move) curve minus a full one (ours, or Move's repeat), at
    the stored curve's points."""
    rt, rv = np.array(ref["t"]), np.array(ref["v"])
    if name == "bands":
        if rv.size == 0:
            return np.array([])
        n = min(rv.shape[1], v.shape[1])
        rb, ob = rv[:, :n], v[:, :n]
        top = np.maximum(rb, ob)
        # Both sides clamped at the floor: a component one has and the
        # other lacks counts as at most BAND_LIVE_DB, not as -240 dB.
        floor = max(top.max() - BAND_LIVE_DB, band_fs_db() - BAND_FLOOR_DB)
        return (np.maximum(rb, floor) - np.maximum(ob, floor))[top > floor]
    if len(rt) == 0 or len(t) < 2:
        return np.array([])
    m = (rt >= t[0]) & (rt <= t[-1])
    return rv[m] - np.interp(rt[m], t, v)


def sound_end_ms(*xs):
    """Where the first of xs stops sounding, less END_MARGIN_MS."""
    ends = [np.flatnonzero(np.abs(x) > 50)[-1] if np.any(np.abs(x) > 50) else len(x) for x in xs]
    return min(ends) / RATE * 1000 - END_MARGIN_MS


def judge(name, err, rms_limit, max_limit):
    """A metric's verdict on an error array: (stats, PASS/FAIL). No
    points at all fails, except for bands, where it means both are silent."""
    st = stats(err)
    if st is None:
        return None, "PASS" if name == "bands" else "FAIL"
    return st, "PASS" if st["rms"] <= rms_limit and st["max"] <= max_limit else "FAIL"


def measure(sample, params, x, ours, dry, end_ms):
    """Every metric that applies to a pad: {name: (Move's curve stored,
    Move's full curve, ours full curve, error)}. x is Move's piece at
    ours' level from note-on; ours and dry are plugin.c's renders."""
    c = {"dry": dry, "n_src": len(read_mono(os.path.join(WAVS, sample))), "params": params, "end_ms": end_ms}
    out = {}
    for name, _, _, _, applies, curve in METRICS:
        if not applies(params, sample) or (name == "gain" and dry is None):
            continue
        mt, mv = curve(x, c)
        ot, ov = curve(ours, c)
        ref = store_curve(name, mt, mv, end_ms)
        out[name] = (ref, (mt, mv), (ot, ov), curve_error(name, ref, ot, ov))
    return out


def attack_us(params):
    return int(round(params.get("Voice_Envelope_Attack", 0.0) * 1e6))


def take_level(data, key):
    """A take's level against the renders, from its dry pieces, by Attack:
    Move's dry level depends on it (0.8465 at 0.1 ms, 0.9311 at 1.0 ms;
    NOTES "Move's dry path"). ({attack_us: level, None: all}, found).
    d[key] is the take's piece, d[key + "_lag"] its lag."""
    sums = {}
    for d in data:
        if plain(d["pc"]["params"]) and d["pc"]["sample"] in ("sine_441.wav", "position_ramp.wav", "sweep.wav"):
            x, ours = d[key], shift(d["ours_raw"], d[key + "_lag"], len(d[key]))
            sl = slice(EDGE, len(x) - EDGE)
            num, den = float(np.dot(x[sl], ours[sl])), float(np.dot(ours[sl], ours[sl]))
            for k in (attack_us(d["pc"]["params"]), None):
                n0, d0 = sums.get(k, (0.0, 0.0))
                sums[k] = (n0 + num, d0 + den)
    levels = {k: n / dd for k, (n, dd) in sums.items() if dd > 0}
    return (levels, True) if levels else ({None: DEFAULT_GAIN}, False)


def piece_level(levels, params):
    """The level for one piece: its Attack's dry pieces, else all of them."""
    return levels.get(attack_us(params), levels[None])


def levels_text(levels):
    by = sorted(k for k in levels if k is not None)
    if len(by) < 2:
        return ""
    return ", by Attack: " + ", ".join("%g ms %.5f" % (k / 1000, levels[k]) for k in by)


def load_pieces(outdir, gain_arg, ours_take=None):
    """A split, rendered Set: each piece with Move's take lined up on
    ours (from note-on, at ours' level), and the level between them.
    With ours_take (a split take of LiveChopper's preview, from split
    --like on this Set), ours is that take's piece, lined up and levelled
    the same way, instead of the render."""
    meta = json.load(open(os.path.join(outdir, "pads.json")))
    pieces = meta["pieces"]
    takes = None
    if ours_take:
        tmeta = json.load(open(os.path.join(ours_take, "pads.json")))
        like = tmeta.get("like")
        if not like or os.path.abspath(like["dir"]) != os.path.abspath(outdir):
            sys.exit("check: %s wasn't split --like %s" % (ours_take, outdir))
        byname = {pc["piece"]: pc for pc in pieces}
        pieces = [byname[nm] for nm in like["pieces"]]
        takes = tmeta["pieces"]
        for pc, tp in zip(pieces, takes):
            if not same_pad(pc, tp):
                sys.exit("check: %s and %s aren't the same pad" % (pc["piece"], tp["piece"]))
    data = []
    for k, pc in enumerate(pieces):
        move = read_mono(os.path.join(outdir, pc["piece"]))
        ours = read_mono(os.path.join(outdir, "ours_" + pc["piece"]))
        dry_path = os.path.join(outdir, "dry_" + pc["piece"])
        dry = read_mono(dry_path) if os.path.exists(dry_path) else None
        d = {"pc": pc, "move": move, "ours_raw": ours, "dry_raw": dry, "move_lag": align(move, ours)}
        if takes:
            d["take"] = read_mono(os.path.join(ours_take, takes[k]["piece"]))
            d["take_lag"] = align(d["take"], ours)
        data.append(d)

    found = False
    levels = {None: gain_arg}
    if not gain_arg:
        levels, found = take_level(data, "move")
    gain = levels[None]
    source = "given" if gain_arg else ("from the dry pieces" + levels_text(levels) if found else "Set 28's")
    if takes:
        take_levels, found = take_level(data, "take")
        if not found:
            sys.exit("check: %s has no dry piece to set its level" % ours_take)
        source += "; preview %.5f%s" % (take_levels[None], levels_text(take_levels))

    for d in data:
        n = len(d["move"])
        d["lag"] = d["move_lag"]
        d["gain"] = piece_level(levels, d["pc"]["params"])
        d["x"] = shift(d["move"], -d["lag"], n) / d["gain"]
        if takes:
            d["ours"] = shift(d["take"], -d["take_lag"], n) / piece_level(take_levels, d["pc"]["params"])
        else:
            d["ours"] = shift(d["ours_raw"], 0, n)
        d["dry"] = shift(d["dry_raw"], 0, n) if d["dry_raw"] is not None else None
        d["end_ms"] = sound_end_ms(d["x"], d["ours"])
        d["m"] = measure(d["pc"]["sample"], d["pc"]["params"], d["x"], d["ours"], d["dry"], d["end_ms"])
    return meta, data, gain, source


def same_pad(a, b):
    """Two pieces with the same sound and settings (a repeat)."""
    if a["sample"] != b["sample"]:
        return False
    pa, pb = a["params"], b["params"]
    for k in set(pa) | set(pb):
        va, vb = pa.get(k), pb.get(k)
        if isinstance(va, float) and isinstance(vb, float):
            if abs(va - vb) > 1e-3 * max(1.0, abs(va), abs(vb)):
                return False
        elif va != vb:
            return False
    return True


# ---------------------------------------------------------------- compare

def cmd_compare(outdir, gain_arg):
    meta, data, gain, source = load_pieces(outdir, gain_arg)
    plots = os.path.join(outdir, "plots")
    os.makedirs(plots, exist_ok=True)
    print("gain %.5f (%.2f dB, %s)" % (gain, 20 * math.log10(gain), source))

    rows = []
    for d in data:
        pc, move, lag = d["pc"], d["move"], d["lag"]
        ours = shift(d["ours_raw"], lag, len(move)) * d["gain"]
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
        for name, (_, _, _, err) in d["m"].items():
            row[name] = stats(err)

        # Punch's shape, and on click_train its gain at each click.
        diag = None
        if gain_effect(pc["params"]) and d["dry"] is not None:
            if "gain" in d["m"]:
                gm, go = d["m"]["gain"][1], d["m"]["gain"][2]
            else:
                gm = gain_curve_clicks(d["x"], d["dry"], 0)
                go = gain_curve_clicks(d["ours"], d["dry"], 0)
            row["gain_shape"] = {"move": gain_shape(*gm, d["end_ms"]), "ours": gain_shape(*go, d["end_ms"]),
                                 "settings": [fx_value(pc["params"], 0), fx_value(pc["params"], 1)]}
            diag = (gm, go, "gain" not in d["m"])
            np.savetxt(os.path.join(plots, pc["piece"].rsplit(".", 1)[0] + "_gain.txt"),
                       np.column_stack(gm), fmt="%.3f", header="Move: ms from note-on, dB against dry")
        rows.append(row)

        panels = ["wave", "zoom", "level"] + [k for k in ("pitch", "position") if k in d["m"]]
        if diag:
            panels.append("gain")
        panels += ["bands_move", "bands_ours"]
        fig, axes = plt.subplots(len(panels), 1, figsize=(12, 2.4 * len(panels)))
        t = np.arange(len(move)) / RATE
        for ax, kind in zip(axes, panels):
            if kind == "wave":
                ax.plot(t, move, lw=0.4, label="Move")
                ax.plot(t, ours, lw=0.4, alpha=0.7, label="ours x %.3f" % d["gain"])
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
            elif kind in ("pitch", "position"):
                (mt, mv), (ot, ov) = d["m"][kind][1], d["m"][kind][2]
                on = (mt >= START_MS) & (mt <= d["end_ms"])
                oo = (ot >= START_MS) & (ot <= d["end_ms"])
                style = dict(lw=0.6) if kind == "pitch" else dict(ls="", marker=",")
                ax.plot(mt[on], mv[on], **style)
                ax.plot(ot[oo], ov[oo], alpha=0.7, **style)
                ax.set_ylabel("cents from 441 Hz" if kind == "pitch" else "source ms", fontsize=7)
                ax.set_xlabel("ms from note-on", fontsize=7)
            elif kind == "gain":
                (tm, gm), (to, go), points = diag
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
                (tb, bm), (_, bo) = d["m"]["bands"][1], d["m"]["bands"][2]
                b = bm if kind == "bands_move" else bo
                ax.imshow(b, aspect="auto", origin="lower", vmin=bm.max() - 60, vmax=bm.max(),
                          extent=[tb[0], tb[-1] + BAND_HOP / RATE * 1000, 0, len(BANDS)])
                ax.set_yticks([0, 10, 20, 29], ["%d" % BANDS[i] for i in (0, 10, 20, 29)])
                ax.set_ylabel(("Move" if kind == "bands_move" else "ours") + " Hz", fontsize=7)
                ax.set_xlabel("ms from note-on", fontsize=7)
            ax.tick_params(labelsize=7)
            ax.grid(alpha=0.3)
        plt.tight_layout()
        plt.savefig(os.path.join(plots, pc["piece"].rsplit(".", 1)[0] + ".png"), dpi=80)
        plt.close(fig)

    def f(s, unit):
        return "-" if not s else "%.2f/%.2f%s" % (s["rms"], s["max"], unit)
    print("%-22s %-9s %4s %16s %12s %16s %16s %16s %16s" % (
        "piece", "effect", "lag", "level rms/max", "residual", "gain", "pitch", "position", "bands"))
    for r in rows:
        print("%-22s %-9s %4d %16s %10.1f LSB %16s %16s %16s %16s" % (
            r["piece"], r["effect"], r["lag"], f(r["level_db"], " dB"), r["residual_lsb"],
            f(r.get("gain"), " dB"), f(r.get("pitch"), " ct"), f(r.get("position"), " ms"), f(r.get("bands"), " dB")))
    shaped = [r for r in rows if "gain_shape" in r]
    if shaped:
        def g(s, k, fmt):
            return "-" if not s or s.get(k) is None else fmt % s[k]
        print("\ngain against dry, dB (Move / ours): at the start, deepest and when, settled; ms: halfway down,"
              " then 50 % and 90 % back up to settled after the deepest point")
        cols = (("start_db", "%.1f"), ("min_db", "%.1f"), ("min_ms", "%.0f"), ("settled_db", "%.1f"),
                ("down50_ms", "%.0f"), ("up50_ms", "%.0f"), ("up90_ms", "%.0f"))
        print("%-22s %-15s" % ("piece", "settings") + "".join(" %13s" % k for k, _ in cols))
        for r in shaped:
            m, o = r["gain_shape"]["move"], r["gain_shape"]["ours"]
            print("%-22s %-15s" % (r["piece"], " ".join("%.4g" % v for v in r["gain_shape"]["settings"])) + "".join(
                " %13s" % ("%s / %s" % (g(m, k, f), g(o, k, f))) for k, f in cols))
    json.dump({"gain": gain, "rows": rows}, open(os.path.join(outdir, "compare.json"), "w"), indent=1)
    print("plots in", plots)


# ---------------------------------------------------------------- check

def limits_with_floor(data):
    """Each metric's limits, raised to what Move's repeated pads differ by."""
    lim = {name: [r, m] for name, _, r, m, _, _ in METRICS}
    floors = {}
    for i, a in enumerate(data):
        for b in data[i + 1:]:
            if not same_pad(a["pc"], b["pc"]):
                continue
            for name in set(a["m"]) & set(b["m"]):
                st = stats(curve_error(name, a["m"][name][0], *b["m"][name][1]))
                if st:
                    fl = floors.setdefault(name, {"rms": 0.0, "max": 0.0, "pairs": []})
                    fl["rms"], fl["max"] = max(fl["rms"], st["rms"]), max(fl["max"], st["max"])
                    fl["pairs"].append([a["pc"]["piece"], b["pc"]["piece"]])
    for name, fl in floors.items():
        lim[name] = [max(lim[name][0], fl["rms"]), max(lim[name][1], fl["max"])]
    return lim, floors


def cmd_check(outdir, gain_arg, ours_take=None):
    """Today's plugin.c against a split acceptance Set: 0 if every pad
    passes every metric that applies, 1 otherwise. With ours_take, the
    recorded preview take stands in for plugin.c's renders."""
    cmd_render(outdir, quiet=True)
    meta, data, gain, source = load_pieces(outdir, gain_arg, ours_take)
    if ours_take:
        print("Move's pieces against the preview take in %s" % ours_take)
    lim, floors = limits_with_floor(data)
    units = {name: unit for name, unit, _, _, _, _ in METRICS}
    print("level %.5f (%s). Limits rms/max:" % (gain, source) + "".join(
        " %s %.2g/%.2g %s%s" % (n, lim[n][0], lim[n][1], units[n], " (raised by a repeat)" if n in floors else "")
        for n in lim))
    if not floors:
        print("  note: no repeated pad, so no check of Move's own repeatability")

    # Against a preview take, the result has its own name and no references.
    refdir = None if ours_take else os.path.join(outdir, "refs")
    if refdir:
        os.makedirs(refdir, exist_ok=True)
    rows, fails = [], 0
    for d in data:
        pc = d["pc"]
        row = {"piece": pc["piece"], "effect": pc["params"].get("Effect_Type"), "metrics": {}}
        cells = []
        for name, (ref, _, _, err) in d["m"].items():
            st, verdict = judge(name, err, *lim[name])
            fails += verdict == "FAIL"
            row["metrics"][name] = {"stats": st, "verdict": verdict, "limits": lim[name]}
            cells.append("%s %s %s" % (name, "-" if st is None else "%.2f/%.2f" % (st["rms"], st["max"]), verdict))
        rows.append(row)
        print("%-22s %-9s %s" % (pc["piece"], row["effect"], "   ".join(cells)))
        if refdir:
            json.dump({"set": os.path.basename(os.path.dirname(meta.get("set") or "")) or None,
                   "piece": pc["piece"], "sample": pc["sample"], "params": pc["params"],
                   "settings": piece_settings(pc), "frames": pc["frames"],
                   "end_ms": round(d["end_ms"], 3), "dry": d["dry"] is not None,
                   "metrics": {name: {"limits": lim[name], "move": ref} for name, (ref, _, _, _) in d["m"].items()}},
                  open(os.path.join(refdir, pc["piece"].rsplit(".", 1)[0] + ".json"), "w"))
    verdict = "PASS" if fails == 0 else "FAIL"
    name = "check_vs_%s.json" % os.path.basename(os.path.normpath(ours_take)) if ours_take else "check.json"
    json.dump({"verdict": verdict, "level": gain, "limits": lim, "floors": floors, "rows": rows,
               "ours_take": os.path.abspath(ours_take) if ours_take else None},
              open(os.path.join(outdir, name), "w"), indent=1)
    print("%s: %d of %d pads, %d failing metric(s)" % (
        verdict, sum(all(m["verdict"] == "PASS" for m in r["metrics"].values()) for r in rows), len(rows), fails))
    return 0 if fails == 0 else 1


# ---------------------------------------------------------------- ab

AB_GAP_S = 1.0          # silence between A and B
AB_TAIL_S = 0.05        # kept past the later of the two sounds' ends
AB_FADE = 220           # frames faded at each half's end (5 ms)


def ab_half(v, frames):
    v = np.concatenate([v, np.zeros(max(0, frames - len(v)))])[:frames].copy()
    v[-AB_FADE:] *= np.linspace(1, 0, AB_FADE)
    return v


def cmd_ab_make(outdir, ours_take, seed=None):
    """One WAV a pad, Move's piece and the preview's at the same level, in
    an order drawn from seed (a random one if not given), into
    <ours_take>/ab with the key in key.json."""
    cmd_render(outdir, quiet=True)
    with contextlib.redirect_stdout(io.StringIO()):
        meta, data, gain, source = load_pieces(outdir, None, ours_take)
    if seed is None:
        seed = random.SystemRandom().randrange(1 << 30)
    rnd = random.Random(seed)
    ab = os.path.join(ours_take, "ab")
    shutil.rmtree(ab, ignore_errors=True)
    os.makedirs(ab)
    pairs = []
    for k, d in enumerate(data):
        # Both at ours' level, put back at Move's dry level (Set 28).
        move, prev = d["x"] * DEFAULT_GAIN, d["ours"] * DEFAULT_GAIN
        ends = [np.flatnonzero(np.abs(v) > 50)[-1] if np.any(np.abs(v) > 50) else 0 for v in (move, prev)]
        frames = max(ends) + int(AB_TAIL_S * RATE)
        move_first = rnd.random() < 0.5
        a, b = (move, prev) if move_first else (prev, move)
        name = "pair_%02d.wav" % (k + 1)
        write_mono(os.path.join(ab, name), np.concatenate(
            [ab_half(a, frames), np.zeros(int(AB_GAP_S * RATE)), ab_half(b, frames)]))
        pairs.append({"pair": k + 1, "file": name, "piece": d["pc"]["piece"], "move": "A" if move_first else "B"})
    json.dump({"set": os.path.abspath(outdir), "preview": os.path.abspath(ours_take), "seed": seed,
               "levels": source, "pairs": pairs}, open(os.path.join(ab, "key.json"), "w"), indent=1)
    print("%d pairs in %s (A, %.1f s of silence, B); levels %s." % (len(pairs), ab, AB_GAP_S, source))
    print("Listen to each on the same speakers or headphones, without opening key.json, and")
    print("answer one character a pair, in order: . (no difference) or A/B (the one that is Move):")
    print("  fxlab.py ab score %s <answers> [--accept N,N,...]" % ab)
    return ab


def cmd_ab_score(ab, answers, accept=()):
    """Scores the answers against key.json: 0 when no pair had a difference
    heard that accept doesn't list, 1 otherwise. Writes result.json."""
    key = json.load(open(os.path.join(ab, "key.json")))
    pairs = key["pairs"]
    answers = answers.upper()
    if len(answers) != len(pairs) or any(c not in ".AB" for c in answers):
        sys.exit("ab score: %d answers, each ., A or B; got %r" % (len(pairs), answers))
    rows, open_diffs = [], []
    for p, c in zip(pairs, answers):
        heard = c != "."
        row = {"pair": p["pair"], "piece": p["piece"], "answer": c, "move": p["move"], "heard": heard,
               "named_move": heard and c == p["move"], "accepted": p["pair"] in accept}
        if heard and not row["accepted"]:
            open_diffs.append(p["pair"])
        rows.append(row)
        print("pair %2d  %-22s %s%s" % (p["pair"], p["piece"],
              "no difference" if not heard else "heard; named %s, Move was %s (%s)" % (
                  c, p["move"], "right" if row["named_move"] else "wrong"),
              "; accepted" if heard and row["accepted"] else ""))
    heard = [r for r in rows if r["heard"]]
    verdict = "PASS" if not open_diffs else "FAIL"
    json.dump({"verdict": verdict, "seed": key["seed"], "rows": rows, "unaccepted": open_diffs},
              open(os.path.join(ab, "result.json"), "w"), indent=1)
    print("%s: a difference heard on %d of %d pairs (Move named right on %d)%s" % (
        verdict, len(heard), len(rows), sum(r["named_move"] for r in heard),
        "; not accepted: " + ", ".join(map(str, open_diffs)) if open_diffs else ""))
    return 0 if verdict == "PASS" else 1


# ---------------------------------------------------------------- refs

REFS = os.path.join(REPO, "tests", "move_refs")


def cmd_refs(outdir, dest, seed, name=None):
    """Save a passing acceptance Set's Move curves as tests/move_refs/<effect>/,
    or <name>/ for a Set that tests no effect (the envelope's)."""
    chk = json.load(open(os.path.join(outdir, "check.json")))
    if chk["verdict"] != "PASS":
        sys.exit("refs: %s didn't pass its check" % outdir)
    meta = json.load(open(os.path.join(outdir, "pads.json")))
    effects = [name] if name else sorted({effect_name(pc["params"]) for pc in meta["pieces"] if not neutral(pc["params"])})
    if len(effects) != 1:
        sys.exit("refs: an acceptance Set tests one effect, this one has %s" % (effects or "none"))
    folder = os.path.join(dest, effects[0].lower().replace(" ", "_"))
    os.makedirs(folder, exist_ok=True)
    for old in sorted(os.listdir(folder)):
        if old.endswith(".json"):
            print("  replacing", os.path.join(folder, old))
            os.remove(os.path.join(folder, old))
    for pc in meta["pieces"]:
        name = pc["piece"].rsplit(".", 1)[0] + ".json"
        ref = json.load(open(os.path.join(outdir, "refs", name)))
        ref["seed"] = seed
        json.dump(ref, open(os.path.join(folder, name), "w"), separators=(",", ":"))
    print("%d references in %s" % (len(meta["pieces"]), folder))


def cmd_refs_check(folder):
    """plugin.c against every saved reference: 0 if all pass."""
    files = sorted(os.path.join(r, f) for r, _, fs in os.walk(folder) for f in fs if f.endswith(".json")) \
        if os.path.isdir(folder) else []
    if not files:
        print("no Move references in %s yet" % folder)
        return 0
    build_render()
    tmp = os.path.join(REPO, "build", "refs_check")
    os.makedirs(tmp, exist_ok=True)
    fails = 0
    for path in files:
        ref = json.load(open(path))
        ours_path, dry_path = os.path.join(tmp, "ours.wav"), os.path.join(tmp, "dry.wav")
        render_pad(ref["sample"], ref["settings"], ref["frames"], ours_path, quiet=True)
        dry = None
        if ref["dry"]:
            render_pad(ref["sample"], dry_settings(ref["settings"]), ref["frames"], dry_path, quiet=True)
            dry = read_mono(dry_path)
        ours = read_mono(ours_path)
        c = {"dry": dry, "n_src": len(read_mono(os.path.join(WAVS, ref["sample"]))),
             "params": ref["params"], "end_ms": ref["end_ms"]}
        cells = []
        for name, _, _, _, _, curve in METRICS:
            if name not in ref["metrics"]:
                continue
            r = ref["metrics"][name]
            st, verdict = judge(name, curve_error(name, r["move"], *curve(ours, c)), *r["limits"])
            fails += verdict == "FAIL"
            cells.append("%s %s %s" % (name, "-" if st is None else "%.2f/%.2f" % (st["rms"], st["max"]), verdict))
        print("%-40s %s" % (os.path.relpath(path, folder), "   ".join(cells)))
    print("%s: %d reference pad(s), %d failing metric(s)" % ("PASS" if fails == 0 else "FAIL", len(files), fails))
    return 0 if fails == 0 else 1


# ---------------------------------------------------------------- accept-set

# Each effect's settings: (knob in src/knobs.mjs, Move's name for it).
KNOBS_FOR = {
    "Stretch": (("stretch_factor", "Stretch Factor"), ("stretch_grain", "Grain Size")),
    "Loop": (("loop_offset", "Loop Offset"), ("loop_length", "Loop Length")),
    "Pitch Env": (("pitch_amount", "Pitch Env Amount"), ("pitch_decay", "Pitch Env Decay")),
    "Punch": (("punch_amount", "Punch Amount"), ("punch_release", "Punch Release")),
    "8-bit": (("rate", "8-Bit Rate"), ("crush_decay", "8-Bit Decay")),
    "FM": (("fm_amount", "FM Amount"), ("fm_freq", "FM Frequency")),
    "Ring Mod": (("ring_amount", "Ring Mod Amt"), ("ring_freq", "Ring Mod Freq")),
    "Sub Osc": (("sub_amount", "Sub Amount"), ("sub_freq", "Sub Frequency")),
    "Noise": (("noise_amount", "Noise Amount"), ("noise_color", "Noise Color")),
}
# The test sounds each effect's acceptance Set plays (PLAN "What to record"),
# kept under Move's output ceiling; drum_synth is added to every Set.
ACCEPT_SOUNDS = {
    "Stretch": ["click_train", "position_ramp", "sine_441"],
    "Loop": ["click_train", "position_ramp"],
    "Pitch Env": ["sine_441", "position_ramp"],
    "Punch": ["sine_441", "sine_441_quiet"],
    "8-bit": ["click_train", "noise_white", "sweep"],
    "FM": ["sine_441", "position_ramp"],
    "Ring Mod": ["sine_441"],
    "Sub Osc": ["silence_click", "sine_441"],
    "Noise": ["silence_click", "sine_441"],
}


def cmd_accept_set(effect, seed, pads):
    match = [e for e in KNOBS_FOR if e.lower() == effect.lower()]
    if not match:
        sys.exit("accept-set: no effect %r (one of %s)" % (effect, ", ".join(KNOBS_FOR)))
    effect = match[0]
    i = [e[0] for e in EFFECTS].index(effect)
    rule = EFFECTS[i][3]
    rng = random.Random(seed)
    sounds = ACCEPT_SOUNDS[effect] + ["drum_synth"]
    knobs = KNOBS_FOR[effect]
    drawn = []
    while len(drawn) < pads:
        req = [[k, rng.random()] for k, _ in knobs]
        out = json.loads(subprocess.check_output(
            ["node", os.path.join(REPO, "tools", "fxlab", "knob_readout.mjs"), json.dumps(req)]))
        values = {EFFECTS[i][1]: out[0][1], EFFECTS[i][2]: out[1][1]}
        if rule is not None and abs(values.get(rule[0], -1) - rule[1]) < 1e-6:
            continue                    # the effect would do nothing: draw again
        drawn.append(out)
    print("Acceptance Set for %s, seed %d (docs/PLAN.md step 4, \"When an effect is done\")." % (effect, seed))
    print("Every pad: Attack at its minimum, Hold Inf, Low-Pass 24 fully open, Transpose 0, Full Velocity.")
    print("Play the pads in order about 3 s apart, then split and run fxlab.py check.\n")
    print("| Pad | Sound | Settings |")
    print("|---|---|---|")
    print("| 1 | sine_441 | dry (Stretch 1.00) |")
    for k, out in enumerate(drawn):
        print("| %d | %s | %s |" % (k + 2, sounds[k % len(sounds)],
                                    ", ".join("%s %s" % (label, out[j][0]) for j, (_, label) in enumerate(knobs))))
    print("| %d | %s | a copy of pad 2 (Move's repeatability) |" % (pads + 2, sounds[0]))


# ---------------------------------------------------------------- make-set

SET_TEMPLATE = os.path.join(REPO, "tools", "fxlab", "sets", "template_song.abl")  # Set 34: 16 pads
SET_SAMPLE_URI = "ableton:/user-library/Samples/LiveChopper%20Tests/"
SET_PADS = 16
SET_NOTE_BEATS = 0.25           # a Trigger pad's note: the envelope ignores its length
SET_RANGES = {                  # the settings a typo would quietly break (src/knobs.mjs)
    "Voice_Envelope_Attack": (0.0001, 20.0),
    "Voice_Envelope_Hold": (0.001, 60.0),
    "Voice_Envelope_Decay": (0.001, 60.0),
}
SET_CHOICES = {"Voice_Envelope_Mode": ("A-H-D", "A-S-R")}
DEVICE_SETS = "/data/UserData/UserLibrary/Sets"
DEVICE_SET_STAGING = "/data/UserData/livechopper-sets"


def set_cells(song):
    """The Drum Rack's chains with a drum cell, in note order."""
    out = []

    def walk(devices):
        for d in devices:
            if d.get("kind") == "drumRack":
                for c in d.get("chains", []):
                    cells = [x for x in c.get("devices", []) if x.get("kind") == "drumCell"]
                    if cells:
                        out.append((c, cells[0]))
            for c in d.get("chains", []):
                walk(c.get("devices", []))

    for t in song.get("tracks", []):
        walk(t.get("devices", []))
    return sorted(out, key=lambda x: x[0]["drumZoneSettings"]["receivingNote"])


def set_param(cell, name, value):
    """Set one Drum Sampler parameter, keeping its form (a scalar or
    {"value", "presetValue"}) and its type."""
    params = cell["parameters"]
    if name not in params:
        raise ValueError("no Drum Sampler parameter %r" % name)
    old = params[name]["value"] if isinstance(params[name], dict) else params[name]
    if isinstance(old, bool) != isinstance(value, bool) or isinstance(old, str) != isinstance(value, str):
        raise ValueError("%s: %r is not the type of %r" % (name, value, old))
    if name in SET_CHOICES and value not in SET_CHOICES[name]:
        raise ValueError("%s: %r is not one of %s" % (name, value, SET_CHOICES[name]))
    if name in SET_RANGES and not SET_RANGES[name][0] <= value <= SET_RANGES[name][1]:
        raise ValueError("%s: %r is outside %s..%s" % ((name, value) + SET_RANGES[name]))
    if isinstance(old, (int, float)) and not isinstance(old, bool):
        value = type(old)(value) if isinstance(old, float) else value
    if isinstance(params[name], dict):
        params[name]["value"] = value
    else:
        params[name] = value


def build_set(spec, template=SET_TEMPLATE):
    """A Move Set (Song.abl's JSON) from a spec: every pad from the
    template's dry first pad, then the spec's defaults, then the pad's own
    settings; and one clip on track 1 playing the pads in order."""
    song = json.load(open(template))
    cells = set_cells(song)
    pads = spec["pads"]
    if len(pads) != SET_PADS or len(cells) != SET_PADS:
        raise ValueError("a Set has %d pads: the spec has %d, the template %d" % (SET_PADS, len(pads), len(cells)))
    base = json.loads(json.dumps(cells[0][1]["parameters"]))
    spacing = float(spec.get("spacing_beats", 6))
    notes = []
    for i, ((chain, cell), pad) in enumerate(zip(cells, pads)):
        if not os.path.exists(os.path.join(WAVS, pad["sample"])):
            raise ValueError("pad %d: no test sound %s" % (i + 1, pad["sample"]))
        cell["parameters"] = json.loads(json.dumps(base))
        for k, v in list(spec.get("defaults", {}).items()) + list(pad.get("params", {}).items()):
            try:
                set_param(cell, k, v)
            except ValueError as e:
                raise ValueError("pad %d: %s" % (i + 1, e))
        cell["deviceData"]["sampleUri"] = SET_SAMPLE_URI + urllib.parse.quote(pad["sample"])
        beats = pad["gate_s"] * float(spec["tempo"]) / 60 if "gate_s" in pad else SET_NOTE_BEATS
        notes.append({"noteNumber": chain["drumZoneSettings"]["receivingNote"], "startTime": i * spacing,
                      "duration": beats, "velocity": 127.0, "offVelocity": 0.0})
    song["tempo"] = float(spec["tempo"])
    end = SET_PADS * spacing
    song["tracks"][0]["clipSlots"][0]["clip"] = {
        "isPlaying": True, "name": spec.get("name", ""), "color": 6, "isEnabled": True,
        "region": {"start": 0.0, "end": end, "loop": {"start": 0.0, "end": end, "isEnabled": False}},
        "grooveId": None, "stepEditorScrollPosition": 0.0, "notes": notes}
    return song


def cmd_make_set(spec_path, outdir, host=None):
    spec = json.load(open(spec_path))
    try:
        song = build_set(spec)
    except ValueError as e:
        sys.exit("make-set: %s" % e)
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, "Song.abl")
    json.dump(song, open(out, "w"), indent=2)
    print("%s: %s, %g BPM, a pad every %g s" % (out, spec["name"], spec["tempo"],
                                               spec.get("spacing_beats", 6) * 60 / spec["tempo"]))
    shown = ("Voice_Envelope_Mode", "Voice_Envelope_Attack", "Voice_Envelope_Hold", "Voice_Envelope_Decay", "Effect_Type")
    gates = {n["noteNumber"]: n["duration"] * 60 / spec["tempo"] for n in song["tracks"][0]["clipSlots"][0]["clip"]["notes"]}
    for note, sample, p in drum_pads(song):
        print("  %2d %-18s %s%s" % (note - 35, sample, "  ".join("%s %s" % (k.split("_")[-1], p.get(k)) for k in shown),
                                    "  released after %g s" % gates[note] if p.get("Voice_Envelope_Mode") == "A-S-R" else ""))
    if host:
        install_set(out, spec["name"], host)


def install_set(song_path, name, host):
    """Put a Set on the Move the way Schwung's test harness does: a new
    Sets/<uuid>/<name>/Song.abl with the xattrs Move keeps on a Set. Move
    lists it after a restart."""
    import uuid
    ssh = ["ssh", "-o", "BatchMode=yes", host]
    names = subprocess.run(ssh + ["ls -1 %s/*/ 2>/dev/null" % DEVICE_SETS], capture_output=True, text=True).stdout
    if name in {x.strip().rstrip("/") for x in names.splitlines()}:
        sys.exit("make-set: the Move already has a Set named %r" % name)
    subprocess.run(ssh + ["mkdir -p %s" % DEVICE_SET_STAGING], check=True)
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", song_path, "%s:%s/Song.abl" % (host, DEVICE_SET_STAGING)], check=True)
    set_dir = "%s/%s" % (DEVICE_SETS, uuid.uuid4())
    inner = "%s/%s" % (set_dir, name)
    q = shlex.quote
    script = "; ".join([
        "set -e",
        "used=$(for d in %s/*/; do getfattr -n user.song-index --only-values \"$d\" 2>/dev/null; echo; done"
        " | grep -E '^[0-9]+$' | sort -n | tail -n 1)" % DEVICE_SETS,
        "mkdir -p %s" % q(inner),
        "cp %s/Song.abl %s/Song.abl" % (DEVICE_SET_STAGING, q(inner)),
        "chown -R ableton:users %s" % q(set_dir),
        "setfattr -n user.song-index -v $(( ${used:-999} + 1 )) %s" % q(set_dir),
        "setfattr -n user.last-modified-time -v $(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ) %s" % q(set_dir),
        "setfattr -n user.local-cloud-state -v notSynced %s" % q(set_dir),
        "setfattr -n user.song-color -v 3 %s" % q(set_dir),
        "setfattr -n user.was-externally-modified -v false %s" % q(set_dir),
        "rm %s/Song.abl" % DEVICE_SET_STAGING,
        "ls -l %s" % q(inner),
        "getfattr -d %s" % q(set_dir),
    ])
    r = subprocess.run(ssh + [script], capture_output=True, text=True)
    print(r.stdout + r.stderr)
    if r.returncode:
        sys.exit("make-set: install failed")
    print("installed as %s. Restart Move to see it in the Set list." % inner)


# ---------------------------------------------------------------- device-check

DEVICE_DIR = "/data/UserData/livechopper-fxcheck"   # never /tmp on the Move (CLAUDE.md)
DEVICE_TOLERANCE = 1                                # LSB


def cmd_device_check(outdirs, host):
    """Every pad of outdirs rendered on the Move and on the host: 0 if
    they match within DEVICE_TOLERANCE."""
    jobs = []
    for outdir in outdirs:
        for pc in json.load(open(os.path.join(outdir, "pads.json")))["pieces"]:
            settings = dsp_settings(pc["params"])
            where = os.path.join(*os.path.normpath(os.path.abspath(outdir)).split(os.sep)[-2:])
            jobs.append((pc["sample"], settings, pc["frames"], "%s %s" % (where, pc["piece"])))
            if gain_effect(pc["params"]):
                jobs.append((pc["sample"], dry_settings(settings), pc["frames"], jobs[-1][3] + " (dry)"))
    local = os.path.join(REPO, "build", "device_check")
    shutil.rmtree(local, ignore_errors=True)
    os.makedirs(os.path.join(local, "host"))
    arm = os.path.join(REPO, "build", "fx_render_arm")
    # build.sh's flags for dsp.so, as an executable linked to the Move's libm
    subprocess.check_call(["aarch64-linux-gnu-gcc", "-std=c11", "-O2", "-march=armv8-a", "-mtune=cortex-a72",
                           "-fomit-frame-pointer", "-fno-stack-protector", "-DNDEBUG",
                           "-I" + os.path.join(REPO, "src", "dsp"), os.path.join(REPO, "tools", "fxlab", "fx_render.c"),
                           "-o", arm, "-lm", "-lpthread"])
    build_render()
    script = ["set -e", "cd " + DEVICE_DIR, "mkdir -p out"]
    for k, (sample, settings, frames, _) in enumerate(jobs):
        render_pad(sample, settings, frames, os.path.join(local, "host", "%03d.wav" % k), quiet=True)
        script.append(" ".join(shlex.quote(a) for a in
                               ["./fx_render", sample, "out/%03d.wav" % k, "%.6f" % (frames / RATE)] + settings)
                      + " > /dev/null")
    open(os.path.join(local, "run.sh"), "w").write("\n".join(script) + "\n")
    samples = sorted({j[0] for j in jobs})
    print("rendering %d pads on %s ..." % (len(jobs), host))
    subprocess.check_call(["ssh", host, "rm -rf %s && mkdir -p %s" % (DEVICE_DIR, DEVICE_DIR)])
    subprocess.check_call(["scp", "-q", arm, "%s:%s/fx_render" % (host, DEVICE_DIR)])
    subprocess.check_call(["scp", "-q", os.path.join(local, "run.sh")] + [os.path.join(WAVS, x) for x in samples]
                          + ["%s:%s/" % (host, DEVICE_DIR)])
    subprocess.check_call(["ssh", host, "sh %s/run.sh" % DEVICE_DIR])
    subprocess.check_call(["scp", "-q", "-r", "%s:%s/out" % (host, DEVICE_DIR), os.path.join(local, "device")])
    subprocess.check_call(["ssh", host, "rm -rf %s" % DEVICE_DIR])
    worst_all, fails = 0, 0
    for k, (_, _, _, label) in enumerate(jobs):
        a = wavfile.read(os.path.join(local, "host", "%03d.wav" % k))[1].astype(int)
        b = wavfile.read(os.path.join(local, "device", "%03d.wav" % k))[1].astype(int)
        worst = int(np.abs(a - b).max()) if a.shape == b.shape else None
        ok = worst is not None and worst <= DEVICE_TOLERANCE
        fails += not ok
        worst_all = max(worst_all, worst or 0)
        print("%-40s %s" % (label, "differs in length" if worst is None else "max %d LSB, %d frames differ %s" % (
            worst, int(np.count_nonzero(np.any(a != b, axis=-1))) if a.ndim > 1 else int(np.count_nonzero(a != b)),
            "PASS" if ok else "FAIL")))
    print("%s: %d pads, worst %d LSB (limit %d)" % ("PASS" if fails == 0 else "FAIL", len(jobs), worst_all, DEVICE_TOLERANCE))
    return 0 if fails == 0 else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split"); s.add_argument("take"); s.add_argument("rest", nargs="+", metavar="[song] outdir")
    s.add_argument("--like", help="<outdir>:NN,NN,...: pads copied from an existing split Set, for a preview take")
    s = sub.add_parser("render"); s.add_argument("outdir")
    s = sub.add_parser("compare"); s.add_argument("outdir"); s.add_argument("--gain", type=float)
    s = sub.add_parser("all"); s.add_argument("take"); s.add_argument("song"); s.add_argument("outdir")
    s.add_argument("--gain", type=float)
    s = sub.add_parser("check"); s.add_argument("outdir"); s.add_argument("--gain", type=float)
    s.add_argument("--ours-take", help="a preview take split --like outdir, in place of the renders")
    s = sub.add_parser("refs"); s.add_argument("outdir"); s.add_argument("--dest", default=REFS)
    s.add_argument("--seed", type=int)
    s.add_argument("--name", help="the folder for a Set with no effect, e.g. envelope")
    s = sub.add_parser("refs-check"); s.add_argument("folder", nargs="?", default=REFS)
    s = sub.add_parser("accept-set"); s.add_argument("effect"); s.add_argument("--seed", type=int, required=True)
    s.add_argument("--pads", type=int, default=8)
    s = sub.add_parser("make-set"); s.add_argument("spec"); s.add_argument("outdir")
    s.add_argument("--install", metavar="HOST", help="also put it on the Move, e.g. root@192.168.4.45")
    s = sub.add_parser("device-check"); s.add_argument("outdir", nargs="+")
    s.add_argument("--host", default="root@192.168.4.45")
    s = sub.add_parser("ab", usage="fxlab.py ab make <outdir> <preview outdir> [--seed N]\n"
                       "       fxlab.py ab score <ab dir> <answers> [--accept N,N,...]")
    s.add_argument("step", choices=["make", "score"]); s.add_argument("args", nargs=2)
    s.add_argument("--seed", type=int)
    s.add_argument("--accept", default="", help="pairs whose heard difference is accepted: N,N,...")
    a = ap.parse_args()
    if a.cmd == "split":
        if a.like and len(a.rest) == 1:
            cmd_split(a.take, None, a.rest[0], like=a.like)
        elif not a.like and len(a.rest) == 2:
            cmd_split(a.take, a.rest[0], a.rest[1])
        else:
            sys.exit("split: <take> <song> <outdir>, or <take> --like <outdir>:NN,... <outdir>")
    if a.cmd == "all":
        cmd_split(a.take, a.song, a.outdir)
    if a.cmd in ("render", "all"):
        cmd_render(a.outdir)
    if a.cmd in ("compare", "all"):
        cmd_compare(a.outdir, a.gain)
    if a.cmd == "check":
        sys.exit(cmd_check(a.outdir, a.gain, a.ours_take))
    if a.cmd == "refs":
        cmd_refs(a.outdir, a.dest, a.seed, a.name)
    if a.cmd == "refs-check":
        sys.exit(cmd_refs_check(a.folder))
    if a.cmd == "accept-set":
        cmd_accept_set(a.effect, a.seed, a.pads)
    if a.cmd == "make-set":
        cmd_make_set(a.spec, a.outdir, a.install)
    if a.cmd == "device-check":
        sys.exit(cmd_device_check(a.outdir, a.host))
    if a.cmd == "ab" and a.step == "make":
        cmd_ab_make(a.args[0], a.args[1], a.seed)
    if a.cmd == "ab" and a.step == "score":
        sys.exit(cmd_ab_score(a.args[0], a.args[1], {int(x) for x in a.accept.split(",") if x}))


if __name__ == "__main__":
    main()
