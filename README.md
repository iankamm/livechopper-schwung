# Chopper for Schwung

Chop a sample across the pads of your Ableton Move in real time, like the chop
modes on MPC and SP drum machines, then export the result as a Move drum rack
preset. See [SPEC.md](SPEC.md).

Status: early development.

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your Ableton Move
- SSH access enabled: http://move.local/development/ssh

## Build from Source

```bash
./scripts/build.sh      # cross-compiles via Docker unless CROSS_PREFIX is set
./scripts/install.sh    # copies dist/chopper to the Move over ssh
```

## Credits

- **Schwung framework**: [Charles Vestal](https://github.com/charlesvestal/schwung)
- Repo layout, build scripts and export approach adapted from
  [schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor)
  (MIT, Copyright (c) 2025 Charles Vestal)

## License

MIT License. See [LICENSE](LICENSE).
