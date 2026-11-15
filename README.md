# calLMAOut

A Chrome extension that notices when you laugh in a chat ("lmao", "HAHAHA", "💀", "i'm crying", keyboard mashes…) and sends a prepared webcam GIF of your face after your message.

## Install

```bash
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `dist/`. The settings page opens on install. Allow the camera there once, pick a webcam, and optionally paste a TypeSafe API key so Jev can catch laughs the local matcher misses. Reload any chat tabs that were already open.

The settings page also has a troubleshooter (**Run checks**) and a live **Activity** log of every step.

## How it works

- `src/content.ts` watches Enter and Send clicks in every text box. If the message was a laugh and the site cleared the box (i.e. actually sent it), it pastes the photo into the box and sends it.
- `src/lib/detect.ts` holds the instant local laugh matcher. Anything it doesn't match goes to [Jev](https://docs.typesafe.ai) as a yes/no question.
- `src/offscreen.ts` owns the camera, so the camera permission is granted once instead of on every site.
- While enabled, `src/offscreen.ts` continuously prepares one GIF at a time. `src/lib/face.ts` scores clean camera pixels, then labels and stickers are applied to a separate output canvas.
- A worker encodes a 480-pixel-maximum GIF: a random entrance, a 2-second still hold, and a different random exit. Effects include cube turn, shatter, 3D bounce, and origami crane. Animation backgrounds are transparent. Transition maps are cached, the color palette is sampled once per photo, and animation frames reuse indexed pixels.
- Sending reads the latest completed GIF, prioritizing a remembered smile when that setting is on. Smile memory lasts 3 seconds by default (configurable in settings) and typing extends it. Enter consumes/forgets it; otherwise the latest prepared photo is used. New photos are prepared at the encoder's pace, with no growing frame queue.
- The first GIF after startup or a camera/settings change must finish before it can be sent. Cache hits skip capture, computer vision, decoration, and encoding; messaging and the chat site's upload still take time. The camera stays on while the extension is enabled and stops when disabled.
- Settings shows the actual ready-to-send GIF, its age, effect, and preparation time. Outgoing attachments use `.gif` and `image/gif`; animation playback depends on the receiving site.

Run `npm run test:gif` to check cache priority/invalidation and independently decode all four generated transitions. The test requires Python with Pillow in addition to Node.

## Apology videos

A laugh sent with a straight face is a strike, and sending a message while a smile is active resets the count. After 3 strikes in a row (configurable under **Apology** in settings; 0 turns it off), a modal covers the chat until you record a 5-second apology video. The page behind it is dimmed and can't be clicked, scrolled or typed in. The video is then sent in that chat. The microphone has to be allowed once in settings.

The video's first frame is left untouched, so its thumbnail looks sincere. After that, the voice is hard-autotuned to the opening of `public/ukelele.mp3`, mixed underneath as the backing track and an ukulele (`public/photos/apology-ukelele.png`) covers your hands.

Recording and processing are separate steps, so the recorded framerate stays smooth:

- **Recording:** each camera frame is drawn once and JPEG-encoded off the main thread, and the microphone's samples are copied as they arrive. Nothing else runs per frame.
- **Processing**, once recording ends, in one pass:
  - **Hands:** MediaPipe HandLandmarker (`public/models/hand_landmarker.task`) runs on the MediaPipe WASM runtime already used for face detection, in VIDEO tracking mode, on a 320 px copy of every 2nd frame. When no hands are visible, the ukulele sits at chest height below the face.
  - **Voice and backing:** no vocoder or synthesized carrier. `src/lib/apology-music.ts` preloads the first five seconds of `public/ukelele.mp3`, resamples it to the microphone rate, and caches its dominant pitch classes. `src/lib/ukulele-audio.ts` hard-snaps the voice to those notes in the nearest vocal octave using TD-PSOLA, with no dry vocal blend. The music plays underneath with headroom and short edge fades. It never plays during recording, so it cannot leak into the microphone.
  - **Encoding:** frames go to the browser's (usually hardware) video encoder through WebCodecs, and [Mediabunny](https://mediabunny.dev) writes the MP4.

The modal displays the existing webcam track in a native muted video element over a local WebRTC connection with no external signaling or relay servers. Extension messages carry setup signals, not JPEG preview frames.

`src/lib/apology-recorder.ts` records in the offscreen page, and `src/lib/apology-modal.ts` is the modal in the chat page. Run `npm run test:apology-audio` to check pitch matching, mixing, timing, and clipping (requires FFmpeg to decode the bundled MP3).

## Smile model

`public/models/smile.onnx` is trained on the [FEI Face Database](https://fei.edu.br/~cet/facedatabase.html): 200 people, each photographed neutral and smiling. FEI has no "laughing" label, so the model detects smiling. Cross-validated accuracy on people it never saw is in `public/models/smile.json` (93.8% at last training).

Webcam photos and training images go through the same normalization, defined in `src/lib/face-spec.json`: eyes placed at fixed positions in a 64×64 crop, grayscale, histogram-equalized, standardized.

To retrain (needs [uv](https://docs.astral.sh/uv/); downloads FEI into the gitignored `data/`):

```bash
npm run train
npm run build
```

The FEI Face Database is for research use only and may not be redistributed. Please cite: C. E. Thomaz and G. A. Giraldi, "A new ranking method for Principal Components Analysis and its application to face image analysis", *Image and Vision Computing*, 28(6), 2010.
