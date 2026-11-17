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

# The listening A/B (PLAN "When an effect is done"): pairs of Move's piece
# and the preview's at the same level (the preview take here is at 0.9,
# "Move" at 0.8465), in an order the seed repeats; scoring passes with
# nothing heard, and a difference heard fails until it is accepted.
r = run("ab", "make", clean, prev, "--seed", "5")
ab = os.path.join(prev, "ab")
key = json.load(open(os.path.join(ab, "key.json")))
gaps = []
for p in key["pairs"]:
    v = fxlab.read_mono(os.path.join(ab, p["file"]))
    h = (len(v) - int(fxlab.AB_GAP_S * fxlab.RATE)) // 2
    a, b = v[:h][:20000], v[-h:][:20000]
    gaps.append(abs(10 * np.log10(np.mean(a ** 2) / np.mean(b ** 2))))
order = [p["move"] for p in key["pairs"]]
run("ab", "make", clean, prev, "--seed", "5")
again = [p["move"] for p in json.load(open(os.path.join(ab, "key.json")))["pairs"]]
check(r.returncode == 0 and len(order) == 3 and max(gaps) < 0.05 and order == again,
      "ab make writes 3 level-matched pairs (worst %.3f dB), the same order for the same seed:\n%s"
      % (max(gaps), r.stdout))
nothing = run("ab", "score", ab, "...")
heard = run("ab", "score", ab, ".." + order[2])
named = json.load(open(os.path.join(ab, "result.json")))["rows"][2]["named_move"]
accepted = run("ab", "score", ab, ".." + order[2], "--accept", "3")
bad = run("ab", "score", ab, "..")
check(nothing.returncode == 0 and heard.returncode == 1 and named and accepted.returncode == 0
      and bad.returncode != 0,
      "ab score: nothing heard passes, a difference heard fails until accepted, a short answer is refused:\n"
      + nothing.stdout + heard.stdout + accepted.stdout + bad.stdout)

# 6. Pitch Env (NOTES "Pitch Env"): the zero-crossing pitch lags a fast
# bend by up to hundreds of cents, but Move's take and ours go through the
# same tracker, so a take that differs only as Move's capture does (the
# 4-frame attack ramp, Low-Pass 24 at 22 kHz) passes, and a real
# difference fails: 47 st for 48, or a 5 ms Decay at 5.5 ms, which only the
# pitch metric sees. Move's capture is whole frames late: Set 32's dry sine
# leaves 5 LSB at lag 31, where half a frame would leave ~300.
def movelike(k, x):
    x = x.copy()
    x[:4] *= [0.25, 0.49, 0.76, 0.99]
    return signal.sosfilt(signal.butter(4, 22000 / 22050, output="sos"), x)


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
               {1: params("Pitch Env", 47 / 48, 2.0), 2: params("Pitch Env", 1.0, 0.0055),
                4: params("Pitch Env", 47 / 48, 0.3)})
r = run("check", off)
v, _ = verdicts(off)
check(r.returncode == 1 and v[1]["pitch"] == "FAIL" and v[2]["pitch"] == "FAIL"
      and v[3]["pitch"] == "PASS" and v[4]["position"] == "FAIL",
      "47 st for 48, and Decay 5.5 ms for 5 ms, fail: %s" % v)
# refs --waive: a failing Set is refused unless every failure is waived;
# a waived metric is left out of its ref, which names it.
_, offrows = verdicts(off)
fails = ["%s:%s" % (r["piece"].rsplit(".", 1)[0], n) for r in offrows
         for n, m in r["metrics"].items() if m["verdict"] == "FAIL"]
wdest = os.path.join(OUT, "waive_refs")
part = run("refs", off, "--dest", wdest, "--seed", "1", *sum((["--waive", f] for f in fails[1:]), []))
full = run("refs", off, "--dest", wdest, "--seed", "1", *sum((["--waive", f] for f in fails), []))
wpiece, wmetric = fails[0].split(":")
wref = json.load(open(os.path.join(wdest, "pitch_env", wpiece + ".json")))
check(len(fails) >= 2 and part.returncode != 0 and full.returncode == 0 and wmetric not in wref["metrics"]
      and wmetric in wref["waived"], "refs --waive: only with every failure waived, and the ref says so:\n"
      + part.stdout + full.stdout)

