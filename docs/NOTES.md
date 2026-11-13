# Design notes

Findings from studying the framework and schwung-waveform-editor (v0.7.3),
2026-10-15, and from measuring Move's Drum Sampler, 2026-11-09 to 12
("Move's Drum Sampler, measured"). These are design-time findings; where
they differ from SPEC.md, SPEC.md is authoritative. Planned work is in
PLAN.md.

## Chop timing: DSP owns pad input

- In an interactive tool (overtake_mode 2) the shim delivers internal pad
  note-on/off to the tool DSP's `on_midi` on the audio thread
  (schwung `src/schwung_shim.c`, "Deliver internal cable-0 note events").
  The same events also reach `onMidiMessageInternal` in ui.js.
- So chop logic lives in the DSP: on note-on, read the playhead right there
  and split. The UI only mirrors state (LEDs, screen) by polling get_param.
- Granularity: `on_midi` runs between blocks, so T is the playhead at the
  block boundary where the note is processed (128 frames, ~2.9 ms). There is
  no intra-block timestamp in the API. SPEC item 7 states this.
- The waveform editor's "Lazy" chop mode does NOT do this: it reads `playPos`
  in the UI (polled per tick), so its chops are tick-accurate at best. Don't
  copy it.

## Realtime safety

- The waveform editor loads WAVs with fopen/malloc inside `set_param`, which
  breaks the rules in plugin_api_v1.h. Don't copy that loader as-is.
- As built: `set_param("file_path")` only copies the path and signals a worker
  thread (SCHED_OTHER, pinned to cores 0-2) created in `create_instance`. The
  worker loads and publishes a buffer pointer; render plays silence until it
  lands. Old buffers are freed by the worker, never on the audio thread.
- For an overtake tool, create/destroy run on the shim worker, so allocation
  and pthread_create there are fine.

## Export (drum rack preset)

What the waveform editor's preset writer showed, which `src/drum_rack.mjs`
grew from. SPEC "Export Drum Preset" lists every field LiveChopper writes.

- The waveform editor's `saveDrumRackPreset()` (ui.js) writes an
  `.ablpreset` JSON to `/data/UserData/UserLibrary/Track Presets/`, in
  pure JS.
- It uses one WAV for all pads: every drumCell points at the same
  `sampleUri` with `Voice_PlaybackStart` / `Voice_PlaybackLength` as
  fractions of the file. LiveChopper does the same.
- Units, from a real Move set (schwung tests/fixtures/song_abl_sample.json):
  envelope times are seconds (ranges under "Knob curves"); Move's own kits
  use hold 0.001 with the decay doing the work. Volume around -12.
- Choke: each pad has `drumZoneSettings.chokeGroup`; the waveform editor
  sets 1 on all 16 pads, so all pads choke each other.
- Transpose: `Voice_Transpose` per drumCell, so a global transpose can be
  exported.
- Envelope: the drumCell envelope is `Voice_Envelope_Attack/Hold/Decay` with
  `Voice_Envelope_Mode: "A-H-D"`. The global envelope maps onto these
  fields (A-H-D, or A-S-R when gated).
- The preset always has 16 chains (receivingNote 36-51); unused pads get
  `speakerOn: false`.

## Move's Drum Sampler, measured

What LiveChopper's knobs and effects were built from (SPEC "Knob model",
"Effect"), read from Move Sets and Move's screen, 2026-11-09 to 12. Work
still to do is in PLAN.md. The Sets, takes and manuals are in
`.claude/recordings/` and `.claude/ref/`, local only.

### Effect fields

In Move's order:

| Effect | `Effect_Type` | Knob 7: field, range | Knob 8: field, range | Move's defaults (Knob 7, 8) |
|---|---|---|---|---|
| Stretch | "Stretch" | StretchFactor: 1-20 | StretchGrainSize: 0.005-0.3 | 1.0, 0.1 |
| Loop | "Loop" | LoopOffset: 0-1 | LoopLength: 0.01-0.5 | 0.0, 0.3 |
| Pitch Env | "Pitch Env" | PitchEnvelopeAmount: -1 to +1 | PitchEnvelopeDecay: 0.005-2 | 0.0, 0.3 |
| Punch | "Punch" | PunchAmount: 0-1 | PunchTime: 0.06-1 | 0.0, 0.12016 |
| 8-Bit | "8-bit" | EightBitResamplingRate: 1000-30000 Hz | EightBitFilterDecay: 0.01-5 | 14080, 5.0 |
| FM | "FM" | FmAmount: 0-1 | FmFrequency: 10-4500 Hz | 0.0, 1000 |
| Ring Mod | "Ring Mod" | RingModAmount: 0-1 | RingModFrequency: 1-5000 Hz | 0.0, 1000 |
| Sub Osc | "Sub Osc" | SubOscAmount: 0-1 | SubOscFrequency: 30-120 Hz | 0.0, 60 |
| Noise | "Noise" | NoiseAmount: 0-1 | NoiseFrequency: 180-15000 Hz | 0.0, 10000 |

