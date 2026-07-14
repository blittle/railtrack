import { useRef } from "react";

interface Props {
  frameCount: number;
  fps: number;
  playhead: number;
  onPlayhead: (v: number) => void;
  playing: boolean;
  onPlay: (v: boolean) => void;
  fadeInSec: number;
  fadeOutSec: number;
  onFadeIn: (sec: number) => void;
  onFadeOut: (sec: number) => void;
  starTrail: boolean;
  trailStartFrac: number;
  trailEndFrac: number;
  onTrailStart: (frac: number) => void;
  onTrailEnd: (frac: number) => void;
  speedRamp: boolean;
  speedPeak: number;
  rampUpFrac: number;
  rampDownFrac: number;
  onRampUp: (frac: number) => void;
  onRampDown: (frac: number) => void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function fmt(frac: number, durS: number): string {
  const s = frac * durS;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

/** Clip timeline: scrubbable playhead + draggable fade wedges and star-trail band. */
export default function Timeline(p: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const durS = p.frameCount > 0 ? p.frameCount / p.fps : 0;
  const enabled = p.frameCount > 0;

  const fadeInFrac = durS ? clamp01(Math.min(0.49, p.fadeInSec / durS)) : 0;
  const fadeOutFrac = durS ? clamp01(Math.min(0.49, p.fadeOutSec / durS)) : 0;
  const index = Math.round(p.playhead * Math.max(0, p.frameCount - 1));

  const fracAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };

  // start a drag that reports the track fraction until pointerup (works off-track too)
  const startDrag = (onFrac: (f: number) => void) => (e: React.PointerEvent) => {
    if (!enabled) return;
    e.stopPropagation();
    e.preventDefault();
    onFrac(fracAt(e.clientX));
    const move = (ev: PointerEvent) => onFrac(fracAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handles = enabled
    ? [
        { key: "fin", frac: fadeInFrac, cls: "fade", onFrac: (f: number) => p.onFadeIn(f * durS), title: "Fade in" },
        { key: "fout", frac: 1 - fadeOutFrac, cls: "fade", onFrac: (f: number) => p.onFadeOut((1 - f) * durS), title: "Fade out" },
        ...(p.starTrail
          ? [
              { key: "ts", frac: p.trailStartFrac, cls: "trail", onFrac: (f: number) => p.onTrailStart(Math.min(f, p.trailEndFrac)), title: "Trails start" },
              { key: "te", frac: p.trailEndFrac, cls: "trail", onFrac: (f: number) => p.onTrailEnd(Math.max(f, p.trailStartFrac)), title: "Trails end" },
            ]
          : []),
        ...(p.speedRamp
          ? [
              { key: "su", frac: p.rampUpFrac, cls: "speed", onFrac: (f: number) => p.onRampUp(Math.min(f, p.rampDownFrac)), title: "Ramp up to peak speed by here" },
              { key: "sd", frac: p.rampDownFrac, cls: "speed", onFrac: (f: number) => p.onRampDown(Math.max(f, p.rampUpFrac)), title: "Start ramping down from peak here" },
            ]
          : []),
      ]
    : [];

  return (
    <div className="timeline-wrap">
      <button className="playBtn" disabled={!enabled} onClick={() => p.onPlay(!p.playing)}
              title={p.playing ? "Pause" : "Play"}>
        {p.playing ? "❚❚" : "▶"}
      </button>
      <div className="timeline-body">
        <div className="timeline" ref={trackRef} onPointerDown={startDrag(p.onPlayhead)}>
          <div className="tl-fade tl-fadeIn" style={{ width: `${fadeInFrac * 100}%` }} />
          <div className="tl-fade tl-fadeOut" style={{ width: `${fadeOutFrac * 100}%` }} />
          {p.starTrail && (
            <div
              className="tl-trail"
              style={{
                left: `${p.trailStartFrac * 100}%`,
                width: `${Math.max(0, p.trailEndFrac - p.trailStartFrac) * 100}%`,
              }}
            />
          )}
          {p.speedRamp && (
            <div
              className="tl-speed"
              style={{
                left: `${p.rampUpFrac * 100}%`,
                width: `${Math.max(0, p.rampDownFrac - p.rampUpFrac) * 100}%`,
              }}
            >
              <span className="tl-speed-badge">{p.speedPeak}×</span>
            </div>
          )}
          {handles.map((h) => (
            <div
              key={h.key}
              className={`tl-handle tl-handle-${h.cls}`}
              style={{ left: `${h.frac * 100}%` }}
              title={h.title}
              onPointerDown={startDrag(h.onFrac)}
            />
          ))}
          <div className="tl-playhead" style={{ left: `${p.playhead * 100}%` }} />
        </div>
        <div className="tl-labels muted">
          <span>frame {enabled ? index + 1 : 0}/{p.frameCount || 0}</span>
          <span>{fmt(p.playhead, durS)} / {fmt(1, durS)}</span>
        </div>
        {(p.starTrail || p.speedRamp) && (
          <div className="tl-legend muted">
            <span className="tl-leg"><i className="sw sw-fade" /> Fade</span>
            {p.starTrail && <span className="tl-leg"><i className="sw sw-trail" /> Trails</span>}
            {p.speedRamp && <span className="tl-leg"><i className="sw sw-speed" /> Speed</span>}
          </div>
        )}
      </div>
    </div>
  );
}
