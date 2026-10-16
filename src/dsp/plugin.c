/*
 * Chopper DSP Plugin
 *
 * Real-time sample chopping across pads. See SPEC.md.
 *
 * V2 API only. Every entry point below runs on the SPI audio callback
 * (see plugin_api_v1.h): no malloc/free, no file I/O, no logging, no locks,
 * no unbounded loops. create_instance/destroy_instance for an overtake tool
 * run on the shim worker, so allocation and thread start/join are allowed
 * there and only there.
 *
 * Loading: set_param("file_path") copies the path and bumps a sequence
 * number. A SCHED_OTHER worker thread (pinned off core 3) notices, reads the
 * WAV into an interleaved stereo int16 buffer, and hands it to the audio
 * thread through the `incoming` pointer. The audio thread swaps it in at the
 * top of a block and passes the old buffer back through `retired` for the
 * worker to free. Neither side ever blocks on the other.
 *
 * Chopping: the DSP owns the slice list and the playhead. A note-on for the
 * blue pad (the first unused one) splits the slice that is playing at the
 * current playhead, inserts the new slice right after it, and playback
 * carries on into the new slice without a gap. Pads stay in time order.
 * One voice at a time: every pad chokes every other. Playback is one-shot.
 *
 * Undo: each chop first pushes a snapshot of the slice list onto a fixed
 * stack (no allocation); set_param("undo") pops it.
 */

#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdatomic.h>
#include <pthread.h>
#include <sched.h>
#include <time.h>

#include "plugin_api_v1.h"

#define PAD_NOTE_MIN 68
#define PAD_NOTE_MAX 99
#define MAX_SLICES 16
/* Slice pads are the left 4x4 block, Pad 1 bottom-left. */
#define PAD_COLS 4
#define PAD_ROW_STRIDE 8
/* Chops closer than this to a slice edge are ignored (~1.5 ms). */
#define MIN_SLICE_FRAMES 64
#define PATH_MAX_LEN 512
#define ERROR_MAX_LEN 64

/* 10 minutes of stereo int16 at 44.1 kHz is ~106 MB. */
#define MAX_SOURCE_FRAMES (44100 * 60 * 10)
#define WORKER_POLL_NS (20 * 1000 * 1000)
#define READ_CHUNK_BYTES (64 * 1024)

enum {
    LOAD_NONE = 0,
    LOAD_BUSY = 1,
    LOAD_FAILED = 2
};

typedef struct {
    int16_t *data;      /* interleaved stereo */
    int frames;
    int sample_rate;    /* rate of the source file */
} sample_buf_t;

/* Everything a chop changes, so undo can restore it whole. */
typedef struct {
    int slice_start[MAX_SLICES];
    int slice_end[MAX_SLICES];
    int slice_count;
} slice_snapshot_t;

/* At most MAX_SLICES - 1 chops can be in effect at once. */
#define UNDO_DEPTH (MAX_SLICES - 1)

typedef struct {
    /* --- audio thread only --- */
    sample_buf_t *current;
    int playing;
    double play_pos;    /* in source frames */
    double play_step;   /* source frames per output frame */
    int play_end;

    /* Slices, in time order. Pad i plays slice i. */
    int slice_start[MAX_SLICES];
    int slice_end[MAX_SLICES];
    int slice_count;
    int playing_slice;  /* -1 when silent */
    uint32_t chop_count; /* bumped on every chop, for the UI */
    uint32_t undo_count; /* bumped on every undo, for the UI */

    slice_snapshot_t undo_stack[UNDO_DEPTH];
    int undo_depth;

    /* --- handoff between audio thread and worker --- */
    char req_path[PATH_MAX_LEN];
    atomic_uint req_seq;
    _Atomic(sample_buf_t *) incoming;
    _Atomic(sample_buf_t *) retired;
    atomic_int load_state;
    char load_error[ERROR_MAX_LEN];

    /* --- worker --- */
    pthread_t worker;
    int worker_started;
    atomic_int worker_quit;
} chopper_t;

static const host_api_v1_t *g_host = NULL;

/* ============================================================================
 * WAV loading (worker thread only)
 * ============================================================================ */

static uint16_t rd_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int16_t clamp16(float v) {
    if (v > 32767.0f) return 32767;
    if (v < -32768.0f) return -32768;
    return (int16_t)v;
}

