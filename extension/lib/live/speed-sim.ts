// ?mock=1 speed simulation: runs the real prompt builder, the real streaming client and the budget governor
// against the offline mock provider, which simulates cached_tokens (1024-token blocks) and Kimi-like latency
// (cold ~1.15 s, cached ~0.65 s). It drives the HUD speed counter; it never touches the overlay.
import {
  BUNDLED_CALIBRATION, BudgetGovernor, KIMI_PROMPT_SPEC, PromptBuilder, REFERENCE_MATCH, SpeedMeter, DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME,
  resolveProvider, speedSnapshot, streamChat, type KimiSpeedSnapshot,
} from '@tacticlens/core';

export class MockKimiLoad {
  private timer: ReturnType<typeof setInterval> | null = null;
  private budget = new BudgetGovernor({ baseDirectorHz: 3 });
  private speed = new SpeedMeter();
  private builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'mock', calibration: BUNDLED_CALIBRATION });
  private inflight = 0;
  private n = 0;

  constructor(private onSpeed: (s: KimiSpeedSnapshot) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.onSpeed(speedSnapshot(this.budget, this.speed));
    if (this.inflight >= 4 || !this.budget.tryLaunch('director')) return;
    const n = ++this.n;
    const tail = { clock: '12:00', t: n / 3, scene: 'WIDE', ball: { state: 'visible', x: 0.5, y: 0.5 }, live: [3, 7, 9], menu: [], screen: null, calm: { state: 'ready' } };
    const built = this.builder.build({ lane: 'director', match: REFERENCE_MATCH, tail });
    this.inflight++;
    this.budget.begin('director');
    void streamChat({
      provider: resolveProvider('mock', ''), mockProfile: 'kimi',
      request: { lane: 'director', messages: built.messages, schema: { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA }, maxCompletionTokens: 500, reasoningEffort: 'low', framesSent: 0 },
    }).then((r) => {
      const t = r.timing;
      if (r.ok) {
        this.budget.record({ lane: 'director', prompt: t.tokensIn, cached: t.cachedTokens ?? 0, completion: t.tokensOut });
        this.speed.decision();
        this.speed.ttft(t.ttftMs);
      }
    }).finally(() => { this.inflight--; this.budget.end('director'); });
  }
}
