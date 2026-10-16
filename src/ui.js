/*
 * Chopper UI
 *
 * Chop a sample across pads in real time. See SPEC.md.
 * 128x64 1-bit monochrome display, QuickJS runtime.
 *
 * The DSP owns pad input and the playhead (so chops are sample-accurate);
 * this UI only mirrors DSP state by polling get_param("status").
 *
 * Step 1: the WAV loads into the DSP; Pad 1 plays the whole sample.
 *
 * Controls:
 *   Pad 1 - Play the sample
 *   Back  - Exit
 */

import {
    MoveBack, MovePads,
    Black, DarkGrey, BrightRed
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("Chopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var PAD_NOTE_MIN = MovePads[0];
var MAX_PADS = 16;
var COLOR_SLICE = BrightRed;     /* playable slice pad */
var SCREEN_W = 128;

/* Slice pads are the left 4x4 block, like a Move drum rack.
 * Pad 1 is bottom-left, numbered left to right then upward. */
var PAD_COLS = 4;
var ROW_STRIDE = 8;

function padIndexToNote(i) {
    return PAD_NOTE_MIN + Math.floor(i / PAD_COLS) * ROW_STRIDE + (i % PAD_COLS);
}

/* ============ State ============ */

var filePath = "";
var fileName = "";

/* Mirrored from DSP status */
var loadState = "none";     /* none | loading | ready | error */
var frames = 0;
var sampleRate = 0;
var playing = false;
var playPos = 0;
var errorMsg = "";

var lastLoadState = "";
var padColors = [];         /* last color sent per pad index, to avoid LED spam */

/* ============ Helpers ============ */

function baseName(path) {
    var i = path.lastIndexOf("/");
    return i >= 0 ? path.substring(i + 1) : path;
}

function formatSeconds(f) {
    if (!sampleRate) return "0.0s";
    return (f / sampleRate).toFixed(1) + "s";
}

function pollStatus() {
    var raw = host_module_get_param("status");
    if (!raw) return;
    var p = raw.split(" ");
    loadState = p[0];
    frames = parseInt(p[1], 10) || 0;
    sampleRate = parseInt(p[2], 10) || 0;
    playing = p[3] === "1";
    playPos = parseInt(p[4], 10) || 0;
}

function onLoadStateChange() {
    if (loadState === "ready") {
        announce("Loaded " + fileName + ", press Pad 1");
    } else if (loadState === "error") {
        errorMsg = host_module_get_param("error") || "Load failed";
        announce("Load failed, " + errorMsg);
    }
    debugLog("load state " + loadState);
}

/* Set a slice pad's LED only when its color changes. */
function setPadColor(i, color) {
    if (padColors[i] === color) return;
    padColors[i] = color;
    setLED(padIndexToNote(i), color);
}

function updatePadLeds() {
    for (var i = 0; i < MAX_PADS; i++) {
        var color = DarkGrey;
        if (i === 0 && loadState === "ready") color = COLOR_SLICE;
        setPadColor(i, color);
    }
}

function clearAllPadLeds() {
    for (var i = 0; i < MovePads.length; i++) setLED(MovePads[i], Black);
}

function exitTool() {
    clearAllPadLeds();
    if (typeof host_exit_module === "function") host_exit_module();
}

/* ============ Drawing ============ */

function draw() {
    clear_screen();
    print(2, 2, "Chopper", 1);
    print(2, 14, fileName ? fileName.substring(0, 20) : "(no file)", 1);

    if (loadState === "loading") {
        print(2, 30, "Loading...", 1);
    } else if (loadState === "error") {
        print(2, 30, errorMsg.substring(0, 20), 1);
    } else if (loadState === "ready") {
        print(2, 26, formatSeconds(frames) + "  " + sampleRate + "Hz", 1);
        /* Playhead bar */
        draw_rect(2, 40, SCREEN_W - 4, 8, 1);
        if (playing && frames > 0) {
            var w = Math.floor((SCREEN_W - 8) * playPos / frames);
            fill_rect(4, 42, Math.max(1, w), 4, 1);
        }
        print(2, 52, playing ? "Playing" : "Press Pad 1", 1);
    }
}

/* ============ Entry points ============ */

globalThis.init = function() {
    filePath = (typeof host_tool_file_path === "string") ? host_tool_file_path : "";
    fileName = baseName(filePath);
    clearAllPadLeds();
    if (filePath) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("file_path", filePath, 10000);
        } else {
            host_module_set_param("file_path", filePath);
        }
    }
    debugLog("init file=" + filePath);
    announce("Chopper, loading " + (fileName || "no file"));
};

globalThis.tick = function() {
    pollStatus();
    if (loadState !== lastLoadState) {
        lastLoadState = loadState;
        onLoadStateChange();
    }
    updatePadLeds();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    var status = data[0] & 0xF0;
    var d1 = data[1];
    var d2 = data[2];

    /* Pads are handled by the DSP on the audio thread; nothing to do here. */
    if (status === 0xB0) {
        if (d1 === CC_BACK && d2 > 0) exitTool();
    }
};
