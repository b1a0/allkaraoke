import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  calcDistanceBetweenPitches,
  calcDistanceStandalone,
  calculateDetailedScoreDataStandalone,
  calculateScoreFromFrequencies,
  calculateScoreFromMp3,
  convertFrequencyRecordsToPlayerNotes,
  decodeAudioFile,
  detectPitchesFromSamples,
  sumDetailedScore,
} from './standaloneScoreCalculation';
import { generateNote, generateSection, generateSong } from 'modules/utils/testUtils';
import { FrequencyRecord, Song } from 'interfaces';
import pitchToFrequency from 'modules/utils/pitchToFrequency';
import convertTxtToSong from 'modules/Songs/utils/convertTxtToSong';

describe('standaloneScoreCalculation', () => {
  describe('calcDistanceBetweenPitches', () => {
    it('returns 0 when pitch matches within tolerance', () => {
      expect(calcDistanceBetweenPitches(60, 60, 2)).toBe(0);
      expect(calcDistanceBetweenPitches(61, 60, 2)).toBe(0);
      expect(calcDistanceBetweenPitches(62, 60, 2)).toBe(0);
    });

    it('returns distance when pitch is outside tolerance', () => {
      expect(calcDistanceBetweenPitches(65, 60, 2)).toBe(5);
      expect(calcDistanceBetweenPitches(55, 60, 2)).toBe(-5);
    });

    it('handles octave-agnostic comparison', () => {
      // Same note in different octaves
      expect(calcDistanceBetweenPitches(60, 72, 2)).toBe(0);
      expect(calcDistanceBetweenPitches(72, 60, 2)).toBe(0);
    });
  });

  describe('calcDistanceStandalone', () => {
    it('returns distance 0 for correct pitch', () => {
      const frequency = pitchToFrequency(60);
      const result = calcDistanceStandalone(frequency, 60, 2);
      expect(result.distance).toBe(0);
    });

    it('returns non-zero distance for wrong pitch', () => {
      const frequency = pitchToFrequency(65);
      const result = calcDistanceStandalone(frequency, 60, 2);
      expect(result.distance).not.toBe(0);
    });

    it('calculates preciseDistance only when distance is 0', () => {
      const correctFreq = pitchToFrequency(60);
      const wrongFreq = pitchToFrequency(65);

      const correctResult = calcDistanceStandalone(correctFreq, 60, 2);
      const wrongResult = calcDistanceStandalone(wrongFreq, 60, 2);

      expect(correctResult.preciseDistance).not.toBe(-1);
      expect(wrongResult.preciseDistance).toBe(-1);
    });
  });

  describe('convertFrequencyRecordsToPlayerNotes', () => {
    let song: Song;

    beforeEach(() => {
      // Create a simple song with known notes
      // bpm: 60, bar: 1000 -> beatLength = 1ms
      song = generateSong([[generateSection(0, 10, 5)]], { bpm: 60, bar: 1000, gap: 0 });
    });

    it('converts frequency records to player notes', () => {
      const note = song.tracks[0].sections[0].type === 'notes' ? song.tracks[0].sections[0].notes[0] : null;
      expect(note).not.toBeNull();

      // Create frequency records that match the note
      const frequency = pitchToFrequency(note!.pitch);
      const frequencyRecords: FrequencyRecord[] = [
        { timestamp: 100 + note!.start, frequency }, // 100ms input lag
        { timestamp: 100 + note!.start + 0.5, frequency },
      ];

      const playerNotes = convertFrequencyRecordsToPlayerNotes(frequencyRecords, song, 0, 2, 100);

      expect(playerNotes.length).toBeGreaterThan(0);
      expect(playerNotes[0].distance).toBe(0);
    });

    it('creates separate player notes for different song notes', () => {
      const notes = song.tracks[0].sections[0].type === 'notes' ? song.tracks[0].sections[0].notes : [];

      const frequencyRecords: FrequencyRecord[] = [];

      // Add frequencies for multiple notes
      for (let i = 0; i < 3 && i < notes.length; i++) {
        const note = notes[i];
        const frequency = pitchToFrequency(note.pitch);
        frequencyRecords.push({ timestamp: 100 + note.start + 0.5, frequency });
      }

      const playerNotes = convertFrequencyRecordsToPlayerNotes(frequencyRecords, song, 0, 2, 100);

      // Should have created separate player notes for each song note
      expect(playerNotes.length).toBe(frequencyRecords.length);
    });
  });

  describe('calculateDetailedScoreDataStandalone', () => {
    it('calculates score correctly for perfect notes', () => {
      const song = generateSong([[generateSection(0, 10, 5)]], { bpm: 60, bar: 1000 });
      const track = song.tracks[0];

      // Create perfect player notes
      const notes = track.sections[0].type === 'notes' ? track.sections[0].notes : [];
      const playerNotes = notes.map((note) => ({
        start: note.start,
        length: note.length,
        distance: 0,
        note,
        isPerfect: true,
        vibrato: false,
        frequencyRecords: [],
      }));

      const [pointsPerBeat, counts, maxCounts] = calculateDetailedScoreDataStandalone(playerNotes, track);

      expect(sumDetailedScore(counts)).toBeGreaterThan(0);
      expect(sumDetailedScore(counts)).toBeLessThanOrEqual(sumDetailedScore(maxCounts));
    });

    it('returns zero score for no matching notes', () => {
      const song = generateSong([[generateSection(0, 10, 5)]], { bpm: 60, bar: 1000 });
      const track = song.tracks[0];

      const [pointsPerBeat, counts] = calculateDetailedScoreDataStandalone([], track);

      expect(sumDetailedScore(counts)).toBe(0);
    });
  });

  describe('calculateScoreFromFrequencies', () => {
    it('calculates complete score from frequency records', () => {
      const song = generateSong([[generateSection(0, 10, 5)]], { bpm: 60, bar: 1000, gap: 0 });
      const notes = song.tracks[0].sections[0].type === 'notes' ? song.tracks[0].sections[0].notes : [];

      // Create frequency records that perfectly match all notes
      const frequencyRecords: FrequencyRecord[] = [];
      for (const note of notes) {
        const frequency = pitchToFrequency(note.pitch);
        // Add multiple frequency samples for each note to build up the player note
        for (let t = 0; t < note.length; t += 0.2) {
          frequencyRecords.push({ timestamp: 100 + note.start + t, frequency });
        }
      }

      const result = calculateScoreFromFrequencies(frequencyRecords, song, 0, 2, 100);

      expect(result.score).toBeGreaterThan(0);
      expect(result.playerNotes.length).toBeGreaterThan(0);
      expect(result.frequencyRecords).toBe(frequencyRecords);
    });

    it('returns zero score when no frequencies are provided', () => {
      const song = generateSong([[generateSection(0, 10, 5)]], { bpm: 60, bar: 1000, gap: 0 });

      const result = calculateScoreFromFrequencies([], song, 0, 2, 100);

      expect(result.score).toBe(0);
      expect(result.playerNotes.length).toBe(0);
    });
  });

  describe('randomCEF integration test', () => {
    it('loads and parses the ultrastar.txt correctly', () => {
      // Read the ultrastar.txt file
      const txtPath = path.resolve(__dirname, '../../../../../tests/fixtures/songs/randomCEF_ultrastar_ontime.txt');
      const txtContent = fs.readFileSync(txtPath, 'utf-8');
      const song = convertTxtToSong(txtContent);

      expect(song.title).toBe('randomCEF');
      expect(song.artist).toBe('Audinom');
      expect(song.bpm).toBe(15);
      expect(song.gap).toBe(0);

      // Check notes
      const notes = song.tracks[0].sections.flatMap(s => s.type === 'notes' ? s.notes : []);
      expect(notes.length).toBe(4);
      expect(notes[0].pitch).toBe(48);
      expect(notes[1].pitch).toBe(53);
      expect(notes[2].pitch).toBe(52);
      expect(notes[3].pitch).toBe(48);
    });

    it('calculates score from simulated frequency records matching randomCEF', () => {
      // Read the ultrastar.txt file
      const txtPath = path.resolve(__dirname, '../../../../../tests/fixtures/songs/randomCEF_ultrastar_ontime.txt');
      const txtContent = fs.readFileSync(txtPath, 'utf-8');
      const song = convertTxtToSong(txtContent);

      // BPM 15, bar 4 (default) -> beatLength = (60 / 15 / 4) * 1000 = 1000ms per beat
      // Notes are at beats 8, 12, 16, 20 with length 1 each
      // So notes are at 8000ms, 12000ms, 16000ms, 20000ms

      const notes = song.tracks[0].sections.flatMap(s => s.type === 'notes' ? s.notes : []);

      // Create frequency records that match the notes perfectly
      const frequencyRecords: FrequencyRecord[] = [];
      for (const note of notes) {
        const frequency = pitchToFrequency(note.pitch);
        const beatLengthMs = 1000; // (60 / 15 / 4) * 1000
        const startMs = note.start * beatLengthMs;

        // Add frequency samples during the note (accounting for 100ms input lag)
        for (let t = 0; t < note.length * beatLengthMs; t += 50) {
          frequencyRecords.push({
            timestamp: startMs + t + 100, // +100 for input lag
            frequency,
          });
        }
      }

      const result = calculateScoreFromFrequencies(frequencyRecords, song, 0, 2, 100);

      console.log('Score:', result.score);
      console.log('Max possible:', sumDetailedScore(result.maxCounts) * result.pointsPerBeat);
      console.log('Player notes count:', result.playerNotes.length);
      console.log('Counts:', result.counts);
      console.log('Max counts:', result.maxCounts);

      // Should have a good score since we simulated perfect pitch
      expect(result.score).toBeGreaterThan(0);
      expect(result.playerNotes.length).toBe(4); // One player note per song note
    });

    // Note: The full MP3 integration test requires AudioContext which is only available in browser.
    // Use the browser-based test runner or the example in the comments below to test with actual MP3.
    //
    // Example browser usage:
    // ```
    // import { calculateScoreFromMp3 } from './standaloneScoreCalculation';
    // import convertTxtToSong from 'modules/Songs/utils/convertTxtToSong';
    //
    // const txtResponse = await fetch('/tests/fixtures/songs/randomCEF_ultrastar_ontime.txt');
    // const txtContent = await txtResponse.text();
    // const song = convertTxtToSong(txtContent);
    //
    // const result = await calculateScoreFromMp3('/randomCEF_nodrums.mp3', song, 0, 2, 100, 2048);
    // console.log('Score:', result.score);
    // ```
  });
});
