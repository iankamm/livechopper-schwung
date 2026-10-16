/*
 * Host-side test for src/dsp/plugin.c: compiles the plugin in, loads WAVs
 * through the real worker thread, and drives pads/params like the host.
 *
 *   gcc -std=c11 -g -fsanitize=address,undefined -Isrc/dsp \
 *       tests/dsp_test.c -o build/dsp_test -lm -lpthread && build/dsp_test
 */
#include "../src/dsp/plugin.c"

#include <math.h>
#include <unistd.h>
#include <sys/stat.h>

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static plugin_api_v2_t *api;
static int16_t out[MOVE_FRAMES_PER_BLOCK * 2];

static void wr16(FILE *f, int v) { fputc(v & 255, f); fputc((v >> 8) & 255, f); }
static void wr32(FILE *f, int v) { wr16(f, v & 0xFFFF); wr16(f, (v >> 16) & 0xFFFF); }

/* Ramp WAV: sample i of channel c = (i * 3 + c * 1000) % 30000, scaled to bits. */
static void write_wav(const char *path, int frames, int channels, int rate, int bits) {
    FILE *f = fopen(path, "wb");
    int bps = bits / 8, data = frames * channels * bps;
    fwrite("RIFF", 1, 4, f); wr32(f, 36 + data); fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f); wr32(f, 16); wr16(f, 1); wr16(f, channels);
    wr32(f, rate); wr32(f, rate * channels * bps); wr16(f, channels * bps); wr16(f, bits);
    fwrite("data", 1, 4, f); wr32(f, data);
    for (int i = 0; i < frames; i++) {
        for (int c = 0; c < channels; c++) {
            int v = (i * 3 + c * 1000) % 30000;
            if (bits == 16) wr16(f, v);
            else { fputc(0x5A, f); wr16(f, v); }   /* 24-bit: low byte is noise */
        }
    }
    fclose(f);
}

static int ramp(int i, int c) { return (i * 3 + c * 1000) % 30000; }

static void render(void *inst, int blocks) {
    for (int b = 0; b < blocks; b++) api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
}

static void note(void *inst, int n) {
    uint8_t m[3] = { 0x90, (uint8_t)n, 100 };
    api->on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL);
}

static void param(void *inst, const char *k, const char *v) { api->set_param(inst, k, v); }

static void get(void *inst, const char *k, char *buf, int len) {
    if (api->get_param(inst, k, buf, len) < 0) buf[0] = 0;
}

static void *load(const char *path) {
    void *inst = api->create_instance(".", NULL);
    param(inst, "file_path", path);
    char st[256];
    for (int t = 0; t < 400; t++) {
        render(inst, 1);
        get(inst, "status", st, sizeof st);
        if (strncmp(st, "ready", 5) == 0 || strncmp(st, "error", 5) == 0) break;
        usleep(5000);
    }
    return inst;
}

/* Slices as "count:s-e,s-e,..." */
static const char *slices(void *inst) {
    static char res[512];
    char raw[1024];
    get(inst, "slices", raw, sizeof raw);
    unsigned chop, undo, del; int depth, playing, sel, count;
    int n = 0, off = 0;
    sscanf(raw, "%u %u %u %d %d %d %d%n", &chop, &undo, &del, &depth, &playing, &sel, &count, &off);
    n = snprintf(res, sizeof res, "%d:", count);
    const char *p = raw + off;
    for (int i = 0; i < count; i++) {
        int s, e, used;
        sscanf(p, "%d %d%n", &s, &e, &used);
        p += used;
        n += snprintf(res + n, sizeof res - (size_t)n, "%s%d-%d", i ? "," : "", s, e);
    }
    return res;
}

static int field(void *inst, int i) {
    char raw[1024];
    get(inst, "slices", raw, sizeof raw);
    const char *p = raw;
    int v = 0;
    for (int k = 0; k <= i; k++) v = parse_int(&p);
    return v;
}
#define F_PLAYING 4
#define F_SELECTED 5

/* Render until nothing is playing (and the choke tail is gone). */
static void until_silent(void *inst) {
    for (int i = 0; i < 2000 && field(inst, F_PLAYING) != -1; i++) render(inst, 1);
    render(inst, 1);
}

