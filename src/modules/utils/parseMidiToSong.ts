import { songBeat, NoteType, NotesSection, Song, SongTrack, NoteInclName } from 'interfaces';

interface MidiNote {
  pitch: number;
  noteName: string;
  startTicks: number;
  durationTicks: number;
  channel: number;
}

interface MidiParseResult {
  notes: MidiNote[];
  ticksPerBeat: number;
  tempoMicroseconds: number; // microseconds per beat
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new Error('MIDI note must be an integer between 0 and 127');
  }

  const noteIndex = midi % 12;
  const octave = Math.floor(midi / 12) - 1;

  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

/**
 * Parse a MIDI file and extract note events.
 */
function parseMidiFile(arrayBuffer: ArrayBuffer): MidiParseResult {
  const data = new DataView(arrayBuffer);
  let offset = 0;

  // Read header chunk
  const headerChunkType = String.fromCharCode(
    data.getUint8(offset),
    data.getUint8(offset + 1),
    data.getUint8(offset + 2),
    data.getUint8(offset + 3),
  );
  offset += 4;

  if (headerChunkType !== 'MThd') {
    throw new Error('Invalid MIDI file: Missing MThd header');
  }

  const headerLength = data.getUint32(offset);
  offset += 4;

  const format = data.getUint16(offset);
  offset += 2;

  const numTracks = data.getUint16(offset);
  offset += 2;

  const ticksPerBeat = data.getUint16(offset);
  offset += 2;

  // Skip any remaining header bytes
  offset += headerLength - 6;

  const allNotes: MidiNote[] = [];
  let tempoMicroseconds = 500000; // Default: 120 BPM

  // Read track chunks
  for (let trackIndex = 0; trackIndex < numTracks; trackIndex++) {
    const trackChunkType = String.fromCharCode(
      data.getUint8(offset),
      data.getUint8(offset + 1),
      data.getUint8(offset + 2),
      data.getUint8(offset + 3),
    );
    offset += 4;

    if (trackChunkType !== 'MTrk') {
      throw new Error(`Invalid MIDI file: Expected MTrk, got ${trackChunkType}`);
    }

    const trackLength = data.getUint32(offset);
    offset += 4;

    const trackEnd = offset + trackLength;
    let currentTick = 0;
    let runningStatus = 0;

    // Track active notes (note on without note off yet)
    const activeNotes: Map<number, { pitch: number; startTicks: number; channel: number }> = new Map();

    while (offset < trackEnd) {
      // Read variable-length delta time
      let deltaTime = 0;
      let byte;
      do {
        byte = data.getUint8(offset++);
        deltaTime = (deltaTime << 7) | (byte & 0x7f);
      } while (byte & 0x80);

      currentTick += deltaTime;

      // Read event
      let eventByte = data.getUint8(offset);

      // Handle running status
      if (eventByte < 0x80) {
        eventByte = runningStatus;
      } else {
        offset++;
        if (eventByte < 0xf0) {
          runningStatus = eventByte;
        }
      }

      const eventType = eventByte & 0xf0;
      const channel = eventByte & 0x0f;

      if (eventType === 0x90) {
        // Note On
        const pitch = data.getUint8(offset++);
        const velocity = data.getUint8(offset++);

        if (velocity > 0) {
          // Note on
          activeNotes.set(pitch, { pitch, startTicks: currentTick, channel });
        } else {
          // Note off (velocity 0)
          const activeNote = activeNotes.get(pitch);
          if (activeNote) {
            allNotes.push({
              pitch: activeNote.pitch,
              noteName: midiToNoteName(activeNote.pitch),
              startTicks: activeNote.startTicks,
              durationTicks: currentTick - activeNote.startTicks,
              channel: activeNote.channel,
            });
            activeNotes.delete(pitch);
          }
        }
      } else if (eventType === 0x80) {
        // Note Off
        const pitch = data.getUint8(offset++);
        offset++; // velocity (unused)

        const activeNote = activeNotes.get(pitch);
        if (activeNote) {
          allNotes.push({
            pitch: activeNote.pitch,
            noteName: midiToNoteName(activeNote.pitch),
            startTicks: activeNote.startTicks,
            durationTicks: currentTick - activeNote.startTicks,
            channel: activeNote.channel,
          });
          activeNotes.delete(pitch);
        }
      } else if (eventType === 0xa0) {
        // Polyphonic Key Pressure
        offset += 2;
      } else if (eventType === 0xb0) {
        // Control Change
        offset += 2;
      } else if (eventType === 0xc0) {
        // Program Change
        offset += 1;
      } else if (eventType === 0xd0) {
        // Channel Pressure
        offset += 1;
      } else if (eventType === 0xe0) {
        // Pitch Bend
        offset += 2;
      } else if (eventByte === 0xff) {
        // Meta Event
        const metaType = data.getUint8(offset++);
        let metaLength = 0;
        let b;
        do {
          b = data.getUint8(offset++);
          metaLength = (metaLength << 7) | (b & 0x7f);
        } while (b & 0x80);

        if (metaType === 0x51 && metaLength === 3) {
          // Tempo
          tempoMicroseconds =
            (data.getUint8(offset) << 16) | (data.getUint8(offset + 1) << 8) | data.getUint8(offset + 2);
        }

        offset += metaLength;
      } else if (eventByte === 0xf0 || eventByte === 0xf7) {
        // SysEx
        let sysexLength = 0;
        let b;
        do {
          b = data.getUint8(offset++);
          sysexLength = (sysexLength << 7) | (b & 0x7f);
        } while (b & 0x80);
        offset += sysexLength;
      }
    }
  }

  // Sort notes by start time
  allNotes.sort((a, b) => a.startTicks - b.startTicks);

  return {
    notes: allNotes,
    ticksPerBeat,
    tempoMicroseconds,
  };
}

