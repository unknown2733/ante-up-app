/** Fictional scenarios. These IDs are deliberately invalid as Solana addresses. */
export interface DemoCallFixture {
  actor: string;
  openDay: number;
  closeDay: number | null;
  openNote: string;
  closeNote?: string;
  noteDelayDays?: number;
}

export interface DemoScenarioFixture {
  slug: string;
  title: string;
  subtitle: string;
  subject: 'KEYWORD' | 'VIDEO' | 'TRACK' | 'ALBUM' | 'ACCOUNT';
  phase: 'CURVE' | 'POOL' | 'PREVIEW';
  story: 'GROWTH' | 'SLOWDOWN' | 'REVIVAL' | 'LOSS' | 'SIDEWAYS' | 'WAITING';
  /** Six weekly synthetic h anchors, spanning exactly five weeks. */
  h: readonly [number, number, number, number, number, number];
  /** Curve quotes are independent illustrative values; POOL references use priceScale × h. */
  curvePrice?: readonly [number, number, number, number, number, number];
  priceScale?: number;
  missingDays?: readonly number[];
  calls: readonly DemoCallFixture[];
}

export const demoActors = [
  { id: 'demo:wallet:ava', label: 'Ava · demo wallet' },
  { id: 'demo:wallet:ben', label: 'Ben · demo wallet' },
  { id: 'demo:wallet:cleo', label: 'Cleo · demo wallet' },
  { id: 'demo:wallet:dex', label: 'Dex · demo wallet' },
  { id: 'demo:wallet:elle', label: 'Elle · demo wallet' },
  { id: 'demo:wallet:fox', label: 'Fox · demo wallet' },
  { id: 'demo:wallet:gia', label: 'Gia · demo wallet' },
  { id: 'demo:wallet:hal', label: 'Hal · demo wallet' },
] as const;

