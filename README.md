<div align="center">

# calLMAOut

### a chrome extension to catch when you type LMAO with a straight face. whenever you "laugh", it sends a photo of how you're actually reacting. if you go too far, you might owe the chat an apology.,,

</div>

<div align="center">
<div style="display: flex; justify-content: center; align-items: center; gap: 20px;">
    <img src="images/calLMAOut.gif" alt"demo gif 1" width="300"/>
    <img src="images/calLMAOut-2.gif" alt="demo gif 2" width="300"/>
</div>
</div>


## install
```bash
npm install
npm run build
```
**or download the latest build from [the website](https://callmaout.andrewd.ai/)!**

1. open `chrome://extensions`, turn on developer mode
2. click **load unpacked** and pick either your unzipped folder from the website or `dist/` from your build
3. the settings page opens on install. allow the camera there once, pick a webcam
4. (optionally) paste a TypeSafe API key so Jev can catch laughs the local matcher misses

<sup>(don't forget to reload your chat tabs to apply the extension!)</sup>

## how it works
in short: Jev detects whether your message is supposed to express laughter or not, a custom-trained CV model asks whether or not you're actually laughing, and then a facial recognition model puts stickers around your face and turns you into a hilarious GIF.

<sup>(faces are checked locally, your data is never sent for processing elsewhere (besides anything uploaded to social media, obviously)</sup>

### pipeline
- `src/content.ts` watches enter and send clicks in every text box. if the message was a laugh and the site cleared the box (i.e. actually sent it), it pastes the GIF into the box and sends it (with configurable delay).
- `src/lib/detect.ts` holds the instant local laugh matcher. anything it doesn't match by regex goes to [Jev](https://docs.typesafe.ai) as a yes/no question.
- `src/offscreen.ts` owns the camera, so the camera permission is granted once instead of on every site.
  - while enabled, `src/offscreen.ts` continuously prepares one GIF at a time by capturing the user's face and applying modifications
    - `src/lib/face.ts` decides where labels and stickers can go, and animations are applied afterwards
- sending a GIF pulls the latest completed GIF, prioritizing a remembered smile when that setting is on (i.e., if you just smiled, count that one)

### apology videos
after too many times caught "laughing" with a straight face (configurable under **apology** in settings; 0 turns it off), you won't be allowed to chat until you submit a 5-second apology video.

- each camera frame is drawn once and JPEG-encoded off the main thread, and the microphone's samples are copied as they arrive
- once recording ends, in one pass:
  - MediaPipe HandLandmarker (`public/models/hand_landmarker.task`) runs on the MediaPipe WASM runtime already used for face detection, in video tracking mode, on a 320 px copy of every 2nd frame. a ukelele appears in and follows your hands to give your apology a touch of musical talent
  - `src/lib/apology-music.ts` preloads the first five seconds of `public/ukelele.mp3`, resamples it to the microphone rate, and caches its dominant pitch classes. `src/lib/ukulele-audio.ts` hard-snaps the voice to those notes to create a homemade "vocoding" effect in the nearest vocal octave using TD-PSOLA (time-domain pitch-synchronous overlap-and-add)
  - frames go to the browser's (usually hardware) video encoder through WebCodecs, and [Mediabunny](https://mediabunny.dev) writes the MP4

`src/lib/apology-recorder.ts` records in the offscreen page, and `src/lib/apology-modal.ts` is the modal in the chat page. Run `npm run test:apology-audio` to check pitch matching, mixing, timing, and clipping (requires FFmpeg to decode the bundled MP3).

### smile model

`public/models/smile.onnx` is trained on the [FEI Face Database](https://fei.edu.br/~cet/facedatabase.html): 200 people, each photographed neutral and smiling. FEI has no "laughing" label, so the model detects smiling. Cross-validated accuracy on people it never saw is in `public/models/smile.json` (93.8% at last training).

webcam photos and training images go through the same normalization, defined in `src/lib/face-spec.json`: eyes placed at fixed positions in a 64×64 crop, grayscale, histogram-equalized, standardized.

to retrain (needs [uv](https://docs.astral.sh/uv/); downloads FEI into the gitignored `data/`):

```bash
npm run train
npm run build
```

The FEI Face Database is for research use only and may not be redistributed. Please cite: C. E. Thomaz and G. A. Giraldi, "A new ranking method for Principal Components Analysis and its application to face image analysis", *Image and Vision Computing*, 28(6), 2010.

## contributing
as a developer, i likely won't be actively maintaining this project myself unless something big happens with it, as it was designed to be a fun one-off hackathon project. however, feel free to contribute or do whatever you like with the code, if there's interest in this project, i might consider returning to it :)
