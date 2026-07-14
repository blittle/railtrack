import { describe, it, expect } from "vitest";
import type { SpeedKeyframe, TimelapseProject } from "../project";
import {
  buildFfmpeg,
  buildProxyCommand,
  brightnessToGamma,
  denoiseFilter,
  speedAtFrame,
  ZoomNotSupportedError,
} from "../buildFfmpeg";
import { windowAtFrame, hasZoom, ease } from "../interpolate";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg";

/**
 * Canonical project = the exact pipeline we validated by hand on the 787 real
 * frames: a 7752x4360 window (bottom-aligned, y=944) panning x 0->200 over the
 * full clip, scaled to 4K with lanczos. This is the regression anchor.
 */
function canonicalProject(over: Partial<TimelapseProject> = {}): TimelapseProject {
  return {
    version: 1,
    source: {
      dir: "/Users/blittle/Desktop/timelapses/tl2",
      glob: "*.jpg",
      frameCount: 787,
      width: 7952,
      height: 5304,
    },
    output: {
      w: 3840,
      h: 2160,
      path: "timelapse_4k.mp4",
      fps: 30,
      codec: "h264",
      crf: 18,
      scaleFlags: "lanczos",
    },
    keyframes: [
      { frame: 0, x: 0, y: 944, w: 7752, h: 4360, easing: "linear" },
      { frame: 786, x: 200, y: 944, w: 7752, h: 4360, easing: "linear" },
    ],
    post: {},
    ...over,
  };
}

