import { MIDDLEA, SEMITONE, noDistanceNoteTypes, noPointsNoteTypes } from 'consts';
import { DetailedScore, FrequencyRecord, Note, NotesSection, PlayerNote, Song, SongTrack } from 'interfaces';
import pitchToFrequency from 'modules/utils/pitchToFrequency';
import AubioStrategy from 'modules/GameEngine/Input/MicStrategies/Aubio';
import getSongBeatLength from 'modules/Songs/utils/getSongBeatLength';
import isNotesSection from 'modules/Songs/utils/isNotesSection';
import { getNoteAtBeat } from 'modules/Songs/utils/notesSelectors';
import detectVibrato from './detectVibrato';

export const MAX_POINTS = 3_500_000;
const SINGING_BREAK_TOLERANCE_MS = 100;

const noteTypesMultipliers: DetailedScore = {
  freestyle: 0.25,
  rap: 0.25,
  rapstar: 0.5,
  star: 2,
  normal: 1,
  perfect: 0,
  vibrato: 0,
};

// Pitch detection helpers
const pitchFromFrequency = (freq: number) =>
  Math.round(12 * (Math.log(freq / MIDDLEA) / Math.log(2))) + SEMITONE;

const getDistanceInCents = (noteFreq: number, freq: number) =>
  Math.floor((1200 * Math.log(freq / noteFreq)) / Math.log(2));

const getCentDistance = (targetNote: number, freq: number, tolerance: number) => {
  const noteFreq = pitchToFrequency(targetNote);
  const cents = getDistanceInCents(noteFreq, freq);
  const distance = Math.sign(cents) * ((((Math.abs(cents) % 1200) + 600) % 1200) - 600);
  return distance / (tolerance * 100 + 50);
};

export const calcDistanceBetweenPitches = (note: number, targetNote: number, tolerance: number) => {
  const noteDistance = (((note % 12) - (targetNote % 12) + 18) % 12) - 6;
  return Math.abs(noteDistance) <= tolerance ? 0 : noteDistance;
};

export const calcDistanceStandalone = (frequency: number, targetNote: number, tolerance: number) => {
  const note = pitchFromFrequency(frequency);
  let preciseDistance: number = -1;
  const distance = calcDistanceBetweenPitches(note, targetNote, tolerance);

  if (distance === 0) {
    preciseDistance = getCentDistance(targetNote, frequency, tolerance);
  }

  return { distance, preciseDistance };
};

// Score calculation helpers
const countsToBeats = (counts: DetailedScore): DetailedScore => ({
  freestyle: counts.freestyle * noteTypesMultipliers.freestyle,
  rap: counts.rap * noteTypesMultipliers.rap,
  rapstar: counts.rapstar * noteTypesMultipliers.rapstar,
  star: counts.star * noteTypesMultipliers.star,
  normal: counts.normal * noteTypesMultipliers.normal,
  perfect: counts.perfect * noteTypesMultipliers.perfect,
  vibrato: counts.vibrato * noteTypesMultipliers.vibrato,
});

export const sumDetailedScore = (counts: DetailedScore) =>
  counts.freestyle + counts.rap + counts.star + counts.normal + counts.perfect + counts.vibrato;

function countSungBeats(track: SongTrack): DetailedScore {
  const counts: DetailedScore = {
    freestyle: 0,
    rap: 0,
    rapstar: 0,
    star: 0,
    normal: 0,
    perfect: 0,
    vibrato: 0,
  };

  track.sections.filter(isNotesSection).forEach((section) => {
    const notes = section.notes.filter((note) => !noPointsNoteTypes.includes(note.type));

    notes.forEach((note) => {
      counts[note.type] = counts[note.type] + note.length;
      counts.perfect = counts.perfect + note.length;
      counts.vibrato = counts.vibrato + note.length;
    });
  });

  return counts;
}

function getPlayerNoteDistance(note: PlayerNote) {
  return noDistanceNoteTypes.includes(note.note.type) ? 0 : note.distance;
}

/**
 * Appends a frequency record to the player notes array, handling note segmentation
 * and scoring logic.
 */