Field names drop the `Effect_` prefix. Times are seconds; units are not
stored in the set file. Sources:

- `Effect_Type` strings: real Move presets (Schwung's and the waveform
  editor's test data), and Set 18 (a 909 Kit), which confirmed "Noise"
  and "Loop".
- Ranges: Set 18 has two pads per effect, one with each setting turned
  fully down and one fully up. Set 19 (a Viral Kit) does the same for
  Noise and for 8-Bit's Filter Decay. Where a fully-down or fully-up value
  equals the default (Noise Amount 0, 8-Bit Filter Decay 5), the default
  sits at that end of the range.
- Defaults: the 909 Kit preset's values (`presetValue` in the set), which
  match Move's set fixture in Schwung. Loop Offset's default is 0.0 in
  both; `src/drum_rack.mjs` wrote 0.02 until PLAN step 2 fixed it.

Move's manual (Drum Sampler, Main Bank) puts each effect's two settings on
Knobs 7 and 8 and lists the effects in this order: Stretch, Loop, Pitch
Env, Punch, 8-Bit, FM, Ring Mod, Sub Osc, Noise. It has no Off. Which
setting sits on which knob is from screen session 3. For every effect but
Loop that is also the order of its field pair in the set file; Loop's
pair is stored Length first, Offset second, the reverse of its knobs.

### Knob curves (Sets 20, 21)

Set 20 (a Citizen Drop Kit) has one pad per effect with both settings
turned one click from the default: up, except 8-Bit Filter Decay, whose
default is its maximum, so that one went down. Every click moves the knob
by the same amount: 0.7645% of its travel (0.00764526), about 131 clicks
end to end. Each setting maps knob position p (0-1) onto its range with
one of these curves:

| Curve | value = | Settings |
|---|---|---|
| linear | min + (max-min)·p | Punch, Ring Mod, Sub Osc and Noise Amount; Pitch Env Amount |
| log | min·(max/min)^p | 8-Bit Rate, 8-Bit Filter Decay, FM Frequency, Sub Osc Frequency |
| square | min + (max-min)·p² | Stretch Grain Size, Loop Length, Noise Frequency, Stretch Factor, Loop Offset |
| cube | min + (max-min)·p³ | Pitch Env Decay, Punch Time, FM Amount |
| 5th power | min + (max-min)·p⁵ | Ring Mod Frequency |

Each fits its click to within 1%. Set 21 (a Frantik Kit) turned Stretch
Factor, Loop Offset, FM Amount and Ring Mod Frequency 10 slow clicks, which
settled those four. Stretch Factor and Loop Offset explain their odd first
click: Move keeps stepping the knob until the value on screen changes.
Stretch Factor shows 2 decimals, so 1.00 to 1.01 takes 3 steps; Loop
Offset shows a percentage with 1 decimal. Both match all ten clicks
exactly. FM Amount skips too (its clicks land on knob steps 12 and 28, both
exact on the cube curve), but no simple rounding of its value explains
which steps it skips, so its on-screen format decides that.

Set 21 also measured the envelope and filter frequency, all log curves with
exactly one knob step per click:

| Setting | Move |
|---|---|
| Attack | log, 0.0001-20 s |
| Hold | log, 0.001-60 s (the top shows "Inf") |
| Decay | log, 0.001-60 s (the top shows "60.0 s") |
| Filter Frequency | log, 30 Hz-22 kHz, x1.0517 a click |

The envelope ranges are from Set 19 (pads 5 and 6, fully down and fully
up). Set 18's 909 Kit first showed Decay goes past 10 s, with decays of
12.87 s and 13.92 s; Schwung's Move set fixture has 10.0.

The filter's 10-click pad landed on 11 steps, which the display rule can't
explain at those values; probably one extra click. Its single click is
exact.

The rule for every Move knob measured (Sets 20-25): 131 equal knob steps
across the range (0.00764526 each, the last one short), a curve per
setting, a tenth of a step with Shift, and steps skipped until the
displayed value changes. Length is the one knob seen that doesn't skip.

### Every knob follows Move

Every knob that mirrors a Move control follows Move's range, curve, step
size, Shift fine step and on-screen format (PLAN steps 1 and 2 built it).
Gain (Filter & Setup Knob 8) is LiveChopper's own, since Move has no Gain
knob there: Move's drum sampler range (-70 to +24 dB) with Simpler-like
steps (0.5 dB, Shift 0.1, 2 dB below -24 dB). Its readout follows Move's
rule anyway: no "+" (decided 2026-11-12).

| Knob | Range | Curve and step | Display |
|---|---|---|---|
| Main 1 Transpose | -48 to +48 st (Set 22, screen) | 1 st a click | "12 st", "-12 st", "0 st" (no +) |
| Shift Main 1 Detune | -50 to +50 ct (Set 22, screen) | 1 ct a click | "5 ct", "-50 ct" (no +) |
| Main 2 Start | sample length | 1 screen column a click | no number: the waveform, the marker and "Start" |
| Shift Main 2 Zoom | LiveChopper's own (decided 2026-11-09) | Move has two levels | - |
| Main 3-5 Attack, Hold, Decay | 0.10 ms-20.0 s / 1.00 ms-Inf / 1.00 ms-60.0 s | log, 131 steps, one value a click (Sets 21, 23) | 3 significant figures: "0.10 ms", "10.6 ms", "110 ms", "1.03 s", "20.0 s"; Hold's top is "Inf" |
| Main 5 Length (Move: Shift) | 0-100% of the sample | Move: linear, 0.7645% of the sample a click, no skipping (Set 23). LiveChopper keeps 1 screen column a click (decided 2026-11-09) | "0.0 %"-"9.9 %", then "11 %"-"100 %"; over the waveform |
| Main 6 Effect | nine effects, no Off | one effect every 4 detents (see below) | "Playback Effect", the effect's name, and a bar for its place in the list |
| Main 7-8 effect settings | see "Effect fields" | see "Knob curves" | see screen session 3 |
| Filter 1 Frequency | 30 Hz-22 kHz | log (Set 21) | "Filter Frequency", "30.0 Hz"-"22.0 kHz" |
| Filter 2 Resonance / Peak Gain | 0-0.9 / -12 to +12 dB | both linear (Peak Gain linear in dB), 131 steps (Set 25) | "Filter Resonance" "0.0 %"-"90 %"; "Filter Gain" "-12 dB"-"12 dB" |
| Filter 3 Type, 4 Envelope Mode | four types / Trigger, Gate | one item every 4 detents | "Filter Type": Low-Pass 12, Low-Pass 24, High-Pass 24, Peak; "Envelope Mode": Trigger, Gate |

The list knobs (Effect, Type, Envelope Mode) move one item every 4
detents (decided 2026-11-13). This is Schwung's own list gate
(knob_engine.mjs ENUM_DELTA_DIV): turning back drops a partial turn, and
Shift lifts the gate to one item a detent. A Move knob sends about 210
detents a rotation (Schwung's EC4_SURFACE.md), so at one item a detent all
nine effects went by in about 15 degrees. Move's own rate for its lists is
unmeasured: the screen captures have frames but no encoder counts, and a
Set only keeps the end value.

Shift's fine step (the manual mentions it for Attack, Hold, Filter
Frequency and Resonance): on Attack and Hold it is a tenth of a knob step,
skipped until the display changes (Set 23: Attack 0.10 to 0.11 ms took 6
fine steps, Hold 0.80 to 0.81 s took 1; both exact). All 18 effect
settings have the same fine step: Set 24's one Shift click on each landed
on a whole number of tenth-steps (1 to 3 for most, 25 for Stretch Factor,
31 for Loop Offset and 112 for FM Amount, which start where the display is
coarse). Filter Frequency, Resonance and Peak Gain have it too (Set 25).
Decay and Length have none (screen session 2). The exact count is
sometimes one or a few more than rounding predicts (Resonance from 0 took
2 fine steps where 1 already shows "0.1 %"; likewise Stretch Factor, Loop
Offset, FM Amount and Peak Gain from their ends). Not explained; plain
rounding is close enough to copy.

Screen session 1 (2026-11-09, `.claude/tools/capture_display.py`; Set 22
holds the raw values):

- Knob readout layout: the name on the top line, a bar under it filled from
  the left in proportion to the value (from the minimum, even for Transpose
  and Detune), the value at bottom left, and the sampler icon at bottom
  right.
- Turning fast skips values: a slow click moves Transpose 1 st, a fast
  turn 2-3. Whether LiveChopper does the same is unchecked (PLAN
  "Open").
- Start: the marker is a full-height line with a flag at the top, moving
  one screen column a slow click. Zoomed in, it travels to the screen's
  centre and then the waveform scrolls under it. Only two zoom levels
  showed up (the zoomed view about 2.5x the full one).

Screen session 2 (2026-11-09; Set 23 holds the raw values):

- Attack, Hold and Decay each swept end to end, one value a click, every
  value distinct. The ratios per click match the log curves exactly
  (Attack x1.0978, Hold and Decay x1.0878). The knob sits on multiples of
  0.00764526 clamped to 1, so the last click is short: Hold goes 56.1 s
  then Inf.
- Display: 3 significant figures, in ms below 1 s and in s from 1 s.
- Length: the screen is the waveform with a bracket at each end of the
  played region, "Length" at bottom left and the value at bottom right; no
  bar or icon. Pad 5's one click took Voice_PlaybackLength from 1 to
  0.992355, one knob step of the whole sample, and the sweep shows each
  click moves 0.7645% even where the display repeats ("11 %" twice), so
  Length doesn't skip. A chop is often a small part of a long recording,
  where 0.76% of the whole is a big jump (0.92 s on a 2-minute recording),
  so LiveChopper keeps its column step (decided 2026-11-09): zoomed out it
  nearly matches Move's (1/124 of the sample against 1/131), and zoomed in
  it gets finer, as Move's own Start knob does.
- Shift on Knob 5: on Move, holding Shift switches the knob between Decay
  and Length, so neither has a fine step (Set 23's pads 4 and 6 stayed at
  their defaults). LiveChopper copies it (decided 2026-11-09).

Screen session 3 (2026-11-09; Set 24 holds the raw values, pads 2-10 one
Shift click on each setting):

- Knob 6 is titled "Playback Effect". Each click showed the next effect, in
  the manual's order, with the bar moving along the list.
- Each setting's readout uses the usual knob layout. Move's names and
  formats, Knob 7 then Knob 8:

| Effect | Knob 7 | Knob 8 |
|---|---|---|
| Stretch | Stretch Factor: "1.00"-"20.00" (no unit) | Grain Size: "5.00 ms"-"300 ms" |
| Loop | Loop Offset: "0.0 %"-"100 %" | Loop Length: "10.0 ms"-"500 ms" |
| Pitch Env | Pitch Env Amount: "-100 %"-"100 %" | Pitch Env Decay: "5.00 ms"-"2.00 s" |
| Punch | Punch Amount: "0.0 %"-"100 %" | Punch Release: "60.0 ms"-"1.00 s" |
| 8-Bit | 8-Bit Rate: "1.00 kHz"-"30.0 kHz" | 8-Bit Decay: "10.0 ms"-"3.98 s", then "Off" at the top (5.0) |
| FM | FM Amount: "0.0 %"-"100 %" | FM Frequency: "10.0 Hz"-"4.50 kHz" |
| Ring Mod | Ring Mod Amt: "0.0 %"-"100 %" | Ring Mod Freq: "1.00 Hz"-"5.00 kHz" |
| Sub Osc | Sub Amount: "0.0 %"-"100 %" | Sub Frequency: "30.0 Hz"-"120 Hz" |
| Noise | Noise Amount: "0.0 %"-"100 %" | Noise Color: "180 Hz"-"15.0 kHz" |

- Formats, the same for every knob so far: times and frequencies show 3
  significant figures (ms below 1 s, kHz from 1 kHz); percentages show one
  decimal below 10 and none from 10, by size, so "-6.7 %" but "-14 %"; no
  "+" sign.

Screen session 4 (2026-11-10, the Filter & Setup page; Set 25 holds the raw
values):

- Titles: "Filter Frequency", "Filter Resonance", "Filter Gain" (Peak Gain,
  only while the type is Peak), "Filter Type", "Envelope Mode".
- Filter Type steps one type a click in LiveChopper's order, Low-Pass 24
  the default; Envelope Mode is Trigger or Gate, one a click.
- Resonance: linear 0-0.9, 0.688% a click (Set 25: 1 click 0.00688, 10
  clicks 0.0688, exact), shown "0.0 %"-"90 %".
- Peak Gain: stored linear (1.0 = 0 dB), but the knob is linear in dB:
  24 dB over 131 steps, 0.18 dB a click (10 clicks +1.84 dB, exact). Shown
  "-12 dB", "-0.2 dB", "0.0 dB", "12 dB": the percentage rule, no "+".
- Knobs 5-8, which LiveChopper leaves unused or gives to Gain: 5 "Choke"
  (Off, On), 6 "Velocity >" and a target (Filter, Attack, Hold, Decay,
  FX 1, FX 2), 7 that target's amount ("-100 %"-"100 %", each target keeps
  its own), 8 "Pan" ("50 Left", "Center", "50 Right"). SPEC leaves choke
  and velocity out on purpose, and Gain stays on Knob 8.

