# Chopper for Schwung

Chop a sample across the pads of your Ableton Move in real time, like the chop
modes on MPC and SP drum machines, then export the result as a Move drum rack
preset. See [SPEC.md](SPEC.md).

Status: early development.

## Controls

| Control | Function |
|---------|----------|
| Red pad | Play that slice (one-shot) and select it |
| Blue pad | While a slice plays: chop at the playhead |
| Knob 1 / Knob 2 | Move the selected slice's start / end |
| Knob 3 | Zoom |
| Knob 4 | Waveform vertical scale |
| Knob 5 / 6 / 7 | Attack / Hold / Decay (all pads) |
| Knob 8 | Transpose (all pads, repitch) |
| Jog / Jog click | Move the active marker / switch start and end |
| Touch a knob | Preview its value |
| Shift | Fine steps for knobs and jog |
| Left / Right | Select previous / next slice |
| Delete | Delete the selected slice (merges it into the previous one; Pad 1 is trimmed off) |
| Undo | Undo the last chop or delete |
| Capture | Export a drum rack preset to Track Presets |
| Back | Exit (asks first if there are changes not exported) |

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your Ableton Move
- SSH access enabled: http://move.local/development/ssh

## Build from Source

```bash
./scripts/test.sh       # host-side tests (gcc, node)
./scripts/build.sh      # uses aarch64-linux-gnu-gcc if installed, else Docker
```

This produces `dist/chopper-module.tar.gz`. Install it either way:

- **Web manager (no ssh):** open http://move.local:7700/modules, use the
  custom install option to upload the tarball, then restart Schwung.
- **ssh:** `./scripts/install.sh` copies `dist/chopper` to the Move.

## Credits

- **Schwung framework**: [Charles Vestal](https://github.com/charlesvestal/schwung)
- Repo layout, build scripts and export approach adapted from
  [schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
  (MIT, Copyright (c) 2025 Charles Vestal)

## License

MIT License. See [LICENSE](LICENSE).
