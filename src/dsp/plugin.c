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
 * slice list and the gain and bumps a sequence number. The worker copies
 * each slice's frames from the source file (same format, bit depth and
 * channel count; scaled by the gain unless it is 0 dB) into
 * "<prefix> 01.wav", "<prefix> 02.wav", ... and publishes how many it
 * wrote; get_param("export_result") reports it.
 *
 * Resume: "Keep for later" hides the tool and leaves this instance running,
 * so the slices, undo history and settings are still here when the UI
 * reconnects. set_param("ui_state") keeps a short opaque string for the UI
 * (zoom, unexported flag) and set_param("stop") fades out any
 * voice before the pads go back to Move.
 *
 * Waveform: the worker builds three levels of peak tables at load time, so
 * get_param("wave ...") reads a bounded number of values per column.
 *
 * Sound: one global attack/hold/decay envelope and one global transpose
 * plus detune (repitch: changes speed and pitch together) apply to every
 * slice. A
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
 *
 * Gain: one global gain, set_param("gain_db10") in tenths of a dB (-70 to
 * +24 dB, Move's drum sampler range), ramped over a block so changes don't
 * click. The loader also finds the file's peak at full precision, and
 * get_param("normalize_gain") is the gain that puts it at 0 dBFS, so
 * Normalize is just a gain setting. Slice export applies the gain.
 *
 * Channels: set_param("convert_channels", "mono" | "left" | "right") asks
 * the worker to rewrite the playing file as a 1-channel WAV (the mean of
 * the channels, or just the first or second) in its own format and bit
 * depth, keeping its other chunks. It writes "<file>.convert-tmp" next to
 * it with the original's owner and permissions, loads that, and only then
 * renames it over the original, so a failure leaves the sample and the
 * playing audio as they were. The buffer is published with conv_seq set:
 * the frame count is the same, so the audio thread swaps it in without
 * touching slices, undo or the voice (and status never says "loading"),
 * and only then marks the request done. A conversion of a file that was
 * replaced meanwhile is dropped. get_param("convert_result") reports it.
 *
 * Crush: set_param("crush_hz"), 0 = off or 1000-30000 Hz, the range of the
 * drum sampler's 8-Bit effect, which the exported preset sets. Playback
 * gets a stand-in for it: each voice is sampled and held at that rate (in
 * output frames, after repitching) and cut to 8 bits, before the envelope.
 * Slice export leaves it out, like the envelope and transpose.
 *
 * Filter: the drum sampler's filter, which the exported preset sets.
 * set_param("filter_type") 0-3 = Low-Pass 12, Low-Pass 24 (the default),
 * High-Pass 24, Peak; "filter_hz10" the cutoff in tenths of a Hz (30 Hz to
 * 22 kHz), "filter_res" the resonance in thousandths (0-900, Move's 0-0.9)
 * and "filter_peak_db10" the Peak type's gain in tenths of a dB (+-12 dB).
 * Playback runs each voice through a stand-in after the crush: a TPT
 * state-variable filter (Simper's SVF), two stages for the 24 dB types, and
 * a bell of fixed width for Peak, which ignores the resonance. The cutoff
 * glides (~10 ms, in octaves) and the coefficients are recomputed every
 * FILTER_COEF_FRAMES. A low-pass type fully open (22 kHz, Move's default)
 * skips the filter, so playback is bit-identical to no filter at all.
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
#include <limits.h>
#include <sys/stat.h>

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
#define TRANSPOSE_MIN (-48)        /* semitones, as on Move's drum sampler */
#define TRANSPOSE_MAX 48
#define DETUNE_MIN (-50)            /* cents */
#define DETUNE_MAX 50
#define GAIN_DB10_MIN (-700)        /* -70 dB, as on Move's drum sampler */
#define GAIN_DB10_MAX 240           /* +24 dB */
#define NORM_GAIN_SILENT (-32768)   /* normalize_gain of an all-zero file */
#define DECLICK_FRAMES 64           /* ~1.5 ms fade on a choked voice */
#define CRUSH_HZ_MIN 1000           /* the drum sampler's 8-Bit Resampling Rate range */
#define CRUSH_HZ_MAX 30000

/* Filter, in the drum sampler's ranges */
enum { FILTER_LP12 = 0, FILTER_LP24 = 1, FILTER_HP24 = 2, FILTER_PEAK = 3 };
#define FILTER_HZ10_MIN 300         /* 30 Hz */
#define FILTER_HZ10_MAX 220000      /* 22 kHz: fully open */
#define FILTER_RES_MAX 900          /* thousandths: Move's 0.9 */
#define FILTER_PEAK_DB10_MAX 120    /* +-12 dB */
#define FILTER_COEF_FRAMES 16       /* coefficients recomputed this often */
#define FILTER_GLIDE 0.0356f        /* per update: ~10 ms one-pole glide */
#define FILTER_NYQUIST_FRAC 0.45f   /* cutoff clamp, as a fraction of the rate */
#define FILTER_K_OPEN 1.41421356f   /* Butterworth: no resonance */
#define FILTER_K_MAX_RES 0.1f       /* at resonance 0.9: strong, never oscillates */
#define FILTER_PEAK_Q 1.0f          /* bell width, about 1.4 octaves */

/* convert_channels modes, and convert_result status */
enum { CONV_MONO_MIX = 0, CONV_LEFT = 1, CONV_RIGHT = 2 };
enum {
    CONV_FAILED = 0,
    CONV_OK = 1,
    CONV_ALREADY_MONO = 2,  /* 1-channel file: nothing written */
    CONV_LINKED = 3         /* the file has other hard links: nothing written */
};

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
    int norm_gain_db10; /* gain putting the peak at 0 dBFS, or NORM_GAIN_SILENT */
    int channels;       /* in the file */
    unsigned conv_seq;  /* nonzero: the converted current file, for request conv_seq */
} sample_buf_t;

/* Everything a chop changes, so undo can restore it whole. */
typedef struct {
    int slice_start[MAX_SLICES];
    int slice_end[MAX_SLICES];
    int slice_count;
} slice_snapshot_t;

#define UNDO_DEPTH 32

/* Per-voice crush state: phase counts up by crush_hz each output frame and
 * a new held frame is taken each time it reaches MOVE_SAMPLE_RATE. */
typedef struct {
    int phase;
    float l, r;
} crush_state_t;

/* Per-voice filter state: two SVF stages, two integrators per channel. */
typedef struct {
    float ic1[2][2];    /* [stage][L/R] */
    float ic2[2][2];
} filter_state_t;

/* Filter coefficients for each stage: out = m0 * in + m1 * band + m2 * low.
 * stages = 0 is bypass. */
typedef struct {
    int stages;
    float a1[2], a2[2], a3[2];
    float m0[2], m1[2], m2[2];
} filter_coef_t;

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
    crush_state_t crush;
    filter_state_t filter;

    /* Choke tail: the voice that was cut off, fading out */
    int tail_active;
    double tail_pos;
    int tail_end;
    float tail_gain;
    int tail_left;
    crush_state_t tail_crush;
    filter_state_t tail_filter;

    /* Global sound settings */
    int attack_us, hold_us, decay_us;           /* as set; hold may be HOLD_FULL */
    int attack_frames, hold_frames, decay_frames;
    int transpose;                              /* semitones */
    int detune;                                 /* cents */
    int gated;                                  /* 1 = A-S-R, 0 = one-shot A-H-D */
    double pitch_ratio;                         /* 2^((transpose*100 + detune)/1200) */
    int gain_db10;                              /* tenths of a dB, -700 to 240 */
    float gain_target;                          /* linear, from gain_db10 */
    float gain_cur;                             /* linear, ramps to gain_target */
    int crush_hz;                               /* 0 = off, else CRUSH_HZ_MIN-MAX */
    int filter_type;                            /* FILTER_LP12 .. FILTER_PEAK */
    int filter_hz10;                            /* cutoff, tenths of a Hz */
    int filter_res;                             /* thousandths, 0 to FILTER_RES_MAX */
    int filter_peak_db10;                       /* Peak gain, tenths of a dB */
    float filter_k;                             /* SVF damping from the resonance */
    float filter_peak_a;                        /* bell amplitude, 10^(dB/40) */
    float filter_oct_target;                    /* log2 of the cutoff in Hz */
    float filter_oct;                           /* glides to filter_oct_target */
    filter_coef_t filter_coef;

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
    float export_gain;          /* linear gain at the time of the request */
    atomic_uint export_req_seq;
    atomic_uint export_done_seq;
    atomic_int export_written;  /* slices written by the last finished export */

    /* --- channel conversion: audio thread requests, worker writes and loads --- */
    char conv_src[PATH_MAX_LEN];
    int conv_mode;
    atomic_uint conv_req_seq;
    atomic_uint conv_done_seq;
    atomic_int conv_status;

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

static void wr_u16(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void wr_u32(uint8_t *p, uint32_t v) { wr_u16(p, v & 0xFFFF); wr_u16(p + 2, v >> 16); }

/* One sample at p as a fraction of full scale (-1 to just under 1 for PCM).
 * fmt: 1 = PCM int, 3 = IEEE float, at the source's full precision. */
static double read_native(const uint8_t *p, int fmt, int bits) {
    if (fmt == 3) {
        if (bits == 32) {
            float v;
            memcpy(&v, p, 4);
            return v;
        }
        double d;
        memcpy(&d, p, 8);
        return d;
    }
    switch (bits) {
    case 8:  return ((int)p[0] - 128) / 128.0;
    case 16: return (int16_t)rd_u16(p) / 32768.0;
    case 24: {
        int32_t v = (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24) >> 8;
        return v / 8388608.0;
    }
    default: return (int32_t)rd_u32(p) / 2147483648.0;
    }
}

/* Inverse of read_native, rounding and clipping PCM to its range. */
static void write_native(uint8_t *p, double v, int fmt, int bits) {
    if (fmt == 3) {
        if (bits == 32) {
            float f = (float)v;
            memcpy(p, &f, 4);
        } else {
            memcpy(p, &v, 8);
        }
        return;
    }
    double scale = (double)(1LL << (bits - 1));
    double q = floor(v * scale + 0.5);
    if (q > scale - 1) q = scale - 1;
    if (q < -scale) q = -scale;
    int64_t i = (int64_t)q;
    switch (bits) {
    case 8:  p[0] = (uint8_t)(i + 128); break;
    case 16: wr_u16(p, (uint32_t)(i & 0xFFFF)); break;
    case 24: p[0] = (uint8_t)i; p[1] = (uint8_t)(i >> 8); p[2] = (uint8_t)(i >> 16); break;
    default: wr_u32(p, (uint32_t)i); break;
    }
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

/* Gain in tenths of a dB that puts `peak` (fraction of full scale) at
 * 0 dBFS: PCM full scale is the top code, one step under 1.0. Rounded down
 * so normalizing never clips. */
static int normalize_gain_db10(double peak, int fmt, int bits) {
    if (peak <= 0.0) return NORM_GAIN_SILENT;
    double full = fmt == 3 ? 1.0 : 1.0 - 1.0 / (double)(1LL << (bits - 1));
    double g = floor(200.0 * log10(full / peak) + 1e-9);
    if (g > GAIN_DB10_MAX) g = GAIN_DB10_MAX;
    if (g < GAIN_DB10_MIN) g = GAIN_DB10_MIN;
    return (int)g;
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
    double peak = 0.0;          /* at full precision, every channel, for Normalize */
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
            for (int c = 0; c < channels; c++) {
                double v = fabs(read_native(fp + c * bytes_per_sample, fmt, bits));
                if (v > peak) peak = v;
            }
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
    s->channels = channels;
    s->norm_gain_db10 = normalize_gain_db10(peak, fmt, bits);
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

#define FMT_MAX_BYTES 64

/* Find the fmt chunk (copied into fmt) and the data chunk of an open WAV.
 * fmt_len stays 0 or data_off -1 when they are missing. Worker only. */
static void read_wav_layout(FILE *f, uint8_t *fmt, uint32_t *fmt_len, long *data_off, uint32_t *data_bytes) {
    uint8_t hdr[12];
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) return;
    for (;;) {
        uint8_t ch[8];
        if (fread(ch, 1, 8, f) != 8) break;
        uint32_t len = rd_u32(ch + 4);
        if (memcmp(ch, "fmt ", 4) == 0) {
            if (len < 16 || len > FMT_MAX_BYTES || fread(fmt, 1, len, f) != len) break;
            *fmt_len = len;
            if ((len & 1) && fseek(f, 1, SEEK_CUR) != 0) break;
        } else if (memcmp(ch, "data", 4) == 0) {
            *data_bytes = len;
            *data_off = ftell(f);
            break;
        } else if (fseek(f, (long)(len + (len & 1)), SEEK_CUR) != 0) {
            break;
        }
    }
}

/* RIFF header, the given fmt chunk and a data chunk header for `bytes` of
 * audio. Returns 1 on success. Worker only. */
static int write_wav_header(FILE *o, const uint8_t *fmt, uint32_t fmt_len, uint32_t bytes) {
    uint8_t h[12 + 8 + FMT_MAX_BYTES + 1 + 8];
    int n;
    memcpy(h, "RIFF", 4);
    wr_u32(h + 4, 4 + (8 + fmt_len + (fmt_len & 1)) + (8 + bytes + (bytes & 1)));
    memcpy(h + 8, "WAVE", 4);
    memcpy(h + 12, "fmt ", 4);
    wr_u32(h + 16, fmt_len);
    memcpy(h + 20, fmt, fmt_len);
    n = 20 + (int)fmt_len;
    if (fmt_len & 1) h[n++] = 0;
    memcpy(h + n, "data", 4);
    wr_u32(h + n + 4, bytes);
    n += 8;
    return fwrite(h, 1, (size_t)n, o) == (size_t)n;
}

/* Write each slice of src as its own WAV in the source's format. At unity
 * gain the frames are copied as they are; otherwise each sample is scaled
 * (PCM clips at full scale). Returns the number of files written. Worker
 * only. */
static int write_slices(const char *src, const char *prefix,
                        const int *starts, const int *ends, int count, float gain) {
    FILE *f = fopen(src, "rb");
    if (!f) return 0;

    uint8_t fmt[FMT_MAX_BYTES];
    uint32_t fmt_len = 0, data_bytes = 0;
    long data_off = -1;
    read_wav_layout(f, fmt, &fmt_len, &data_off, &data_bytes);
    int block_align = fmt_len ? rd_u16(fmt + 12) : 0;
    int tag = fmt_len ? rd_u16(fmt) : 0;
    int bits = fmt_len ? rd_u16(fmt + 14) : 0;
    if (tag == 0xFFFE && fmt_len >= 26) tag = rd_u16(fmt + 24);   /* EXTENSIBLE subformat */
    int scale = gain != 1.0f;
    int ok_fmt = (tag == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32)) ||
                 (tag == 3 && (bits == 32 || bits == 64));
    int bps = bits / 8;
    uint8_t *buf = (uint8_t *)malloc(READ_CHUNK_BYTES);
    if (!fmt_len || data_off < 0 || block_align <= 0 || !buf ||
        (scale && (!ok_fmt || block_align % bps != 0))) {
        free(buf);
        fclose(f);
        return 0;
    }
    /* Whole frames per read, so scaling never splits a sample. */
    uint32_t chunk = (uint32_t)(READ_CHUNK_BYTES - READ_CHUNK_BYTES % block_align);
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

        int ok = write_wav_header(o, fmt, fmt_len, bytes) &&
                 fseek(f, data_off + a * block_align, SEEK_SET) == 0;
        uint32_t left = bytes;
        while (ok && left > 0) {
            size_t want = left < chunk ? left : chunk;
            ok = fread(buf, 1, want, f) == want;
            for (size_t k = 0; ok && scale && k < want; k += (size_t)bps) {
                write_native(buf + k, read_native(buf + k, tag, bits) * gain, tag, bits);
            }
            ok = ok && fwrite(buf, 1, want, o) == want;
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

/* Chunks with an entry per channel: dropped from a 1-channel copy, where
 * they would be wrong. */
static int per_channel_chunk(const uint8_t *id) {
    return memcmp(id, "PEAK", 4) == 0 || memcmp(id, "chna", 4) == 0;
}

/* Copy n bytes from f to o. Returns 1 on success. Worker only. */
static int copy_bytes(FILE *f, FILE *o, uint8_t *buf, uint32_t n) {
    while (n > 0) {
        size_t want = n < READ_CHUNK_BYTES ? n : READ_CHUNK_BYTES;
        if (fread(buf, 1, want, f) != want || fwrite(buf, 1, want, o) != want) return 0;
        n -= (uint32_t)want;
    }
    return 1;
}

/* Write src as a 1-channel WAV dest in the same format: the mean of all
 * channels (CONV_MONO_MIX), or channel 0 or 1. Every other chunk (cue
 * points, loops, LIST and so on) is copied as it is, except per-channel
 * ones. A data chunk that runs past the end of the file is cut to the
 * frames there, as load_wav does. Returns a CONV_* status. Fails rather
 * than overwrite dest. Worker only. */
static int write_channels(const char *src, const char *dest, int mode) {
    FILE *f = fopen(src, "rb");
    if (!f) return CONV_FAILED;
    struct stat fst;
    long size = fstat(fileno(f), &fst) == 0 ? (long)fst.st_size : 0;
    uint8_t fmt[FMT_MAX_BYTES];
    uint32_t fmt_len = 0, data_bytes = 0;
    long data_off = -1;
    read_wav_layout(f, fmt, &fmt_len, &data_off, &data_bytes);
    int tag = fmt_len ? rd_u16(fmt) : 0;
    int ext = tag == 0xFFFE;
    int channels = fmt_len ? rd_u16(fmt + 2) : 0;
    int bits = fmt_len ? rd_u16(fmt + 14) : 0;
    if (ext && fmt_len >= 26) tag = rd_u16(fmt + 24);   /* EXTENSIBLE subformat */
    int ok_fmt = (tag == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32)) ||
                 (tag == 3 && (bits == 32 || bits == 64));
    int bps = bits / 8;
    int block_align = fmt_len ? rd_u16(fmt + 12) : 0;
    if (ok_fmt && data_off >= 0 && channels == 1) {
        fclose(f);
        return CONV_ALREADY_MONO;
    }
    uint8_t *in = (uint8_t *)malloc(READ_CHUNK_BYTES);
    uint8_t *out = (uint8_t *)malloc(READ_CHUNK_BYTES);
    if (!ok_fmt || data_off < 0 || channels < 2 || block_align != channels * bps || !in || !out) {
        free(in); free(out);
        fclose(f);
        return CONV_FAILED;
    }
    long frames = (long)(data_bytes / (uint32_t)block_align);
    long in_file = (size - data_off) / block_align;
    int truncated = frames > in_file;
    if (truncated) frames = in_file;
    if (frames <= 0) {
        free(in); free(out);
        fclose(f);
        return CONV_FAILED;
    }
    uint32_t bytes = (uint32_t)(frames * bps);

    /* Same fmt chunk, one channel. */
    uint32_t rate = rd_u32(fmt + 4);
    wr_u16(fmt + 2, 1);
    wr_u32(fmt + 8, rate * (uint32_t)bps);
    wr_u16(fmt + 12, (uint32_t)bps);
    if (ext && fmt_len >= 24) wr_u32(fmt + 20, 0x4);     /* SPEAKER_FRONT_CENTER */

    FILE *o = fopen(dest, "wbx");
    if (!o) {
        free(in); free(out);
        fclose(f);
        return CONV_FAILED;
    }
    /* RIFF size is filled in at the end. */
    uint8_t h[12];
    memcpy(h, "RIFF", 4);
    wr_u32(h + 4, 0);
    memcpy(h + 8, "WAVE", 4);
    int ok = fwrite(h, 1, 12, o) == 12;
    int wrote_fmt = 0, wrote_data = 0;
    long pos = 12;
    while (ok && (!wrote_data || !truncated)) {
        uint8_t ch[8];
        if (fseek(f, pos, SEEK_SET) != 0 || fread(ch, 1, 8, f) != 8) break;
        uint32_t len = rd_u32(ch + 4);
        long body = pos + 8;
        pos = body + (long)len + (long)(len & 1);
        if (body == data_off) {
            uint8_t dh[8];
            memcpy(dh, "data", 4);
            wr_u32(dh + 4, bytes);
            ok = wrote_fmt && fwrite(dh, 1, 8, o) == 8;
            int pick = mode == CONV_RIGHT ? 1 : 0;
            long per_chunk = READ_CHUNK_BYTES / block_align;
            long left = frames;
            while (ok && left > 0) {
                long n = left < per_chunk ? left : per_chunk;
                ok = fread(in, (size_t)block_align, (size_t)n, f) == (size_t)n;
                for (long i = 0; ok && i < n; i++) {
                    const uint8_t *fp = in + i * block_align;
                    double v;
                    if (mode == CONV_MONO_MIX) {
                        v = 0.0;
                        for (int c = 0; c < channels; c++) v += read_native(fp + c * bps, tag, bits);
                        v /= channels;
                    } else {
                        v = read_native(fp + pick * bps, tag, bits);
                    }
                    write_native(out + i * bps, v, tag, bits);
                }
                ok = ok && fwrite(out, (size_t)bps, (size_t)n, o) == (size_t)n;
                left -= n;
            }
            if (ok && (bytes & 1)) ok = fputc(0, o) != EOF;
            wrote_data = 1;
        } else if (memcmp(ch, "fmt ", 4) == 0) {
            if (wrote_fmt) continue;
            uint8_t fh[8];
            memcpy(fh, "fmt ", 4);
            wr_u32(fh + 4, fmt_len);
            ok = fwrite(fh, 1, 8, o) == 8 && fwrite(fmt, 1, fmt_len, o) == fmt_len &&
                 (!(fmt_len & 1) || fputc(0, o) != EOF);
            wrote_fmt = 1;
        } else if (body + (long)len > size) {
            break;                  /* runs past the end of the file: drop it */
        } else if (!per_channel_chunk(ch)) {
            ok = fwrite(ch, 1, 8, o) == 8 && copy_bytes(f, o, in, len) &&
                 (!(len & 1) || fputc(0, o) != EOF);
        }
    }
    long total = ftell(o);
    ok = ok && wrote_data && total > 8 && total - 8 <= (long)UINT32_MAX;
    if (ok) {
        wr_u32(h + 4, (uint32_t)(total - 8));
        ok = fseek(o, 4, SEEK_SET) == 0 && fwrite(h + 4, 1, 4, o) == 4;
    }
    if (fclose(o) != 0) ok = 0;
    free(in); free(out);
    fclose(f);
    if (!ok) {
        remove(dest);
        return CONV_FAILED;
    }
    return CONV_OK;
}

#ifdef LIVE_CHOPPER_TEST
static int test_fail_convert_load;  /* tests: the converted file won't load */
#endif

/* Rewrite the WAV at src as 1 channel (see write_channels) and load it
 * into *out. A symlink's target is rewritten, keeping the link. The new
 * file is written next to the original as "<file>.convert-tmp", given its
 * owner and permissions, and loaded before it is renamed over the
 * original, so on any failure the original is left as it was and *out is
 * NULL. A file with other hard links is refused: renaming would split it
 * from them. Returns a CONV_* status. Worker only. */
static int convert_file(const char *src, int mode, sample_buf_t **out) {
    *out = NULL;
    char real[PATH_MAX], tmp[PATH_MAX];
    struct stat st;
    if (!realpath(src, real) || stat(real, &st) != 0) return CONV_FAILED;
    if (snprintf(tmp, sizeof(tmp), "%s.convert-tmp", real) >= (int)sizeof(tmp)) return CONV_FAILED;
    remove(tmp);                    /* left over from a crash */
    int status = write_channels(real, tmp, mode);
    if (status != CONV_OK) return status;
    if (st.st_nlink > 1) {
        remove(tmp);
        return CONV_LINKED;
    }
    if (chown(tmp, st.st_uid, st.st_gid) != 0) { /* best effort */ }
    chmod(tmp, st.st_mode & 07777);
    char err[ERROR_MAX_LEN] = "";
    sample_buf_t *s = load_wav(tmp, err, sizeof(err));
#ifdef LIVE_CHOPPER_TEST
    if (test_fail_convert_load) {
        free_sample(s);
        s = NULL;
    }
#endif
    if (s && !build_peaks(s)) {
        free_sample(s);
        s = NULL;
    }
    if (!s || rename(tmp, real) != 0) {
        free_sample(s);
        remove(tmp);
        return CONV_FAILED;
    }
    memcpy(s->path, src, PATH_MAX_LEN);
    *out = s;
    return CONV_OK;
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
            float gain = inst->export_gain;
            /* A newer request landed mid-copy: take it next time round. */
            if (atomic_load_explicit(&inst->export_req_seq, memory_order_acquire) == eseq) {
                src[PATH_MAX_LEN - 1] = '\0';
                prefix[PATH_MAX_LEN - 1] = '\0';
                if (count < 0 || count > MAX_SLICES) count = 0;
                int written = write_slices(src, prefix, starts, ends, count, gain);
                atomic_store(&inst->export_written, written);
                atomic_store_explicit(&inst->export_done_seq, eseq, memory_order_release);
                continue;
            }
        }

        /* Converting waits for any loaded buffer to be taken first, since it
         * publishes one of its own. */
        unsigned cseq = atomic_load_explicit(&inst->conv_req_seq, memory_order_acquire);
        if (cseq != atomic_load(&inst->conv_done_seq) && atomic_load(&inst->incoming) == NULL) {
            char src[PATH_MAX_LEN];
            memcpy(src, inst->conv_src, PATH_MAX_LEN);
            int mode = inst->conv_mode;
            /* A newer request landed mid-copy: take it next time round. */
            if (atomic_load_explicit(&inst->conv_req_seq, memory_order_acquire) == cseq) {
                src[PATH_MAX_LEN - 1] = '\0';
                sample_buf_t *s = NULL;
                int status = convert_file(src, mode, &s);
                atomic_store(&inst->conv_status, status);
                if (s) {
                    s->conv_seq = cseq;     /* done once the audio thread takes it */
                    atomic_store(&inst->incoming, s);
                } else {
                    atomic_store_explicit(&inst->conv_done_seq, cseq, memory_order_release);
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

enum { ADOPT_LOAD, ADOPT_SWAP, ADOPT_DROP };

/* What taking s does: a converted copy of the current file normally has
 * the same frames and goes in under the slices, undo and the voice
 * (SWAP); one of a file that has since been replaced is thrown away
 * (DROP); anything else starts over (LOAD). Audio thread only. */
static int adopt_kind(const live_chopper_t *inst, const sample_buf_t *s) {
    const sample_buf_t *c = inst->current;
    if (!s->conv_seq) return ADOPT_LOAD;
    if (!c || strcmp(s->path, c->path) != 0) return ADOPT_DROP;
    return s->frames == c->frames ? ADOPT_SWAP : ADOPT_LOAD;
}

/* Take a newly loaded buffer if the worker has published one and the
 * previous retired buffer has been collected. */
static void adopt_incoming(live_chopper_t *inst) {
    sample_buf_t *s = atomic_load(&inst->incoming);
    if (!s || atomic_load(&inst->retired) != NULL) return;
    int kind = adopt_kind(inst, s);
    /* Mark a conversion done before the worker can see the slot free, or
     * it would run the same request again. */
    if (s->conv_seq) atomic_store_explicit(&inst->conv_done_seq, s->conv_seq, memory_order_release);
    atomic_store(&inst->incoming, NULL);
    if (kind == ADOPT_DROP) {
        atomic_store(&inst->retired, s);
        return;
    }
    sample_buf_t *old = inst->current;
    inst->current = s;
    if (kind == ADOPT_SWAP) {
        atomic_store(&inst->retired, old);
        return;
    }
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

static void update_pitch_ratio(live_chopper_t *inst) {
    inst->pitch_ratio = pow(2.0, (inst->transpose * 100 + inst->detune) / 1200.0);
}

static void set_transpose(live_chopper_t *inst, int semis) {
    if (semis < TRANSPOSE_MIN) semis = TRANSPOSE_MIN;
    if (semis > TRANSPOSE_MAX) semis = TRANSPOSE_MAX;
    inst->transpose = semis;
    update_pitch_ratio(inst);
}

/* Tenths of a dB, clamped to -70..+24 dB. The audio ramps to it over the
 * next block. */
static void set_gain(live_chopper_t *inst, int db10) {
    if (db10 > GAIN_DB10_MAX) db10 = GAIN_DB10_MAX;
    if (db10 < GAIN_DB10_MIN) db10 = GAIN_DB10_MIN;
    inst->gain_db10 = db10;
    inst->gain_target = (float)pow(10.0, db10 / 200.0);
}

static void set_detune(live_chopper_t *inst, int cents) {
    if (cents < DETUNE_MIN) cents = DETUNE_MIN;
    if (cents > DETUNE_MAX) cents = DETUNE_MAX;
    inst->detune = cents;
    update_pitch_ratio(inst);
}

/* 0 is off; anything else is clamped to the 8-Bit effect's range. */
static void set_crush(live_chopper_t *inst, int hz) {
    if (hz <= 0) hz = 0;
    else if (hz < CRUSH_HZ_MIN) hz = CRUSH_HZ_MIN;
    else if (hz > CRUSH_HZ_MAX) hz = CRUSH_HZ_MAX;
    inst->crush_hz = hz;
}

/* Truncate to 8 bits, as dropping the low byte of a 16-bit sample does. */
static float quantize8(float v) {
    return floorf(v / 256.0f) * 256.0f;
}

/* Sample-and-hold one voice's frame at hz. Off keeps the phase full, so
 * turning crush on takes a fresh frame at once. */
static void crush_frame(int hz, crush_state_t *c, float *l, float *r) {
    if (hz <= 0) {
        c->phase = MOVE_SAMPLE_RATE;
        return;
    }
    if (c->phase >= MOVE_SAMPLE_RATE) {
        c->phase -= MOVE_SAMPLE_RATE;
        c->l = quantize8(*l);
        c->r = quantize8(*r);
    }
    c->phase += hz;
    *l = c->l;
    *r = c->r;
}

static int clamp_int(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static void set_filter_type(live_chopper_t *inst, int type) {
    inst->filter_type = clamp_int(type, FILTER_LP12, FILTER_PEAK);
}

/* The cutoff glides there from wherever it is. */
static void set_filter_hz10(live_chopper_t *inst, int hz10) {
    inst->filter_hz10 = clamp_int(hz10, FILTER_HZ10_MIN, FILTER_HZ10_MAX);
    inst->filter_oct_target = log2f(inst->filter_hz10 / 10.0f);
}

/* Resonance 0 is a flat Butterworth (k = sqrt 2); 0.9 brings k down to
 * FILTER_K_MAX_RES, exponentially, so the peak grows evenly. */
static void set_filter_res(live_chopper_t *inst, int res) {
    inst->filter_res = clamp_int(res, 0, FILTER_RES_MAX);
    inst->filter_k = FILTER_K_OPEN * powf(FILTER_K_MAX_RES / FILTER_K_OPEN, inst->filter_res / (float)FILTER_RES_MAX);
}

static void set_filter_peak(live_chopper_t *inst, int db10) {
    inst->filter_peak_db10 = clamp_int(db10, -FILTER_PEAK_DB10_MAX, FILTER_PEAK_DB10_MAX);
    inst->filter_peak_a = powf(10.0f, inst->filter_peak_db10 / 400.0f);
}

/* One SVF stage's coefficients for a given g = tan(pi * fc / rate). */
static void svf_stage(filter_coef_t *c, int s, float g, float k, float m0, float m1, float m2) {
    c->a1[s] = 1.0f / (1.0f + g * (g + k));
    c->a2[s] = g * c->a1[s];
    c->a3[s] = g * c->a2[s];
    c->m0[s] = m0;
    c->m1[s] = m1;
    c->m2[s] = m2;
}

/* Glide the cutoff one step and recompute the coefficients. The 24 dB types
 * add a Butterworth stage after the resonant one. A low-pass type that has
 * reached the top is bypassed, with its state cleared for when it comes
 * back. Bounded: one tan per call. */
static void filter_update(live_chopper_t *inst) {
    filter_coef_t *c = &inst->filter_coef;
    float d = inst->filter_oct_target - inst->filter_oct;
    inst->filter_oct = fabsf(d) < 1e-4f ? inst->filter_oct_target : inst->filter_oct + d * FILTER_GLIDE;
    int type = inst->filter_type;
    if (type != FILTER_HP24 && type != FILTER_PEAK && inst->filter_hz10 == FILTER_HZ10_MAX &&
        inst->filter_oct == inst->filter_oct_target) {
        c->stages = 0;
        memset(&inst->filter, 0, sizeof inst->filter);
        memset(&inst->tail_filter, 0, sizeof inst->tail_filter);
        return;
    }
    float hz = exp2f(inst->filter_oct);
    if (hz > FILTER_NYQUIST_FRAC * MOVE_SAMPLE_RATE) hz = FILTER_NYQUIST_FRAC * MOVE_SAMPLE_RATE;
    float g = tanf((float)M_PI * hz / MOVE_SAMPLE_RATE);
    float k = inst->filter_k;
    if (type == FILTER_PEAK) {
        float a = inst->filter_peak_a;
        float kp = 1.0f / (FILTER_PEAK_Q * a);
        svf_stage(c, 0, g, kp, 1.0f, kp * (a * a - 1.0f), 0.0f);
        c->stages = 1;
    } else if (type == FILTER_HP24) {
        svf_stage(c, 0, g, k, 1.0f, -k, -1.0f);
        svf_stage(c, 1, g, FILTER_K_OPEN, 1.0f, -FILTER_K_OPEN, -1.0f);
        c->stages = 2;
    } else {
        svf_stage(c, 0, g, k, 0.0f, 0.0f, 1.0f);
        svf_stage(c, 1, g, FILTER_K_OPEN, 0.0f, 0.0f, 1.0f);
        c->stages = type == FILTER_LP24 ? 2 : 1;
    }
    if (c->stages < 2) {
        /* Clear the unused stage so a later 24 dB type starts it clean. */
        for (int ch = 0; ch < 2; ch++) {
            inst->filter.ic1[1][ch] = inst->filter.ic2[1][ch] = 0.0f;
            inst->tail_filter.ic1[1][ch] = inst->tail_filter.ic2[1][ch] = 0.0f;
        }
    }
}

static float svf_tick(const filter_coef_t *c, int s, float *ic1, float *ic2, float v0) {
    float v3 = v0 - *ic2;
    float v1 = c->a1[s] * *ic1 + c->a2[s] * v3;
    float v2 = *ic2 + c->a2[s] * *ic1 + c->a3[s] * v3;
    *ic1 = 2.0f * v1 - *ic1;
    *ic2 = 2.0f * v2 - *ic2;
    return c->m0[s] * v0 + c->m1[s] * v1 + c->m2[s] * v2;
}

/* Run one voice's frame through the filter (nothing when bypassed). */
static void filter_frame(const filter_coef_t *c, filter_state_t *f, float *l, float *r) {
    for (int s = 0; s < c->stages; s++) {
        *l = svf_tick(c, s, &f->ic1[s][0], &f->ic2[s][0], *l);
        *r = svf_tick(c, s, &f->ic1[s][1], &f->ic2[s][1], *r);
    }
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
    inst->tail_crush = inst->crush;
    inst->tail_filter = inst->filter;
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
    inst->crush.phase = MOVE_SAMPLE_RATE;   /* hold the slice's first frame */
    memset(&inst->filter, 0, sizeof inst->filter);
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
    atomic_init(&inst->conv_req_seq, 0);
    atomic_init(&inst->conv_done_seq, 0);
    atomic_init(&inst->conv_status, CONV_FAILED);
    inst->playing_slice = -1;
    inst->gate_note = -1;
    inst->release_pos = -1;
    inst->attack_us = 0;
    inst->hold_us = HOLD_FULL;
    inst->hold_frames = HOLD_FULL;
    inst->decay_us = DEFAULT_DECAY_US;
    inst->decay_frames = us_to_frames(DEFAULT_DECAY_US);
    set_transpose(inst, 0);
    set_gain(inst, 0);
    inst->gain_cur = inst->gain_target;
    set_filter_type(inst, FILTER_LP24);
    set_filter_hz10(inst, FILTER_HZ10_MAX);
    set_filter_res(inst, 0);
    set_filter_peak(inst, 0);
    inst->filter_oct = inst->filter_oct_target;
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
    if (strcmp(key, "detune") == 0) {
        const char *p = val;
        set_detune(inst, parse_int(&p));
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
        inst->export_gain = inst->gain_target;
        atomic_fetch_add_explicit(&inst->export_req_seq, 1, memory_order_release);
        return;
    }
    if (strcmp(key, "convert_channels") == 0) {
        /* "mono" | "left" | "right": the worker rewrites the file as 1 channel */
        if (!inst->current) return;
        int mode = strcmp(val, "left") == 0 ? CONV_LEFT : strcmp(val, "right") == 0 ? CONV_RIGHT :
                   strcmp(val, "mono") == 0 ? CONV_MONO_MIX : -1;
        if (mode < 0) return;
        memcpy(inst->conv_src, inst->current->path, PATH_MAX_LEN);
        inst->conv_mode = mode;
        atomic_fetch_add_explicit(&inst->conv_req_seq, 1, memory_order_release);
        return;
    }
    if (strcmp(key, "gain_db10") == 0) {
        const char *p = val;
        set_gain(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "crush_hz") == 0) {
        const char *p = val;
        set_crush(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "filter_type") == 0) {
        const char *p = val;
        set_filter_type(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "filter_hz10") == 0) {
        const char *p = val;
        set_filter_hz10(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "filter_res") == 0) {
        const char *p = val;
        set_filter_res(inst, parse_int(&p));
        return;
    }
    if (strcmp(key, "filter_peak_db10") == 0) {
        const char *p = val;
        set_filter_peak(inst, parse_int(&p));
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
    if (strcmp(key, "channels") == 0) {
        if (!inst->current) return -1;
        return snprintf(buf, (size_t)buf_len, "%d", inst->current->channels);
    }
    if (strcmp(key, "convert_result") == 0) {
        /* "<requested seq> <finished seq> <status>" */
        return snprintf(buf, (size_t)buf_len, "%u %u %d",
                        atomic_load(&inst->conv_req_seq), atomic_load(&inst->conv_done_seq),
                        atomic_load(&inst->conv_status));
    }
    if (strcmp(key, "normalize_gain") == 0) {
        /* Gain (tenths of a dB) that puts the peak at 0 dBFS, or "silent" */
        if (!inst->current) return -1;
        if (inst->current->norm_gain_db10 == NORM_GAIN_SILENT) return snprintf(buf, (size_t)buf_len, "silent");
        return snprintf(buf, (size_t)buf_len, "%d", inst->current->norm_gain_db10);
    }
    if (strcmp(key, "status") == 0) {
        /* "<state> <frames> <rate> <playing> <pos>"
         * state: loading | ready | error | none */
        int ls = atomic_load(&inst->load_state);
        sample_buf_t *s = inst->current;
        const char *state = "none";
        sample_buf_t *in = atomic_load(&inst->incoming);
        /* A converted copy swapped in under the slices is not a load. */
        if (ls == LOAD_BUSY || (in && adopt_kind(inst, in) == ADOPT_LOAD)) state = "loading";
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
        /* "<attack_us> <hold_us, -1 = full> <decay_us> <transpose> <gated> <detune>
         *  <gain_db10> <crush_hz> <filter_type> <filter_hz10> <filter_res>
         *  <filter_peak_db10>" */
        return snprintf(buf, (size_t)buf_len, "%d %d %d %d %d %d %d %d %d %d %d %d",
                        inst->attack_us, inst->hold_us, inst->decay_us, inst->transpose, inst->gated,
                        inst->detune, inst->gain_db10, inst->crush_hz, inst->filter_type,
                        inst->filter_hz10, inst->filter_res, inst->filter_peak_db10);
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
    /* Gain ramps linearly to its target across the block. */
    float g0 = inst->gain_cur, g1 = inst->gain_target;
    inst->gain_cur = g1;
    if (!s || (!inst->playing && !inst->tail_active)) {
        /* Nothing to hear the cutoff glide: the next note starts on it. */
        inst->filter_oct = inst->filter_oct_target;
        return;
    }

    double step = (double)s->sample_rate / (double)MOVE_SAMPLE_RATE * inst->pitch_ratio;
    int crush_hz = inst->crush_hz;
    const filter_coef_t *fc = &inst->filter_coef;
    for (int i = 0; i < frames; i++) {
        float l = 0.0f, r = 0.0f, vl, vr;
        if (i % FILTER_COEF_FRAMES == 0) filter_update(inst);

        if (inst->playing) {
            if ((int)inst->play_pos >= inst->play_end || env_finished(inst)) {
                inst->playing = 0;
                inst->playing_slice = -1;
            } else {
                float g = env_gain(inst);
                read_frame(s, inst->play_pos, &vl, &vr);
                crush_frame(crush_hz, &inst->crush, &vl, &vr);
                filter_frame(fc, &inst->filter, &vl, &vr);
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
                crush_frame(crush_hz, &inst->tail_crush, &vl, &vr);
                filter_frame(fc, &inst->tail_filter, &vl, &vr);
                l += vl * g;
                r += vr * g;
                inst->tail_pos += step;
                inst->tail_left--;
            }
        }

        float gain = g0 + (g1 - g0) * (float)(i + 1) / (float)frames;
        out[i * 2] = clamp16(l * gain);
        out[i * 2 + 1] = clamp16(r * gain);
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