describe("buildFfmpeg", () => {
  it("reproduces the validated crop+scale pipeline", () => {
    const { filtergraph, args } = buildFfmpeg(canonicalProject());

    // commas inside the crop expressions are escaped (\,) so the filtergraph
    // parser doesn't read them as filter separators
    expect(filtergraph).toBe(
      "crop=7752:4360:" +
        "if(lt(n\\,0)\\,0\\,if(lt(n\\,786)\\,0+(200)*((n-0)/786)\\,200)):" +
        "if(lt(n\\,0)\\,944\\,if(lt(n\\,786)\\,944\\,944))," +
        "scale=3840:2160:flags=lanczos",
    );

    expect(args).toEqual([
      "-y",
      "-framerate", "30",
      "-pattern_type", "glob",
      "-i", "/Users/blittle/Desktop/timelapses/tl2/*.jpg",
      "-vf", filtergraph,
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "timelapse_4k.mp4",
    ]);
  });

  it("uses VideoToolbox encoders with -q:v (not -crf) when hwAccel is on", () => {
    const h264 = buildFfmpeg(
      canonicalProject({ output: { ...canonicalProject().output, hwAccel: true } }),
    ).args;
    expect(h264).toContain("h264_videotoolbox");
    expect(h264).not.toContain("libx264");
    expect(h264).not.toContain("-crf");
    expect(h264).not.toContain("-preset");
    expect(h264).toContain("-q:v");

    const h265 = buildFfmpeg(
      canonicalProject({ output: { ...canonicalProject().output, codec: "h265", hwAccel: true } }),
    ).args;
    expect(h265).toContain("hevc_videotoolbox");
    expect(h265).toContain("hvc1"); // hevc tag still applied

    const prores = buildFfmpeg(
      canonicalProject({ output: { ...canonicalProject().output, codec: "prores", hwAccel: true } }),
    ).args;
    expect(prores).toContain("prores_videotoolbox");
    expect(prores).not.toContain("prores_ks");
  });

  it("nlmeans is available as a denoise filter (strength maps to s)", () => {
    expect(denoiseFilter({ filter: "nlmeans", strength: 0 })).toBe("nlmeans=s=1");
    expect(denoiseFilter({ filter: "nlmeans", strength: 1 })).toBe("nlmeans=s=10");
  });

  it("deband runs after the grade and before the fade", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          color: { brightness: 0.1, contrast: 1.2, temperature: 6500 },
          deband: { strength: 0.5 },
          fade: { inSec: 0, outSec: 1 },
        },
      }),
    );
    const g = filtergraph.indexOf("eq=");
    const d = filtergraph.indexOf("deband=");
    const f = filtergraph.indexOf("fade=t=out");
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThan(d); // grade before deband
    expect(d).toBeLessThan(f); // deband before fade
    expect(filtergraph).toContain("deband=1thr=0.0325:2thr=0.0325:3thr=0.0325:4thr=0.0325");
  });

  it("runs deflicker first in the pre-crop chain, before stack and crop", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          deflicker: { size: 7 },
          frameStack: { frames: 3, mode: "median" },
        },
      }),
    );
    expect(filtergraph.startsWith("deflicker=size=7:mode=am,")).toBe(true);
    const df = filtergraph.indexOf("deflicker");
    expect(df).toBeLessThan(filtergraph.indexOf("tmedian"));
    expect(filtergraph.indexOf("tmedian")).toBeLessThan(filtergraph.indexOf("crop="));
  });

  it("clamps deflicker window to ffmpeg's 2..129 range", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { deflicker: { size: 999 } } }),
    );
    expect(filtergraph).toContain("deflicker=size=129:mode=am");
  });

  it("inserts temporal frame stacking pre-crop (median rejects outliers)", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { frameStack: { frames: 5, mode: "median" } } }),
    );
    // tmedian with radius = floor(5/2) = 2, and it runs BEFORE the crop/scale.
    expect(filtergraph.startsWith("tmedian=radius=2,")).toBe(true);
    expect(filtergraph.indexOf("tmedian")).toBeLessThan(filtergraph.indexOf("crop="));
  });

  it("mean stacking uses center-weighted tmix", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { frameStack: { frames: 5, mode: "mean" } } }),
    );
    expect(filtergraph.startsWith("tmix=frames=5:weights='1 2 3 2 1',")).toBe(true);
  });

  it("stacking precedes denoise and lagfun in the star-trail graph", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          frameStack: { frames: 3, mode: "median" },
          denoise: { filter: "hqdn3d", strength: 0.5 },
          starTrail: { decay: 1 },
        },
      }),
    );
    const s = filtergraph.indexOf("tmedian");
    const d = filtergraph.indexOf("hqdn3d");
    const l = filtergraph.indexOf("lagfun");
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(d);
    expect(d).toBeLessThan(l);
  });

  it("lighten speed-up decimates, retimes, and remaps the pan", () => {
    const { filtergraph, args, outputFrames } = buildFfmpeg(
      canonicalProject({ post: { lightenSpeedup: { factor: 4 } } }),
    );
    // factor-1 = 3 chained lighten blends, then framestep + setpts to speed up.
    expect(filtergraph).toContain(
      "tblend=all_mode=lighten,tblend=all_mode=lighten,tblend=all_mode=lighten,framestep=4,setpts=PTS/4",
    );
    // the blend/decimate runs BEFORE the crop
    expect(filtergraph.indexOf("framestep=4")).toBeLessThan(filtergraph.indexOf("crop="));
    // pan is evaluated against source frame = 4*n (output frame remapped)
    expect(filtergraph).toContain("4*n");
    // clip length drops to ceil(N/4); N=787 -> 197
    expect(outputFrames).toBe(Math.ceil(787 / 4));
    // constant output rate is locked for the retimed stream
    expect(args).toContain("-r");
  });

  it("factor 2 uses a single lighten blend", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { lightenSpeedup: { factor: 2 } } }),
    );
    expect(filtergraph).toContain("tblend=all_mode=lighten,framestep=2,setpts=PTS/2");
    expect(filtergraph).not.toContain("tblend=all_mode=lighten,tblend=all_mode=lighten");
  });

  it("rejects combining lighten speed-up with star trails", () => {
    expect(() =>
      buildFfmpeg(
        canonicalProject({
          post: { lightenSpeedup: { factor: 2 }, starTrail: { decay: 1 } },
        }),
      ),
    ).toThrow(/can't be combined/);
  });

  it("speed keyframe easeAmount blends linear <-> smoothstep", () => {
    const lin: SpeedKeyframe[] = [
      { frame: 0, speed: 1, easing: "linear" },
      { frame: 10, speed: 3, easing: "easeInOut", easeAmount: 0 },
    ];
    const smooth: SpeedKeyframe[] = [
      { frame: 0, speed: 1, easing: "linear" },
      { frame: 10, speed: 3, easing: "easeInOut", easeAmount: 1 },
    ];
    // at u=0.25: linear -> 1.5, full smoothstep -> 1.3125
    expect(speedAtFrame(lin, 2.5)).toBeCloseTo(1.5, 5);
    expect(speedAtFrame(smooth, 2.5)).toBeCloseTo(1.3125, 4);
  });

  it("speed ramp retimes at the very end and shortens the clip", () => {
    const kf = (frame: number, speed: number): { frame: number; speed: number; easing: "linear" } =>
      ({ frame, speed, easing: "linear" });
    const { args, filtergraph, outputFrames } = buildFfmpeg(
      canonicalProject({ post: { speedRamp: { keyframes: [kf(0, 2), kf(786, 2)] } } }),
    );
    // constant 2× over N=787 frames -> ~394 output frames
    expect(outputFrames).toBe(394);
    // the retime is the LAST thing in the -vf chain (after crop/scale)
    expect(filtergraph).toMatch(/setpts=.*,fps=30$/);
    expect(filtergraph.indexOf("crop=")).toBeLessThan(filtergraph.indexOf("setpts="));
    // constant output rate is locked
    expect(args).toContain("-r");
  });

  it("speed ramp comes after the grade + fade tail, not before", () => {
    const kf = (frame: number, speed: number): { frame: number; speed: number; easing: "linear" } =>
      ({ frame, speed, easing: "linear" });
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          color: { brightness: 0.1, contrast: 1.2, temperature: 6500 },
          fade: { inSec: 0, outSec: 1 },
          speedRamp: { keyframes: [kf(0, 3), kf(786, 3)] },
        },
      }),
    );
    expect(filtergraph.indexOf("eq=")).toBeLessThan(filtergraph.indexOf("setpts="));
    expect(filtergraph.indexOf("fade=t=out")).toBeLessThan(filtergraph.indexOf("setpts="));
  });

  it("a 1x->fast->1x ramp lands between full-speed and top-speed length", () => {
    const { outputFrames } = buildFfmpeg(
      canonicalProject({
        post: {
          speedRamp: {
            keyframes: [
              { frame: 0, speed: 1, easing: "linear" },
              { frame: 393, speed: 4, easing: "easeInOut" },
              { frame: 786, speed: 1, easing: "easeInOut" },
            ],
          },
        },
      }),
    );
    // shorter than 1x (787) but longer than a uniform 4x (~197)
    expect(outputFrames).toBeLessThan(787);
    expect(outputFrames).toBeGreaterThan(197);
  });

  it("appends color grade (eq gamma + colortemperature) before any fade", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          color: { brightness: 0.1, contrast: 1.2, temperature: 4000 },
          fade: { inSec: 0, outSec: 1 },
        },
      }),
    );
    expect(filtergraph).toContain("eq=gamma=1.1:contrast=1.2,colortemperature=temperature=4000");
    // grade comes before the fade-out
    expect(filtergraph.indexOf("colortemperature")).toBeLessThan(filtergraph.indexOf("fade=t=out"));
  });

  it("omits neutral grade components", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { color: { brightness: 0, contrast: 1, temperature: 5000 } } }),
    );
    expect(filtergraph).not.toContain("eq="); // gamma/contrast neutral
    expect(filtergraph.endsWith("colortemperature=temperature=5000")).toBe(true);
  });

  it("maps brightness slider offsets to ffmpeg gamma", () => {
    expect(brightnessToGamma(0)).toBe(1);
    expect(brightnessToGamma(0.3)).toBe(1.3);
    expect(brightnessToGamma(-0.3)).toBe(0.7);
    expect(brightnessToGamma(1)).toBe(2);
  });

  it("appends expanded tone and color grade controls", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          color: {
            exposure: 0.12,
            brightness: 0.2,
            contrast: 1.3,
            shadows: 20,
            highlights: -30,
            temperature: 5200,
            tint: 25,
            vibrance: 0.4,
            saturation: 1.2,
          },
        },
      }),
    );
    expect(filtergraph).toContain("eq=brightness=0.12:gamma=1.2:contrast=1.3:saturation=1.2");
    expect(filtergraph).toContain("curves=all='0/0 0.25/0.29 0.75/0.69 1/1'");
    expect(filtergraph).toContain("colortemperature=temperature=5200");
    expect(filtergraph).toContain("colorbalance=rm=0.02:gm=-0.02:bm=0.02");
    expect(filtergraph).toContain("vibrance=intensity=0.4");
  });

  it("appends fade in/out as the last filters (simple -vf path)", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { fade: { inSec: 1, outSec: 2 } } }),
    );
    // fps 30 -> 30 frames in; out over 60 frames ending at frame 787
    expect(filtergraph.endsWith("fade=t=in:s=0:n=30,fade=t=out:s=727:n=60")).toBe(true);
  });

  it("injects fade before [outv] in a filter_complex graph (star-trail retract)", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          starTrail: { decay: 1, startFrame: 100, endFrame: 400 },
          fade: { inSec: 0, outSec: 1 },
        },
      }),
    );
    // 1088 output frames -> fade out starts at 1058, before the [outv] label
    expect(filtergraph).toContain("fade=t=out:s=1058:n=30[outv]");
    expect(filtergraph.endsWith("[outv]")).toBe(true);
  });

  it("appends denoise when configured", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { denoise: { filter: "hqdn3d", strength: 0.5 } } }),
    );
    expect(filtergraph.endsWith(",hqdn3d=4:3:6:0")).toBe(true);
  });

  it("forces even crop/output dimensions", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        output: { ...canonicalProject().output, w: 3841, h: 2161 },
        keyframes: [
          { frame: 0, x: 0, y: 944, w: 7753, h: 4361, easing: "linear" },
          { frame: 786, x: 200, y: 944, w: 7753, h: 4361, easing: "linear" },
        ],
      }),
    );
    expect(filtergraph.startsWith("crop=7752:4360:")).toBe(true);
    expect(filtergraph).toContain("scale=3840:2160:");
  });

  it("applies star-trail (lagfun) BEFORE the crop/pan", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { starTrail: { decay: 1 } } }),
    );
    expect(filtergraph.startsWith("lagfun=decay=1,crop=7752:4360:")).toBe(true);
    const li = filtergraph.indexOf("lagfun");
    const ci = filtergraph.indexOf("crop");
    expect(li).toBeGreaterThanOrEqual(0);
    expect(li).toBeLessThan(ci); // lagfun precedes crop
  });

  it("with star trails, denoise runs before lagfun (pre-crop), not after scale", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: {
          denoise: { filter: "hqdn3d", strength: 0.5 },
          starTrail: { decay: 0.98 },
        },
      }),
    );
    expect(filtergraph.startsWith("hqdn3d=4:3:6:0,lagfun=decay=0.98,crop=")).toBe(true);
    // exactly one denoise instance, and it is before crop
    expect((filtergraph.match(/hqdn3d/g) || []).length).toBe(1);
    expect(filtergraph.indexOf("hqdn3d")).toBeLessThan(filtergraph.indexOf("crop"));
  });

  it("delays star trails via split/trim/concat so trails accumulate from the start frame", () => {
    const { filtergraph, args } = buildFfmpeg(
      canonicalProject({ post: { starTrail: { decay: 1, startFrame: 300 } } }),
    );
    // pre-segment untouched, post-segment gets a FRESH lagfun, then concat
    expect(filtergraph).toContain("split=2[a][b]");
    expect(filtergraph).toContain("[a]trim=end_frame=300,setpts=PTS-STARTPTS[pre]");
    expect(filtergraph).toContain("[b]trim=start_frame=300,setpts=PTS-STARTPTS,lagfun=decay=1[post]");
    expect(filtergraph).toContain("[pre][post]concat=n=2:v=1,crop=7752:4360:");
    expect(filtergraph).not.toContain("enable="); // no broken timeline gate
    expect(args).toContain("-filter_complex");
    expect(args).toContain("[outv]");
  });

  it("uses a simple -vf chain (lagfun on whole stream) when trails start at frame 0", () => {
    const { filtergraph, args } = buildFfmpeg(
      canonicalProject({ post: { starTrail: { decay: 1, startFrame: 0 } } }),
    );
    expect(filtergraph).toContain("lagfun=decay=1,crop=");
    expect(filtergraph).not.toContain("concat");
    expect(args).toContain("-vf");
  });

  it("retracts trails (reverse-lagfun-reverse) when an end frame is set", () => {
    const { filtergraph, args, outputFrames } = buildFfmpeg(
      canonicalProject({
        post: { starTrail: { decay: 1, startFrame: 100, endFrame: 400 } },
      }),
    );
    // A (untouched) | B (grow) | C (retract) | D (normal tail) -> 4-way split+concat
    expect(filtergraph).toContain("split=4");
    expect(filtergraph).toContain("concat=n=4:v=1");
    // grow segment: lagfun before crop, over [100,401)
    expect(filtergraph).toContain("[B0]trim=start_frame=100:end_frame=401");
    expect(filtergraph).toContain("lagfun=decay=1");
    // retract segment: downscale, reverse, lagfun, reverse, then a moving crop
    expect(filtergraph).toContain("reverse,lagfun=decay=1,reverse,crop=3840:2160:");
    expect(filtergraph).toContain("[D0]trim=start_frame=401");
    expect(args).toContain("-filter_complex");
    // C adds (end-start+1)=301 frames to the clip
    expect(outputFrames).toBe(787 + 301);
  });

  it("comet (decay<1) wind-down dissolves via blend, not reverse-erosion", () => {
    const { filtergraph, args, outputFrames } = buildFfmpeg(
      canonicalProject({
        post: { starTrail: { decay: 0.95, startFrame: 100, endFrame: 400 } },
      }),
    );
    // crossfade comet stream into plain — no reverse (which would flip the comet)
    expect(filtergraph).toContain("blend=all_expr=");
    expect(filtergraph).not.toContain("reverse");
    expect(filtergraph).toContain("lagfun=decay=0.95");
    expect(args).toContain("-filter_complex");
    expect(outputFrames).toBe(787); // no added frames
  });

  it("omits the A segment when the trail retracts but starts at frame 0", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({
        post: { starTrail: { decay: 1, startFrame: 0, endFrame: 400 } },
      }),
    );
    expect(filtergraph).toContain("split=3"); // B, C, D only
    expect(filtergraph).not.toContain("[A0]");
  });

  it("clamps star-trail decay to 0..1", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { starTrail: { decay: 5 } } }),
    );
    expect(filtergraph.startsWith("lagfun=decay=1,")).toBe(true);
  });

  it("renders animated zoom via a bounding crop + zoompan (single sub-pixel sample)", () => {
    const p = canonicalProject({
      keyframes: [
        { frame: 0, x: 0, y: 944, w: 7752, h: 4360, easing: "linear" },
        { frame: 786, x: 1376, y: 1724, w: 5000, h: 2812, easing: "linear" },
      ],
    });
    const { filtergraph } = buildFfmpeg(p);
    // constant bounding crop (union of the windows), then zoompan to the output
    expect(filtergraph).toContain("crop=7752:4360:0:944");
    expect(filtergraph).toContain("zoompan=");
    expect(filtergraph).toContain("s=3840x2160");
    // zoom expressions are parameterized on the output frame index `on`
    expect(filtergraph).toContain("on");
  });

  it("still rejects zoom combined with star trails", () => {
    const p = canonicalProject({
      keyframes: [
        { frame: 0, x: 0, y: 944, w: 7752, h: 4360, easing: "linear" },
        { frame: 786, x: 1376, y: 1724, w: 5000, h: 2812, easing: "linear" },
      ],
      post: { starTrail: { decay: 1 } },
    });
    expect(() => buildFfmpeg(p)).toThrow(ZoomNotSupportedError);
  });

  it("preview mode: low-res + fast preset, no decimation, full frame rate", () => {
    const { filtergraph, args, outputFrames } = buildFfmpeg(
      canonicalProject({ post: { starTrail: { decay: 1 } } }),
      { preview: { width: 1920 } },
    );
    // 1920 wide at 16:9 -> 1080 tall, sharper lanczos scaling
    expect(filtergraph).toContain("scale=1920:1080:flags=lanczos");
    expect(filtergraph).toContain("lagfun=decay=1"); // trails before crop
    // preview supersamples horizontally (x4) for a smooth sub-pixel pan
    expect(filtergraph).toContain("scale=iw*4:ih:flags=bilinear");
    expect(filtergraph).toContain("crop=31008:4360:"); // 7752 * 4
    expect(filtergraph).not.toContain("select="); // no decimation — plays full rate
    expect(args).toContain("veryfast");
    expect(args).toContain("20"); // crf
    expect(outputFrames).toBe(787); // every frame
  });

  it("panSupersample enables sub-pixel pan on the full render", () => {
    const off = buildFfmpeg(canonicalProject());
    expect(off.filtergraph).not.toContain("scale=iw*"); // default: integer crop
    expect(off.filtergraph.startsWith("crop=7752:4360:")).toBe(true);

    const on = buildFfmpeg(canonicalProject(), { panSupersample: 4 });
    expect(on.filtergraph).toContain("scale=iw*4:ih:flags=bilinear");
    expect(on.filtergraph).toContain("crop=31008:4360:"); // 7752 * 4
    expect(on.filtergraph).toContain("scale=3840:2160:flags=lanczos"); // back to 4K
  });

  it("preview drops denoise for speed", () => {
    const { filtergraph } = buildFfmpeg(
      canonicalProject({ post: { denoise: { filter: "hqdn3d", strength: 0.5 } } }),
      { preview: { width: 1920 } },
    );
    expect(filtergraph).not.toContain("hqdn3d");
  });

  it("requires at least two keyframes", () => {
    const p = canonicalProject({
      keyframes: [{ frame: 0, x: 0, y: 944, w: 7752, h: 4360, easing: "linear" }],
    });
    expect(() => buildFfmpeg(p)).toThrow();
  });
});

