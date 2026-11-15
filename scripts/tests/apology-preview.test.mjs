import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const peers = [];
class FakePeer {
  remoteDescription = null;
  connectionState = 'new';
  tracks = [];
  candidates = [];
  constructor(config) { assert.deepEqual(config.iceServers, []); peers.push(this); }
  addTransceiver(track, options) { this.tracks.push({ track, options }); }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(description) {
    this.localDescription = { ...description, toJSON: () => description };
    // Deliberately deliver ICE before the description to test buffering.
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local-host' }) } });
  }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate(candidate) {
    assert.ok(this.remoteDescription, 'must set remote description before ICE');
    this.candidates.push(candidate);
  }
  close() { this.connectionState = 'closed'; }
}
globalThis.RTCPeerConnection = FakePeer;
const source = await readFile(new URL('../../src/lib/apology-preview.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ApologyPreview } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const errors = [];
const jobs = [];
let stopped = false;
const track = { kind: 'video', stop() { stopped = true; } };
const stream = { getVideoTracks: () => [track] };
let displayed;
const sender = new ApologyPreview((signal) => jobs.push(receiver.receive(signal)), (e) => errors.push(e));
const receiver = new ApologyPreview((signal) => jobs.push(sender.receive(signal)), (e) => errors.push(e), (value) => { displayed = value; });
try {
  await sender.offer(stream);
  // Answer delivery adds more async signaling work while the offer drains.
  for (let i = 0; i < 5; i++) await Promise.all(jobs);
  assert.equal(peers[0].remoteDescription.type, 'answer');
  assert.equal(peers[1].remoteDescription.type, 'offer');
  assert.equal(peers[0].candidates.length, 1);
  assert.equal(peers[1].candidates.length, 1);
  assert.equal(peers[0].tracks.length, 1);
  assert.equal(peers[0].tracks[0].track, track);
  assert.equal(peers[0].tracks[0].options.direction, 'sendonly');
  peers[1].ontrack({ track, streams: [stream] });
  assert.equal(displayed, stream, 'native video receives the camera stream');
  assert.deepEqual(errors, []);
  receiver.close();
  const count = peers[1].candidates.length;
  await receiver.receive({ candidate: { candidate: 'late' } });
  assert.equal(peers[1].candidates.length, count, 'ignore stale signals after retry/disconnect');
} finally {
  sender.close();
  receiver.close();
}
assert.equal(stopped, false, 'closing preview must not stop the recording camera');
assert.ok(peers.every((peer) => peer.connectionState === 'closed'));
console.log('Preview signaling, early ICE buffering, shared webcam track, and cleanup checks passed.');
