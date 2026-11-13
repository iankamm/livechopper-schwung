# LiveChopper for Schwung

Chop a sample across your Ableton Move's pads by ear while it plays.
Inspired by the sample chopping workflow from the SP-404, MPC Sample, and
Ableton Live Simpler. Fine-tune the chops, shape them with the drum
sampler's effects and filter, then export a Move drum rack preset or a
folder of WAV files. See [docs/SPEC.md](docs/SPEC.md) for more details and
[docs/PLAN.md](docs/PLAN.md) for what's planned.

## Controls

| Control | Function | Shift |
|---------|----------|-------|
| Red pad | Select and play slice | — |
| Blue pad | Chop at the playhead | — |
| Jog wheel | Adjust slice start | Fine adjust |
| Jog click | — | Tools menu |
| Down / Up | Filter & Setup knobs / Main knobs | — |
| Left / Right | Previous / next slice | — |
| Delete | Delete slice | — |
| Undo | Undo | Redo |
| Record | Export menu | — |
| Play | Play / stop Move set | — |
| Back | Exit menu (keep for later / exit) | — |

The knobs follow the two banks of Move's own Drum Sampler, so each control is where Move has it, and they step and read out as Move's do (measured on a Move: same ranges, curves, 131 clicks end to end, and Shift as a tenth-of-a-click fine adjust).

**Main knobs** (Up)

| Knob | Function | Shift |
|------|----------|-------|
| 1 | Transpose | Detune |
| 2 | Slice start | Zoom |
| 3 / 4 | Attack / hold | Fine adjust |
| 5 | Decay | Length (the slice's end) |
| 6 | Effect: Stretch, Loop, Pitch Env, Punch, 8-Bit, FM, Ring Mod, Sub Osc, Noise | — |
| 7 / 8 | The effect's two settings (8-Bit: rate / decay) | Fine adjust |

**Filter & Setup knobs** (Down)

| Knob | Function | Shift |
|------|----------|-------|
| 1 | Filter frequency | Fine adjust |
| 2 | Resonance (Peak gain on Peak) | Fine adjust |
| 3 | Filter type: Low-Pass 12 / 24, High-Pass 24, Peak | — |
| 4 | Envelope mode: Trigger (one-shot) / Gate (plays while held) | — |
| 8 | Gain | Fine adjust |

Envelope, gain, transpose, detune, the effect and the filter apply to all pads. In chop mode Punch plays as Move's does (matched to recordings of Move's own output); the other effects play as simple stand-ins for now. The exported drum rack gets Move's own. Settings can be adjusted per pad after exporting to a native drum preset.

## Requirements

[Schwung](https://github.com/charlesvestal/schwung) 1.7.3 or later installed on your Ableton Move.

LiveChopper 0.7.0 has been tested on a Move running Schwung 1.9.2, the
newest release at the time, with no problems found. CI runs the host tests
against both 1.7.3 and the newest Schwung release.

## Build and Install

```bash
./scripts/test.sh           # host-side tests (gcc, node; Python checks against
                            # Move recordings once tools/fxlab/setup_env.sh has run)
./scripts/build.sh          # aarch64-linux-gnu-gcc if installed, else Docker
./scripts/install-hooks.sh  # once per clone: run the tests on every commit
```

The build produces `dist/live-chopper-module.tar.gz`.

The tests expect [schwung](https://github.com/charlesvestal/schwung) and
[schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
checked out next to this repo. CI runs the same tests and the ARM64 build on
every push and pull request.

To install, use the tarball you built or download `live-chopper-module.tar.gz`
from [Releases](https://github.com/iankamm/livechopper-schwung/releases),
where each version's notes say what changed:

- **Web manager:** upload the tarball at http://move.local:7700/modules
  (custom install), then restart Schwung.
- **ssh:** `./scripts/install.sh` (needs SSH enabled at
  http://move.local/development/ssh).

## Credits

- **Schwung framework**: [Charles Vestal](https://github.com/charlesvestal/schwung)
- Repo layout, build scripts and export approach adapted from
  [schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
  (MIT, Copyright (c) 2025 Charles Vestal)

## AI Disclosure

> Development is heavily assisted by Claude Code. I do not consider myself a developer, but I have some computer science knowledge and experience with C, JavaScript, and embedded development. I understand some of the source code logic and general development/testing process, but I did not write any code here by hand or manually review most lines. Every release was tested by me on my Ableton Move.

\- Human

## License

MIT License. See [LICENSE](LICENSE).
