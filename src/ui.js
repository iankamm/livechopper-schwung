/*
 * Chopper UI
 *
 * Chop a sample across pads in real time. See SPEC.md.
 * 128x64 1-bit monochrome display, QuickJS runtime.
 *
 * Step 0: shows the chosen file and a pad probe read back from the DSP,
 * to confirm pad notes reach the DSP's on_midi on the audio thread.
 *
 * Controls:
 *   Pads  - (probe) counted by the DSP
 *   Back  - Exit
 */

import {
    MoveBack, MovePads,
    Black, DarkGrey, PureBlue
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("Chopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var PAD_NOTE_MIN = MovePads[0];
var PAD_NOTE_MAX = MovePads[MovePads.length - 1];
var MAX_PADS = 16;

/* Slice pads are the left 4x4 block, like a Move drum rack.
 * Pad 1 is bottom-left, numbered left to right then upward. */
var PAD_COLS = 4;
var ROW_STRIDE = 8;

function padIndexToNote(i) {
    return PAD_NOTE_MIN + Math.floor(i / PAD_COLS) * ROW_STRIDE + (i % PAD_COLS);
}

/* Returns 0-15 for a slice pad, or -1 for the right half. */
function noteToPadIndex(note) {
    var off = note - PAD_NOTE_MIN;
    if (off < 0 || off >= MovePads.length) return -1;
    var col = off % ROW_STRIDE;
    if (col >= PAD_COLS) return -1;
    return Math.floor(off / ROW_STRIDE) * PAD_COLS + col;
}

/* ============ State ============ */

var filePath = "";
var fileName = "";
var probe = "";
var hostSeesPad = -1;   /* last pad note seen by the UI, for comparison */
var hostSeesPadIdx = -1;
var ledInitIndex = 0;   /* progressive LED init, a few per tick */

/* ============ Helpers ============ */

function baseName(path) {
    var i = path.lastIndexOf("/");
    return i >= 0 ? path.substring(i + 1) : path;
}

function initLedsStep() {
    var end = Math.min(ledInitIndex + 8, MovePads.length);
    for (; ledInitIndex < end; ledInitIndex++) {
        setLED(MovePads[ledInitIndex], restColor(MovePads[ledInitIndex]));
    }
}

function restColor(note) {
    return noteToPadIndex(note) >= 0 ? DarkGrey : Black;
}

function exitTool() {
    for (var i = 0; i < MovePads.length; i++) setLED(MovePads[i], Black);
    if (typeof host_exit_module === "function") host_exit_module();
}

/* ============ Drawing ============ */

function draw() {
    clear_screen();
    print(2, 2, "Chopper", 1);
    print(2, 14, fileName ? fileName.substring(0, 20) : "(no file)", 1);
    print(2, 28, "DSP: " + probe, 1);
    print(2, 40, "UI pad: " + hostSeesPad +
          (hostSeesPadIdx >= 0 ? " = Pad " + (hostSeesPadIdx + 1) : ""), 1);
}

/* ============ Entry points ============ */

globalThis.init = function() {
    filePath = (typeof host_tool_file_path === "string") ? host_tool_file_path : "";
    fileName = baseName(filePath);
    if (filePath) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("file_path", filePath, 10000);
        } else {
            host_module_set_param("file_path", filePath);
        }
    }
    debugLog("init file=" + filePath);
    announce("Chopper, " + (fileName || "no file"));
};

globalThis.tick = function() {
    if (ledInitIndex < MovePads.length) initLedsStep();
    probe = host_module_get_param("pad_probe") || "?";
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    var status = data[0] & 0xF0;
    var d1 = data[1];
    var d2 = data[2];

    if (status === 0xB0) {
        if (d1 === CC_BACK && d2 > 0) exitTool();
    } else if (status === 0x90 && d2 > 0) {
        if (d1 >= PAD_NOTE_MIN && d1 <= PAD_NOTE_MAX) {
            hostSeesPad = d1;
            hostSeesPadIdx = noteToPadIndex(d1);
            if (hostSeesPadIdx >= 0) setLED(d1, PureBlue);
        }
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
        if (d1 >= PAD_NOTE_MIN && d1 <= PAD_NOTE_MAX) {
            setLED(d1, restColor(d1));
        }
    }
};
