#!/usr/bin/env node
/**
 * Reads the video's narration (video/narration.ts) aloud with Kokoro, a free,
 * open-source AI voice that runs on this computer, and saves one file per
 * line in video-output/kokoro/. `npm run video` runs this first and then
 * paces the recording to these files.
 *
 * The first run installs Kokoro into video-output/tts-engine (git-ignored)
 * and downloads its voice model from Hugging Face, about 90 MB. Later runs
 * only redo lines whose wording or voice changed.
 *
 *   VIDEO_KOKORO_VOICE=am_michael   another voice (default af_heart)
 *   VIDEO_KOKORO_SPEED=1.1          faster or slower speech (default 1)
 *   VIDEO_TTS=say                   skip this and use the Mac's own voice instead
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if ((process.env.VIDEO_TTS ?? "kokoro") !== "kokoro" || process.env.VIDEO_NARRATION === "captions") process.exit(0);

const KOKORO = "kokoro-js@1.2.1";
const engine = path.resolve("video-output", "tts-engine");
const out = path.resolve("video-output", "kokoro");
const voice = process.env.VIDEO_KOKORO_VOICE ?? "af_heart";
const speed = Number(process.env.VIDEO_KOKORO_SPEED ?? "1");

const { NARRATION } = await import(pathToFileURL(path.resolve("video", "narration.ts")).href);

fs.mkdirSync(out, { recursive: true });
const manifestFile = path.join(out, "manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
const todo = Object.entries(NARRATION).filter(([id, text]) => {
  const done = manifest[id];
  return !(done && done.text === text && done.voice === voice && done.speed === speed && fs.existsSync(path.join(out, `${id}.wav`)));
});
if (todo.length === 0) {
  console.log(`Kokoro voice (${voice}): all ${Object.keys(NARRATION).length} lines are ready.`);
  process.exit(0);
}

const entry = path.join(engine, "node_modules", "kokoro-js", "dist", "kokoro.js");
if (!fs.existsSync(entry)) {
  console.log("Installing the Kokoro voice. This happens once and can take a few minutes.");
  fs.mkdirSync(engine, { recursive: true });
  if (!fs.existsSync(path.join(engine, "package.json"))) fs.writeFileSync(path.join(engine, "package.json"), '{ "private": true }\n');
  execFileSync("npm", ["install", "--prefix", engine, "--no-audit", "--no-fund", "--loglevel", "error", KOKORO], { stdio: "inherit" });
}
const { KokoroTTS } = await import(pathToFileURL(entry).href);
let tts;
try {
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
} catch (error) {
  console.error(`Couldn't load Kokoro's voice model from Hugging Face: ${error.message}`);
  console.error("Check the internet connection and run again, or use the Mac's voice with VIDEO_TTS=say.");
  process.exit(1);
}

for (const [i, [id, text]] of todo.entries()) {
  process.stdout.write(`Kokoro voice (${voice}): line ${i + 1} of ${todo.length}, ${id}\n`);
  const audio = await tts.generate(text, { voice, speed });
  await audio.save(path.join(out, `${id}.wav`));
  manifest[id] = { text, voice, speed };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
}
