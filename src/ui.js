/*
 * Chopper UI
 *
 * Chop a sample across pads in real time. See SPEC.md.
 * 128x64 1-bit monochrome display, QuickJS runtime.
 *
 * The DSP owns pad input, the slice list and the playhead (so chops are
 * sample-accurate); this UI only mirrors DSP state by polling get_param.
 *
 * Controls:
 *   Red pads  - Play that slice (one-shot, chokes the others)
 *   Blue pad  - While a slice plays: chop at the playhead
 *   Back      - Exit
 */

import {
    MoveBack, MovePads,
    Black, DarkGrey, BrightRed, PureBlue
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("Chopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var PAD_NOTE_MIN = MovePads[0];
var MAX_PADS = 16;
var COLOR_SLICE = BrightRed;    /* playable slice pad */
var COLOR_TARGET = PureBlue;    /* chop target */
var COLOR_UNUSED = DarkGrey;
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

/* Mirrored from DSP slices */
var chopCount = 0;
var playingSlice = -1;
var sliceCount = 0;
var sliceStarts = [];

var lastLoadState = "";
var lastChopCount = 0;
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

function pollSlices() {
    var raw = host_module_get_param("slices");
    if (!raw) return;
    var p = raw.split(" ");
    chopCount = parseInt(p[0], 10) || 0;
    playingSlice = parseInt(p[1], 10);
    sliceCount = parseInt(p[2], 10) || 0;
    sliceStarts = [];
    for (var i = 0; i < sliceCount; i++) {
        sliceStarts.push(parseInt(p[3 + i * 2], 10) || 0);
    }
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

function onChop() {
    if (sliceCount >= MAX_PADS) {
        announce("Chop, " + sliceCount + " slices, all pads used");
    } else {
        announce("Chop, " + sliceCount + " slices");
    }
}

/* Set a slice pad's LED only when its color changes. */
function setPadColor(i, color) {
    if (padColors[i] === color) return;
    padColors[i] = color;
    setLED(padIndexToNote(i), color);
}

function updatePadLeds() {
    var ready = loadState === "ready";
    for (var i = 0; i < MAX_PADS; i++) {
        var color = COLOR_UNUSED;
        if (ready && i < sliceCount) color = COLOR_SLICE;
        else if (ready && i === sliceCount) color = COLOR_TARGET;
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

var BAR_X = 2;
var BAR_Y = 38;
var BAR_W = SCREEN_W - 4;
var BAR_H = 10;

function frameToX(f) {
    return BAR_X + Math.floor((BAR_W - 1) * f / frames);
}

function drawSliceBar() {
    draw_rect(BAR_X, BAR_Y, BAR_W, BAR_H, 1);
    if (frames <= 0) return;
    /* Slice boundaries (skip slice 1's start, the left edge) */
    for (var i = 1; i < sliceStarts.length; i++) {
        var x = frameToX(sliceStarts[i]);
        draw_line(x, BAR_Y - 3, x, BAR_Y + BAR_H - 1, 1);
    }
    if (playing) {
        var px = frameToX(playPos);
        fill_rect(px, BAR_Y + 2, 2, BAR_H - 4, 1);
    }
}

function draw() {
    clear_screen();
    print(2, 2, "Chopper", 1);
    print(2, 14, fileName ? fileName.substring(0, 20) : "(no file)", 1);

    if (loadState === "loading") {
        print(2, 30, "Loading...", 1);
    } else if (loadState === "error") {
        print(2, 30, errorMsg.substring(0, 20), 1);
    } else if (loadState === "ready") {
        print(2, 26, formatSeconds(frames) + "  " + sliceCount + "/" + MAX_PADS + " pads", 1);
        drawSliceBar();
        var footer;
        if (playing && playingSlice >= 0) footer = "Playing Pad " + (playingSlice + 1);
        else if (sliceCount === 1) footer = "Press Pad 1";
        else footer = "Press a red pad";
        print(2, 52, footer, 1);
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
    pollSlices();
    if (loadState !== lastLoadState) {
        lastLoadState = loadState;
        onLoadStateChange();
    }
    if (chopCount !== lastChopCount) {
        if (chopCount > lastChopCount) onChop();
        lastChopCount = chopCount;
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
