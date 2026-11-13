import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/lib/demo";
import { NARRATION, type BeatId } from "./narration";

/**
 * The parts of the video recording that aren't about the app: the voice,
 * the on-screen cursor, smooth scrolling, and the timeline that
 * scripts/video-assemble.mjs turns into the finished video.
 *
 * How the timing works: each browser window records one continuous video
 * (Playwright's recordVideo). The recording script marks which stretches of
 * which window belong in the film ("segments") and when each narration line
 * starts. Waiting for Stripe or a page load happens between segments, so it
 * is cut out. Each line is held on screen for as long as it takes to say.
 */

export const OUT = "video-output";
export const SIZE = { width: 1280, height: 720 };
/** A short breath after each line before the next one starts. */
const PAUSE_MS = 500;

export type Role = "broker" | "holder";

type Line = { id: BeatId; text: string; audio: string | null; seconds: number; source: string };

const found = (cmd: string, args: string[] = ["--version"]) => {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return !r.error;
};

const audioSeconds = (file: string) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  const seconds = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isFinite(seconds)) throw new Error(`Couldn't read the length of ${file}`);
  return seconds;
};

/** Stops before recording anything if the finished video couldn't be put together. */
export function checkTools() {
  if (!found("ffmpeg", ["-version"]) || !found("ffprobe", ["-version"])) {
    throw new Error("The video needs ffmpeg, which is free. Install it with `brew install ffmpeg` and run again.");
  }
}

/**
 * Gets every narration line ready before recording starts, so the recording
 * knows how long to hold each one.
 *
 * For each line, in order of preference: your own recording in
 * video/voice/<id>.(m4a|wav|aiff|mp3); the Kokoro AI voice made by
 * scripts/video-voice.mjs, if its file matches the line's current wording;
 * the Mac's built-in `say` voice (or espeak-ng elsewhere); or no sound at all, with the line shown as a caption
 * for an estimated reading time. VIDEO_NARRATION=captions skips the voice.
 */
export function prepareNarration(): Record<BeatId, Line> {
  const dir = path.join(OUT, "narration");
  fs.mkdirSync(dir, { recursive: true });
  const captionsOnly = process.env.VIDEO_NARRATION === "captions";
  const engine = captionsOnly ? null : found("say", ["-v", "?"]) ? "say" : found("espeak-ng") ? "espeak-ng" : null;
  const kokoroDir = path.join(OUT, "kokoro");
  const kokoroFile = path.join(kokoroDir, "manifest.json");
  const kokoro: Record<string, { text: string }> =
    process.env.VIDEO_TTS === "say" || !fs.existsSync(kokoroFile) ? {} : JSON.parse(fs.readFileSync(kokoroFile, "utf8"));
  const lines = {} as Record<BeatId, Line>;
  for (const [id, text] of Object.entries(NARRATION) as [BeatId, string][]) {
    const own = ["m4a", "wav", "aiff", "mp3"].map((ext) => path.join("video", "voice", `${id}.${ext}`)).find((f) => fs.existsSync(f));
    let audio: string | null = null;
    let source = "caption only";
    if (own && !captionsOnly) {
      audio = path.resolve(own);
      source = "your recording";
    } else if (!captionsOnly && kokoro[id]?.text === text && fs.existsSync(path.join(kokoroDir, `${id}.wav`))) {
      audio = path.resolve(kokoroDir, `${id}.wav`);
      source = "kokoro";
    } else if (engine === "say") {
      audio = path.resolve(dir, `${id}.aiff`);
      const voice = process.env.VIDEO_VOICE ? ["-v", process.env.VIDEO_VOICE] : [];
      const rate = ["-r", process.env.VIDEO_RATE ?? "185"];
      run("say", [...voice, ...rate, "-o", audio, text]);
      source = "say";
    } else if (engine === "espeak-ng") {
      audio = path.resolve(dir, `${id}.wav`);
      run("espeak-ng", ["-s", process.env.VIDEO_RATE ?? "165", "-w", audio, text]);
      source = "espeak-ng";
    }
    // Without a voice, hold each caption long enough to read it comfortably.
    const seconds = audio ? audioSeconds(audio) : Math.max(2, text.split(/\s+/).length / 2.7);
    lines[id] = { id, text, audio, seconds, source };
  }
  return lines;
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.error}`);
}

/** A cursor drawn into the page, because the video can't see the real mouse. */
const CURSOR_SCRIPT = `(() => {
  if (window !== window.top) return;
  const install = () => {
    if (document.getElementById("__video-cursor")) return;
    const c = document.createElement("div");
    c.id = "__video-cursor";
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#0f172a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform";
    document.documentElement.appendChild(c);
    const place = (x, y) => {
      c.style.transform = "translate(" + (x - 5) + "px," + (y - 3) + "px)";
      try { sessionStorage.setItem("__video-cursor", JSON.stringify([x, y])); } catch {}
    };
    let start = [-50, -50];
    try { start = JSON.parse(sessionStorage.getItem("__video-cursor")) || start; } catch {}
    place(start[0], start[1]);
    window.__videoCursor = place;
    window.__videoClick = (x, y) => {
      const r = document.createElement("div");
      r.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:36px;height:36px;border-radius:50%;" +
        "border:3px solid rgba(79,70,229,.8);left:" + (x - 18) + "px;top:" + (y - 18) + "px;transition:transform .5s,opacity .5s";
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.6)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 600);
    };
    document.addEventListener("mousemove", (e) => place(e.clientX, e.clientY), true);
  };
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);
})();`;

const cursorAt = new WeakMap<Page, { x: number; y: number }>();

/** Waits until a smooth scroll has stopped moving. */
async function settle(page: Page) {
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) return;
    last = y;
    await page.waitForTimeout(120);
  }
}

/** Scrolls smoothly until the element is on screen. */
export async function scrollTo(page: Page, target: Locator, block: "start" | "center" = "center") {
  await target.waitFor();
  await target.evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b }), block);
  await settle(page);
}

/** Moves the cursor, smoothly, onto an element, scrolling to it first if it's off screen. */
export async function show(page: Page, target: Locator) {
  const from = cursorAt.get(page) ?? { x: SIZE.width / 2, y: SIZE.height / 2 };
  // Pointing at something is for the viewer's benefit, so a missing element only warns.
  // A click on it still fails properly, in click().
  if (!(await target.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
    console.warn(`  Couldn't find ${target} to point at. Carrying on.`);
    return from;
  }
  const box = await target.boundingBox();
  if (!box || box.y < 0 || box.y + box.height > SIZE.height) await scrollTo(page, target);
  const end = (await target.boundingBox())!;
  const to = { x: end.x + Math.min(end.width / 2, 60), y: end.y + end.height / 2 };
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = from.x + (to.x - from.x) * ease;
    const y = from.y + (to.y - from.y) * ease;
    await page.evaluate(([px, py]) => (window as unknown as { __videoCursor?: (x: number, y: number) => void }).__videoCursor?.(px, py), [x, y]);
    await page.waitForTimeout(16);
  }
  await page.mouse.move(to.x, to.y);
  cursorAt.set(page, to);
  return to;
}