### Stretch and Loop stand-ins (PLAN step 3, 2026-11-11)

Live's manual (Drum Sampler, 31.4.2 Playback Effects; the same device as
Move's) is the only description: Stretch "changes the sample's length
without altering its pitch", Factor being "a multiple of the original
playback speed" and Grain Size the grain in ms; Loop "repeats a portion of
the sample", Loop Offset setting "the loop start point relative to the
sample start" and Loop Length its duration in ms. The design (SPEC
"Effect" has what it does), and why:

- Both run inside one voice path shared by the playing voice and the choke
  tail (read, 8-Bit, effect, filter, advance), and each voice knows its
  slice's start as well as its end, kept up to date when a chop, delete or
  marker nudge changes the slice under it.
- Stretch: a grain restarts early enough to end inside the slice, or the
  last grains of a long stretch run into silence. The envelope runs in
  real time, so a short Decay cuts a long stretch. Plain grains drift the
  pitch a little where the grain is short (5 ms grains on a 441 Hz tone at
  Factor 20 read 423 Hz), lo-fi as Live's manual describes Move's.
- Loop: the level dips for 1.5 ms either side of each wrap rather than
  crossfading, because a crossfade would need audio from before the loop,
  which a loop at the very start doesn't have. A playhead left behind a
  loop moved by the knobs plays on into it.
