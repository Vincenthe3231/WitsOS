/**
 * SRT/VTT subtitle parser.
 *
 * Parses SubRip (.srt) and WebVTT (.vtt) subtitle files into cue groups.
 * Both formats share the same timing format (HH:MM:SS,mmm) and cue structure.
 * Gracefully handles malformed input: missing sequence numbers, extra blank lines, etc.
 *
 * Output: array of cues, each with start/end times (seconds), text, and optional metadata.
 */

export interface Cue {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Cue text (subtitle content). */
  text: string;
  /** Optional cue ID (SRT sequence number or VTT cue ID). */
  id?: string;
}

/**
 * Parse timing string "HH:MM:SS,mmm" or "HH:MM:SS.mmm" into seconds.
 * Returns null on invalid input.
 */
function parseTimestamp(ts: string): number | null {
  // Normalize comma to dot for milliseconds
  const normalized = ts.replace(',', '.');
  const match = normalized.match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return null;
  const hours = match[1];
  const minutes = match[2];
  const seconds = match[3];
  const millis = match[4];
  if (!hours || !minutes || !seconds || !millis) return null;
  return (
    parseInt(hours, 10) * 3600 +
    parseInt(minutes, 10) * 60 +
    parseInt(seconds, 10) +
    parseInt(millis, 10) / 1000
  );
}

/**
 * Parse SRT/VTT subtitle text into cues.
 * Tolerant parser: handles extra whitespace, missing sequence numbers, etc.
 */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    // Skip blank lines
    while (i < lines.length && !lines[i]!.trim()) i++;
    if (i >= lines.length) break;

    // Next line might be a sequence number (SRT) or cue ID (VTT)
    let id: string | undefined;
    let timingLine: string | undefined;

    // Try to parse as sequence number (all digits)
    const firstLine = lines[i]!.trim();
    if (/^\d+$/.test(firstLine)) {
      id = firstLine;
      i++;
      // Skip blanks after ID
      while (i < lines.length && !lines[i]!.trim()) i++;
      if (i < lines.length) {
        timingLine = lines[i]!.trim();
        i++;
      }
    } else {
      // Treat first line as timing (VTT format, or SRT with missing ID)
      timingLine = firstLine;
      i++;
    }

    // Parse timing line "start --> end"
    if (!timingLine || !timingLine.includes('-->')) continue;

    const [startStr, endStr] = timingLine.split('-->').map((s) => s.trim());
    if (!startStr || !endStr) continue;

    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);
    if (start === null || end === null) continue;

    // Collect cue text (all non-blank lines until next blank)
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim()) {
      textLines.push(lines[i]!);
      i++;
    }

    if (textLines.length > 0) {
      cues.push({
        id,
        start,
        end,
        text: textLines.join('\n').trim(),
      });
    }
  }

  return cues;
}