/* Convert one sample at p to int16. fmt: 1 = PCM int, 3 = IEEE float. */
static int16_t decode_sample(const uint8_t *p, int fmt, int bits) {
    if (fmt == 3) {
        if (bits == 32) {
            float f;
            memcpy(&f, p, 4);
            return clamp16(f * 32768.0f);
        }
        double d;
        memcpy(&d, p, 8);
        return clamp16((float)(d * 32768.0));
    }
    switch (bits) {
    case 8:  return (int16_t)(((int)p[0] - 128) << 8);
    case 16: return (int16_t)rd_u16(p);
    case 24: return (int16_t)rd_u16(p + 1);     /* top 16 of 24 bits */
    default: return (int16_t)rd_u16(p + 2);     /* top 16 of 32 bits */
    }
}

/* Returns a new buffer, or NULL with err filled in. */
static sample_buf_t *load_wav(const char *path, char *err, size_t err_len) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(err, err_len, "Can't open file");
        return NULL;
    }

    uint8_t hdr[12];
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) {
        fclose(f);
        snprintf(err, err_len, "Not a WAV file");
        return NULL;
    }

    int fmt = 0, channels = 0, rate = 0, bits = 0, have_fmt = 0;
    uint32_t data_bytes = 0;
    int have_data = 0;

    /* Walk chunks until "data", picking up "fmt " on the way. */
    for (;;) {
        uint8_t ch[8];
        if (fread(ch, 1, 8, f) != 8) break;
        uint32_t len = rd_u32(ch + 4);
        if (memcmp(ch, "fmt ", 4) == 0) {
            uint8_t fb[40];
            uint32_t n = len < sizeof(fb) ? len : (uint32_t)sizeof(fb);
            if (n < 16 || fread(fb, 1, n, f) != n) break;
            fmt = rd_u16(fb);
            channels = rd_u16(fb + 2);
            rate = (int)rd_u32(fb + 4);
            bits = rd_u16(fb + 14);
            if (fmt == 0xFFFE && n >= 26) fmt = rd_u16(fb + 24); /* EXTENSIBLE subformat */
            have_fmt = 1;
            if (fseek(f, (long)(len - n + (len & 1)), SEEK_CUR) != 0) break;
        } else if (memcmp(ch, "data", 4) == 0) {
            data_bytes = len;
            have_data = 1;
            break;
        } else {
            if (fseek(f, (long)(len + (len & 1)), SEEK_CUR) != 0) break;
        }
    }

    if (!have_fmt || !have_data) {
        fclose(f);
        snprintf(err, err_len, "Bad WAV header");
        return NULL;
    }
    int ok_fmt = (fmt == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32)) ||
                 (fmt == 3 && (bits == 32 || bits == 64));
    if (!ok_fmt || channels < 1 || rate < 1000 || rate > 384000) {
        fclose(f);
        snprintf(err, err_len, "Unsupported WAV format");
        return NULL;
    }

    int bytes_per_sample = bits / 8;
    int block_align = bytes_per_sample * channels;
    long frames = (long)(data_bytes / (uint32_t)block_align);
    if (frames <= 0) {
        fclose(f);
        snprintf(err, err_len, "Empty WAV file");
        return NULL;
    }
    if (frames > MAX_SOURCE_FRAMES) {
        fclose(f);
        snprintf(err, err_len, "File too long");
        return NULL;
    }

    sample_buf_t *s = (sample_buf_t *)calloc(1, sizeof(sample_buf_t));
    int16_t *out = (int16_t *)malloc((size_t)frames * 2 * sizeof(int16_t));
    uint8_t *chunk = (uint8_t *)malloc(READ_CHUNK_BYTES);
    if (!s || !out || !chunk) {
        free(s); free(out); free(chunk);
        fclose(f);
        snprintf(err, err_len, "Out of memory");
        return NULL;
    }

    int frames_per_chunk = READ_CHUNK_BYTES / block_align;
    long done = 0;
    while (done < frames) {
        long want = frames - done;
        if (want > frames_per_chunk) want = frames_per_chunk;
        size_t got = fread(chunk, (size_t)block_align, (size_t)want, f);
        for (size_t i = 0; i < got; i++) {
            const uint8_t *fp = chunk + i * (size_t)block_align;
            int16_t l = decode_sample(fp, fmt, bits);
            int16_t r = channels > 1 ? decode_sample(fp + bytes_per_sample, fmt, bits) : l;
            out[(done + (long)i) * 2] = l;
            out[(done + (long)i) * 2 + 1] = r;
        }
        done += (long)got;
        if ((long)got < want) break; /* truncated file: keep what we have */
    }
    free(chunk);
    fclose(f);

    if (done <= 0) {
        free(out); free(s);
        snprintf(err, err_len, "Empty WAV file");
        return NULL;
    }

    s->data = out;
    s->frames = (int)done;
    s->sample_rate = rate;
    return s;
}

