/*
 * LiveChopper DSP Plugin
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
 * Fine-tuning: chop points are shared. Moving the start of slice N also
 * moves the end of slice N-1, so slices never gap or overlap. Only slice
 * 1's start and the last slice's end trim the sample.
 *
 * Slice export: set_param("export_slices", "<path prefix>") snapshots the
 * slice list and bumps a sequence number. The worker copies each slice's
 * frames straight from the source file (same format, bit depth and channel
 * count) into "<prefix> 01.wav", "<prefix> 02.wav", ... and publishes how
 * many it wrote; get_param("export_result") reports it.
 *
 * Resume: "Keep for later" hides the tool and leaves this instance running,
 * so the slices, undo history and settings are still here when the UI
 * reconnects. set_param("ui_state") keeps a short opaque string for the UI
 * (zoom, wave scale, unexported flag) and set_param("stop") fades out any
 * voice before the pads go back to Move.
 *
 * Waveform: the worker builds three levels of peak tables at load time, so
 * get_param("wave ...") reads a bounded number of values per column.
 *
 * Sound: one global attack/hold/decay envelope and one global transpose
 * (repitch: changes speed and pitch together) apply to every slice. A
 * chop does not retrigger the envelope, so playback stays seamless.
 * Gated mode (set_param("gate", "1")) is Move's A-S-R: full level while
 * the pad that started the voice is held, then Decay is the release, and
 * Hold does nothing. One-shot (the default) is A-H-D. When
 * a pad cuts off another, the old voice fades out over DECLICK_FRAMES.
 *
 * Delete: set_param("delete") removes a slice by merging it into the
 * previous one, i.e. it removes a chop point. Deleting Pad 1 instead trims
 * its audio off the start of the sample.
 *
 * Undo: each chop and delete first pushes a snapshot of the slice list onto
 * a fixed stack (no allocation); set_param("undo") pops it. When the stack
 * is full the oldest snapshot is dropped.
 *
 * Redo: undo pushes the slice list it replaces onto a redo stack, and
 * set_param("redo") pops it back (pushing onto the undo stack). Any new
 * chop, delete or marker nudge clears the redo stack.
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
#include <math.h>
#include <pwd.h>
#include <unistd.h>

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
#define UI_STATE_MAX_LEN 128

/* 10 minutes of stereo int16 at 44.1 kHz is ~106 MB. */
#define MAX_SOURCE_FRAMES (44100 * 60 * 10)
#define WORKER_POLL_NS (20 * 1000 * 1000)
#define READ_CHUNK_BYTES (64 * 1024)

/* Peak levels: max |sample| per block of 64, 1024 and 16384 frames. */
#define PEAK_LEVELS 3
static const int PEAK_BLOCK[PEAK_LEVELS] = { 64, 1024, 16384 };
#define WAVE_MAX_COLS 128

/* Envelope and pitch */
#define HOLD_FULL (-1)              /* hold until the slice ends */
#define DEFAULT_DECAY_US 50000
#define MAX_ENV_US 10000000         /* 10 s */
#define TRANSPOSE_MIN (-24)
#define TRANSPOSE_MAX 24
#define DECLICK_FRAMES 64           /* ~1.5 ms fade on a choked voice */

enum {
    LOAD_NONE = 0,
    LOAD_BUSY = 1,
    LOAD_FAILED = 2
};

typedef struct {
    int16_t *data;      /* interleaved stereo */
    int frames;
    int sample_rate;    /* rate of the source file */
    char path[PATH_MAX_LEN]; /* source file, for slice export */
    uint8_t *peaks[PEAK_LEVELS];  /* 0-255, max of |L| and |R| per block */
    int peak_len[PEAK_LEVELS];
} sample_buf_t;

/* Everything a chop changes, so undo can restore it whole. */
typedef struct {
    int slice_start[MAX_SLICES];
    int slice_end[MAX_SLICES];
    int slice_count;
} slice_snapshot_t;

#define UNDO_DEPTH 32