- Checked by ear on the Move (2026-11-11): Factor 2 plays twice as long,
  and Loop starts at its Offset (LiveChopper first played from the slice
  start into the loop, and was changed to match). Neither sounds like
  Move's own.

### Move's dry path (Set 28)

Set 28, 2026-11-12: the six sounds at Stretch 1.00, Attack minimum, Hold
Inf, Low-Pass 24 at 22 kHz, pad Volume -12 dB, Velocity to Volume 0.5,
Full Velocity (`.claude/recordings/set28/`):

- Gain -1.45 dB (0.8465) on every sound, the same in both volumes, and
  flat to +-0.02 dB from 30 Hz to 19.5 kHz. It isn't the pad's -12 dB, so
  each Set's dry take sets the reference level; effects are compared
  relative to it.
- That level depends on Attack: 0.8465 at the 0.10 ms minimum, 0.9311
  (-0.62 dB, +0.83 dB on the minimum) at 1.0 ms, in both Set 31 and Set 32
  (whose position_ramp pads had 1.0 ms). `fxlab.py` sets each pad's level
  from the dry pads with the same Attack.
- Attack at its minimum (0.10 ms) is a linear ramp over the first 4
  frames (0.25, 0.49, 0.76, 0.99), so a click on frame 0 almost vanishes.
  LiveChopper's Attack 0 starts at full level.