# make-set: the Set split reads back is the spec, and its clip plays it.
spec = {"name": "Selftest", "tempo": 120, "spacing_beats": 6,
        "defaults": {"Voice_Envelope_Hold": 0.1, "Effect_Type": "Stretch", "Effect_StretchFactor": 1.0},
        "pads": [{"sample": "sine_441.wav", "params": {"Voice_Envelope_Decay": 0.01 * (i + 1)}} for i in range(16)]}
spec["pads"][3] = {"sample": "position_ramp.wav", "params": {"Voice_Envelope_Mode": "A-S-R"}, "gate_s": 0.5}
song = json.loads(json.dumps(fxlab.build_set(spec)))
pads = fxlab.drum_pads(song)
check([p[1] for p in pads] == [x["sample"] for x in spec["pads"]], "make-set: samples in pad order")
check(abs(pads[1][2]["Voice_Envelope_Decay"] - 0.02) < 1e-9 and pads[1][2]["Voice_Envelope_Hold"] == 0.1
      and pads[1][2]["Effect_FmAmount"] == 0.0, "make-set: a pad's settings over the defaults over the dry pad")
check(pads[3][2]["Voice_Envelope_Mode"] == "A-S-R", "make-set: Gate mode")
notes = song["tracks"][0]["clipSlots"][0]["clip"]["notes"]
check([n["startTime"] for n in notes] == [6.0 * i for i in range(16)]
      and [n["noteNumber"] for n in notes] == [p[0] for p in pads] and notes[3]["duration"] == 1.0,
      "make-set: one note a pad, 6 beats apart, the Gate pad held 0.5 s")
# FM that reverses the read, slow against the band window, averages its bands.
fmp = lambda amt, hz: {"Effect_Type": "FM", "Effect_FmAmount": amt, "Effect_FmFrequency": hz}
check(fxlab.fm_reverses(fmp(0.77, 20.15)) and fxlab.fm_reverses(fmp(1.0, 10.0)) and not fxlab.fm_reverses(fmp(0.5, 100.0))
      and not fxlab.fm_reverses(fmp(0.05, 10.0)), "fm_reverses: deep and under 43 Hz only")
# accept-set --spec: the draw as a make-set spec, pad 1 dry, pad 16 repeating pad 2.
drawn = [[["%d %%" % k, k / 20.0, 0], ["%d Hz" % (10 + k), 10.0 + k, 0], ["%d ms" % (k + 1), (k + 1) / 1000.0, 0]]
         for k in range(14)]
aspec = fxlab.accept_spec("FM", 7, drawn, ["sine_441", "position_ramp", "drum_synth"],
                          fxlab.KNOBS_FOR["FM"] + (("decay", "Decay"),))
apads = fxlab.drum_pads(fxlab.build_set(aspec))
check(len(apads) == 16 and apads[0][2]["Effect_Type"] == "Stretch" and apads[15][2] == apads[1][2]
      and apads[3][1] == "drum_synth.wav" and apads[5][2]["Effect_FmAmount"] == 0.2
      and apads[5][2]["Effect_FmFrequency"] == 14.0 and abs(apads[5][2]["Voice_Envelope_Decay"] - 0.005) < 1e-12
      and apads[5][2]["Voice_Envelope_Hold"] == 60.0 and apads[5][2]["Voice_Envelope_Attack"] == fxlab.ACCEPT_ATTACK,
      "accept-set --spec: the drawn FM pads and their Decay, Hold Inf, Attack at its minimum")
# accept-set Loop: every pad ends before the next (a finite Hold or a gate,
# ended by 4.2 s at its pitch), Attack 1 ms on every pad, pad 16 repeats pad 2.
lspec_path = os.path.join(OUT, "loop_accept.json")
lrun = run("accept-set", "Loop", "--seed", "5", "--spec", lspec_path)
lspec = json.load(open(lspec_path)) if lrun.returncode == 0 else {"pads": []}
lpads = lspec["pads"]