int main(void) {
    api = move_plugin_init_v2(NULL);
    mkdir("build", 0755);
    write_wav("build/t16.wav", 44100, 1, 44100, 16);
    write_wav("build/t24.wav", 4800, 2, 48000, 24);

    /* ---- Load + plain playback ---- */
    void *inst = load("build/t16.wav");
    char st[256];
    get(inst, "status", st, sizeof st);
    CHECK(strncmp(st, "ready 44100 44100", 17) == 0, "status after load: %s", st);
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "initial slices %s", slices(inst));

    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    int exact = 1;
    for (int i = 0; i < MOVE_FRAMES_PER_BLOCK; i++)
        if (out[i * 2] != ramp(i, 0) || out[i * 2 + 1] != ramp(i, 0)) exact = 0;
    CHECK(exact, "mono 16-bit plays back sample-exact on both channels");

    /* ---- Chop at the playhead: block-accurate ---- */
    render(inst, 9);                       /* playhead at 10 blocks = 1280 */
    note(inst, 69);                        /* Pad 2 is blue */
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "first chop %s", slices(inst));
    CHECK(field(inst, F_PLAYING) == 1 && field(inst, F_SELECTED) == 1, "playback moved to new slice");
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == ramp(1280, 0), "playback continues seamlessly at the chop: %d vs %d", out[0], ramp(1280, 0));

    /* ---- Middle split (spec example) ---- */
    note(inst, 68); render(inst, 5);       /* Pad 1 at 640 */
    note(inst, 70);                        /* Pad 3 is blue */
    CHECK(strcmp(slices(inst), "3:0-640,640-1280,1280-44100") == 0, "middle split %s", slices(inst));
    CHECK(field(inst, F_PLAYING) == 1, "plays the new Pad 2");

    /* Blue pad while silent does nothing; pads past blue do nothing */
    render(inst, 50);
    note(inst, 71);
    CHECK(strcmp(slices(inst), "3:0-640,640-1280,1280-44100") == 0, "blue pad while silent");

    /* ---- Undo ---- */
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "undo %s", slices(inst));
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "undo to start %s", slices(inst));
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "undo with nothing left");

    /* ---- Delete merges into previous ---- */
    note(inst, 68); render(inst, 10); note(inst, 69);      /* 0-1280 | 1280-end */
    note(inst, 69); render(inst, 10); note(inst, 70);      /* 1280-2560 | 2560-end */
    CHECK(strcmp(slices(inst), "3:0-1280,1280-2560,2560-44100") == 0, "setup for delete %s", slices(inst));
    param(inst, "delete", "1");
    CHECK(strcmp(slices(inst), "2:0-2560,2560-44100") == 0, "delete Pad 2 merges into Pad 1: %s", slices(inst));
    CHECK(field(inst, F_SELECTED) == 0, "selection moves to the merged pad");
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "3:0-1280,1280-2560,2560-44100") == 0, "undo delete %s", slices(inst));
    param(inst, "delete", "0");
    CHECK(strcmp(slices(inst), "2:0-2560,2560-44100") == 0, "delete Pad 1 merges into Pad 2: %s", slices(inst));
    param(inst, "delete", "1");
    param(inst, "delete", "0");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "delete down to one %s", slices(inst));
    param(inst, "delete", "0");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "can't delete the only slice");

    /* Delete the playing slice: playback continues in the merged slice */
    note(inst, 68); render(inst, 10); note(inst, 69);
    render(inst, 2);
    param(inst, "delete", "1");
    CHECK(field(inst, F_PLAYING) == 0, "playing slice deleted: plays on in merged Pad 1");

    /* ---- Undo history is bounded and keeps working past 32 steps ---- */
    for (int i = 0; i < 40; i++) {
        note(inst, 68); render(inst, 3); note(inst, 69);
        param(inst, "delete", "1");
    }
    int undos = 0;
    for (int i = 0; i < 100 && field(inst, 3) > 0; i++) { param(inst, "undo", "1"); undos++; }
    CHECK(undos == 32, "undo history holds 32 steps (got %d)", undos);

    /* ---- Linked nudge ---- */
    api->destroy_instance(inst);
    inst = load("build/t16.wav");
    note(inst, 68); render(inst, 10); note(inst, 69);
    param(inst, "nudge", "1 0 100");
    CHECK(strcmp(slices(inst), "2:0-1380,1380-44100") == 0, "nudge start moves previous end %s", slices(inst));
    param(inst, "nudge", "0 1 -2000");
    CHECK(strcmp(slices(inst), "2:0-64,64-44100") == 0, "nudge clamps at min length %s", slices(inst));
    param(inst, "nudge", "0 0 500");
    CHECK(strcmp(slices(inst), "2:0-64,64-44100") == 0, "can't push start past end %s", slices(inst));
    param(inst, "nudge", "1 1 -100");
    CHECK(strcmp(slices(inst), "2:0-64,64-44000") == 0, "trim last end %s", slices(inst));

    /* ---- Transpose +12 plays at double speed ---- */
    param(inst, "transpose", "12");
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[2] == ramp(2, 0) && out[4] == ramp(4, 0), "transpose +12 reads every other frame (%d %d %d, want %d %d %d; %s)", out[0], out[2], out[4], ramp(0,0), ramp(2,0), ramp(4,0), slices(inst));
    param(inst, "transpose", "0");

    /* ---- Envelope: attack ramps, hold/decay end the voice ---- */
    param(inst, "nudge", "0 1 20000");      /* Pad 1 = 0-20064 */
    param(inst, "attack_us", "10000");      /* 441 frames */
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == 0 && abs(out[200] - ramp(100, 0) * 100 / 441) <= 1, "attack ramps from 0 (%d)", out[200]);
    param(inst, "attack_us", "0");
    param(inst, "hold_us", "10000");
    param(inst, "decay_us", "10000");
    note(inst, 68);
    render(inst, 8);                        /* 1024 frames > 441 + 441 */
    CHECK(field(inst, F_PLAYING) == -1, "voice ends after hold + decay");
    param(inst, "hold_us", "-1");

    /* ---- Choke fades the old voice instead of cutting it ---- */
    note(inst, 68); render(inst, 4);
    note(inst, 69);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] != ramp(20064, 0), "choke mixes in a fading tail");
    api->destroy_instance(inst);

    /* ---- 24-bit stereo 48 kHz ---- */
    inst = load("build/t24.wav");
    get(inst, "status", st, sizeof st);
    CHECK(strncmp(st, "ready 4800 48000", 16) == 0, "24-bit stereo status %s", st);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == ramp(0, 0) && out[1] == ramp(0, 1), "24-bit stereo decodes L/R (%d %d)", out[0], out[1]);
    api->destroy_instance(inst);

    /* ---- Bad file ---- */
    FILE *f = fopen("build/bad.wav", "wb"); fputs("not a wav", f); fclose(f);
    inst = load("build/bad.wav");
    get(inst, "status", st, sizeof st);
    char err[64];
    get(inst, "error", err, sizeof err);
    CHECK(strncmp(st, "error", 5) == 0 && strcmp(err, "Not a WAV file") == 0, "bad file: %s / %s", st, err);
    api->destroy_instance(inst);

    printf(failures ? "%d FAILED\n" : "all checks passed\n", failures);
    return failures ? 1 : 0;
}
