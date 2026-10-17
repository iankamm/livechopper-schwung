/*
 * Move drum rack preset (.ablpreset) builder.
 *
 * Adapted from schwung-waveform-editor's saveDrumRackPreset() and
 * buildDrumCellParams(), Copyright (c) 2025 Charles Vestal, MIT License.
 *
 * Every pad points at the same WAV with Voice_PlaybackStart/Length set to
 * its slice as fractions of the file. All 16 pads share choke group 1.
 * Envelope times are in seconds (A-H-D mode), as in Move's own sets.
 */

export var USER_LIBRARY = "/data/UserData/UserLibrary/";
export var PRESET_DIR = USER_LIBRARY + "Track Presets";
export var PAD_COUNT = 16;
var FIRST_NOTE = 36;
var CHOKE_GROUP = 1;

/* Drum sampler limits, from values seen in Move sets. */
var ATTACK_MIN_S = 0.0001;
var HOLD_MIN_S = 0.001;
var HOLD_FULL_S = 60.0;     /* "Full": longer than any slice */
var DECAY_MIN_S = 0.001;
var DECAY_MAX_S = 10.0;
var GAIN_NEG_INF = -1000;    /* gainDb10 for -inf, as in plugin.c */
var GAIN_MIN_DB10 = -700;    /* Move's drum sampler Gain: -70 to +24 dB */
var GAIN_MAX_DB10 = 240;

/* "ableton:/user-library/<path>" for a file inside the User Library, with
 * each path segment percent-encoded. null if the file is elsewhere. */
export function sampleUriFor(filePath) {
    if (!filePath || filePath.indexOf(USER_LIBRARY) !== 0) return null;
    var rel = filePath.substring(USER_LIBRARY.length);
    return "ableton:/user-library/" + rel.split("/").map(encodeURIComponent).join("/");
}

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/*
 * env: { attackUs, holdUs (-1 = Full), decayUs, gated }
 */
export function envelopeSeconds(env) {
    return {
        attack: Math.max(ATTACK_MIN_S, env.attackUs / 1e6),
        hold: env.holdUs < 0 ? HOLD_FULL_S : Math.max(HOLD_MIN_S, env.holdUs / 1e6),
        decay: clamp(env.decayUs / 1e6, DECAY_MIN_S, DECAY_MAX_S),
        /* Gated playback is Move's A-S-R: sustain while held, Decay releases. */
        mode: env.gated ? "A-S-R" : "A-H-D"
    };
}

/* Voice_Gain from tenths of a dB. Move stores linear amplitude (a Song.abl
 * had +24 dB = 15.8489, -70 dB = 0.000316) and its range is -70 to +24 dB,
 * with no -inf, so -inf exports as -70 dB. */
function voiceGain(db10) {
    if (db10 === undefined || db10 === null) return 1.0;
    if (db10 <= GAIN_NEG_INF || db10 < GAIN_MIN_DB10) db10 = GAIN_MIN_DB10;
    if (db10 > GAIN_MAX_DB10) db10 = GAIN_MAX_DB10;
    return Math.pow(10, db10 / 200);
}

function buildDrumCellParams(playbackStart, playbackLength, envS, transpose, detune, gainDb10) {
    return {
        "Effect_EightBitFilterDecay": 5.0,
        "Effect_EightBitResamplingRate": 14080.0,
        "Effect_FmAmount": 0.0,
        "Effect_FmFrequency": 1000.0,
        "Effect_LoopLength": 0.30000001192092896,
        "Effect_LoopOffset": 0.019999999552965164,
        "Effect_NoiseAmount": 0.0,
        "Effect_NoiseFrequency": 10000.0,
        "Effect_On": true,
        "Effect_PitchEnvelopeAmount": 0.0,
        "Effect_PitchEnvelopeDecay": 0.30000001192092896,
        "Effect_PunchAmount": 0.0,
        "Effect_PunchTime": 0.12015999853610992,
        "Effect_RingModAmount": 0.0,
        "Effect_RingModFrequency": 1000.0,
        "Effect_StretchFactor": 1.0,
        "Effect_StretchGrainSize": 0.10000000149011612,
        "Effect_SubOscAmount": 0.0,
        "Effect_SubOscFrequency": 60.0,
        "Effect_Type": "Stretch",
        "Enabled": true,
        "NotePitchBend": true,
        "Pan": 0.0,
        "Voice_Detune": (detune || 0) / 100,     /* Move stores semitones */
        "Voice_Envelope_Attack": envS.attack,
        "Voice_Envelope_Decay": envS.decay,
        "Voice_Envelope_Hold": envS.hold,
        "Voice_Envelope_Mode": envS.mode,
        "Voice_Filter_Frequency": 22000.0,
        "Voice_Filter_On": true,
        "Voice_Filter_PeakGain": 1.0,
        "Voice_Filter_Resonance": 0.0,
        "Voice_Filter_Type": "Lowpass",
        "Voice_Gain": voiceGain(gainDb10),
        "Voice_ModulationAmount": 0.0,
        "Voice_ModulationSource": "Velocity",
        "Voice_ModulationTarget": "Filter",
        "Voice_PitchToEnvelopeModulation": true,
        "Voice_PlaybackLength": playbackLength,
        "Voice_PlaybackStart": playbackStart,
        "Voice_Transpose": transpose,
        "Voice_VelocityToVolume": 0.5,
        "Volume": -12.0
    };
}

