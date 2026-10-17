# Chopper for Schwung

Chop a sample across the pads of your Ableton Move by ear, while it plays.
Start it from Pad 1 and tap the next pad wherever you want a cut: playback
carries straight on into the new slice, so a whole loop is chopped in one
pass. This is the tap-to-slice workflow known as "lazy chop" or live chop on
Akai MPCs, and also found as real-time chop on the Roland SP-404MKII and on
Teenage Engineering's EP-133 K.O. II.

Then fine-tune the chop points and export the result as a Move drum rack
preset or as one WAV per slice. See [SPEC.md](SPEC.md).

Status: early development.

## Controls

| Control | Function |
|---------|----------|
| Red pad | Select and play slice |
| Blue pad | Chop at the playhead |
| Knob 1 / 2 | Slice start / end |
| Knob 3 / 4 | Zoom / waveform scale |
| Knob 5 / 6 / 7 | Attack / hold / decay |
| Knob 8 | Transpose |
| Jog | Slice start |
| Left / Right | Previous / next slice |
| Shift | Fine adjust |
| Mute | One-shot (lit) / gated |
| Delete | Delete slice |
| Undo / Shift+Undo | Undo / redo |
| Record | Export menu |
| Play | Play / stop Move's set |
| Back | Keep for later / exit |

Touch a knob to see its value. Envelope and transpose apply to all pads. Settings can be adjusted per pad after exporting to a native drum preset.

## Requirements

[Schwung](https://github.com/charlesvestal/schwung) installed on your Ableton Move.

## Build and Install

```bash
./scripts/test.sh       # host-side tests (gcc, node)
./scripts/build.sh      # aarch64-linux-gnu-gcc if installed, else Docker
```

This produces `dist/chopper-module.tar.gz`. To install:

- **Web manager:** upload the tarball at http://move.local:7700/modules
  (custom install), then restart Schwung.
- **ssh:** `./scripts/install.sh` (needs SSH enabled at
  http://move.local/development/ssh).

## Credits

- **Schwung framework**: [Charles Vestal](https://github.com/charlesvestal/schwung)
- Repo layout, build scripts and export approach adapted from
  [schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
  (MIT, Copyright (c) 2025 Charles Vestal)

## License

MIT License. See [LICENSE](LICENSE).