function appendFrequencyToPlayerNotesStandalone(
  playerNotes: PlayerNote[],
  record: FrequencyRecord,
  note: Note,
  beatLength: number,
  tolerance: number,
) {
  if (record.frequency === 0) return;

  const { distance, preciseDistance } = calcDistanceStandalone(record.frequency, note.pitch, tolerance);

  const noteCandidate = {
    ...record,
    beat: Math.max(0, record.timestamp) / beatLength,
    distance,
    preciseDistance,
  };

  const lastNote = playerNotes.at(-1);
  const breakToleranceBeat = SINGING_BREAK_TOLERANCE_MS / beatLength;
  const noteEndBeat = note.start + note.length;
  const isThisNoteDifferentThanLast = !lastNote || lastNote.note.start !== note.start;
  const isDistanceDifferent =
    !lastNote || (lastNote.distance !== noteCandidate.distance && !noDistanceNoteTypes.includes(note.type));

  if (
    isThisNoteDifferentThanLast ||
    isDistanceDifferent ||
    noteCandidate.beat - (lastNote.start + lastNote.length) > breakToleranceBeat
  ) {
    const roundedStart = noteCandidate.beat - breakToleranceBeat < note.start ? note.start : noteCandidate.beat;
    playerNotes.push({
      start: Math.min(isThisNoteDifferentThanLast ? roundedStart : noteCandidate.beat, noteEndBeat),
      length: 0,
      distance: noteCandidate.distance,
      note,
      isPerfect: false,
      vibrato: false,
      frequencyRecords: [
        {
          frequency: noteCandidate.frequency,
          preciseDistance: noteCandidate.preciseDistance,
          timestamp: noteCandidate.timestamp,
        },
      ],
    });

    if (lastNote && note.start !== lastNote.note.start) {
      const lastPlayerNoteEndBeat = lastNote.start + lastNote.length;
      const lastNoteEndBeat = lastNote.note.start + lastNote.note.length;
      const roundedLength =
        lastPlayerNoteEndBeat + breakToleranceBeat > lastNoteEndBeat ? lastNoteEndBeat : lastPlayerNoteEndBeat;
      lastNote.length = Math.max(0, roundedLength - lastNote.start);
    }
  } else {
    lastNote.length = Math.max(0, Math.min(noteCandidate.beat, note.start + note.length) - lastNote.start);
    lastNote.frequencyRecords.push({
      frequency: noteCandidate.frequency,
      timestamp: noteCandidate.timestamp,
      preciseDistance: noteCandidate.preciseDistance,
    });

    lastNote.isPerfect = lastNote.distance === 0 && Math.abs(lastNote.length - lastNote.note.length) < 0.5;
    lastNote.vibrato = lastNote.distance === 0 && detectVibrato(lastNote.frequencyRecords);
  }
}

/**
 * Decode an MP3 file to PCM audio samples.
 */
export async function decodeAudioFile(fileOrUrl: File | string): Promise<{ samples: Float32Array; sampleRate: number }> {
  let arrayBuffer: ArrayBuffer;

  if (typeof fileOrUrl === 'string') {
    const response = await fetch(fileOrUrl);
    arrayBuffer = await response.arrayBuffer();
  } else {
    arrayBuffer = await fileOrUrl.arrayBuffer();
  }

  // Use a regular AudioContext to decode
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  await audioContext.close();

  // Get mono audio (mix channels if stereo)
  const numberOfChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const samples = new Float32Array(length);

  if (numberOfChannels === 1) {
    audioBuffer.copyFromChannel(samples, 0);
  } else {
    // Mix down to mono
    const channel0 = audioBuffer.getChannelData(0);
    const channel1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      samples[i] = (channel0[i] + channel1[i]) / 2;
    }
  }

  return { samples, sampleRate: audioBuffer.sampleRate };
}

/**
 * Run pitch detection on audio samples and return frequency records.
 */
export async function detectPitchesFromSamples(
  samples: Float32Array,
  sampleRate: number,
  fftSize: number = 2048,
): Promise<FrequencyRecord[]> {
  const strategy = new AubioStrategy();

  // Create a dummy context just for initialization
  const dummyContext = new AudioContext({ sampleRate });
  await strategy.init(dummyContext, fftSize);
  await dummyContext.close();

  const frequencyRecords: FrequencyRecord[] = [];
  const hopSize = fftSize; // Process non-overlapping frames
  const msPerSample = 1000 / sampleRate;

  for (let i = 0; i + fftSize <= samples.length; i += hopSize) {
    const frame = samples.slice(i, i + fftSize);
    const frequency = await strategy.getFrequency(frame);

    // Timestamp is at the center of the frame
    const timestamp = (i + fftSize / 2) * msPerSample;

    frequencyRecords.push({
      timestamp,
      frequency,
    });
  }

  return frequencyRecords;
}

/**
 * Get the section index containing a specific beat.
 */
function getSectionIndexByBeat(track: SongTrack, beat: number): number {
  return track.sections.findIndex((section, index, sections) => {
    if (beat < 0) return true;
    if (beat < section.start) return false;
    if (index === sections.length - 1) return true;
    return sections[index + 1].start > beat;
  });
}

/**
 * Convert frequency records to player notes by matching against song notes.
 */
