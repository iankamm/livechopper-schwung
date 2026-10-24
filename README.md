# LiveChopper for Schwung

Chop a sample across your Ableton Move's pads by ear while it plays. Inspired by the sample chopping workflow from the SP-404, MPC Sample, and Ableton Live Simpler. Fine-tune the chops, shape them with the drum sampler's 8-Bit effect and filter, then export a Move drum rack
preset or a folder of WAV files. See [SPEC.md](SPEC.md) for more details.

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
| Back | Exit | — |

The knobs follow the two banks of Move's own Drum Sampler, so each control is where Move has it.

**Main knobs** (Up)

| Knob | Function | Shift |
|------|----------|-------|
| 1 | Transpose | Detune |
| 2 | Slice start | Zoom |
| 3 / 4 | Attack / hold | Fine adjust |
| 5 | Decay (Shift+tap: Length, the slice's end) | Fine adjust |
| 6 | Effect: Off / 8-Bit | — |
| 7 | 8-Bit rate | Fine adjust |

**Filter & Setup knobs** (Down)

| Knob | Function | Shift |
|------|----------|-------|
| 1 | Filter frequency | Fine adjust |
| 2 | Resonance (Peak gain on Peak) | Fine adjust |
| 3 | Filter type: Low-Pass 12 / 24, High-Pass 24, Peak | — |
| 4 | Envelope mode: Trigger (one-shot) / Gate (plays while held) | — |
| 8 | Gain | Fine adjust |

Envelope, gain, transpose, detune, the 8-Bit effect and the filter apply to all pads. Settings can be adjusted per pad after exporting to a native drum preset.

## Requirements

[Schwung](https://github.com/charlesvestal/schwung) 1.7.3 or later installed on your Ableton Move.

## Build and Install

```bash
./scripts/test.sh           # host-side tests (gcc, node)
./scripts/build.sh          # aarch64-linux-gnu-gcc if installed, else Docker
./scripts/install-hooks.sh  # once per clone: run the tests on every commit
```

The tests expect [schwung](https://github.com/charlesvestal/schwung) and
[schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
checked out next to this repo. CI runs the same tests and the ARM64 build on
every push and pull request.

This produces `dist/live-chopper-module.tar.gz`. To install:

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

This was created with Claude Code. I do not consider myself a developer, but I have some computer science knowledge and experience with C, JavaScript, and embedded development. I understand some of the source code logic and general development/testing process, but I did not write any of this code by hand.

## License

MIT License. See [LICENSE](LICENSE).