describe("buildProxyCommand", () => {
  it("downscales the whole sequence to numbered JPEGs in one pass", () => {
    const args = buildProxyCommand(
      "/src/tl2/",
      "*.jpg",
      "/tmp/cache/",
      1280,
    );
    expect(args).toContain("/src/tl2/*.jpg");
    expect(args).toContain("/tmp/cache/frame_%05d.jpg");
    expect(args).toContain("scale=1280:-1:flags=bilinear");
    expect(args).not.toContain("libx264"); // image output, no video encode
  });
});

describe("denoiseFilter", () => {
  it("maps strength 0.5 to the validated presets", () => {
    expect(denoiseFilter({ filter: "hqdn3d", strength: 0.5 })).toBe("hqdn3d=4:3:6:0");
    expect(denoiseFilter({ filter: "fftdnoiz", strength: 0.5 })).toBe("fftdnoiz=sigma=4");
  });
  it("clamps strength to 0..1", () => {
    expect(denoiseFilter({ filter: "fftdnoiz", strength: 5 })).toBe("fftdnoiz=sigma=8");
    expect(denoiseFilter({ filter: "fftdnoiz", strength: -1 })).toBe("fftdnoiz=sigma=0");
  });
});

describe("windowAtFrame", () => {
  const kf = canonicalProject().keyframes;

  it("holds endpoints outside the keyframed range", () => {
    expect(windowAtFrame(kf, -10).x).toBe(0);
    expect(windowAtFrame(kf, 9999).x).toBe(200);
  });

  it("interpolates linearly between keyframes", () => {
    expect(windowAtFrame(kf, 393).x).toBeCloseTo(100, 5); // halfway
    expect(windowAtFrame(kf, 393).y).toBe(944); // constant
  });

  it("applies easeInOut (smoothstep) to the destination keyframe", () => {
    const eased = [
      { frame: 0, x: 0, y: 0, w: 100, h: 100, easing: "linear" as const },
      { frame: 100, x: 200, y: 0, w: 100, h: 100, easing: "easeInOut" as const },
    ];
    // smoothstep(0.25) = 0.25^2 * (3 - 0.5) = 0.15625 -> x = 200 * 0.15625
    expect(windowAtFrame(eased, 25).x).toBeCloseTo(31.25, 4);
    // symmetric: midpoint is still 0.5
    expect(windowAtFrame(eased, 50).x).toBeCloseTo(100, 4);
  });
});