- The end of the sample fades out over its last ~417 frames (9.5 ms),
  S-shaped (gain 0.79 300 frames before the end, 0.41 at 200, 0.10 at
  100). LiveChopper's slices stop dead.
- Low-Pass 24 at 22 kHz is a real filter, not a bypass: a click is
  followed by a ring at Nyquist (+-780 after a 24k click, alternating each
  frame, falling ~2% a frame). Inaudible; LiveChopper bypasses it.
- position_ramp passes cleanly: gain and offset alone fit it to 0.5 LSB
  rms, so each value gives the frame read to ~2 frames. Usable for Loop,
  Pitch Env and FM (not Stretch, whose crossfading grains mix two
  positions; click_train shows its grains).
- `tools/fxlab/fxlab.py` on this take (render of plugin.c at the same
  settings): gain 0.8462, residual over the steady part 5.9 LSB (sine),
  2.4 LSB (ramp), pitch 0.00 st, read position 0.18 ms rms, bands 0.00 dB.
  What remains is the attack ramp, the end fade and the Nyquist ring, and
  the dry pads pass every metric of PLAN's "When an effect is done" with
  room to spare (bands 0.01 dB, pitch 0.85 ct max, position 0.35 ms max),
  so those don't need matching first. Set 28's first two takes, recorded
  without Move->Schwung, went through the Set template's "Punch Glue"
  compressor, "Analog Clip" and Limiter and Move's speaker enhancer (+6 dB
  at 150 Hz, a dip at 500 Hz, the ramp reduced to a blip).