function macros() {
    return {
        "Enabled": true,
        "Macro0": 0.0, "Macro1": 0.0, "Macro2": 0.0, "Macro3": 0.0,
        "Macro4": 0.0, "Macro5": 0.0, "Macro6": 0.0, "Macro7": 0.0
    };
}

function reverbReturnChain() {
    return {
        "name": "",
        "color": 0,
        "devices": [{
            "presetUri": null,
            "kind": "reverb",
            "name": "",
            "parameters": {
                "AllPassGain": 0.9219444394111633,
                "AllPassSize": 0.7699999809265137,
                "BandFreq": 402.4820251464844,
                "BandHighOn": true,
                "BandLowOn": true,
                "BandWidth": 4.572916507720947,
                "ChorusOn": false,
                "CutOn": false,
                "DecayTime": 3542.771728515625,
                "DiffuseDelay": 0.2142857164144516,
                "EarlyReflectModDepth": 3.2428934574127197,
                "EarlyReflectModFreq": 0.1093868613243103,
                "Enabled": true,
                "FlatOn": false,
                "FreezeOn": false,
                "HighFilterType": "Shelf",
                "MixDiffuse": 1.995300054550171,
                "MixDirect": 1.0,
                "MixReflect": 1.792531132698059,
                "PreDelay": 7.023662090301514,
                "RoomSize": 67.26939392089844,
                "RoomType": "SuperEco",
                "ShelfHiFreq": 1469.94873046875,
                "ShelfHiGain": 0.8833333849906921,
                "ShelfHighOn": true,
                "ShelfLoFreq": 670.7686157226563,
                "ShelfLoGain": 0.6166667342185974,
                "ShelfLowOn": true,
                "SizeModDepth": 0.15581557154655457,
                "SizeModFreq": 2.3727688789367676,
                "SizeSmoothing": "Fast",
                "SpinOn": true,
                "StereoSeparation": 107.62000274658203
            },
            "deviceData": {}
        }],
        "mixer": {
            "pan": 0.0,
            "solo-cue": false,
            "speakerOn": true,
            "volume": 0.0,
            "sends": [{ "isEnabled": false, "amount": -70.0 }]
        }
    };
}

/*
 * opts: {
 *   name:       preset name
 *   sampleUri:  from sampleUriFor()
 *   frames:     total frames in the WAV
 *   starts, ends: slice boundaries in frames (1-16 slices, time order)
 *   env:        { attackUs, holdUs, decayUs, gated }
 *   transpose:  semitones
 *   detune:     cents (-50 to +50)
 *   gainDb10:   gain in tenths of a dB, -1000 = -inf
 * }
 * Returns the preset object (JSON.stringify it to write).
 */
export function buildDrumRackPreset(opts) {
    var n = Math.min(opts.starts.length, PAD_COUNT);
    var envS = envelopeSeconds(opts.env);

    /* Always 16 chains for Move. Pads past the last slice reuse its region
     * with the speaker off, so the preset loads cleanly. */
    var drumChains = [];
    for (var i = 0; i < PAD_COUNT; i++) {
        var hasSlice = i < n;
        var si = hasSlice ? i : n - 1;
        var start = opts.starts[si] / opts.frames;
        var len = (opts.ends[si] - opts.starts[si]) / opts.frames;
        drumChains.push({
            "name": "",
            "color": 0,
            "devices": [{
                "presetUri": null,
                "kind": "drumCell",
                "name": "",
                "parameters": buildDrumCellParams(start, len, envS, opts.transpose, opts.detune, opts.gainDb10),
                "deviceData": { "sampleUri": opts.sampleUri }
            }],
            "mixer": {
                "pan": 0.0,
                "solo-cue": false,
                "speakerOn": hasSlice,
                "volume": 0.0,
                "sends": [{ "isEnabled": true, "amount": -70.0 }]
            },
            "drumZoneSettings": {
                "receivingNote": FIRST_NOTE + i,
                "sendingNote": 60,
                "chokeGroup": CHOKE_GROUP
            }
        });
    }

    return {
        "$schema": "http://tech.ableton.com/schema/song/1.8.2/devicePreset.json",
        "kind": "instrumentRack",
        "name": opts.name,
        "parameters": macros(),
        "chains": [{
            "name": "",
            "color": 0,
            "devices": [{
                "presetUri": null,
                "kind": "drumRack",
                "name": opts.name,
                "parameters": macros(),
                "chains": drumChains,
                "returnChains": [reverbReturnChain()]
            }],
            "mixer": {
                "pan": 0.0,
                "solo-cue": false,
                "speakerOn": true,
                "volume": 0.0,
                "sends": []
            }
        }]
    };
}