describe("ease", () => {
  it("clamps and shapes correctly", () => {
    expect(ease(-1, "linear")).toBe(0);
    expect(ease(2, "linear")).toBe(1);
    expect(ease(0.5, "easeInOut")).toBeCloseTo(0.5, 5);
    expect(ease(0, "easeInOut")).toBe(0);
    expect(ease(1, "easeInOut")).toBe(1);
  });
});

describe("hasZoom", () => {
  it("detects constant vs changing window size", () => {
    expect(hasZoom(canonicalProject().keyframes)).toBe(false);
    expect(
      hasZoom([
        { frame: 0, x: 0, y: 0, w: 100, h: 100, easing: "linear" },
        { frame: 10, x: 0, y: 0, w: 50, h: 50, easing: "linear" },
      ]),
    ).toBe(true);
  });
});

describe("resolveFfmpeg", () => {
  it("prefers a configured path, falls back to PATH lookup", () => {
    expect(resolveFfmpeg("/opt/homebrew/bin/ffmpeg")).toBe("/opt/homebrew/bin/ffmpeg");
    expect(resolveFfmpeg("  ")).toBe("ffmpeg");
    expect(resolveFfmpeg(null)).toBe("ffmpeg");
    expect(resolveFfprobe(undefined)).toBe("ffprobe");
  });
});
