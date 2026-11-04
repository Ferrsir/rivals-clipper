import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_RATE, analyzeSamples } from '../src/main/studio/beats';
import { synthTrack } from './studio-synth';

test('finds tempo and beat grid of a steady track', () => {
  const a = analyzeSamples(synthTrack(140, 30));
  assert.ok(Math.abs(a.bpm - 140) < 1.5, `bpm ${a.bpm}`);
  const period = 60 / 140;
  // Every detected beat sits within 25 ms of the true grid.
  for (const b of a.beats) {
    const k = Math.round((b - 0.25) / period);
    assert.ok(Math.abs(b - (0.25 + k * period)) < 0.025, `beat ${b} off grid`);
  }
  assert.ok(a.beats.length > 60, `only ${a.beats.length} beats`);
});

test('handles slower tempos without halving or doubling', () => {
  const a = analyzeSamples(synthTrack(96, 30));
  assert.ok(Math.abs(a.bpm - 96) < 1.5, `bpm ${a.bpm}`);
});

test('finds the drop where the bass comes in', () => {
  const bpm = 128;
  const quietBars = 8;
  const a = analyzeSamples(synthTrack(bpm, 40, { quietBars }));
  const dropTrue = 0.25 + quietBars * 4 * (60 / bpm);
  assert.ok(a.drops.length >= 1, 'no drop found');
  assert.ok(Math.abs(a.drops[0] - dropTrue) < 0.1, `drop ${a.drops[0]} vs ${dropTrue}`);
  // The drop is a downbeat.
  assert.ok(a.downbeats.some((d) => Math.abs(d - a.drops[0]) < 0.01));
});

test('gives sane output for silence', () => {
  const a = analyzeSamples(new Float32Array(ANALYSIS_RATE * 5));
  assert.equal(a.drops.length, 0);
  assert.ok(a.energy < 0.05);
});