### Punch (Sets 29-31)

Done 2026-11-12: fitted on Sets 29 and 30, accepted on Set 31 (seed 1112,
references in `tests/move_refs/punch/`), and the preview as the Move
plays it passes. Live's manual describes Punch as ducking with a fixed
attack, emphasising the transient, Release being how long the gain
reduction takes to return.

Set 29: one Drum Rack, 15 pads in note order, played about 3 s apart
(`.claude/recordings/set29/`; Amount 50 % is 0.4969 on Move's knob):

| Pads | Sound | Punch |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00): the level reference |
| 2-7 | sine_441 | Amount 50 % and 100 %, each at Release 60 ms, 120 ms (default), 1.00 s |
| 8-13 | click_train | the same six |
| 14 | sine_441_quiet | dry |
| 15 | sine_441_quiet | Amount 100 %, Release 120 ms |

Move's Punch is a fixed gain envelope from note-on, nothing like the
stand-in's boost at the start it replaced:

- Makeup: the start and everything after the release sit at 1 + Amount³
  of the dry level (1.1227 = +1.00 dB at 0.4969, exact to 4 digits; 2.000
  = +6.02 dB at 100 %). So the transient keeps that level and the body is
  ducked below it.
- Not level-dependent: sine_441_quiet's curve matches sine_441's to 0.1
  dB. Nor retriggered: each click of click_train lands on the sine's curve
  for the same settings.
- Duck attack: the same for every Release. Barely moving at 2 ms, halfway
  down at 14-18 ms, 95 % of the way by ~50 ms, done by ~80 ms.
- Release: back to the makeup level at about Release after note-on.
- Ceiling: at 100 % click_train settles at +2.4 dB, not +6: see Set 30.

Set 30: the same baseline and timing, 12 pads (`.claude/recordings/set30/`;
Amounts 9.86, 25.4, 75.1, 90.1 %, Releases 252 and 506 ms):

| Pads | Sound | Settings | For |
|---|---|---|---|
| 1 | sine_441 | dry | the level reference |
| 2-5 | sine_441 | Punch 9.9 %, 25 %, 75 %, 90 %, Release 1.00 s | depth, makeup and the attack against Amount |
| 6 | sine_441 | Punch 100 %, 1.00 s | Set 29's pad 7 again: do takes repeat |
| 7-8 | sine_441 | Punch 50 %, 100 %, Release 252 ms | the release's shape |
| 9-10 | sine_441 | Punch 50 %, 100 %, Release 506 ms | the release's shape |
| 11 | sine_441 | Stretch 1.00, Filter Peak, 434 or 457 Hz, Peak Gain 12 dB | the ceiling without Punch |
| 12 | click_train | Punch 75 %, 1.00 s | the ceiling again |

- Repeatable: pad 6 matches Set 29's pad 7 to 0.0006 dB rms (0.008 dB
  max). Move's Punch is deterministic.
- Makeup 1 + Amount³ holds at every Amount (+0.01, +0.14, +3.07, +4.76 dB
  predicted; +0.0, +0.1, +3.0, +4.7 measured on the 2 ms start).
- Depth: gain = makeup x max(1 - Amount x env(t), 0.15), env rising from
  0 to 1 at note-on and falling back to 0 over the Release. The bottom
  against the makeup is 0.902, 0.750, 0.501, 0.248, 0.150, 0.150 at 9.9,
  25, 50, 75, 90, 100 %: 1 - Amount down to the 0.15 clamp. The clamp
  explains Set 29's flat bottom at 100 % and why 90 % ducks deeper than
  100 % in absolute terms (same clamp, less makeup).