typedef struct {
    /* --- audio thread only --- */
    sample_buf_t *current;
    int playing;
    double play_pos;    /* in source frames */
    int play_end;
    int env_pos;        /* output frames since the voice was triggered */
    int gate_note;      /* pad note that started the voice; -1 once released */
    int release_pos;    /* gated: frames since release, -1 while held */
    float release_gain; /* gated: level when the release began */

    /* Choke tail: the voice that was cut off, fading out */
    int tail_active;
    double tail_pos;
    int tail_end;
    float tail_gain;
    int tail_left;

    /* Global sound settings */
    int attack_us, hold_us, decay_us;           /* as set; hold may be HOLD_FULL */
    int attack_frames, hold_frames, decay_frames;
    int transpose;                              /* semitones */
    int gated;                                  /* 1 = A-S-R, 0 = one-shot A-H-D */
    double pitch_ratio;                         /* 2^(transpose/12) */

    /* Slices, in time order. Pad i plays slice i. */
    int slice_start[MAX_SLICES];
    int slice_end[MAX_SLICES];
    int slice_count;
    int playing_slice;  /* -1 when silent */
    int selected_slice; /* slice being fine-tuned */
    uint32_t chop_count; /* bumped on every chop, for the UI */
    uint32_t undo_count; /* bumped on every undo, for the UI */
    uint32_t delete_count; /* bumped on every delete, for the UI */
    uint32_t redo_count; /* bumped on every redo, for the UI */

    char ui_state[UI_STATE_MAX_LEN]; /* opaque to the DSP; kept for a resumed UI */

    slice_snapshot_t undo_stack[UNDO_DEPTH];
    int undo_depth;
    slice_snapshot_t redo_stack[UNDO_DEPTH];
    int redo_depth;

    /* --- handoff between audio thread and worker --- */
    char req_path[PATH_MAX_LEN];
    atomic_uint req_seq;
    _Atomic(sample_buf_t *) incoming;
    _Atomic(sample_buf_t *) retired;
    atomic_int load_state;
    char load_error[ERROR_MAX_LEN];

    /* --- slice export: audio thread requests, worker writes --- */
    char export_src[PATH_MAX_LEN];
    char export_prefix[PATH_MAX_LEN];
    int export_start[MAX_SLICES];
    int export_end[MAX_SLICES];
    int export_count;
    atomic_uint export_req_seq;
    atomic_uint export_done_seq;
    atomic_int export_written;  /* slices written by the last finished export */

    /* --- worker --- */
    pthread_t worker;
    int worker_started;
    atomic_int worker_quit;
} live_chopper_t;

static const host_api_v1_t *g_host = NULL;

/* ============================================================================
 * WAV loading (worker thread only)
 * ============================================================================ */

static uint16_t rd_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Round to nearest and clip. */
static int16_t clamp16(float v) {
    if (v > 32767.0f) return 32767;
    if (v < -32768.0f) return -32768;
    return (int16_t)lrintf(v);
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
    for (int l = 0; l < PEAK_LEVELS; l++) free(s->peaks[l]);
    free(s->data);
    free(s);
}

static uint8_t frame_peak(const int16_t *d, int i) {
    int l = d[i * 2] < 0 ? -d[i * 2] : d[i * 2];
    int r = d[i * 2 + 1] < 0 ? -d[i * 2 + 1] : d[i * 2 + 1];
    int m = l > r ? l : r;
    return (uint8_t)(m >> 7);
}

/* Worker only. Returns 0 on allocation failure. */
static int build_peaks(sample_buf_t *s) {
    for (int l = 0; l < PEAK_LEVELS; l++) {
        int bs = PEAK_BLOCK[l];
        int n = (s->frames + bs - 1) / bs;
        uint8_t *pk = (uint8_t *)malloc((size_t)n);
        if (!pk) return 0;
        for (int b = 0; b < n; b++) {
            uint8_t m = 0;
            if (l == 0) {
                int end = (b + 1) * bs < s->frames ? (b + 1) * bs : s->frames;
                for (int i = b * bs; i < end; i++) {
                    uint8_t v = frame_peak(s->data, i);
                    if (v > m) m = v;
                }
            } else {
                /* Each level is built from the one below (16 blocks each). */
                int ratio = bs / PEAK_BLOCK[l - 1];
                int end = (b + 1) * ratio < s->peak_len[l - 1] ? (b + 1) * ratio : s->peak_len[l - 1];
                for (int i = b * ratio; i < end; i++) {
                    if (s->peaks[l - 1][i] > m) m = s->peaks[l - 1][i];
                }
            }
            pk[b] = m;
        }
        s->peaks[l] = pk;
        s->peak_len[l] = n;
    }
    return 1;
}

/* The shim runs as root but Move's own UI runs as ableton, so hand new
 * files over to it or Move can't manage them. Worker only. */
static void chown_to_ableton(const char *path) {
    struct passwd *pw = getpwnam("ableton");
    if (pw && chown(path, pw->pw_uid, pw->pw_gid) != 0) { /* best effort */ }
}