static void free_sample(sample_buf_t *s) {
    if (!s) return;
    free(s->data);
    free(s);
}

static void worker_demote(void) {
    struct sched_param sp = { .sched_priority = 0 };
    sched_setscheduler(0, SCHED_OTHER, &sp);
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(0, &set);
    CPU_SET(1, &set);
    CPU_SET(2, &set);
    sched_setaffinity(0, sizeof(set), &set);
}

static void *worker_main(void *arg) {
    chopper_t *inst = (chopper_t *)arg;
    unsigned seen_seq = 0;
    worker_demote();

    while (!atomic_load(&inst->worker_quit)) {
        /* Free whatever the audio thread has let go of. */
        sample_buf_t *old = atomic_exchange(&inst->retired, NULL);
        if (old) free_sample(old);

        unsigned seq = atomic_load_explicit(&inst->req_seq, memory_order_acquire);
        if (seq != seen_seq && atomic_load(&inst->incoming) == NULL) {
            char path[PATH_MAX_LEN];
            memcpy(path, inst->req_path, PATH_MAX_LEN);
            path[PATH_MAX_LEN - 1] = '\0';
            /* A newer request landed mid-copy: take it next time round. */
            if (atomic_load_explicit(&inst->req_seq, memory_order_acquire) == seq) {
                seen_seq = seq;
                atomic_store(&inst->load_state, LOAD_BUSY);
                char err[ERROR_MAX_LEN] = "";
                sample_buf_t *s = path[0] ? load_wav(path, err, sizeof(err)) : NULL;
                if (s) {
                    atomic_store(&inst->incoming, s);
                    atomic_store(&inst->load_state, LOAD_NONE);
                } else {
                    memcpy(inst->load_error, err, ERROR_MAX_LEN);
                    atomic_store(&inst->load_state, LOAD_FAILED);
                    if (g_host && g_host->log) {
                        char msg[PATH_MAX_LEN + ERROR_MAX_LEN + 16];
                        snprintf(msg, sizeof(msg), "chopper: %s: %s", err, path);
                        g_host->log(msg);
                    }
                }
                continue;
            }
        }

        struct timespec ts = { 0, WORKER_POLL_NS };
        nanosleep(&ts, NULL);
    }
    return NULL;
}

/* ============================================================================
 * Playback (audio thread)
 * ============================================================================ */

/* Take a newly loaded buffer if the worker has published one and the
 * previous retired buffer has been collected. */
static void adopt_incoming(chopper_t *inst) {
    if (atomic_load(&inst->incoming) == NULL || atomic_load(&inst->retired) != NULL) return;
    sample_buf_t *s = atomic_exchange(&inst->incoming, NULL);
    if (!s) return;
    sample_buf_t *old = inst->current;
    inst->current = s;
    inst->playing = 0;
    inst->playing_slice = -1;
    inst->slice_start[0] = 0;
    inst->slice_end[0] = s->frames;
    inst->slice_count = 1;
    inst->chop_count = 0;
    inst->undo_count = 0;
    inst->undo_depth = 0;
    if (old) atomic_store(&inst->retired, old);
}

/* Returns 0-15 for a slice pad note, -1 otherwise. */
static int note_to_pad(int note) {
    int off = note - PAD_NOTE_MIN;
    if (off < 0 || note > PAD_NOTE_MAX) return -1;
    int col = off % PAD_ROW_STRIDE;
    if (col >= PAD_COLS) return -1;
    int idx = (off / PAD_ROW_STRIDE) * PAD_COLS + col;
    return idx < MAX_SLICES ? idx : -1;
}