- Release: (1 - g/makeup) / Amount over t/Release is one curve at 1 s for
  every Amount, to 0.02: 0.98 at 0.4 R, 0.95 at 0.5, 0.89 at 0.6, 0.79 at
  0.7, 0.63 at 0.8, 0.40 at 0.9, 0.08 at 1.0, 0 by 1.05 R. At shorter
  Releases its tail runs past R (env 0.14 at R for 506 ms, 0.24 for 252,
  0.41 for 120, 0.54 for 60), as if a fixed smoothing acts on top.
- Attack: faster with more Amount (env 0.14 at 10 ms at 9.9 %, 0.38 at
  100 %), so not one curve in linear gain.
- Ceiling: pad 11 (no effect, Peak +12 dB) flattens at exactly 31918
  with a soft knee, so the ceiling isn't Punch's. It is two clips: Move
  clips hard at full scale after the effect and before its filter (the
  ring after a clipped click is 1.348 x dry at both 75 % and 100 % Punch,
  which is 32767 / 24327: the click clipped to full scale, then filtered),
  and Schwung's capture then soft-clips above 29204 (PLAN, "When an effect
  is done"). LiveChopper also clips at full scale, but after its filter,
  which matters only when the filter rings.

The model (`src/dsp/plugin.c`, `fx_frame`), fitted by least squares to all
14 sine pads of Sets 29 and 30 at once, through the same 100-frame window
that measures Move (rms 0.061 dB, worst 0.89 dB):

- gain = (1 + Amount³) x exp(S(ln T)), T = max(1 - Amount x (1 - (t/L)^n),
  0.15), S two one-poles of 10.434 ms in series starting at 0 (0 dB) at
  note-on, L = R - 35.65 R^-0.308 ms (R the Release in ms: 10 ms short at
  60 ms, 4 ms at 1 s), n = 3.975 + 0.555 ln R (R in s: 2.4 at 60 ms, 4.0
  at 1 s).
- Smoothing in dB is what makes the attack faster at higher Amounts: a
  deeper target is a bigger step in dB, so it gets further in the same
  time. The fit put the smoothing domain at p = 0.07 when left free
  (0 being dB). Linear smoothing, a smoothed attack only, a soft floor
  or a floor after the smoothing all fitted worse (worst 1.6-7 dB); a
  release stretched to R plus a few ms, unsmoothed, missed Move's
  exponential tail (its envelope falls ~0.64 every 5 ms after R).
- `fxlab.py check` with it: every Punch pad below the capture's soft-clip
  knee passes on Sets 29 and 30 (gain worst 0.86 dB, bands worst 0.60 dB).
  What fails is clipping: Set 29's 100 % click pads (bands 1.36 dB: Move's
  take was soft-clipped by Schwung's capture as well, our render was not),
  Set 30's 75 % click pad on the limit (0.99 dB), and Set 30's Peak pad.

Set 31, the acceptance Set (`fxlab.py accept-set Punch --seed 1112`,
drawn after tuning), plus two pads at Transpose +12 for whether Punch's
times follow the pitch, as "Envelope Follows Pitch" might make them. Both
repeat Set 30 settings, so a halved time would show directly:

| Pad | Sound | Settings |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00) |
| 2 | sine_441 | Punch Amount 28 %, Release 75.1 ms |
| 3 | sine_441_quiet | Punch Amount 75 %, Release 60.0 ms |
| 4 | drum_synth | Punch Amount 83 %, Release 420 ms |
| 5 | sine_441 | Punch Amount 57 %, Release 751 ms |
| 6 | sine_441_quiet | Punch Amount 17 %, Release 192 ms |
| 7 | drum_synth | Punch Amount 83 %, Release 823 ms |
| 8 | sine_441 | Punch Amount 6.9 %, Release 60.1 ms |
| 9 | sine_441_quiet | Punch Amount 69 %, Release 941 ms |
| 10 | sine_441 | a copy of pad 2 |
| 11 | sine_441 | Transpose 12 st, Punch Amount 100 %, Release 252 ms (Set 30 pad 8) |
| 12 | sine_441 | Transpose 12 st, Punch Amount 50 %, Release 506 ms (Set 30 pad 10) |

- Recorded 2026-11-12 with two departures: pad 5's Release is 751 ms (750
  isn't a step on Move), and every pad's Attack is 1.0 ms, not the minimum
  (the render reads both from the Set, so the comparison holds).
- `fxlab.py check`: 12 of 12 pass, gain worst 0.97 dB (pad 11), bands
  worst 1.04 dB (pad 4, drum_synth), pitch under 1 cent. Pads 11 and 12
  pass with Punch's times unchanged by Transpose, so they don't follow the
  pitch. `fxlab.py refs .claude/recordings/set31/punch --seed 1112` saved
  them as `tests/move_refs/punch/`, which `test.sh` checks.
