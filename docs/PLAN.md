# LiveChopper plan

Work that isn't built yet. [SPEC.md](SPEC.md) describes what the module does
today; when something here is built, its decisions move into SPEC.md and it
comes off this list.

## Remaining drum sampler effects

The knobs already mirror Move's Drum Sampler (SPEC "Knob pages"), but of its
built-in effects only 8-Bit is done (SPEC "Crush"). Every exported preset
already writes the fields for all of them (`src/drum_rack.mjs`), so the
export side is mostly choosing the type and filling in two values.

| Effect | `Effect_Type` | Setting 1 (Knob 7) | Setting 2 (Knob 8) | Defaults we write now |
|---|---|---|---|---|
| 8-Bit (done) | "8-bit" | EightBitResamplingRate | EightBitFilterDecay | 14080, 5.0 |
| Stretch | "Stretch" | StretchFactor | StretchGrainSize | 1.0, 0.1 |
| Punch | "Punch" | PunchAmount | PunchTime | 0.0, 0.12 |
| Pitch Env | "Pitch Env" | PitchEnvelopeAmount | PitchEnvelopeDecay | 0.0, 0.3 |
| FM | "FM" | FmAmount | FmFrequency | 0.0, 1000 |
| Ring Mod | "Ring Mod" | RingModAmount | RingModFrequency | 0.0, 1000 |
| Sub Osc | "Sub Osc" | SubOscAmount | SubOscFrequency | 0.0, 60 |
| Noise | unconfirmed | NoiseAmount | NoiseFrequency | 0.0, 10000 |
| Loop | unconfirmed | LoopLength | LoopOffset | 0.3, 0.02 |

Field names drop the `Effect_` prefix. The `Effect_Type` strings marked as
known come from real Move presets (Schwung's and the waveform editor's test
data); which setting sits on Knob 7 and which on Knob 8 is to be confirmed
against Move.

### Proposed design

Extends SPEC "Crush"; the decision there becomes "Effect".

- Main Knob 6 steps through Off and the nine effects, in Move's order.
- Main Knob 7 is the selected effect's first setting, Main Knob 8 its
  second. Knob 8 is unused today, so this also gives 8-Bit its Filter Decay,
  as on Move.
- One effect at a time, global for every pad, like the rest of the sound
  settings. Each effect keeps its own two values while you switch between
  them, as the filter keeps Resonance and Peak Gain apart.
- Readouts, steps and Shift fine steps copy Move's, as for the filter.
- Export: `Effect_Type` plus that effect's two fields; the other effects'
  fields stay at their defaults.
- Chop mode plays a stand-in for each effect, not an emulation, in
  drumCell's order: sample -> effect -> filter -> envelope.
- Resume keeps the selected effect and all values; any change counts as
  unexported work.

### Phases

1. Punch, Pitch Env, Sub Osc, Ring Mod, FM, Noise. These shape the signal,
   so each stand-in is a small per-voice DSP block next to the crush.
2. Stretch and Loop. These change how the sample is played back, so they
   interact with the playhead a chop reads and with slice ends. Each needs
   its own design before building.

### To settle on the Move first

- The `Effect_Type` strings for Noise and Loop: no example preset uses them.
- Each setting's range, step size, units and how Move displays it (Move
  manual 15.9.1). The test data only shows defaults.
- Loop Offset's default: Move's set fixture has 0.0, `src/drum_rack.mjs`
  writes 0.02.
- Effect Off: keep writing "Stretch" at 1.0 (today's no-op), or switch to
  `Effect_On: false`.

## Other ideas (not committed to)

- Snap chops to the set's tempo.
- Use the right-hand 16 pads, which do nothing today.
- Per-pad sound settings before export. SPEC currently leaves these to the
  drum rack on purpose.

## Maintenance

- A weekly scheduled CI run, so a new Schwung release is tested even while
  this repo is idle.
- Release v0.6.3 to put the help.json fix (Shift+tap back to Decay) on
  devices.
