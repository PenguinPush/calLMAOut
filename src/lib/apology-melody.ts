// The tune the apology voice is forced onto. An original placeholder: a short, overwrought
// "please forgive me" phrase that loops for the length of the video. Swap in your own melody
// by editing the notes; each entry is [MIDI note, length in beats], and null is a rest.
export const MELODY: { bpm: number; notes: [number | null, number][] } = {
  bpm: 96,
  notes: [
    [67, 0.5], [69, 0.5], [71, 1], [69, 0.5], [67, 0.5], [64, 1],
    [62, 0.5], [64, 0.5], [67, 1.5], [null, 0.5],
    [72, 1], [71, 0.5], [69, 0.5], [67, 1], [64, 0.5], [62, 0.5],
    [60, 2],
  ],
};

/** The MIDI note playing at `seconds` (the melody loops), or null during a rest. */
export function noteAt(seconds: number) {
  const beat = (seconds * MELODY.bpm) / 60;
  const length = MELODY.notes.reduce((sum, [, beats]) => sum + beats, 0);
  let at = beat % length;
  for (const [note, beats] of MELODY.notes) {
    if (at < beats) return note;
    at -= beats;
  }
  return null;
}