- Preview on the Move (2026-11-12, `.claude/recordings/preview1/`, a
  Skipback take of LiveChopper playing sine_441 at Set 30 pads 1, 8, 10
  and 2): against plugin.c's render, 4 of 4 pass (gain worst 0.28 dB,
  bands 0.06 dB, pitch 0); Move's own Set 30 pads against it, 4 of 4
  pass (gain worst 0.47 dB, bands 0.26 dB). The preview plays at unity,
  1.45 dB above Move's dry level (0.8465); `check` compares each take at
  its own level, so this isn't part of the verdict.
- Device: `fxlab.py device-check` renders the pads of Sets 28-30 on the
  Move (plugin.c built with build.sh's flags, the Move's libm) and
  compares them with the host's: all 56 renders identical, bit for bit.
  What `check` measures on the host is what the Move plays.

### Pitch Env (Set 32)

Fitted 2026-11-13 on Set 32 (`.claude/recordings/set32/`): one Drum Rack,
16 pads in note order, about 4 s apart (a downward bend reads the 2 s
sounds slower, so they outlast 2 s), Attack at its minimum except on the
position_ramp pads (1.0 ms, read from the Set).

| Pad | Sound | Pitch Env |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00): the level reference |
| 2-5 | sine_441 | Amount 100 %, 50 %, 25 %, 10 %, Decay 2.00 s |
| 6-7 | sine_441 | Amount -100 %, -25 %, Decay 2.00 s |
| 8-10 | sine_441 | Amount 100 %, Decay 300 ms, 50.2 ms (50.0 isn't a step on Move), 5.00 ms |
| 11 | position_ramp | dry: the read-position reference |
| 12-13 | position_ramp | Amount 100 %, -100 %, Decay 300 ms |
| 14 | position_ramp | Amount 50 %, Decay 2.00 s |
| 15 | position_ramp | Transpose 12 st, Amount 100 %, Decay 300 ms |
| 16 | sine_441 | a copy of pad 8 |

- **Depth:** 100 % is 48 semitones, linear in Amount and mirrored below
  zero. An exponential fitted to each 2 s pad's pitch from 100 ms on
  starts at 48.0-48.9 semitones per 100 % (pads 2-7).
- **Shape:** exponential in semitones, falling to 1/1000 at the Decay:
  the same fits give a time constant of Decay / 6.90-6.92 (ln 1000 is
  6.908) on every 2 s pad, and 300 ms gives 43.7 ms (Decay / 6.87).
- **One frame in:** Move's envelope has already taken one frame's step on
  the first frame. Without that, every +100 % pad reads ~15 frames less
  than ours by the end of the bend (r(0) - 1 at 16x), whatever the Decay,
  and Decay 5 ms fails pitch by 494 ct max; with it, 1.2 ct. An offset of
  0.75 or 1.25 frames is clearly worse.
- **Transpose:** Decay doesn't follow it (pad 15 rendered at 300 ms
  matches Move to 0.6 LSB past the attack; at 150-250 ms it is off by
  94-286 ms). But
  Move's Attack does: pad 15's 1.0 ms Attack ramps in ~22 frames, half
  of pad 12's 44, so the voice envelope's times follow Transpose
  (Voice_PitchToEnvelopeModulation is on). LiveChopper's don't yet (PLAN
  "following Transpose"), and that mismatch in the first 0.5 ms is all
  that fails pad 15: past 400 frames it matches to 0.6 LSB at lag 31.
- **Repeatable:** pad 16 gives exactly pad 8's numbers.
- `fxlab.py check` with this model: 15 of 16 pass (pad 15 above), pitch
  worst 2.4 ct (pad 9), position worst 0.13 ms.

The pitch metric on a fast bend: the zero-crossing pitch lags it (Move's
stored pitch curve isn't its true pitch there), but both takes go through
the same tracker, so it cancels in `check`. `tests/fxlab_selftest.py`
part 6 keeps that so: a render against a copy of itself with Move's
capture differences (the 4-frame attack ramp, Low-Pass 24 at 22 kHz)
passes, and 47 semitones for 48 or Decay 5.5 ms for 5 ms fail. So the
semitones were read from the 2 s pads, and the short end was fitted by
rendering candidates through plugin.c and the metric, not by fitting the
stored curve.