/** Moves the cursor onto an element and clicks it, with a ripple so the click is visible. */
export async function click(page: Page, target: Locator) {
  const at = await show(page, target);
  await page.waitForTimeout(200);
  await page.evaluate(([x, y]) => (window as unknown as { __videoClick?: (x: number, y: number) => void }).__videoClick?.(x, y), [at.x, at.y]);
  await target.click();
}

/** Types into a field a letter at a time, so it reads like someone typing. */
export async function typeInto(page: Page, target: Locator, text: string) {
  await click(page, target);
  await target.fill("");
  await target.pressSequentially(text, { delay: 35 });
}

/** Holds the picture still. */
export const hold = (page: Page, ms: number) => page.waitForTimeout(ms);

/** A filmed stretch of one window, in wall-clock milliseconds. */
type Segment = { role: Role; from: number; to: number };
type Beat = { id: BeatId; text: string; audio: string | null; at: number; seconds: number };

export class Director {
  private contexts = new Map<Role, BrowserContext>();
  private pages = new Map<Role, Page>();
  private startedAt = new Map<Role, number>();
  private open: { role: Role; wall: number } | null = null;
  private cut = 0; // seconds of film in the segments already closed
  private segments: Segment[] = [];
  private beats: Beat[] = [];

  constructor(private lines: Record<BeatId, Line>) {
    fs.mkdirSync(path.join(OUT, "raw"), { recursive: true });
  }

  /** Opens a recorded browser window for one role and signs in. Signing in isn't filmed. */
  async signIn(browser: Browser, role: Role, email: string): Promise<Page> {
    const context = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: path.join(OUT, "raw", "tmp"), size: SIZE },
    });
    await context.addInitScript(CURSOR_SCRIPT);
    this.startedAt.set(role, Date.now());
    const page = await context.newPage();
    this.contexts.set(role, context);
    this.pages.set(role, page);
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    return page;
  }

  /** Starts filming one role's window. */
  start(role: Role) {
    if (this.open) this.stop();
    this.open = { role, wall: Date.now() };
  }

  /** Stops filming. Whatever happens until the next start() is cut out. */
  stop() {
    if (!this.open) return;
    const { role, wall } = this.open;
    const now = Date.now();
    this.segments.push({ role, from: wall, to: now });
    this.cut += (now - wall) / 1000;
    this.open = null;
  }

  /** Does something off camera (waiting for Stripe, reloading), then carries on filming the same window. */
  async offscreen(work: () => Promise<unknown>) {
    const role = this.open?.role;
    this.stop();
    await work();
    if (role) this.start(role);
  }

  /** Says one line while doing the steps that go with it, then holds until the line has finished. */
  async beat(id: BeatId, steps?: () => Promise<unknown>) {
    if (!this.open) throw new Error(`Line "${id}" was said while nothing was being filmed.`);
    const line = this.lines[id];
    const at = this.cut + (Date.now() - this.open.wall) / 1000;
    this.beats.push({ id, text: line.text, audio: line.audio, at, seconds: line.seconds });
    const began = Date.now();
    await steps?.();
    const left = line.seconds * 1000 + PAUSE_MS - (Date.now() - began);
    if (left > 0) await this.pages.get(this.open.role)!.waitForTimeout(left);
  }

  /** Closes the windows, saves their videos, and writes the timeline for scripts/video-assemble.mjs. */
  async finish() {
    this.stop();
    // Each video's start time, which the assembly step reads from the file itself when it can.
    const videos: Partial<Record<Role, { file: string; startedAt: number }>> = {};
    for (const [role, context] of this.contexts) {
      const video = this.pages.get(role)!.video()!;
      await context.close();
      const file = path.join(OUT, "raw", `${role}.webm`);
      await video.saveAs(file);
      await video.delete();
      videos[role] = { file: path.resolve(file), startedAt: this.startedAt.get(role)! };
    }
    fs.rmSync(path.join(OUT, "raw", "tmp"), { recursive: true, force: true });
    const timeline = { size: SIZE, videos, segments: this.segments, beats: this.beats };
    fs.writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
    return timeline;
  }
}
