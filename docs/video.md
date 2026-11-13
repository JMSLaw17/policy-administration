# Making the submission video

`npm run video` records the demo from [video-script.md](video-script.md) on the deployed app and produces a finished video with narration and captions: `video-output/demo.mp4`. Everything it uses is free.

## Before the first run

1. Install ffmpeg: `brew install ffmpeg`.
2. Install Playwright's video recorder: `npx playwright install ffmpeg`.

## Make the video

```
npm run video
```

The command does five things:

1. It reads each line in [video/narration.ts](../video/narration.ts) aloud with Kokoro and times it. Kokoro is a free, open-source AI voice that runs on your Mac. The first run installs it into `video-output/tts-engine` and downloads its voice model from Hugging Face, about 90 MB. After that, only lines whose wording changed are read again.
2. It signs in to https://policy-administration.vercel.app as the broker and follows the video script: Customers, Acme Bakery's page and its DocuSign-signed policy, **Load demo scenario**, the correction and its preview, the policyholder paying $14.00 by Stripe test card, the second correction and its refund, and the Integration log.
3. It shows each screen for as long as its line takes to say. It draws a cursor, scrolls smoothly and types visibly, and it cuts out the waits for Stripe and for pages to load.
4. It joins the clips, adds the voice, and puts the captions in a band under the picture.
5. It prints the video's length and warns if it runs over five minutes.

It changes data on the deployed site, just as `npm run evidence:screenshots` does. Each run makes one new demo customer with real Stripe test payments and a refund. Run it as often as you like.

`npm run video:assemble` rebuilds `demo.mp4` from the last recording without recording again, for example after changing caption settings.

## Settings

| Setting | What it does |
|---|---|
| `VIDEO_KOKORO_VOICE=am_michael` | Picks the Kokoro voice. The default is `af_heart` (American, female). Others include `af_bella`, `am_michael`, `am_fenrir`, `bf_emma` and `bm_george` (British). |
| `VIDEO_KOKORO_SPEED=1.1` | Makes Kokoro speak faster or slower (default 1). |
| `VIDEO_TTS=say` | Uses the Mac's built-in voice instead of Kokoro. The next two settings apply only to it. |
| `VIDEO_VOICE="Allison (Enhanced)"` | Picks the Mac voice. `say -v '?'` lists the voices. Better voices can be downloaded for free in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. If this is left out, the system voice is used. |
| `VIDEO_RATE=200` | Sets the Mac voice's speed in words per minute (default 185). |
| `VIDEO_NARRATION=captions` | Leaves out the voice and shows captions only. Each caption is held long enough to read. |
| `VIDEO_CAPTIONS=soft` / `off` | Adds the captions as a track viewers can switch on, or leaves them out. The default, `burn`, draws them under the picture. `captions.srt` is written either way. |
| `VIDEO_PARTS=intro,issuing` | Records only some parts (`intro`, `issuing`, `scenario`, `integrations`, `closing`). Use it to try out a change quickly. The `scenario` part also covers the policyholder's payment and the refund. |
| `VIDEO_SIGNED_POLICY=SBP-2026-0002` | Sets which of Acme's policies to show as signed through DocuSign. If the policy isn't on Acme's page, that line is skipped. |
| `DEPLOYED_URL=http://localhost:3100` | Records against a dev server instead of the deployed site. |

## Using your own voice

Record each line as `video/voice/<id>.m4a`, where `<id>` is the line's name in `video/narration.ts`, such as `intro.m4a` or `correct-preview.m4a`. `.wav`, `.aiff` and `.mp3` files work too. QuickTime's **File → New Audio Recording** works for this. The next `npm run video` uses your recordings in place of the computer voice and paces the video to them. Any line you haven't recorded still uses Kokoro. The `video/voice` folder is git-ignored.

You can also record over the finished video in iMovie. `video-output/narration.txt` lists every line with the time it starts.

## What it leaves out

- **Signing in DocuSign.** DocuSign's signing page can't be automated, so the video shows a policy that was already signed, as the script does.
- **The signed PDF.** It opens in a separate viewer the recording can't capture. The video points at the **View signed application** link instead.
- **Stripe's and DocuSign's own dashboards** (optional in part 5). They need your own logins. If you want them in the video, record them by hand and add them in iMovie.

## If something goes wrong

- **A step fails.** The run stops with the step that failed and a screenshot in `test-results/video`. Run it again: every run starts from a fresh demo scenario.
- **The video runs over five minutes.** Shorten lines in `video/narration.ts`, or raise `VIDEO_RATE`.
- **Kokoro fails to download its model.** Check the internet connection and run again, or use `VIDEO_TTS=say`.
- **The voice doesn't sound right.** Try another `VIDEO_KOKORO_VOICE`, or use your own recordings. `npm run video:voice` makes only the voice files, so you can listen to them in `video-output/kokoro/` before recording.

## Files

- `video/narration.ts`: what is said, line by line.
- `video/record.spec.ts`: what happens on screen for each line.
- `scripts/video-voice.mjs`: makes the Kokoro voice files.
- `video/director.ts`: the cursor, scrolling, timing and voice.
- `scripts/video-assemble.mjs`: joins everything with ffmpeg.
- `video-output/`: the result (git-ignored). It holds `demo.mp4`, `captions.srt`, `narration.txt`, the raw recordings and `timeline.json`.