/* Start a slice from its beginning. Cuts off whatever was playing. */
static void play_slice(chopper_t *inst, int idx) {
    sample_buf_t *s = inst->current;
    if (!s || idx < 0 || idx >= inst->slice_count) return;
    inst->play_pos = inst->slice_start[idx];
    inst->play_end = inst->slice_end[idx];
    inst->play_step = (double)s->sample_rate / (double)MOVE_SAMPLE_RATE;
    inst->playing_slice = idx;
    inst->playing = 1;
}

/* Split the playing slice at the playhead. The new slice goes right after
 * it, later slices move up one pad, and playback continues into the new
 * slice. Bounded: at most MAX_SLICES moves. */
static void chop_at_playhead(chopper_t *inst) {
    int p = inst->playing_slice;
    if (!inst->playing || p < 0 || inst->slice_count >= MAX_SLICES) return;

    int t = (int)inst->play_pos;
    if (t - inst->slice_start[p] < MIN_SLICE_FRAMES ||
        inst->slice_end[p] - t < MIN_SLICE_FRAMES) return;

    /* Snapshot for undo. The stack can't overflow: each chop adds a slice
     * and each undo removes one, so depth <= slice_count - 1 < UNDO_DEPTH. */
    if (inst->undo_depth < UNDO_DEPTH) {
        slice_snapshot_t *u = &inst->undo_stack[inst->undo_depth++];
        memcpy(u->slice_start, inst->slice_start, sizeof(u->slice_start));
        memcpy(u->slice_end, inst->slice_end, sizeof(u->slice_end));
        u->slice_count = inst->slice_count;
    }

    for (int i = inst->slice_count; i > p + 1; i--) {
        inst->slice_start[i] = inst->slice_start[i - 1];
        inst->slice_end[i] = inst->slice_end[i - 1];
    }
    inst->slice_start[p + 1] = t;
    inst->slice_end[p + 1] = inst->slice_end[p];
    inst->slice_end[p] = t;
    inst->slice_count++;
    inst->chop_count++;

    /* Same position, same end: only the owner of the playhead changes. */
    inst->playing_slice = p + 1;
}

/* Restore the slice list from before the last chop. If something is
 * playing, it carries on in whichever restored slice holds the playhead. */
static void undo_last_chop(chopper_t *inst) {
    if (inst->undo_depth <= 0) return;
    slice_snapshot_t *u = &inst->undo_stack[--inst->undo_depth];
    memcpy(inst->slice_start, u->slice_start, sizeof(inst->slice_start));
    memcpy(inst->slice_end, u->slice_end, sizeof(inst->slice_end));
    inst->slice_count = u->slice_count;
    inst->undo_count++;

    if (!inst->playing) return;
    int pos = (int)inst->play_pos;
    for (int i = 0; i < inst->slice_count; i++) {
        if (pos >= inst->slice_start[i] && pos < inst->slice_end[i]) {
            inst->playing_slice = i;
            inst->play_end = inst->slice_end[i];
            return;
        }
    }
    inst->playing = 0;
    inst->playing_slice = -1;
}

/* ============================================================================
 * Plugin API
 * ============================================================================ */

static void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir;
    (void)json_defaults;
    chopper_t *inst = (chopper_t *)calloc(1, sizeof(chopper_t));
    if (!inst) return NULL;
    atomic_init(&inst->req_seq, 0);
    atomic_init(&inst->incoming, NULL);
    atomic_init(&inst->retired, NULL);
    atomic_init(&inst->load_state, LOAD_NONE);
    atomic_init(&inst->worker_quit, 0);
    inst->playing_slice = -1;
    if (pthread_create(&inst->worker, NULL, worker_main, inst) == 0) {
        inst->worker_started = 1;
    }
    return inst;
}

static void destroy_instance(void *instance) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst) return;
    if (inst->worker_started) {
        atomic_store(&inst->worker_quit, 1);
        pthread_join(inst->worker, NULL);
    }
    free_sample(inst->current);
    free_sample(atomic_load(&inst->incoming));
    free_sample(atomic_load(&inst->retired));
    free(inst);
}

static void on_midi(void *instance, const uint8_t *msg, int len, int source) {
    chopper_t *inst = (chopper_t *)instance;
    (void)source;
    if (!inst || len < 3) return;

    uint8_t type = msg[0] & 0xF0;
    uint8_t note = msg[1];
    uint8_t vel = msg[2];

    if (type != 0x90 || vel == 0 || !inst->current) return;

    int pad = note_to_pad(note);
    if (pad < 0) return;
    if (pad < inst->slice_count) {
        play_slice(inst, pad);
    } else if (pad == inst->slice_count) {
        chop_at_playhead(inst);
    }
}

