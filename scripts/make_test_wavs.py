#!/usr/bin/env python3
"""Test sounds for tuning the effect stand-ins against Move (docs/PLAN.md,
"Step 4"). Each file is mono, 44.1 kHz, 16-bit, like Move's own samples,
and starts with a step or click at frame 0 so recordings of Move's output
can be lined up with renders of plugin.c.

    scripts/make_test_wavs.py [out_dir]     (default: build/test_wavs)
"""
import math
import os
import random
import struct
import sys
import wave

RATE = 44100
FULL = 32767


def db(x):
    return 10 ** (x / 20.0)


def fade_out(v, ms=5):
    """Fade the last ms to zero, so a file's end doesn't click."""
    n = int(RATE * ms / 1000)
    for i in range(n):
        v[len(v) - n + i] *= (n - 1 - i) / n
    return v


def sine_441():
    """441 Hz (100 frames a cycle), -6 dBFS, 2 s, cosine phase: a step at
    frame 0. Pitch over time (Pitch Env, FM, Stretch), Ring Mod's
    sidebands, Sub Osc's added tone, Punch's gain curve."""
    a = db(-6)
    return fade_out([a * math.cos(2 * math.pi * 441 * i / RATE) for i in range(2 * RATE)])


def sine_441_quiet():
    """sine_441 at -30 dBFS: whether Punch depends on the input level (a
    compressor would duck it less than sine_441; a fixed envelope the same)."""
    a = db(-30)
    return fade_out([a * math.cos(2 * math.pi * 441 * i / RATE) for i in range(2 * RATE)])


def click_train():
    """One-frame clicks at -1 dBFS every 100 ms, 2 s. Loop's Offset and
    Length, Stretch's grains, 8-Bit's rate and its Decay's low-pass."""
    v = [0.0] * (2 * RATE)
    for i in range(0, len(v), RATE // 10):
        v[i] = db(-1)
    return v


def silence_click():
    """One click at frame 0, then 2 s of silence. Sub Osc and Noise alone:
    their envelopes, levels and Noise Color, and whether Noise follows the
    sound's level."""
    v = [0.0] * (2 * RATE)
    v[0] = db(-1)
    return v


def noise_white():
    """White noise, -12 dBFS RMS (uniform), 2 s, seeded. 8-Bit Decay's
    low-pass closing and its bit-reduction floor, on a spectrogram."""
    rnd = random.Random(22222)
    a = db(-12) * math.sqrt(3)
    return fade_out([a * (2 * rnd.random() - 1) for _ in range(2 * RATE)])


def position_ramp():
    """A straight ramp from -16000 to +16000 over 2 s: each value says
    which frame was read (~2.76 frames per LSB). Stretch's grain
    positions, Loop's wrap, the playback rate under Pitch Env and FM. Only
    usable if Move's dry path passes it cleanly (check with Stretch 1.00
    first: a DC blocker would bend it)."""
    n = 2 * RATE
    return [(-16000 + 32000 * i / (n - 1)) / FULL for i in range(n)]


def sweep():
    """20 Hz to 20 kHz log sweep, -6 dBFS, 4 s, cosine phase. 8-Bit's
    aliasing and filtering, and any filtering in Move's neutral path."""
    f1, f2, t_len = 20.0, 20000.0, 4.0
    k = math.log(f2 / f1)
    a = db(-6)
    v = []
    for i in range(int(t_len * RATE)):
        t = i / RATE
        phase = 2 * math.pi * f1 * t_len / k * (math.exp(t * k / t_len) - 1)
        v.append(a * math.cos(phase))
    return fade_out(v)


SOUNDS = [sine_441, click_train, silence_click, noise_white, position_ramp, sweep, sine_441_quiet]


def write(path, v):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-FULL, min(FULL, round(x * FULL)))) for x in v))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("build", "test_wavs")
    os.makedirs(out, exist_ok=True)
    for make in SOUNDS:
        path = os.path.join(out, make.__name__ + ".wav")
        v = make()
        write(path, v)
        print("%-34s %.2f s" % (path, len(v) / RATE))


if __name__ == "__main__":
    main()