/**
 * Convert parsed MIDI data to a Song object compatible with the score calculation.
 */
export function convertMidiToSong(
  arrayBuffer: ArrayBuffer,
  title: string = 'MIDI Song',
  artist: string = 'Unknown',
): Song {
  const { notes, ticksPerBeat, tempoMicroseconds } = parseMidiFile(arrayBuffer);

  // Calculate BPM from tempo
  const bpm = Math.round(60000000 / tempoMicroseconds);

  // For ultrastar format, we use a bar value that makes beat calculations work
  // beatLength = (60 / bpm / bar) * 1000 ms
  // We want 1 tick = 1 beat for simplicity, so we'll convert ticks to beats
  const bar = 4; // Standard 4/4 time

  // Convert MIDI ticks to ultrastar beats
  // In ultrastar: beatLength = (60 / bpm / bar) * 1000 ms
  // In MIDI: tickLength = tempoMicroseconds / ticksPerBeat / 1000 ms
  // So: ultrastarBeat = midiTick * (tickLength / beatLength)
  //                   = midiTick * (tempoMicroseconds / ticksPerBeat) / ((60 / bpm / bar) * 1000)
  //                   = midiTick * (tempoMicroseconds / ticksPerBeat) / (60000 / bpm / bar)
  //                   = midiTick * (tempoMicroseconds * bpm * bar) / (ticksPerBeat * 60000000)
  //                   = midiTick * bar / ticksPerBeat (since bpm = 60000000 / tempoMicroseconds)
  const ticksToBeats = bar / ticksPerBeat;

  // Convert MIDI notes to ultrastar notes
  const songNotes: NoteInclName[] = notes.map((midiNote, index) => ({
    start: Math.round(midiNote.startTicks * ticksToBeats),
    length: Math.max(1, Math.round(midiNote.durationTicks * ticksToBeats)),
    pitch: midiNote.pitch,
    noteName: midiNote.noteName,
    type: 'normal' as const,
    lyrics: `~`, // No lyrics in MIDI
  }));

  // Group notes into sections (one section for simplicity)
  const sections: NotesSection[] = [];

  if (songNotes.length > 0) {
    sections.push({
      type: 'notes',
      start: songNotes[0].start,
      notes: songNotes,
    });
  }

  const track: SongTrack = {
    sections,
    changes: [],
  };

  const song: Song = {
    shortId: -1,
    id: `midi-${Date.now()}`,
    title,
    artist,
    video: '',
    language: [],
    bpm,
    bar,
    gap: 0,
    tracks: [track],
    mergedTrack: track,
    lastUpdate: undefined,
    author: undefined,
    authorUrl: undefined,
    genre: undefined,
    year: undefined,
    edition: undefined,
    sourceUrl: undefined,
    videoGap: undefined,
    artistOrigin: undefined,
    previewStart: undefined,
    previewEnd: undefined,
    volume: undefined,
    manualVolume: undefined,
    realBpm: undefined,
    unsupportedProps: [],
  };

  return song;
}

/**
 * Get info about a MIDI file without full conversion.
 */
export function getMidiInfo(arrayBuffer: ArrayBuffer): {
  noteCount: number;
  durationMs: number;
  bpm: number;
  ticksPerBeat: number;
} {
  const { notes, ticksPerBeat, tempoMicroseconds } = parseMidiFile(arrayBuffer);
  const bpm = 60000000 / tempoMicroseconds;

  let maxEndTick = 0;
  for (const note of notes) {
    const endTick = note.startTicks + note.durationTicks;
    if (endTick > maxEndTick) maxEndTick = endTick;
  }

  const durationMs = (maxEndTick / ticksPerBeat) * (tempoMicroseconds / 1000);

  return {
    noteCount: notes.length,
    durationMs,
    bpm,
    ticksPerBeat,
  };
}
