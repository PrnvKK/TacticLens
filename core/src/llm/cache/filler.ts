// Deterministic filler used to pad the stable prefix to a 1024-token block boundary. It is a reference
// glossary, so the padding also gives the model useful vocabulary (never random, never timestamped).

const GLOSSARY: [string, string][] = [
  ['overload', 'more attackers than defenders in one zone; a shot only when the edge is two or more players'],
  ['free player', 'an attacker with no defender inside roughly five metres and a clear pass lane from the carrier'],
  ['press trap', 'defenders closing the carrier from two sides so the safe passes are cut off'],
  ['pressing trigger', 'a bad touch, a back pass or a pass into the touchline that makes the defence step up together'],
  ['high line', 'a back line holding far from its own goal, leaving space behind it for a through ball'],
  ['low block', 'a compact defence sitting deep, giving up the ball but protecting the box'],
  ['half-space', 'the vertical channel between the wing and the centre; good place to receive between the lines'],
  ['between the lines', 'the gap between a defence line and the midfield line behind it'],
  ['switch of play', 'a long pass from one flank to the other to find a free player and stretch the block'],
  ['counter-attack', 'a fast attack straight after winning the ball while the other team is still out of shape'],
  ['transition', 'the few seconds after the ball changes sides, when shape is weakest'],
  ['build-up', 'the team passing out from the back to move the ball up the pitch under little pressure'],
  ['possession spell', 'an unbroken stretch of one team holding the ball; its length shows control'],
  ['compactness', 'how tightly a team keeps its lines and width; a compact team leaves little room between players'],
  ['line height', 'how far up the pitch a defensive line stands, from its own goal at zero to the opponent goal at one'],
  ['field tilt', 'the share of recent attacking play that happens in the final third; shows territorial pressure'],
  ['momentum', 'a rolling measure of which side is creating more; positive favours team A, negative team B'],
  ['spotlight', 'a ring on one player; used to explain who is running the game or about to receive'],
  ['marking links', 'lines joining each attacker to the defender marking him; shows a loose or tight marking scheme'],
  ['passing lanes', 'open straight lines from the carrier to teammates that a defender does not block'],
  ['key player', 'the player whose ranked involvement score is highest in the facts, never guessed'],
  ['space pocket', 'an empty area near the ball that a runner can attack; only shown when the fact is valid'],
  ['counter run', 'a forward run during a transition; shown while the run is still happening'],
  ['calm gate', 'the client rule that blocks a graphic when the picture is busy, a cut is recent or a graphic is already up'],
  ['menu', 'the list of graphics whose facts are valid this second, computed by rules and never by the model'],
  ['track id', 'the number drawn above a player on the frame; use only ids that appear in the payload'],
  ['team A and B', 'A is the first measured kit colour and B the second; names and colours are in the match block'],
  ['wide shot', 'the main broadcast camera showing most of the pitch; graphics are only drawn on this shot'],
  ['replay', 'a repeated clip, never live; no graphics are requested while a replay is showing'],
  ['close-up', 'a tight shot of players or crowd where tracking is unreliable; stay silent'],
];

/** Exactly `chars` characters of deterministic glossary text (cut on a word boundary where possible). */
export function fillerText(chars: number): string {
  if (chars <= 0) return '';
  const lines: string[] = [];
  let len = 0;
  for (let i = 0; len < chars + 200; i++) {
    const [term, def] = GLOSSARY[i % GLOSSARY.length]!;
    const round = Math.floor(i / GLOSSARY.length) + 1;
    const line = `- ref ${round}.${(i % GLOSSARY.length) + 1} ${term}: ${def}.\n`;
    lines.push(line);
    len += line.length;
  }
  const all = lines.join('');
  const cut = all.slice(0, chars);
  // Pad to the exact length with spaces if the cut ended mid-way and we need exactness; callers rely on length.
  return cut;
}