static void wr_u16(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void wr_u32(uint8_t *p, uint32_t v) { wr_u16(p, v & 0xFFFF); wr_u16(p + 2, v >> 16); }

#define FMT_MAX_BYTES 64

/* Write each slice of src as its own WAV, copying the source frames as they
 * are. Returns the number of files written. Worker only. */
static int write_slices(const char *src, const char *prefix,
                        const int *starts, const int *ends, int count) {
    FILE *f = fopen(src, "rb");
    if (!f) return 0;

    uint8_t fmt[FMT_MAX_BYTES];
    uint32_t fmt_len = 0, data_bytes = 0;
    long data_off = -1;
    uint8_t hdr[12];
    if (fread(hdr, 1, 12, f) == 12 && memcmp(hdr, "RIFF", 4) == 0 && memcmp(hdr + 8, "WAVE", 4) == 0) {
        for (;;) {
            uint8_t ch[8];
            if (fread(ch, 1, 8, f) != 8) break;
            uint32_t len = rd_u32(ch + 4);
            if (memcmp(ch, "fmt ", 4) == 0) {
                if (len < 16 || len > FMT_MAX_BYTES || fread(fmt, 1, len, f) != len) break;
                fmt_len = len;
                if ((len & 1) && fseek(f, 1, SEEK_CUR) != 0) break;
            } else if (memcmp(ch, "data", 4) == 0) {
                data_bytes = len;
                data_off = ftell(f);
                break;
            } else if (fseek(f, (long)(len + (len & 1)), SEEK_CUR) != 0) {
                break;
            }
        }
    }
    int block_align = fmt_len ? rd_u16(fmt + 12) : 0;
    uint8_t *buf = (uint8_t *)malloc(READ_CHUNK_BYTES);
    if (!fmt_len || data_off < 0 || block_align <= 0 || !buf) {
        free(buf);
        fclose(f);
        return 0;
    }
    long total_frames = (long)(data_bytes / (uint32_t)block_align);

    int written = 0;
    for (int i = 0; i < count; i++) {
        long a = starts[i], b = ends[i];
        if (b > total_frames) b = total_frames;
        if (a < 0 || b <= a) continue;
        uint32_t bytes = (uint32_t)((b - a) * block_align);
        uint32_t pad = bytes & 1;

        char path[PATH_MAX_LEN + 16];
        snprintf(path, sizeof(path), "%s %02d.wav", prefix, i + 1);
        FILE *o = fopen(path, "wb");
        if (!o) continue;

        uint8_t h[12 + 8 + FMT_MAX_BYTES + 8];
        int n = 0;
        memcpy(h, "RIFF", 4);
        wr_u32(h + 4, 4 + (8 + fmt_len + (fmt_len & 1)) + (8 + bytes + pad));
        memcpy(h + 8, "WAVE", 4);
        memcpy(h + 12, "fmt ", 4);
        wr_u32(h + 16, fmt_len);
        memcpy(h + 20, fmt, fmt_len);
        n = 20 + (int)fmt_len;
        if (fmt_len & 1) h[n++] = 0;
        memcpy(h + n, "data", 4);
        wr_u32(h + n + 4, bytes);
        n += 8;

        int ok = fwrite(h, 1, (size_t)n, o) == (size_t)n &&
                 fseek(f, data_off + a * block_align, SEEK_SET) == 0;
        uint32_t left = bytes;
        while (ok && left > 0) {
            size_t want = left < READ_CHUNK_BYTES ? left : READ_CHUNK_BYTES;
            ok = fread(buf, 1, want, f) == want && fwrite(buf, 1, want, o) == want;
            left -= (uint32_t)want;
        }
        if (ok && pad) ok = fputc(0, o) != EOF;
        if (fclose(o) != 0) ok = 0;
        if (ok) {
            chown_to_ableton(path);
            written++;
        } else {
            remove(path);
        }
    }
    free(buf);
    fclose(f);
    return written;
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
    live_chopper_t *inst = (live_chopper_t *)arg;
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
                if (s) memcpy(s->path, path, PATH_MAX_LEN);
                if (s && !build_peaks(s)) {
                    free_sample(s);
                    s = NULL;
                    snprintf(err, sizeof(err), "Out of memory");
                }
                if (s) {
                    atomic_store(&inst->incoming, s);
                    atomic_store(&inst->load_state, LOAD_NONE);
                } else {
                    memcpy(inst->load_error, err, ERROR_MAX_LEN);
                    atomic_store(&inst->load_state, LOAD_FAILED);
                    if (g_host && g_host->log) {
                        char msg[PATH_MAX_LEN + ERROR_MAX_LEN + 16];
                        snprintf(msg, sizeof(msg), "live-chopper: %s: %s", err, path);
                        g_host->log(msg);
                    }
                }
                continue;
            }
        }

        unsigned eseq = atomic_load_explicit(&inst->export_req_seq, memory_order_acquire);
        if (eseq != atomic_load(&inst->export_done_seq)) {
            char src[PATH_MAX_LEN], prefix[PATH_MAX_LEN];
            int starts[MAX_SLICES], ends[MAX_SLICES];
            memcpy(src, inst->export_src, PATH_MAX_LEN);
            memcpy(prefix, inst->export_prefix, PATH_MAX_LEN);
            memcpy(starts, inst->export_start, sizeof(starts));
            memcpy(ends, inst->export_end, sizeof(ends));
            int count = inst->export_count;
            /* A newer request landed mid-copy: take it next time round. */
            if (atomic_load_explicit(&inst->export_req_seq, memory_order_acquire) == eseq) {
                src[PATH_MAX_LEN - 1] = '\0';
                prefix[PATH_MAX_LEN - 1] = '\0';
                if (count < 0 || count > MAX_SLICES) count = 0;
                int written = write_slices(src, prefix, starts, ends, count);
                atomic_store(&inst->export_written, written);
                atomic_store_explicit(&inst->export_done_seq, eseq, memory_order_release);
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
static void adopt_incoming(live_chopper_t *inst) {
    if (atomic_load(&inst->incoming) == NULL || atomic_load(&inst->retired) != NULL) return;
    sample_buf_t *s = atomic_exchange(&inst->incoming, NULL);
    if (!s) return;
    sample_buf_t *old = inst->current;
    inst->current = s;
    inst->playing = 0;
    inst->tail_active = 0;
    inst->playing_slice = -1;
    inst->selected_slice = 0;
    inst->slice_start[0] = 0;
    inst->slice_end[0] = s->frames;
    inst->slice_count = 1;
    inst->chop_count = 0;
    inst->undo_count = 0;
    inst->undo_depth = 0;
    inst->delete_count = 0;
    inst->redo_count = 0;
    inst->redo_depth = 0;
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
/* Envelope gain for the main voice at its current position. */
static float env_gain(const live_chopper_t *inst) {
    int p = inst->env_pos;
    if (inst->gated) {
        if (inst->release_pos >= 0) {
            if (inst->release_pos >= inst->decay_frames) return 0.0f;
            return inst->release_gain * (1.0f - (float)inst->release_pos / (float)inst->decay_frames);
        }
        if (p < inst->attack_frames) return (float)p / (float)inst->attack_frames;
        return 1.0f;
    }
    if (p < inst->attack_frames) return (float)p / (float)inst->attack_frames;
    p -= inst->attack_frames;
    if (inst->hold_frames == HOLD_FULL || p < inst->hold_frames) return 1.0f;
    p -= inst->hold_frames;
    if (p >= inst->decay_frames) return 0.0f;
    return 1.0f - (float)p / (float)inst->decay_frames;
}

static int env_finished(const live_chopper_t *inst) {
    if (inst->gated) return inst->release_pos >= 0 && inst->release_pos >= inst->decay_frames;
    if (inst->hold_frames == HOLD_FULL) return 0;
    return inst->env_pos >= inst->attack_frames + inst->hold_frames + inst->decay_frames;
}

/* Gated: start the release from wherever the envelope is now. */
static void release_voice(live_chopper_t *inst) {
    if (!inst->playing || inst->release_pos >= 0) return;
    inst->release_gain = env_gain(inst);
    inst->release_pos = 0;
}

static int us_to_frames(int us) {
    return (int)((int64_t)us * MOVE_SAMPLE_RATE / 1000000);
}

static int clamp_us(int us) {
    if (us < 0) return 0;
    if (us > MAX_ENV_US) return MAX_ENV_US;
    return us;
}

static void set_transpose(live_chopper_t *inst, int semis) {
    if (semis < TRANSPOSE_MIN) semis = TRANSPOSE_MIN;
    if (semis > TRANSPOSE_MAX) semis = TRANSPOSE_MAX;
    inst->transpose = semis;
    inst->pitch_ratio = pow(2.0, semis / 12.0);
}

/* Linear-interpolated stereo frame at a fractional source position. */
static void read_frame(const sample_buf_t *s, double pos, float *l, float *r) {
    int idx = (int)pos;
    float frac = (float)(pos - idx);
    int nxt = idx < s->frames - 1 ? idx + 1 : idx;
    const int16_t *d = s->data;
    *l = d[idx * 2] + (d[nxt * 2] - d[idx * 2]) * frac;
    *r = d[idx * 2 + 1] + (d[nxt * 2 + 1] - d[idx * 2 + 1]) * frac;
}

/* Hand the playing voice to the tail so it fades instead of clicking. */
static void fade_out_voice(live_chopper_t *inst) {
    inst->tail_active = 1;
    inst->tail_pos = inst->play_pos;
    inst->tail_end = inst->play_end;
    inst->tail_gain = env_gain(inst);
    inst->tail_left = DECLICK_FRAMES;
}

static void play_slice(live_chopper_t *inst, int idx, int note) {
    sample_buf_t *s = inst->current;
    if (!s || idx < 0 || idx >= inst->slice_count) return;
    if (inst->playing) fade_out_voice(inst);
    inst->play_pos = inst->slice_start[idx];
    inst->play_end = inst->slice_end[idx];
    inst->env_pos = 0;
    inst->gate_note = note;
    inst->release_pos = -1;
    inst->playing_slice = idx;
    inst->selected_slice = idx;
    inst->playing = 1;
}

/* Save the slice list onto a stack, dropping the oldest entry when full.
 * Bounded: at worst one shift of the stack. */
static void push_snapshot(live_chopper_t *inst, slice_snapshot_t *stack, int *depth) {
    if (*depth == UNDO_DEPTH) {
        memmove(&stack[0], &stack[1], sizeof(slice_snapshot_t) * (UNDO_DEPTH - 1));
        (*depth)--;
    }
    slice_snapshot_t *u = &stack[(*depth)++];
    memcpy(u->slice_start, inst->slice_start, sizeof(u->slice_start));
    memcpy(u->slice_end, inst->slice_end, sizeof(u->slice_end));
    u->slice_count = inst->slice_count;
}

/* Replace the slice list with a saved one. */
static void restore_snapshot(live_chopper_t *inst, const slice_snapshot_t *u) {
    memcpy(inst->slice_start, u->slice_start, sizeof(inst->slice_start));
    memcpy(inst->slice_end, u->slice_end, sizeof(inst->slice_end));
    inst->slice_count = u->slice_count;
    if (inst->selected_slice >= inst->slice_count) inst->selected_slice = inst->slice_count - 1;
}

/* Save the slice list before a new edit. A new edit ends the redo chain. */
static void push_undo(live_chopper_t *inst) {
    push_snapshot(inst, inst->undo_stack, &inst->undo_depth);
    inst->redo_depth = 0;
}

/* After the slice list changes under a playing voice, keep playing in
 * whichever slice now holds the playhead. */
static void relocate_playhead(live_chopper_t *inst) {
    if (!inst->playing) return;
    int pos = (int)inst->play_pos;
    for (int i = 0; i < inst->slice_count; i++) {
        if (pos >= inst->slice_start[i] && pos < inst->slice_end[i]) {
            inst->playing_slice = i;
            inst->play_end = inst->slice_end[i];
            return;
        }
    }
    /* The playhead's audio was removed (Pad 1 deleted): fade it out. */
    fade_out_voice(inst);
    inst->playing = 0;
    inst->playing_slice = -1;
}

/* Split the playing slice at the playhead. The new slice goes right after
 * it, later slices move up one pad, and playback continues into the new
 * slice. Bounded: at most MAX_SLICES moves. */
static void chop_at_playhead(live_chopper_t *inst) {
    int p = inst->playing_slice;
    if (!inst->playing || p < 0 || inst->slice_count >= MAX_SLICES) return;

    int t = (int)inst->play_pos;
    if (t - inst->slice_start[p] < MIN_SLICE_FRAMES ||
        inst->slice_end[p] - t < MIN_SLICE_FRAMES) return;

    push_undo(inst);

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
    inst->selected_slice = p + 1;
}

/* Move a slice's start (side 0) or end (side 1) by delta source frames.
 * Interior chop points are shared with the neighbor, so they are clamped
 * to keep both slices at least MIN_SLICE_FRAMES long. */
static void nudge_marker(live_chopper_t *inst, int idx, int side, int delta) {
    sample_buf_t *s = inst->current;
    if (!s || idx < 0 || idx >= inst->slice_count || delta == 0) return;
    int last = inst->slice_count - 1;
    inst->redo_depth = 0; /* a new edit ends the redo chain */

    if (side == 0 && idx == 0) {
        int pos = inst->slice_start[0] + delta;
        int hi = inst->slice_end[0] - MIN_SLICE_FRAMES;
        if (pos > hi) pos = hi;
        if (pos < 0) pos = 0;
        inst->slice_start[0] = pos;
    } else if (side == 1 && idx == last) {
        int pos = inst->slice_end[last] + delta;
        int lo = inst->slice_start[last] + MIN_SLICE_FRAMES;
        if (pos < lo) pos = lo;
        if (pos > s->frames) pos = s->frames;
        inst->slice_end[last] = pos;
    } else {
        /* Chop point k sits between slice k-1 and slice k. */
        int k = side == 0 ? idx : idx + 1;
        int pos = inst->slice_start[k] + delta;
        int lo = inst->slice_start[k - 1] + MIN_SLICE_FRAMES;
        int hi = inst->slice_end[k] - MIN_SLICE_FRAMES;
        if (pos < lo) pos = lo;
        if (pos > hi) pos = hi;
        inst->slice_start[k] = pos;
        inst->slice_end[k - 1] = pos;
    }

    if (inst->playing && inst->playing_slice >= 0) {
        inst->play_end = inst->slice_end[inst->playing_slice];
    }
}

/* Parse a decimal int at *p and advance past it. RT-safe: no locale. */
static int parse_int(const char **p) {
    const char *c = *p;
    int sign = 1, v = 0;
    while (*c == ' ') c++;
    if (*c == '-') { sign = -1; c++; }
    while (*c >= '0' && *c <= '9') { v = v * 10 + (*c - '0'); c++; }
    *p = c;
    return sign * v;
}

/* Fill buf with cols two-hex-digit peaks covering source frames [a, b).
 * Bounded: each column reads at most ~32 peak entries or 128 frames. */
static int render_wave(live_chopper_t *inst, int a, int b, int cols, char *buf, int buf_len) {
    sample_buf_t *s = inst->current;
    static const char hex[] = "0123456789abcdef";
    if (!s || cols <= 0 || cols > WAVE_MAX_COLS || buf_len < cols * 2 + 1) return -1;
    if (a < 0) a = 0;
    if (b > s->frames) b = s->frames;
    if (b <= a) b = a + 1;

    double span = (double)(b - a) / cols;
    for (int c = 0; c < cols; c++) {
        int f0 = a + (int)(span * c);
        int f1 = a + (int)(span * (c + 1));
        if (f1 <= f0) f1 = f0 + 1;
        if (f0 >= s->frames) f0 = s->frames - 1;
        if (f1 > s->frames) f1 = s->frames;
        int n = f1 - f0;
        uint8_t m = 0;

        int level = -1;
        for (int l = PEAK_LEVELS - 1; l >= 0; l--) {
            if (PEAK_BLOCK[l] * 2 <= n) { level = l; break; }
        }
        if (level < 0) {
            for (int i = f0; i < f1; i++) {
                uint8_t v = frame_peak(s->data, i);
                if (v > m) m = v;
            }
        } else {
            int bs = PEAK_BLOCK[level];
            int b0 = f0 / bs, b1 = (f1 + bs - 1) / bs;
            if (b1 > s->peak_len[level]) b1 = s->peak_len[level];
            for (int i = b0; i < b1; i++) {
                if (s->peaks[level][i] > m) m = s->peaks[level][i];
            }
        }
        buf[c * 2] = hex[m >> 4];
        buf[c * 2 + 1] = hex[m & 15];
    }
    buf[cols * 2] = '\0';
    return cols * 2;
}

/* Restore the slice list from before the last chop. If something is
 * playing, it carries on in whichever restored slice holds the playhead. */
static void undo_last_chop(live_chopper_t *inst) {
    if (inst->undo_depth <= 0) return;
    push_snapshot(inst, inst->redo_stack, &inst->redo_depth);
    restore_snapshot(inst, &inst->undo_stack[--inst->undo_depth]);
    inst->undo_count++;
    relocate_playhead(inst);
}

/* Put back the slice list the last undo replaced. */
static void redo_last_undo(live_chopper_t *inst) {
    if (inst->redo_depth <= 0) return;
    push_snapshot(inst, inst->undo_stack, &inst->undo_depth);
    restore_snapshot(inst, &inst->redo_stack[--inst->redo_depth]);
    inst->redo_count++;
    relocate_playhead(inst);
}

/* Merge slice idx into the previous one, removing the chop point between
 * them. Pad 1 has no previous slice, so deleting it trims its audio off
 * the start and Pad 2 becomes Pad 1. Later slices move down one pad. */
static void delete_slice(live_chopper_t *inst, int idx) {
    if (!inst->current || inst->slice_count < 2 || idx < 0 || idx >= inst->slice_count) return;
    push_undo(inst);

    if (idx > 0) inst->slice_end[idx - 1] = inst->slice_end[idx];
    for (int i = idx; i < inst->slice_count - 1; i++) {
        inst->slice_start[i] = inst->slice_start[i + 1];
        inst->slice_end[i] = inst->slice_end[i + 1];
    }
    inst->slice_count--;
    inst->delete_count++;
    inst->selected_slice = idx == 0 ? 0 : idx - 1;
    relocate_playhead(inst);
}

/* ============================================================================
 * Plugin API
 * ============================================================================ */

static void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir;
    (void)json_defaults;
    live_chopper_t *inst = (live_chopper_t *)calloc(1, sizeof(live_chopper_t));
    if (!inst) return NULL;
    atomic_init(&inst->req_seq, 0);
    atomic_init(&inst->incoming, NULL);
    atomic_init(&inst->retired, NULL);
    atomic_init(&inst->load_state, LOAD_NONE);
    atomic_init(&inst->worker_quit, 0);
    atomic_init(&inst->export_req_seq, 0);
    atomic_init(&inst->export_done_seq, 0);
    atomic_init(&inst->export_written, 0);
    inst->playing_slice = -1;
    inst->gate_note = -1;
    inst->release_pos = -1;
    inst->attack_us = 0;
    inst->hold_us = HOLD_FULL;
    inst->hold_frames = HOLD_FULL;
    inst->decay_us = DEFAULT_DECAY_US;
    inst->decay_frames = us_to_frames(DEFAULT_DECAY_US);
    set_transpose(inst, 0);
    if (pthread_create(&inst->worker, NULL, worker_main, inst) == 0) {
        inst->worker_started = 1;
    }
    return inst;
}

static void destroy_instance(void *instance) {
    live_chopper_t *inst = (live_chopper_t *)instance;
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
    live_chopper_t *inst = (live_chopper_t *)instance;
    (void)source;
    if (!inst || len < 3) return;

    uint8_t type = msg[0] & 0xF0;
    uint8_t note = msg[1];
    uint8_t vel = msg[2];

    if (!inst->current) return;
    if (type == 0x80 || (type == 0x90 && vel == 0)) {
        /* Letting go of the pad that started the voice ends the gate. A
         * chop keeps the voice, so the original pad still holds it. */
        if (note == inst->gate_note) {
            inst->gate_note = -1;
            if (inst->gated) release_voice(inst);
        }
        return;
    }
    if (type != 0x90) return;

    int pad = note_to_pad(note);
    if (pad < 0) return;
    if (pad < inst->slice_count) {
        play_slice(inst, pad, note);
    } else if (pad == inst->slice_count) {
        chop_at_playhead(inst);
    }
}

static void set_param(void *instance, const char *key, const char *val) {
    live_chopper_t *inst = (live_chopper_t *)instance;
    if (!inst || !key || !val) return;

    if (strcmp(key, "delete") == 0) {
        const char *p = val;
        delete_slice(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "undo") == 0) {
        undo_last_chop(inst);
        return;
    }
    if (strcmp(key, "redo") == 0) {
        redo_last_undo(inst);
        return;
    }
    if (strcmp(key, "nudge") == 0) {
        /* "<slice> <side> <delta>" */
        const char *p = val;
        int idx = parse_int(&p);
        int side = parse_int(&p);
        int delta = parse_int(&p);
        nudge_marker(inst, idx, side, delta);
        return;
    }
    if (strcmp(key, "attack_us") == 0) {
        const char *p = val;
        inst->attack_us = clamp_us(parse_int(&p));
        inst->attack_frames = us_to_frames(inst->attack_us);
        return;
    }
    if (strcmp(key, "hold_us") == 0) {
        const char *p = val;
        int us = parse_int(&p);
        if (us < 0) {
            inst->hold_us = HOLD_FULL;
            inst->hold_frames = HOLD_FULL;
        } else {
            inst->hold_us = clamp_us(us);
            inst->hold_frames = us_to_frames(inst->hold_us);
        }
        return;
    }
    if (strcmp(key, "decay_us") == 0) {
        const char *p = val;
        inst->decay_us = clamp_us(parse_int(&p));
        inst->decay_frames = us_to_frames(inst->decay_us);
        return;
    }
    if (strcmp(key, "ui_state") == 0) {
        strncpy(inst->ui_state, val, UI_STATE_MAX_LEN - 1);
        inst->ui_state[UI_STATE_MAX_LEN - 1] = '\0';
        return;
    }
    if (strcmp(key, "stop") == 0) {
        if (inst->playing) fade_out_voice(inst);
        inst->playing = 0;
        inst->playing_slice = -1;
        inst->gate_note = -1;
        return;
    }
    if (strcmp(key, "gate") == 0) {
        inst->gated = val[0] == '1';
        /* Switched to gated after the pad was let go: release now. */
        if (inst->gated && inst->gate_note < 0) release_voice(inst);
        return;
    }
    if (strcmp(key, "transpose") == 0) {
        const char *p = val;
        set_transpose(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "select") == 0) {
        const char *p = val;
        int idx = parse_int(&p);
        if (idx >= 0 && idx < inst->slice_count) inst->selected_slice = idx;
        return;
    }
    if (strcmp(key, "export_slices") == 0) {
        /* "<path prefix>": the worker writes "<prefix> 01.wav", ... */
        if (!inst->current) return;
        memcpy(inst->export_src, inst->current->path, PATH_MAX_LEN);
        strncpy(inst->export_prefix, val, PATH_MAX_LEN - 1);
        inst->export_prefix[PATH_MAX_LEN - 1] = '\0';
        memcpy(inst->export_start, inst->slice_start, sizeof(inst->export_start));
        memcpy(inst->export_end, inst->slice_end, sizeof(inst->export_end));
        inst->export_count = inst->slice_count;
        atomic_fetch_add_explicit(&inst->export_req_seq, 1, memory_order_release);
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
    live_chopper_t *inst = (live_chopper_t *)instance;
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
        /* "<chop_count> <undo_count> <delete_count> <undo_depth> <redo_count>
         *  <redo_depth> <playing_slice> <selected_slice> <count> <start0> <end0> ..." */
        int n = snprintf(buf, (size_t)buf_len, "%u %u %u %d %u %d %d %d %d",
                         inst->chop_count, inst->undo_count, inst->delete_count, inst->undo_depth,
                         inst->redo_count, inst->redo_depth,
                         inst->playing ? inst->playing_slice : -1,
                         inst->selected_slice, inst->slice_count);
        for (int i = 0; i < inst->slice_count && n > 0 && n < buf_len; i++) {
            n += snprintf(buf + n, (size_t)(buf_len - n), " %d %d",
                          inst->slice_start[i], inst->slice_end[i]);
        }
        return n;
    }
    if (strcmp(key, "settings") == 0) {
        /* "<attack_us> <hold_us, -1 = full> <decay_us> <transpose> <gated>" */
        return snprintf(buf, (size_t)buf_len, "%d %d %d %d %d",
                        inst->attack_us, inst->hold_us, inst->decay_us, inst->transpose, inst->gated);
    }
    if (strncmp(key, "wave ", 5) == 0) {
        /* "wave <start> <end> <cols>" -> cols * 2 hex digits */
        const char *p = key + 5;
        int a = parse_int(&p);
        int b = parse_int(&p);
        int cols = parse_int(&p);
        return render_wave(inst, a, b, cols, buf, buf_len);
    }
    if (strcmp(key, "ui_state") == 0) {
        return snprintf(buf, (size_t)buf_len, "%s", inst->ui_state);
    }
    if (strcmp(key, "export_result") == 0) {
        /* "<requested seq> <finished seq> <slices written by the last finished>" */
        return snprintf(buf, (size_t)buf_len, "%u %u %d",
                        atomic_load(&inst->export_req_seq), atomic_load(&inst->export_done_seq),
                        atomic_load(&inst->export_written));
    }
    if (strcmp(key, "error") == 0) {
        if (atomic_load(&inst->load_state) != LOAD_FAILED) return snprintf(buf, (size_t)buf_len, "%s", "");
        return snprintf(buf, (size_t)buf_len, "%s", inst->load_error);
    }
    return -1;
}

static int get_error(void *instance, char *buf, int buf_len) {
    live_chopper_t *inst = (live_chopper_t *)instance;
    if (!inst || atomic_load(&inst->load_state) != LOAD_FAILED) return 0;
    return snprintf(buf, (size_t)buf_len, "%s", inst->load_error);
}

static void render_block(void *instance, int16_t *out, int frames) {
    live_chopper_t *inst = (live_chopper_t *)instance;
    memset(out, 0, (size_t)frames * 2 * sizeof(int16_t));
    if (!inst) return;

    adopt_incoming(inst);

    sample_buf_t *s = inst->current;
    if (!s || (!inst->playing && !inst->tail_active)) return;

    double step = (double)s->sample_rate / (double)MOVE_SAMPLE_RATE * inst->pitch_ratio;
    for (int i = 0; i < frames; i++) {
        float l = 0.0f, r = 0.0f, vl, vr;

        if (inst->playing) {
            if ((int)inst->play_pos >= inst->play_end || env_finished(inst)) {
                inst->playing = 0;
                inst->playing_slice = -1;
            } else {
                float g = env_gain(inst);
                read_frame(s, inst->play_pos, &vl, &vr);
                l += vl * g;
                r += vr * g;
                inst->play_pos += step;
                inst->env_pos++;
                if (inst->release_pos >= 0) inst->release_pos++;
            }
        }

        if (inst->tail_active) {
            if ((int)inst->tail_pos >= inst->tail_end || inst->tail_left <= 0) {
                inst->tail_active = 0;
            } else {
                float g = inst->tail_gain * (float)inst->tail_left / (float)DECLICK_FRAMES;
                read_frame(s, inst->tail_pos, &vl, &vr);
                l += vl * g;
                r += vr * g;
                inst->tail_pos += step;
                inst->tail_left--;
            }
        }

        out[i * 2] = clamp16(l);
        out[i * 2 + 1] = clamp16(r);
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
