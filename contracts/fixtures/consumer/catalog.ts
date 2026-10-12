/** Real subject identities with entirely fictional activity. IDs are invalid as Solana addresses. */
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
  subjectUrl: string;
  creatorLabel: string;
  imageUrl: string;
  imageAlt: string;
  imageSourceUrl: string;
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
  { id: 'demo:wallet:ava', label: 'Ava · example profile' },
  { id: 'demo:wallet:ben', label: 'Ben · example profile' },
  { id: 'demo:wallet:cleo', label: 'Cleo · example profile' },
  { id: 'demo:wallet:dex', label: 'Dex · example profile' },
  { id: 'demo:wallet:elle', label: 'Elle · example profile' },
  { id: 'demo:wallet:fox', label: 'Fox · example profile' },
  { id: 'demo:wallet:gia', label: 'Gia · example profile' },
  { id: 'demo:wallet:hal', label: 'Hal · example profile' },
] as const;

export const demoScenarioFixtures: readonly DemoScenarioFixture[] = [
  {
    slug: 'solstice-builders', title: 'Aurora', subtitle: 'NASA science topic · sample history', subject: 'KEYWORD', phase: 'POOL', story: 'GROWTH',
    subjectUrl: 'https://science.nasa.gov/earth/earth-observatory/purple-haze-aurora/', creatorLabel: 'NASA Earth Observatory',
    imageUrl: 'https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/iotd/2026/purple-haze-aurora/ISS075-E-88592_lrg.jpg?crop=faces%2Cfocalpoint&fit=clip&h=4618&w=6927',
    imageAlt: 'Purple and green aurora photographed from the International Space Station', imageSourceUrl: 'https://science.nasa.gov/earth/earth-observatory/purple-haze-aurora/',
    h: [0.82, 1.02, 1.28, 1.62, 1.95, 2.35], priceScale: 0.8,
    calls: [
      { actor: 'ava', openDay: 4, closeDay: 18, openNote: 'The discussion is broadening beyond the launch post.', closeNote: 'Closed after the second week of steady activity.' },
      { actor: 'ben', openDay: 25, closeDay: 33, openNote: 'A new set of builders is joining the conversation.', closeNote: 'Momentum held through the week.' },
      { actor: 'gia', openDay: 32, closeDay: null, openNote: 'Watching whether this level holds.' },
    ],
  },
  {
    slug: 'arcade-hour', title: 'Black holes', subtitle: 'NASA science topic · sample history', subject: 'KEYWORD', phase: 'CURVE', story: 'SLOWDOWN',
    subjectUrl: 'https://science.nasa.gov/universe/black-holes/', creatorLabel: 'NASA Science',
    imageUrl: 'https://assets.science.nasa.gov/dynamicimage/assets/science/astro/universe/2023/09/Black_Hole_Face_on_View-1.png?crop=faces%2Cfocalpoint&fit=clip&h=1599&w=2188',
    imageAlt: 'NASA illustration of a black hole viewed face on', imageSourceUrl: 'https://science.nasa.gov/resource/black-hole/',
    h: [2.4, 2.72, 2.58, 2.05, 1.53, 1.12], curvePrice: [1.02, 1.25, 1.35, 1.21, 1.05, 0.91],
    calls: [
      { actor: 'cleo', openDay: 8, closeDay: 20, openNote: 'The initial burst may persist.', closeNote: 'Activity weakened sooner than I expected.' },
      { actor: 'dex', openDay: 26, closeDay: 34, openNote: 'Testing whether the slide has ended.' },
    ],
  },
  {
    slug: 'paper-robots', title: 'Mars', subtitle: 'NASA science topic · sample history', subject: 'KEYWORD', phase: 'POOL', story: 'REVIVAL',
    subjectUrl: 'https://science.nasa.gov/mars/', creatorLabel: 'NASA Science',
    imageUrl: 'https://assets.science.nasa.gov/dynamicimage/assets/science/psd/mars/downloadable_items/3/6/36082_PIA16018_malin_06rocks_wo_ano1.jpg?crop=faces%2Cfocalpoint&fit=clip&h=1533&w=2108',
    imageAlt: 'Gravel covered surface of Mars photographed by Curiosity', imageSourceUrl: 'https://science.nasa.gov/resource/gravel-covered-martian-surface/',
    h: [1.3, 2.12, 1.45, 0.91, 1.24, 2.18], priceScale: 0.64,
    calls: [
      { actor: 'elle', openDay: 10, closeDay: 21, openNote: 'Early interest looks durable.', closeNote: 'The first wave faded.' },
      { actor: 'fox', openDay: 25, closeDay: 35, openNote: 'A second discussion thread is taking off.', closeNote: 'The revival reached a new high.' },
    ],
  },
  {
    slug: 'rooftop-loop', title: 'Artemis I: launch to splashdown', subtitle: 'NASA video · sample history', subject: 'VIDEO', phase: 'CURVE', story: 'GROWTH',
    subjectUrl: 'https://science.nasa.gov/resource/nasas-artemis-i-moon-mission-launch-to-splashdown-highlights/', creatorLabel: 'NASA',
    imageUrl: 'https://i.ytimg.com/vi/jrDv0OdMt5s/hqdefault.jpg', imageAlt: 'Thumbnail for NASA Artemis I mission highlights video',
    imageSourceUrl: 'https://www.youtube.com/watch?v=jrDv0OdMt5s',
    h: [0.64, 0.79, 1.05, 1.5, 2.4, 3.12], curvePrice: [0.72, 0.78, 0.96, 1.22, 1.56, 1.96],
    calls: [
      { actor: 'hal', openDay: 6, closeDay: 17, openNote: 'The clip is reaching new communities.' },
      { actor: 'ava', openDay: 28, closeDay: 34, openNote: 'Remixes are extending the run.', closeNote: 'Closed while the remix wave was still rising.' },
    ],
  },
  {
    slug: 'one-take-kitchen', title: 'Earth at Night', subtitle: 'NASA video · sample history', subject: 'VIDEO', phase: 'CURVE', story: 'LOSS',
    subjectUrl: 'https://science.nasa.gov/resource/video-lights-of-human-activity-shine-in-nasas-image-of-earth-at-night/', creatorLabel: 'NASA',
    imageUrl: 'https://i.ytimg.com/vi/2TKuumpbcXc/hqdefault.jpg', imageAlt: 'Thumbnail for NASA Earth at Night video',
    imageSourceUrl: 'https://www.youtube.com/watch?v=2TKuumpbcXc',
    h: [2.2, 2.96, 2.37, 1.55, 0.98, 0.71], curvePrice: [0.85, 1.34, 1.22, 1.08, 0.87, 0.79],
    calls: [
      { actor: 'ben', openDay: 9, closeDay: 23, openNote: 'The clip could keep spreading.', closeNote: 'It did not hold the initial audience.' },
      { actor: 'gia', openDay: 28, closeDay: 33, openNote: 'Checking for another sharing wave.' },
    ],
  },
  {
    slug: 'night-market-cut', title: 'Unfold the Universe', subtitle: 'NASA Webb video · sample history', subject: 'VIDEO', phase: 'POOL', story: 'REVIVAL',
    subjectUrl: 'https://science.nasa.gov/resource/its-time-to-unfold-the-universe/', creatorLabel: 'NASA',
    imageUrl: 'https://i.ytimg.com/vi/69uT90tEJdE/hqdefault.jpg', imageAlt: 'Thumbnail for NASA Webb Unfold the Universe video',
    imageSourceUrl: 'https://www.youtube.com/watch?v=69uT90tEJdE',
    h: [1.1, 1.84, 1.17, 0.88, 1.35, 2.42], priceScale: 0.9,
    calls: [
      { actor: 'dex', openDay: 12, closeDay: 22, openNote: 'The first wave still has room.', closeNote: 'I closed as sharing slowed.' },
      { actor: 'cleo', openDay: 27, closeDay: 35, openNote: 'A new edit is circulating.', closeNote: 'The second wave beat the first.' },
    ],
  },
  {
    slug: 'midnight-ferry', title: 'Awake', subtitle: 'Tycho track · sample history', subject: 'TRACK', phase: 'POOL', story: 'GROWTH',
    subjectUrl: 'https://tycho.bandcamp.com/track/awake', creatorLabel: 'Tycho',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e020066c5b73d811eeafab2dbaf', imageAlt: 'Artwork for Awake by Tycho',
    imageSourceUrl: 'https://open.spotify.com/embed/album/2M7ef1A2exhxN6cNxgsruf',
    h: [0.76, 0.88, 1.03, 1.24, 1.51, 1.88], priceScale: 0.72,
    calls: [
      { actor: 'elle', openDay: 3, closeDay: 19, openNote: 'Small playlists are picking this up.' },
      { actor: 'fox', openDay: 28, closeDay: 34, openNote: 'The chorus is finding a broader audience.', closeNote: 'Closed after another week of growth.' },
    ],
  },
  {
    slug: 'blue-window', title: 'Rosewood', subtitle: 'Bonobo track · sample history', subject: 'TRACK', phase: 'CURVE', story: 'SIDEWAYS',
    subjectUrl: 'https://bonobomusic.bandcamp.com/track/rosewood', creatorLabel: 'Bonobo',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02226e702d1878d4a44b273980', imageAlt: 'Fragments artwork for Rosewood by Bonobo',
    imageSourceUrl: 'https://open.spotify.com/embed/album/4KjbNbnTnJ97kZgQkOHr6v',
    h: [1.02, 1.06, 1.01, 1.04, 1.0, 1.03], curvePrice: [0.96, 0.99, 0.97, 1.01, 0.98, 1.0],
    calls: [
      { actor: 'gia', openDay: 5, closeDay: 17, openNote: 'The listener base looks steady.' },
      { actor: 'hal', openDay: 27, closeDay: 34, openNote: 'Trying a short observation window.', closeNote: 'Little changed this week.' },
    ],
  },
  {
    slug: 'first-signal', title: 'May Ninth', subtitle: 'Khruangbin track · sample history', subject: 'TRACK', phase: 'CURVE', story: 'LOSS',
    subjectUrl: 'https://khruangbin.bandcamp.com/track/may-ninth', creatorLabel: 'Khruangbin',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e020aaf76a18898d0b63a9ff455', imageAlt: 'A LA SALA artwork for May Ninth by Khruangbin',
    imageSourceUrl: 'https://open.spotify.com/embed/album/1PeC1ckDJSzYHkwo6JHbP2',
    h: [2.75, 2.35, 1.92, 1.43, 1.07, 0.82], curvePrice: [1.7, 1.49, 1.31, 1.1, 0.94, 0.83],
    calls: [
      { actor: 'ava', openDay: 5, closeDay: 20, openNote: 'The launch audience may return.', closeNote: 'The trend kept slipping.' },
      { actor: 'ben', openDay: 29, closeDay: 35, openNote: 'Looking for a floor.' },
    ],
  },
  {
    slug: 'northbound', title: 'Epoch', subtitle: 'Tycho album · sample history', subject: 'ALBUM', phase: 'POOL', story: 'GROWTH',
    subjectUrl: 'https://tycho.bandcamp.com/album/epoch', creatorLabel: 'Tycho',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e025d91c6e082aa6f4d2a871e53', imageAlt: 'Epoch album artwork by Tycho',
    imageSourceUrl: 'https://open.spotify.com/embed/album/0GXI4iAc5FshqWgIlaNAXO',
    h: [0.69, 0.9, 1.13, 1.48, 1.82, 2.04], priceScale: 0.74,
    calls: [
      { actor: 'cleo', openDay: 7, closeDay: 21, openNote: 'More than one track is being discussed.' },
      { actor: 'dex', openDay: 27, closeDay: 34, openNote: 'Reviews are keeping attention up.', closeNote: 'The release stayed visible.' },
    ],
  },
  {
    slug: 'after-the-rain', title: 'Fragments', subtitle: 'Bonobo album · sample history', subject: 'ALBUM', phase: 'POOL', story: 'REVIVAL',
    subjectUrl: 'https://bonobomusic.bandcamp.com/album/fragments', creatorLabel: 'Bonobo',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02226e702d1878d4a44b273980', imageAlt: 'Fragments album artwork by Bonobo',
    imageSourceUrl: 'https://open.spotify.com/embed/album/4KjbNbnTnJ97kZgQkOHr6v',
    h: [1.79, 1.48, 1.06, 0.83, 1.31, 2.26], priceScale: 0.69,
    calls: [
      { actor: 'fox', openDay: 7, closeDay: 19, openNote: 'Initial reviews look strong.', closeNote: 'Interest tapered after release week.' },
      { actor: 'elle', openDay: 26, closeDay: 35, openNote: 'An older track is bringing listeners back.', closeNote: 'The catalog is moving again.', noteDelayDays: 1 },
    ],
  },
  {
    slug: 'quiet-rooms', title: 'A LA SALA', subtitle: 'Khruangbin album · sample history', subject: 'ALBUM', phase: 'CURVE', story: 'SIDEWAYS',
    subjectUrl: 'https://khruangbin.bandcamp.com/album/a-la-sala', creatorLabel: 'Khruangbin',
    imageUrl: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e020aaf76a18898d0b63a9ff455', imageAlt: 'A LA SALA album artwork by Khruangbin',
    imageSourceUrl: 'https://open.spotify.com/embed/album/1PeC1ckDJSzYHkwo6JHbP2',
    h: [1.14, 1.11, 1.16, 1.09, 1.13, 1.12], curvePrice: [1.05, 1.06, 1.04, 1.07, 1.05, 1.06],
    calls: [
      { actor: 'hal', openDay: 8, closeDay: 19, openNote: 'Consistent niche interest.' },
      { actor: 'gia', openDay: 29, closeDay: 35, openNote: 'I expect a modest week.', closeNote: 'Almost flat, as expected.' },
    ],
  },
  {
    slug: 'orbit-atelier', title: 'Svelte', subtitle: 'GitHub organization · sample history', subject: 'ACCOUNT', phase: 'POOL', story: 'GROWTH',
    subjectUrl: 'https://github.com/sveltejs', creatorLabel: 'Svelte',
    imageUrl: 'https://avatars.githubusercontent.com/u/23617963?s=200&v=4', imageAlt: 'Svelte organization avatar on GitHub', imageSourceUrl: 'https://github.com/sveltejs',
    h: [0.94, 1.14, 1.46, 1.74, 2.03, 2.38], priceScale: 0.78,
    calls: [
      { actor: 'ben', openDay: 6, closeDay: 21, openNote: 'The account is becoming a regular source.' },
      { actor: 'ava', openDay: 28, closeDay: 35, openNote: 'The weekly reach is still growing.', closeNote: 'Closed after another positive week.' },
    ],
  },
  {
    slug: 'weekend-letters', title: 'Vite', subtitle: 'GitHub organization · sample history', subject: 'ACCOUNT', phase: 'CURVE', story: 'SLOWDOWN',
    subjectUrl: 'https://github.com/vitejs', creatorLabel: 'Vite',
    imageUrl: 'https://avatars.githubusercontent.com/u/65625612?s=200&v=4', imageAlt: 'Vite organization avatar on GitHub', imageSourceUrl: 'https://github.com/vitejs',
    h: [2.12, 2.45, 2.2, 1.73, 1.28, 0.93], curvePrice: [1.23, 1.37, 1.28, 1.12, 0.96, 0.84], missingDays: [15, 16, 17],
    calls: [
      { actor: 'dex', openDay: 9, closeDay: 23, openNote: 'The weekly format could sustain attention.', closeNote: 'Updates slowed down.' },
      { actor: 'fox', openDay: 27, closeDay: 35, openNote: 'Watching the next issue.', noteDelayDays: 1 },
    ],
  },
  {
    slug: 'new-frequency', title: 'Deno', subtitle: 'GitHub organization · sample history', subject: 'ACCOUNT', phase: 'PREVIEW', story: 'WAITING',
    subjectUrl: 'https://github.com/denoland', creatorLabel: 'Deno',
    imageUrl: 'https://avatars.githubusercontent.com/u/42048915?s=200&v=4', imageAlt: 'Deno organization avatar on GitHub', imageSourceUrl: 'https://github.com/denoland',
    h: [0.58, 0.63, 0.71, 0.69, 0.77, 0.82],
    calls: [
      { actor: 'cleo', openDay: 8, closeDay: 22, openNote: 'Recording an early view of activity.' },
      { actor: 'elle', openDay: 30, closeDay: null, openNote: 'Waiting for a clearer trend.', noteDelayDays: 1 },
    ],
  },
] as const;