export function convertFrequencyRecordsToPlayerNotes(
  frequencyRecords: FrequencyRecord[],
  song: Song,
  trackNumber: number,
  tolerance: number,
  inputLagMs: number = 100,
): PlayerNote[] {
  const playerNotes: PlayerNote[] = [];
  const track = song.tracks[trackNumber];
  const beatLength = getSongBeatLength(song);

  for (const record of frequencyRecords) {
    // Adjust for input lag
    const adjustedTimestamp = record.timestamp - inputLagMs;
    const adjustedRecord = { ...record, timestamp: adjustedTimestamp };

    const recordBeat = adjustedTimestamp / beatLength;
    const sectionIndex = getSectionIndexByBeat(track, recordBeat);
    const section = track.sections[sectionIndex];

    if (section && isNotesSection(section)) {
      const note = getNoteAtBeat(section, recordBeat, 0) ?? getNoteAtBeat(section, recordBeat, 0.5);

      if (note) {
        appendFrequencyToPlayerNotesStandalone(playerNotes, adjustedRecord, note, beatLength, tolerance);
      }
    }
  }

  return playerNotes;
}

export interface StandaloneScoreResult {
  score: number;
  pointsPerBeat: number;
  counts: DetailedScore;
  maxCounts: DetailedScore;
  playerNotes: PlayerNote[];
  frequencyRecords: FrequencyRecord[];
}

/**
 * Calculate detailed score data from player notes (standalone version).
 */
export function calculateDetailedScoreDataStandalone(
  playerNotes: PlayerNote[],
  track: SongTrack,
): [number, DetailedScore, DetailedScore] {
  const counts: DetailedScore = {
    freestyle: 0,
    rap: 0,
    rapstar: 0,
    star: 0,
    normal: 0,
    perfect: 0,
    vibrato: 0,
  };

  const maxCounts = countsToBeats(countSungBeats(track));
  const pointsPerBeat = MAX_POINTS / sumDetailedScore(maxCounts);

  for (let i = 0; i < playerNotes.length; i++) {
    const note = playerNotes[i];
    if (noPointsNoteTypes.includes(note.note.type)) continue;
    if (getPlayerNoteDistance(note) !== 0) continue;

    counts[note.note.type] = counts[note.note.type] + note.length;

    if (note.isPerfect) counts.perfect = counts.perfect + note.length;
    if (note.vibrato) counts.vibrato = counts.vibrato + note.length;
  }

  return [pointsPerBeat, countsToBeats(counts), maxCounts];
}

/**
 * Main standalone function to calculate score from an MP3 file and a song.
 *
 * @param mp3FileOrUrl - The MP3 file (as File object) or URL to the MP3 file
 * @param song - The song object (converted from ultrastar.txt)
 * @param trackNumber - The track number to score against (default: 0)
 * @param tolerance - The pitch tolerance in semitones (default: 2)
 * @param inputLagMs - Input lag compensation in milliseconds (default: 100)
 * @param fftSize - FFT size for pitch detection (default: 2048)
 * @returns Promise containing score results
 */
export async function calculateScoreFromMp3(
  mp3FileOrUrl: File | string,
  song: Song,
  trackNumber: number = 0,
  tolerance: number = 2,
  inputLagMs: number = 100,
  fftSize: number = 2048,
): Promise<StandaloneScoreResult> {
  // Step 1: Decode the MP3 file to audio samples
  const { samples, sampleRate } = await decodeAudioFile(mp3FileOrUrl);

  // Step 2: Run pitch detection to get frequency records
  const frequencyRecords = await detectPitchesFromSamples(samples, sampleRate, fftSize);

  // Step 3: Convert frequency records to player notes
  const playerNotes = convertFrequencyRecordsToPlayerNotes(
    frequencyRecords,
    song,
    trackNumber,
    tolerance,
    inputLagMs,
  );

  // Step 4: Calculate score
  const track = song.tracks[trackNumber];
  const [pointsPerBeat, counts, maxCounts] = calculateDetailedScoreDataStandalone(playerNotes, track);
  const score = sumDetailedScore(counts) * pointsPerBeat;

  return {
    score,
    pointsPerBeat,
    counts,
    maxCounts,
    playerNotes,
    frequencyRecords,
  };
}

/**
 * Calculate score from already-extracted frequency records (useful when you already have the pitch data).
 */
export function calculateScoreFromFrequencies(
  frequencyRecords: FrequencyRecord[],
  song: Song,
  trackNumber: number = 0,
  tolerance: number = 2,
  inputLagMs: number = 100,
): StandaloneScoreResult {
  const playerNotes = convertFrequencyRecordsToPlayerNotes(
    frequencyRecords,
    song,
    trackNumber,
    tolerance,
    inputLagMs,
  );

  const track = song.tracks[trackNumber];
  const [pointsPerBeat, counts, maxCounts] = calculateDetailedScoreDataStandalone(playerNotes, track);
  const score = sumDetailedScore(counts) * pointsPerBeat;

  return {
    score,
    pointsPerBeat,
    counts,
    maxCounts,
    playerNotes,
    frequencyRecords,
  };
}
