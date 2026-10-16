# Chopper for Schwung

Chop a sample across the pads of your Ableton Move in real time, like the chop
modes on MPC and SP drum machines, then export the result as a Move drum rack
preset or as one WAV per slice. See [SPEC.md](SPEC.md).

Status: early development.

## Controls

| Control | Function |
|---------|----------|
| Red pad | Play that slice while held and select it; letting go fades it out over Decay |
| Blue pad | While a slice plays: chop at the playhead |
| Knob 1 / Knob 2 | Move the selected slice's start / end |
| Knob 3 | Zoom |
| Knob 4 | Waveform vertical scale |
| Knob 5 / 7 | Attack / Decay (all pads; Decay up to 10 s, the default, plays out like a one-shot) |
| Knob 6 | Nothing for now |
| Knob 8 | Transpose (all pads, repitch) |
| Jog | Move the selected slice's start |
| Touch a knob | Preview its value |
| Shift | Fine steps for knobs and jog |
| Left / Right | Select previous / next slice |
| Delete | Delete the selected slice (merges it into the previous one; Pad 1 is trimmed off) |
| Undo / Shift+Undo | Undo the last chop or delete / redo it |
| Mute | Mute / unmute all audio on the device, Move and Chopper (lit while muted; leaving Chopper unmutes) |
| Record | Export menu: rename, Slices (one WAV per pad), Drum Preset, Cancel |
| Play | Play / stop Move's set (handled by Move, to practise along) |
| Back | Menu: Keep for later (resume from Tools, e.g. after changing tempo in Move) / Discard and exit / Cancel |

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
