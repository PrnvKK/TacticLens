import { describe, expect, it } from 'vitest';
import { stripMediaTalk } from '../lib/live/media-talk';

describe('stripMediaTalk', () => {
  it('drops the sentences that talk about pictures, the payload or trackers and keeps the football', () => {
    expect(stripMediaTalk('Team Red press high. The annotated image shows it. Team Yellow hold the middle.'))
      .toBe('Team Red press high. Team Yellow hold the middle.');
    expect(stripMediaTalk('The JPEG has a ring on the left back. Team Red have the momentum.')).toBe('Team Red have the momentum.');
    expect(stripMediaTalk('The payload says so. Per the tracker ids, Team Red win it. Team Red are on top.')).toBe('Team Red are on top.');
  });

  it('matches case-insensitively on whole words', () => {
    expect(stripMediaTalk('The Screenshot shows a lot. Team Red are pressing.')).toBe('Team Red are pressing.');
    expect(stripMediaTalk('The JSON is clear. Team Red are pressing.')).toBe('Team Red are pressing.');
    expect(stripMediaTalk('Team Red are pressing from the memory.')).toBe('');
  });

  it('returns an empty string when nothing remains', () => {
    expect(stripMediaTalk('The JPEG shows a frame.')).toBe('');
    expect(stripMediaTalk('   ')).toBe('');
    expect(stripMediaTalk('')).toBe('');
  });

  it('collapses whitespace and leaves football sentences untouched', () => {
    expect(stripMediaTalk('  Team  Red\n\n have it.  ')).toBe('Team Red have it.');
    expect(stripMediaTalk('Team Red are pressing in the final third.')).toBe('Team Red are pressing in the final third.');
  });
});
