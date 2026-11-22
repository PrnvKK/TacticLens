// Hardcoded commentary lines. Kimi does not write the commentary any more: it only PICKS which of these
// lines fits the moment and which team it is about, and the text below is what reaches the chat. That keeps
// every line clean and on-message (no garbled words, no jargon) and makes each model reply tiny and fast.
//
// {T} is the team the line is about, {O} is the other team. Both become "Team <colour>" at render time.

export interface BankLine {
  id: string;
  text: string;
  /** Shown to Kimi: when this line fits, and who {T} should be. */
  when: string;
}

export const LINE_BANK: readonly BankLine[] = [
  { id: 'press_on', text: '{T} are piling on the pressure.', when: 'pressTrap: T is the side NOT on the ball (the pressers)' },
  { id: 'press_trap', text: '{T} are closing {O} down and forcing the mistake.', when: 'pressTrap: T is the side NOT on the ball' },
  { id: 'press_high', text: '{T} are pressing high and {O} have no time on the ball.', when: 'phase press, or pressTrap: T is the pressers' },
  { id: 'overload_side', text: '{T} have the numbers on this side and {O} are stretched.', when: 'overload: T is overload.team' },
  { id: 'overload_pile', text: '{T} are committing bodies forward and {O} are scrambling to cover.', when: 'overload: T is overload.team' },
  { id: 'switch_on', text: '{T} are looking to switch play to the open side.', when: 'switchArc: T is switchArc.team' },
  { id: 'switch_stretch', text: '{T} are stretching {O} with a switch of play.', when: 'switchArc: T is switchArc.team' },
  { id: 'free_man', text: '{T} have a man free in space and {O} are slow to pick him up.', when: 'freePlayer: T is freePlayer.team' },
  { id: 'lanes_open', text: '{T} have options opening up through the middle.', when: 'passingLane: T is passingLane.team' },
  { id: 'counter_go', text: '{T} are breaking at pace and {O} are caught out of shape.', when: 'counterRun: T is counterRun.team' },
  { id: 'space_open', text: 'There is room for {T} to attack between the lines of {O}.', when: 'spacePocket: T is the team in possession' },
  { id: 'poss_keep', text: '{T} are keeping the ball and setting the tempo.', when: 'possessionNow or possessionSwing favours T' },
  { id: 'poss_gain', text: '{T} are slowly taking control of the ball.', when: 'possessionSwing: T is possessionSwing.team' },
  { id: 'momentum', text: '{T} have the momentum right now.', when: 'recent minutes show momentum toward T' },
  { id: 'build_back', text: '{T} are building patiently from the back.', when: 'phase build_up' },
  { id: 'probe', text: '{T} are probing patiently, looking for a way through.', when: 'phase settled, T has the ball' },
  { id: 'transition', text: '{T} are quick to turn defence into attack.', when: 'phase transition' },
  { id: 'under_pressure', text: '{O} are under pressure and struggling to get out.', when: 'T is dominating: pressing, overload or most possession' },
  { id: 'midfield', text: 'The midfield battle between {T} and {O} is finely poised.', when: 'nothing stands out; level game' },
  { id: 'set_piece', text: '{T} could be dangerous from this set piece.', when: 'phase set_piece' },
];

export const LINE_IDS = LINE_BANK.map((l) => l.id);

const BY_ID = new Map(LINE_BANK.map((l) => [l.id, l]));

/** The bank as the compact block pasted into the prompt: one "id | text | when" row per line. */
export function bankForPrompt(): string {
  return LINE_BANK.map((l) => `${l.id} | ${l.text} | ${l.when}`).join('\n');
}

/** Fill one bank line for `team`. `names` are the full team words ("Team Orange"). Returns '' for an unknown id. */
export function renderBankLine(id: string, team: 'A' | 'B', names: { A: string; B: string }): string {
  const line = BY_ID.get(id);
  if (!line) return '';
  const other = team === 'A' ? 'B' : 'A';
  return line.text.replace(/\{T\}/g, names[team]).replace(/\{O\}/g, names[other]);
}
