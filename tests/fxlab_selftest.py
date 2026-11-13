#!/usr/bin/env python3
"""tools/fxlab/fxlab.py's gate (check, refs, refs-check) on synthetic takes:
"Move" here is plugin.c's own render, at Move's dry level and 32 frames
late, so a clean take must pass and a known change must fail. Run with
build/.venv/bin/python after tools/fxlab/make_test_wavs.py (scripts/test.sh).
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from scipy import signal

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tools", "fxlab"))
import fxlab  # noqa: E402

OUT = os.path.join(REPO, "build", "fxlab_selftest")
LAG = 32
failures = 0


def check(cond, msg):
    global failures
    if not cond:
        failures += 1
        print("FAIL: " + msg)


def params(effect="Stretch", a=None, b=None):
    """A pad's Drum Sampler settings: the step 4 baseline, every effect at
    Move's defaults, then this effect's two settings."""
    p = {"Voice_Envelope_Attack": 0.0001, "Voice_Envelope_Hold": 60.0, "Voice_Envelope_Decay": 0.05,
         "Voice_Envelope_Mode": "A-H-D", "Voice_Filter_Type": "Lowpass", "Voice_Filter_Frequency": 22000.0,
         "Voice_Filter_Resonance": 0.0, "Voice_Filter_PeakGain": 1.0, "Voice_Transpose": 0, "Voice_Detune": 0.0,
         "Voice_Gain": 1.0, "Effect_StretchFactor": 1.0, "Effect_PunchAmount": 0.0,
         "Effect_PitchEnvelopeAmount": 0.0, "Effect_Type": effect}
    e = [x for x in fxlab.EFFECTS if x[0] == effect][0]
    if a is not None:
        p[e[1]], p[e[2]] = a, b
    return p


def make_set(name, pads, change=None, move_params=None):
    """A split Set: each pad's "Move" piece is ours at Move's level, LAG
    frames late; change(k, piece) may alter pad k's, and move_params[k]
    renders pad k's piece at other settings than the pad records."""
    d = os.path.join(OUT, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    fxlab.build_render()
    pieces = []
    for k, (sample, p) in enumerate(pads):
        frames = int(2.1 * fxlab.RATE)
        tmp = os.path.join(d, "tmp.wav")
        rp = (move_params or {}).get(k, p)
        fxlab.render_pad(sample, fxlab.dsp_settings(rp), frames, tmp, quiet=True)
        v = fxlab.read_mono(tmp) * fxlab.DEFAULT_GAIN
        if change:
            v = change(k, v)
        v = np.concatenate([np.zeros(LAG), v])[:frames]
        piece = "%02d_%s" % (k + 1, sample)
        fxlab.write_mono(os.path.join(d, piece), v)
        pieces.append({"piece": piece, "note": 36 + k, "sample": sample, "start": 0, "frames": frames, "params": p})
    os.remove(tmp)
    json.dump({"pieces": pieces}, open(os.path.join(d, "pads.json"), "w"))
    return d


def run(*args):
    return subprocess.run([sys.executable, os.path.join(REPO, "tools", "fxlab", "fxlab.py")] + list(args),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def verdicts(d):
    rows = json.load(open(os.path.join(d, "check.json")))["rows"]
    return [{n: m["verdict"] for n, m in r["metrics"].items()} for r in rows], rows


PUNCH = [("sine_441.wav", params()),
         ("sine_441.wav", params("Punch", 1.0, 0.12016)),
         ("sine_441.wav", params("Punch", 0.5, 1.0)),
         ("drum_synth.wav", params("Punch", 0.75, 0.3)),
         ("position_ramp.wav", params()),
         ("sine_441.wav", params("Punch", 1.0, 0.12016))]    # pad 2 again

# 1. ours against itself passes, with (almost) no error and no repeat floor
clean = make_set("clean", PUNCH)
r = run("check", clean)
v, rows = verdicts(clean)
check(r.returncode == 0, "a clean take passes check:\n" + r.stdout)
check([sorted(x) for x in v] == [["bands", "pitch"], ["bands", "gain", "pitch"], ["bands", "gain", "pitch"],
                                 ["bands"], ["bands", "position"], ["bands", "gain", "pitch"]],
      "the metrics that apply to each pad: %s" % v)
worst = max(m["stats"]["max"] for row in rows for m in row["metrics"].values() if m["stats"])
check(worst < 0.05, "a clean take's largest error is ~0 (%.3f)" % worst)
floors = json.load(open(os.path.join(clean, "check.json")))["floors"]
check(set(floors) == {"gain", "pitch", "bands"} and max(f["max"] for f in floors.values()) < 0.05,
      "pads 2 and 6 are a repeat, with no difference: %s" % floors)

# 2. +1 dB on pad 3 fails its gain
loud = make_set("loud", PUNCH, lambda k, x: x * 10 ** (1 / 20) if k == 2 else x)
r = run("check", loud)
v, _ = verdicts(loud)
check(r.returncode == 1 and v[2]["gain"] == "FAIL" and v[1]["gain"] == "PASS",
      "+1 dB on pad 3 fails its gain only: %s" % v[2])

# 3. 10 cents sharp fails pitch
sharp = make_set("sharp", [("sine_441.wav", params()), ("sine_441.wav", params("Pitch Env", 0.5, 0.3))],
                 lambda k, x: np.interp(np.arange(len(x)) * 2 ** (10 / 1200), np.arange(len(x)), x) if k == 1 else x)
r = run("check", sharp)
v, _ = verdicts(sharp)
check(r.returncode == 1 and v[1]["pitch"] == "FAIL" and v[0]["pitch"] == "PASS",
      "10 cents sharp fails pitch: %s" % v)

# 4. refs, then refs-check: passes as saved, fails when Move's curve moves
refs = os.path.join(OUT, "refs")
shutil.rmtree(refs, ignore_errors=True)
r = run("refs", clean, "--dest", refs, "--seed", "7")
check(r.returncode == 0 and len(os.listdir(os.path.join(refs, "punch"))) == len(PUNCH), "refs saves each pad:\n" + r.stdout)
r = run("refs-check", refs)
check(r.returncode == 0, "refs-check passes on what refs saved:\n" + r.stdout)
path = os.path.join(refs, "punch", "02_sine_441.json")
ref = json.load(open(path))
check(ref["seed"] == 7 and ref["dry"] and "gain" in ref["metrics"], "a reference keeps its seed, dry render and gain")
ref["metrics"]["gain"]["move"]["v"] = [x + 1.0 for x in ref["metrics"]["gain"]["move"]["v"]]
json.dump(ref, open(path, "w"))
r = run("refs-check", refs)
check(r.returncode == 1 and "FAIL" in r.stdout, "refs-check fails when a curve is off by 1 dB:\n" + r.stdout)
r = run("refs", loud, "--dest", refs)
check(r.returncode != 0, "refs refuses a Set that failed its check")

# 5. A preview take (as Skipback records LiveChopper on the Move): pads of
# the clean Set played into one take, at another level, with gaps.
def preview_take(name, change=None):
    """A take of clean's pads 1-3 rendered at 0.9, 0.8 s apart; split
    --like clean:01,02,03 into OUT/<name>."""
    parts = []
    for k, (sample, p) in enumerate(PUNCH[:3]):
        tmp = os.path.join(OUT, "tmp.wav")
        fxlab.render_pad(sample, fxlab.dsp_settings(p), int(2.1 * fxlab.RATE), tmp, quiet=True)
        v = fxlab.read_mono(tmp) * 0.9
        if change:
            v = change(k, v)
        parts += [np.zeros(int(0.8 * fxlab.RATE)), v]
    os.remove(tmp)
    take = os.path.join(OUT, name + ".wav")
    fxlab.write_mono(take, np.concatenate(parts + [np.zeros(int(0.5 * fxlab.RATE))]))
    d = os.path.join(OUT, name)
    shutil.rmtree(d, ignore_errors=True)
    return run("split", take, "--like", clean + ":01,02,03", d), d


r, prev = preview_take("preview")
meta = json.load(open(os.path.join(prev, "pads.json")))
check(r.returncode == 0 and [pc["params"] for pc in meta["pieces"]] == [p for _, p in PUNCH[:3]]
      and meta["like"]["pieces"] == ["01_sine_441.wav", "02_sine_441.wav", "03_sine_441.wav"],
      "split --like cuts the take into clean's pads 1-3:\n" + r.stdout)
r = run("check", prev)
check(r.returncode == 0, "check on the preview take alone (against the render) passes:\n" + r.stdout)
r = run("check", clean, "--ours-take", prev)
res = json.load(open(os.path.join(clean, "check_vs_preview.json")))
worst = max(m["stats"]["max"] for row in res["rows"] for m in row["metrics"].values() if m["stats"])
check(r.returncode == 0 and len(res["rows"]) == 3 and worst < 0.05,
      "check --ours-take passes a preview that matches, ~0 error (%.3f):\n%s" % (worst, r.stdout))
r, prev_loud = preview_take("preview_loud", lambda k, x: x * 10 ** (1 / 20) if k == 2 else x)
r = run("check", clean, "--ours-take", prev_loud)
rows = json.load(open(os.path.join(clean, "check_vs_preview_loud.json")))["rows"]
check(r.returncode == 1 and rows[2]["metrics"]["gain"]["verdict"] == "FAIL"
      and rows[1]["metrics"]["gain"]["verdict"] == "PASS",
      "check --ours-take fails +1 dB on the preview's pad 3:\n" + r.stdout)

# 6. Pitch Env (PLAN "Pitch Env Set"): the zero-crossing pitch lags a fast
# bend by up to hundreds of cents, but Move's take and ours go through the
# same tracker, so a take that differs only as Move's capture does (the
# 4-frame attack ramp, Low-Pass 24 at 22 kHz, half a frame late) passes,
# and a real difference fails: 23 st for 24, or a 5 ms Decay at 5.5 ms,
# which only the pitch metric sees.
def movelike(k, x):
    x = x.copy()
    x[:4] *= [0.25, 0.49, 0.76, 0.99]
    x = signal.sosfilt(signal.butter(4, 22000 / 22050, output="sos"), x)
    n = 1 << int(np.ceil(np.log2(len(x) + 4096)))
    f = np.fft.rfft(x, n)
    return np.fft.irfft(f * np.exp(-1j * np.pi * np.arange(len(f)) / n), n)[:len(x)]


PITCH_ENV = [("sine_441.wav", params()),
             ("sine_441.wav", params("Pitch Env", 1.0, 2.0)),
             ("sine_441.wav", params("Pitch Env", 1.0, 0.005)),
             ("sine_441.wav", params("Pitch Env", -1.0, 0.3)),
             ("position_ramp.wav", params("Pitch Env", 1.0, 0.3))]
pe = make_set("pitch_env", PITCH_ENV, movelike)
r = run("check", pe)
v, rows = verdicts(pe)
check(r.returncode == 0, "Pitch Env against a Move-like copy of itself passes:\n" + r.stdout)
off = make_set("pitch_env_off", PITCH_ENV, movelike,
               {1: params("Pitch Env", 23 / 24, 2.0), 2: params("Pitch Env", 1.0, 0.0055),
                4: params("Pitch Env", 23 / 24, 0.3)})
r = run("check", off)
v, _ = verdicts(off)
check(r.returncode == 1 and v[1]["pitch"] == "FAIL" and v[2]["pitch"] == "FAIL"
      and v[3]["pitch"] == "PASS" and v[4]["position"] == "FAIL",
      "23 st for 24, and Decay 5.5 ms for 5 ms, fail: %s" % v)

print("fxlab self-test: %s" % ("all passed" if failures == 0 else "%d failed" % failures))
sys.exit(1 if failures else 0)