export const demoScenarioFixtures: readonly DemoScenarioFixture[] = [
  {
    slug: 'solstice-builders', title: 'Solstice builders', subtitle: 'Fictional keyword · steady climb', subject: 'KEYWORD', phase: 'POOL', story: 'GROWTH',
    h: [0.82, 1.02, 1.28, 1.62, 1.95, 2.35], priceScale: 0.8,
    calls: [
      { actor: 'ava', openDay: 4, closeDay: 18, openNote: 'The discussion is broadening beyond the launch post.', closeNote: 'Closed after the second week of steady activity.' },
      { actor: 'ben', openDay: 25, closeDay: 33, openNote: 'A new set of builders is joining the conversation.', closeNote: 'Momentum held through the week.' },
      { actor: 'gia', openDay: 32, closeDay: null, openNote: 'Watching whether this level holds.' },
    ],
  },
  {
    slug: 'arcade-hour', title: 'Arcade hour', subtitle: 'Fictional keyword · cooling off', subject: 'KEYWORD', phase: 'CURVE', story: 'SLOWDOWN',
    h: [2.4, 2.72, 2.58, 2.05, 1.53, 1.12], curvePrice: [1.02, 1.25, 1.35, 1.21, 1.05, 0.91],
    calls: [
      { actor: 'cleo', openDay: 8, closeDay: 20, openNote: 'The initial burst may persist.', closeNote: 'Activity weakened sooner than I expected.' },
      { actor: 'dex', openDay: 26, closeDay: 34, openNote: 'Testing whether the slide has ended.' },
    ],
  },
  {
    slug: 'paper-robots', title: 'Paper robots', subtitle: 'Fictional keyword · second wave', subject: 'KEYWORD', phase: 'POOL', story: 'REVIVAL',
    h: [1.3, 2.12, 1.45, 0.91, 1.24, 2.18], priceScale: 0.64,
    calls: [
      { actor: 'elle', openDay: 10, closeDay: 21, openNote: 'Early interest looks durable.', closeNote: 'The first wave faded.' },
      { actor: 'fox', openDay: 25, closeDay: 35, openNote: 'A second discussion thread is taking off.', closeNote: 'The revival reached a new high.' },
    ],
  },
  {
    slug: 'rooftop-loop', title: 'Rooftop loop', subtitle: 'Fictional video · breakout', subject: 'VIDEO', phase: 'CURVE', story: 'GROWTH',
    h: [0.64, 0.79, 1.05, 1.5, 2.4, 3.12], curvePrice: [0.72, 0.78, 0.96, 1.22, 1.56, 1.96],
    calls: [
      { actor: 'hal', openDay: 6, closeDay: 17, openNote: 'The clip is reaching new communities.' },
      { actor: 'ava', openDay: 28, closeDay: 34, openNote: 'Remixes are extending the run.', closeNote: 'Closed while the remix wave was still rising.' },
    ],
  },
  {
    slug: 'one-take-kitchen', title: 'One-take kitchen', subtitle: 'Fictional video · early peak', subject: 'VIDEO', phase: 'CURVE', story: 'LOSS',
    h: [2.2, 2.96, 2.37, 1.55, 0.98, 0.71], curvePrice: [0.85, 1.34, 1.22, 1.08, 0.87, 0.79],
    calls: [
      { actor: 'ben', openDay: 9, closeDay: 23, openNote: 'The clip could keep spreading.', closeNote: 'It did not hold the initial audience.' },
      { actor: 'gia', openDay: 28, closeDay: 33, openNote: 'Checking for another sharing wave.' },
    ],
  },
  {
    slug: 'night-market-cut', title: 'Night market cut', subtitle: 'Fictional video · renewed sharing', subject: 'VIDEO', phase: 'POOL', story: 'REVIVAL',
    h: [1.1, 1.84, 1.17, 0.88, 1.35, 2.42], priceScale: 0.9,
    calls: [
      { actor: 'dex', openDay: 12, closeDay: 22, openNote: 'The first wave still has room.', closeNote: 'I closed as sharing slowed.' },
      { actor: 'cleo', openDay: 27, closeDay: 35, openNote: 'A new edit is circulating.', closeNote: 'The second wave beat the first.' },
    ],
  },
  {
    slug: 'midnight-ferry', title: 'Midnight Ferry', subtitle: 'Fictional track · gradual lift', subject: 'TRACK', phase: 'POOL', story: 'GROWTH',
    h: [0.76, 0.88, 1.03, 1.24, 1.51, 1.88], priceScale: 0.72,
    calls: [
      { actor: 'elle', openDay: 3, closeDay: 19, openNote: 'Small playlists are picking this up.' },
      { actor: 'fox', openDay: 28, closeDay: 34, openNote: 'The chorus is finding a broader audience.', closeNote: 'Closed after another week of growth.' },
    ],
  },
  {
    slug: 'blue-window', title: 'Blue Window', subtitle: 'Fictional track · narrow range', subject: 'TRACK', phase: 'CURVE', story: 'SIDEWAYS',
    h: [1.02, 1.06, 1.01, 1.04, 1.0, 1.03], curvePrice: [0.96, 0.99, 0.97, 1.01, 0.98, 1.0],
    calls: [
      { actor: 'gia', openDay: 5, closeDay: 17, openNote: 'The listener base looks steady.' },
      { actor: 'hal', openDay: 27, closeDay: 34, openNote: 'Trying a short observation window.', closeNote: 'Little changed this week.' },
    ],
  },
  {
    slug: 'first-signal', title: 'First Signal', subtitle: 'Fictional track · fading launch', subject: 'TRACK', phase: 'CURVE', story: 'LOSS',
    h: [2.75, 2.35, 1.92, 1.43, 1.07, 0.82], curvePrice: [1.7, 1.49, 1.31, 1.1, 0.94, 0.83],
    calls: [
      { actor: 'ava', openDay: 5, closeDay: 20, openNote: 'The launch audience may return.', closeNote: 'The trend kept slipping.' },
      { actor: 'ben', openDay: 29, closeDay: 35, openNote: 'Looking for a floor.' },
    ],
  },
  {
    slug: 'northbound', title: 'Northbound', subtitle: 'Fictional album · discovery phase', subject: 'ALBUM', phase: 'POOL', story: 'GROWTH',
    h: [0.69, 0.9, 1.13, 1.48, 1.82, 2.04], priceScale: 0.74,
    calls: [
      { actor: 'cleo', openDay: 7, closeDay: 21, openNote: 'More than one track is being discussed.' },
      { actor: 'dex', openDay: 27, closeDay: 34, openNote: 'Reviews are keeping attention up.', closeNote: 'The release stayed visible.' },
    ],
  },
  {
    slug: 'after-the-rain', title: 'After the Rain', subtitle: 'Fictional album · rediscovery', subject: 'ALBUM', phase: 'POOL', story: 'REVIVAL',
    h: [1.79, 1.48, 1.06, 0.83, 1.31, 2.26], priceScale: 0.69,
    calls: [
      { actor: 'fox', openDay: 7, closeDay: 19, openNote: 'Initial reviews look strong.', closeNote: 'Interest tapered after release week.' },
      { actor: 'elle', openDay: 26, closeDay: 35, openNote: 'An older track is bringing listeners back.', closeNote: 'The catalog is moving again.', noteDelayDays: 1 },
    ],
  },
  {
    slug: 'quiet-rooms', title: 'Quiet Rooms', subtitle: 'Fictional album · steady catalog', subject: 'ALBUM', phase: 'CURVE', story: 'SIDEWAYS',
    h: [1.14, 1.11, 1.16, 1.09, 1.13, 1.12], curvePrice: [1.05, 1.06, 1.04, 1.07, 1.05, 1.06],
    calls: [
      { actor: 'hal', openDay: 8, closeDay: 19, openNote: 'Consistent niche interest.' },
      { actor: 'gia', openDay: 29, closeDay: 35, openNote: 'I expect a modest week.', closeNote: 'Almost flat, as expected.' },
    ],
  },
  {
    slug: 'orbit-atelier', title: 'Orbit Atelier', subtitle: 'Fictional account · growing reach', subject: 'ACCOUNT', phase: 'POOL', story: 'GROWTH',
    h: [0.94, 1.14, 1.46, 1.74, 2.03, 2.38], priceScale: 0.78,
    calls: [
      { actor: 'ben', openDay: 6, closeDay: 21, openNote: 'The account is becoming a regular source.' },
      { actor: 'ava', openDay: 28, closeDay: 35, openNote: 'The weekly reach is still growing.', closeNote: 'Closed after another positive week.' },
    ],
  },
  {
    slug: 'weekend-letters', title: 'Weekend Letters', subtitle: 'Fictional account · slower updates', subject: 'ACCOUNT', phase: 'CURVE', story: 'SLOWDOWN',
    h: [2.12, 2.45, 2.2, 1.73, 1.28, 0.93], curvePrice: [1.23, 1.37, 1.28, 1.12, 0.96, 0.84], missingDays: [15, 16, 17],
    calls: [
      { actor: 'dex', openDay: 9, closeDay: 23, openNote: 'The weekly format could sustain attention.', closeNote: 'Updates slowed down.' },
      { actor: 'fox', openDay: 27, closeDay: 35, openNote: 'Watching the next issue.', noteDelayDays: 1 },
    ],
  },
  {
    slug: 'new-frequency', title: 'New Frequency', subtitle: 'Fictional account · no price yet', subject: 'ACCOUNT', phase: 'PREVIEW', story: 'WAITING',
    h: [0.58, 0.63, 0.71, 0.69, 0.77, 0.82],
    calls: [
      { actor: 'cleo', openDay: 8, closeDay: 22, openNote: 'Recording an early view of activity.' },
      { actor: 'elle', openDay: 30, closeDay: null, openNote: 'Waiting for a clearer trend.', noteDelayDays: 1 },
    ],
  },
] as const;