static void set_param(void *instance, const char *key, const char *val) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst || !key || !val) return;

    if (strcmp(key, "undo") == 0) {
        undo_last_chop(inst);
        return;
    }
    if (strcmp(key, "file_path") == 0) {
        strncpy(inst->req_path, val, PATH_MAX_LEN - 1);
        inst->req_path[PATH_MAX_LEN - 1] = '\0';
        atomic_store(&inst->load_state, LOAD_BUSY);
        atomic_fetch_add_explicit(&inst->req_seq, 1, memory_order_release);
    }
}

static int get_param(void *instance, const char *key, char *buf, int buf_len) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst || !key || !buf || buf_len <= 0) return -1;

    if (strcmp(key, "file_path") == 0) {
        return snprintf(buf, (size_t)buf_len, "%s", inst->req_path);
    }
    if (strcmp(key, "status") == 0) {
        /* "<state> <frames> <rate> <playing> <pos>"
         * state: loading | ready | error | none */
        int ls = atomic_load(&inst->load_state);
        sample_buf_t *s = inst->current;
        const char *state = "none";
        if (ls == LOAD_BUSY || atomic_load(&inst->incoming)) state = "loading";
        else if (ls == LOAD_FAILED) state = "error";
        else if (s) state = "ready";
        return snprintf(buf, (size_t)buf_len, "%s %d %d %d %d", state,
                        s ? s->frames : 0, s ? s->sample_rate : 0,
                        inst->playing, (int)inst->play_pos);
    }
    if (strcmp(key, "slices") == 0) {
        /* "<chop_count> <undo_count> <undo_depth> <playing_slice> <count>
         *  <start0> <end0> ..." */
        int n = snprintf(buf, (size_t)buf_len, "%u %u %d %d %d",
                         inst->chop_count, inst->undo_count, inst->undo_depth,
                         inst->playing ? inst->playing_slice : -1, inst->slice_count);
        for (int i = 0; i < inst->slice_count && n > 0 && n < buf_len; i++) {
            n += snprintf(buf + n, (size_t)(buf_len - n), " %d %d",
                          inst->slice_start[i], inst->slice_end[i]);
        }
        return n;
    }
    if (strcmp(key, "error") == 0) {
        if (atomic_load(&inst->load_state) != LOAD_FAILED) return snprintf(buf, (size_t)buf_len, "%s", "");
        return snprintf(buf, (size_t)buf_len, "%s", inst->load_error);
    }
    return -1;
}

static int get_error(void *instance, char *buf, int buf_len) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst || atomic_load(&inst->load_state) != LOAD_FAILED) return 0;
    return snprintf(buf, (size_t)buf_len, "%s", inst->load_error);
}

static void render_block(void *instance, int16_t *out, int frames) {
    chopper_t *inst = (chopper_t *)instance;
    memset(out, 0, (size_t)frames * 2 * sizeof(int16_t));
    if (!inst) return;

    adopt_incoming(inst);

    sample_buf_t *s = inst->current;
    if (!s || !inst->playing) return;

    const int16_t *d = s->data;
    int last = s->frames - 1;
    for (int i = 0; i < frames; i++) {
        int idx = (int)inst->play_pos;
        if (idx >= inst->play_end) {
            inst->playing = 0;
            inst->playing_slice = -1;
            break;
        }
        float frac = (float)(inst->play_pos - idx);
        int nxt = idx < last ? idx + 1 : idx;
        float l = d[idx * 2] + (d[nxt * 2] - d[idx * 2]) * frac;
        float r = d[idx * 2 + 1] + (d[nxt * 2 + 1] - d[idx * 2 + 1]) * frac;
        out[i * 2] = clamp16(l);
        out[i * 2 + 1] = clamp16(r);
        inst->play_pos += inst->play_step;
    }
}

static plugin_api_v2_t s_plugin_api = {
    .api_version = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = create_instance,
    .destroy_instance = destroy_instance,
    .on_midi = on_midi,
    .set_param = set_param,
    .get_param = get_param,
    .get_error = get_error,
    .render_block = render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host_api) {
    g_host = host_api;
    return &s_plugin_api;
}
