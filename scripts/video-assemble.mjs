#!/usr/bin/env node
/**
 * Puts the submission video together from what `npm run video` recorded:
 * the filmed stretches of each browser window, joined in order, with each
 * narration line placed where it was said, and captions.
 *
 *   npm run video:assemble        rebuild video-output/demo.mp4 without recording again
 *
 * VIDEO_CAPTIONS=burn (default) draws captions in a band under the picture, =soft adds
 * them as a track the viewer can switch on, =off leaves them out. A
 * captions.srt file is written either way.
 *
 * Uses ffmpeg, which is free (`brew install ffmpeg`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("video-output");
const timelineFile = path.join(OUT, "timeline.json");
if (!fs.existsSync(timelineFile)) {
  console.error("Nothing recorded yet. Run `npm run video` first.");
  process.exit(1);
}
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error) {
  console.error("This needs ffmpeg, which is free. Install it with `brew install ffmpeg` and run again.");
  process.exit(1);
}
const { size, videos, segments: filmed, beats } = JSON.parse(fs.readFileSync(timelineFile, "utf8"));

// Where each filmed stretch sits in its window's video. Playwright stamps each
// video with the moment it started recording, to the millisecond.
const videoStart = {};
for (const [role, v] of Object.entries(videos)) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=creation_time", "-of", "csv=p=0", v.file], { encoding: "utf8" });
  const stamped = Date.parse(r.stdout.trim());
  videoStart[role] = Number.isFinite(stamped) ? stamped : v.startedAt;
}
const segments = filmed.map((s) => ({
  file: videos[s.role].file,
  from: Math.max(0, (s.from - videoStart[s.role]) / 1000),
  seconds: (s.to - s.from) / 1000,
}));
const filmSeconds = segments.reduce((sum, s) => sum + s.seconds, 0);

// Captions: each line split into short pieces, timed in proportion to their length.
const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
const pieces = (text) => {
  const out = [];
  for (const sentence of text.match(/[^.!?]+[.!?]?/g) ?? [text]) {
    // A long sentence is split into lines of about equal length, at word breaks.
    const words = sentence.trim().split(/\s+/);
    const count = Math.ceil(sentence.trim().length / 80);
    const per = Math.ceil(words.length / count);
    for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
  }
  return out;
};
let srt = "";
let n = 0;
for (const beat of beats) {
  const parts = pieces(beat.text);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  let t = beat.at;
  for (const p of parts) {
    const d = (beat.seconds * p.length) / total;
    srt += `${++n}\n${stamp(t)} --> ${stamp(Math.min(t + d, filmSeconds))}\n${p}\n\n`;
    t += d;
  }
}
fs.writeFileSync(path.join(OUT, "captions.srt"), srt);

// A plain list of the lines and when each starts, for recording your own voice over the video.
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
fs.writeFileSync(
  path.join(OUT, "narration.txt"),
  beats.map((b) => `${clock(b.at)}  [${b.id}]  ${b.text}`).join("\n\n") + "\n",
);

// What this copy of ffmpeg can do. Homebrew's build has changed what it includes over time.
const filters = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
let captions = process.env.VIDEO_CAPTIONS ?? "burn";
if (captions === "burn" && !/\ssubtitles\s/.test(filters)) {
  console.warn("This ffmpeg can't draw captions into the picture, so they're added as a track viewers can switch on.");
  captions = "soft";
}
const video = /\slibx264\s/.test(encoders)
  ? ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
  : /\sh264_videotoolbox\s/.test(encoders)
    ? ["-c:v", "h264_videotoolbox", "-b:v", "5M", "-pix_fmt", "yuv420p"]
    : ["-c:v", "mpeg4", "-q:v", "3"];

/** Height of the caption band added under the picture, in pixels. */
const BAND = 80;

const args = ["-hide_banner", "-loglevel", "error", "-y"];
const graph = [];
segments.forEach((s, i) => {
  args.push("-ss", s.from.toFixed(3), "-t", s.seconds.toFixed(3), "-i", s.file);
  graph.push(`[${i}:v]fps=25,scale=${size.width}:${size.height},setsar=1[s${i}]`);
});
graph.push(`${segments.map((_, i) => `[s${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[film]`);
if (captions === "burn") {
  // Captions go in a dark band under the picture, so they never cover the app.
  const style = "FontName=Helvetica,FontSize=10,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,MarginV=9";
  graph.push(`[film]pad=${size.width}:${size.height + BAND}:0:0:color=0x0f172a,subtitles=captions.srt:force_style='${style}'[v]`);
} else graph.push("[film]null[v]");

const voiced = beats.filter((b) => b.audio);
voiced.forEach((b, k) => {
  args.push("-i", b.audio);
  const ms = Math.round(b.at * 1000);
  graph.push(`[${segments.length + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${k}]`);
});
if (voiced.length) {
  graph.push(`${voiced.map((_, k) => `[a${k}]`).join("")}amix=inputs=${voiced.length}:normalize=0:duration=longest[aud]`);
}
if (captions === "soft") args.push("-i", "captions.srt");

args.push("-filter_complex", graph.join(";"), "-map", "[v]");
if (voiced.length) args.push("-map", "[aud]", "-c:a", "aac", "-b:a", "160k");
if (captions === "soft") args.push("-map", `${segments.length + voiced.length}:s`, "-c:s", "mov_text", "-metadata:s:s:0", "language=eng");
args.push(...video, "-movflags", "+faststart", "-t", filmSeconds.toFixed(3), "demo.mp4");

const result = spawnSync("ffmpeg", args, { cwd: OUT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

const voice = voiced.length ? `${voiced.length} of ${beats.length} lines voiced` : `${beats.length} lines, no voice (captions only)`;
console.log(`Made video-output/demo.mp4: ${clock(filmSeconds)} long, ${voice}, captions ${captions === "off" ? "off" : captions === "soft" ? "as a track" : "in a band under the picture"}.`);
console.log("Also wrote captions.srt and narration.txt (each line with its start time) beside it.");
if (filmSeconds > 300) {
  console.warn("It's longer than five minutes. Shorten lines in video/narration.ts, or speed the voice up with VIDEO_RATE (default 185).");
}