def loop_ends(p, pad):
    q = dict(lspec.get("defaults", {}), **p)
    r = 2 ** (q.get("Voice_Transpose", 0) / 12)
    if q.get("Voice_Envelope_Mode") == "A-S-R":
        return pad.get("gate_s", 1e9) + q["Voice_Envelope_Decay"]
    return (q["Voice_Envelope_Attack"] + q["Voice_Envelope_Hold"] + q["Voice_Envelope_Decay"]) / r


check(lrun.returncode == 0 and len(lpads) == 16 and lpads[15] == lpads[1]
      and all(p["params"]["Effect_Type"] == "Loop" and p["params"]["Voice_Envelope_Attack"] == 0.001
              and loop_ends(p["params"], p) <= fxlab.TRANSPOSE_MAX_S for p in lpads[1:])
      and sum(p["params"].get("Voice_Envelope_Mode") == "A-S-R" for p in lpads[1:15]) == len(fxlab.LOOP_GATE_PADS)
      and sum(bool(p["params"].get("Voice_Transpose")) for p in lpads[1:15]) == len(fxlab.LOOP_TRANSPOSE_PADS),
      "accept-set Loop: finite Holds or gates, ending in time, Attack 1 ms, the gates and transposed pads:\n"
      + lrun.stdout[-500:])
rel = fxlab.clip_releases(song)
check(abs(rel[pads[3][0]] - 0.5) < 1e-9, "split: a Gate pad's release time comes from the clip: %s" % rel.get(pads[3][0]))
pc = {"params": pads[3][2], "release_s": rel[pads[3][0]]}
check(fxlab.piece_settings(pc)[-1] == "release=0.500000" and fxlab.piece_settings(dict(pc, params=pads[2][2]))
      == fxlab.dsp_settings(pads[2][2]), "render: only a Gate pad is released, at the clip's time")
for bad in ({"Voice_Envelope_Decya": 0.1}, {"Voice_Envelope_Decay": 0.0}, {"Voice_Envelope_Mode": "ADSR"}):
    try:
        fxlab.build_set(dict(spec, defaults=bad))
        check(False, "make-set refuses %s" % bad)
    except ValueError:
        pass

# The noise metric: quiet noise on a sine (Set 44 pad 2's, ~45 dB under
# it), Move's dry path a fiftieth of a frame and 0.05 % off ours. The same
# noise level passes; 3.5 dB more fails; a sound one block long still
# gets its one block.
rng = np.random.default_rng(7)
nt = np.arange(2 * fxlab.RATE)
dry = 1100 * np.sin(2 * np.pi * 441 * nt / fxlab.RATE)
mdry = 1.0005 * 1100 * np.sin(2 * np.pi * 441 * (nt - 0.02) / fxlab.RATE)
nc = {"dry": dry, "end_ms": 1900.0}


def noise_err(gain_db, c=nc):
    mv = fxlab.curve_noise(mdry + 3.0 * rng.standard_normal(len(nt)), c)
    ov = fxlab.curve_noise(dry + 3.0 * 10 ** (gain_db / 20) * rng.standard_normal(len(nt)), c)
    ref = fxlab.store_curve("noise", *mv, c["end_ms"])
    return fxlab.judge("noise", fxlab.curve_error("noise", ref, *ov), 1.0, 3.0)


same, louder = noise_err(0.0), noise_err(3.5)
short = noise_err(0.0, {"dry": dry, "end_ms": 150.0})
check(same[1] == "PASS" and louder[1] == "FAIL" and abs(louder[0]["rms"] - 3.5) < 0.3
      and short[0] is not None and short[1] == "PASS",
      "noise metric: same level passes, 3.5 dB louder fails, one short block counts: %s %s %s" % (same, louder, short))

# 8-Bit pads compare bands averaged over CRUSH_BAND_GROUP windows: one
# white noise with a different noise 10 dB under it on each side
# (standing in for its by-products, which turn over with timing) passes
# there and fails window by window; 1.5 dB louder still fails. (Over 12
# seeds at 10.5 dB under, all three hold; at 9 dB the averaged max swings
# past 3 dB on a few: the narrowest low bands hold under one FFT bin.)
crush = {"Effect_Type": "8-bit", "Effect_EightBitResamplingRate": 14080.0, "Effect_EightBitFilterDecay": 5.0}
shared = 3000 * rng.standard_normal(2 * fxlab.RATE)
w1, w2 = (shared + 0.3 * 3000 * rng.standard_normal(2 * fxlab.RATE) for _ in range(2))


def bands_err(p, ours_gain_db=0.0):
    c = {"params": p, "end_ms": 1900.0}
    ref = fxlab.store_curve("bands", *fxlab.curve_bands(w1, c), c["end_ms"])
    return fxlab.judge("bands", fxlab.curve_error("bands", ref, *fxlab.curve_bands(w2 * 10 ** (ours_gain_db / 20), c)),
                       1.0, 3.0)[1]


got = (bands_err(crush), bands_err(params()), bands_err(crush, 1.5))
check(got == ("PASS", "FAIL", "FAIL"), "8-Bit bands: averaged noise passes, per window fails, 1.5 dB louder fails: %s" % (got,))

# The position metric fits each pad's level and divides out its envelope
# (Set 48 pads 3 and 9): position_ramp read at rate 1 under a 20 ms
# Attack, 10 ms Hold and a decay, "Move" 0.3 % louder, passes. Move's read
# slipping 3 ms from 150 ms on, under the decay at 0.33, fails, and would
# pass (~1 ms) with the envelope left in; Move reading 2 % fast fails. A
# Hold after an Attack under 1 ms is left out (Move's level climbs there).
pn = int(0.4 * fxlab.RATE)
pt = np.arange(pn) / fxlab.RATE
penv = np.where(pt < 0.02, pt / 0.02, np.where(pt < 0.03, 1.0, 10 ** (-4 * (pt - 0.03))))
pramp = lambda rate, slip=0: -16000 + 32000 * (rate * np.arange(pn) - slip * (pt >= 0.15)) / 88199
pp = params()
pp.update({"Voice_Envelope_Attack": 0.02, "Voice_Envelope_Hold": 0.01})


def position_verdict(move, env):
    m = fxlab.measure("position_ramp.wav", pp, move, penv * pramp(1.0), None, 380.0,
                      None if env is None else env * fxlab.ENV_DC)
    return fxlab.judge("position", m["position"][3], 1.0, 2.0)[1]


got = (position_verdict(1.003 * penv * pramp(1.0), penv), position_verdict(penv * pramp(1.0, 132), penv),
       position_verdict(penv * pramp(1.0, 132), None), position_verdict(penv * pramp(1.02), penv))
check(got == ("PASS", "FAIL", "PASS", "FAIL"),
      "position: 0.3 %% louder passes, a 3 ms slip under the decay fails (passes with the envelope left in), "
      "2 %% fast fails: %s" % (got,))
# The level fit follows Move's climb over a finite Hold: one level to the
# Attack's end, a straight line over the Hold, then the second level.
u = fxlab.hold_ramp(dict(pp, Voice_Envelope_Attack=0.001, Voice_Envelope_Hold=0.002, Voice_Transpose=12), 200)
check(u[22] == 0.0 and abs(u[44] - 0.5) < 0.02 and u[70] == 1.0 and not fxlab.hold_ramp(params(), 200).any(),
      "hold_ramp: 0 to Attack/2, 1 after (Attack + Hold)/2 at +12, all 0 at Hold Inf: %s" % (u[[22, 44, 70]],))
climb = penv * pramp(1.0) * (0.98 + 0.02 * fxlab.hold_ramp(pp, pn))
check(position_verdict(climb, penv) == "PASS", "position: Move's level climbing 2 %% over the Hold passes")

print("fxlab self-test: %s" % ("all passed" if failures == 0 else "%d failed" % failures))
sys.exit(1 if failures else 0)
