/** Public subjects only. Metric mappings are explicit; no artist/album proxy for track plays. */
export interface ReferenceSubject {
  slug: string;
  title: string;
  subject: 'KEYWORD' | 'VIDEO' | 'TRACK' | 'ALBUM' | 'ACCOUNT';
  creatorLabel: string;
  subjectUrl: string;
  imageAlt: string;
  wikipediaArticle?: string;
  githubLogin?: string;
  youtubeId?: string;
}

export const referenceSubjects: readonly ReferenceSubject[] = [
  { slug: 'aurora', title: 'Aurora', subject: 'KEYWORD', creatorLabel: 'NASA Earth Observatory',
    subjectUrl: 'https://science.nasa.gov/earth/earth-observatory/purple-haze-aurora/',
    imageAlt: 'Aurora photographed from the International Space Station', wikipediaArticle: 'Aurora' },
  { slug: 'black-holes', title: 'Black holes', subject: 'KEYWORD', creatorLabel: 'NASA Science',
    subjectUrl: 'https://science.nasa.gov/universe/black-holes/',
    imageAlt: 'Black hole illustration from NASA Science', wikipediaArticle: 'Black_hole' },
  { slug: 'mars', title: 'Mars', subject: 'KEYWORD', creatorLabel: 'NASA Science',
    subjectUrl: 'https://science.nasa.gov/mars/',
    imageAlt: 'Mars image from NASA Science', wikipediaArticle: 'Mars' },
  { slug: 'artemis-i-highlights', title: 'Artemis I: launch to splashdown', subject: 'VIDEO', creatorLabel: 'NASA',
    subjectUrl: 'https://science.nasa.gov/resource/nasas-artemis-i-moon-mission-launch-to-splashdown-highlights/',
    imageAlt: 'NASA Artemis I mission highlights video thumbnail', youtubeId: 'jrDv0OdMt5s' },
  { slug: 'earth-at-night', title: 'Earth at Night', subject: 'VIDEO', creatorLabel: 'NASA',
    subjectUrl: 'https://science.nasa.gov/resource/video-lights-of-human-activity-shine-in-nasas-image-of-earth-at-night/',
    imageAlt: 'NASA Earth at Night video thumbnail', youtubeId: '2TKuumpbcXc' },
  { slug: 'unfold-the-universe', title: 'Unfold the Universe', subject: 'VIDEO', creatorLabel: 'NASA',
    subjectUrl: 'https://science.nasa.gov/resource/its-time-to-unfold-the-universe/',
    imageAlt: 'NASA Webb Unfold the Universe video thumbnail', youtubeId: '69uT90tEJdE' },
  { slug: 'tycho-awake', title: 'Awake', subject: 'TRACK', creatorLabel: 'Tycho',
    subjectUrl: 'https://tycho.bandcamp.com/track/awake', imageAlt: 'Awake artwork by Tycho' },
  { slug: 'bonobo-rosewood', title: 'Rosewood', subject: 'TRACK', creatorLabel: 'Bonobo',
    subjectUrl: 'https://bonobomusic.bandcamp.com/track/rosewood', imageAlt: 'Fragments artwork for Rosewood by Bonobo' },
  { slug: 'khruangbin-may-ninth', title: 'May Ninth', subject: 'TRACK', creatorLabel: 'Khruangbin',
    subjectUrl: 'https://khruangbin.bandcamp.com/track/may-ninth', imageAlt: 'A LA SALA artwork for May Ninth by Khruangbin' },
  { slug: 'tycho-epoch', title: 'Epoch', subject: 'ALBUM', creatorLabel: 'Tycho',
    subjectUrl: 'https://tycho.bandcamp.com/album/epoch', imageAlt: 'Epoch album artwork by Tycho', wikipediaArticle: 'Epoch_(Tycho_album)' },
  { slug: 'bonobo-fragments', title: 'Fragments', subject: 'ALBUM', creatorLabel: 'Bonobo',
    subjectUrl: 'https://bonobomusic.bandcamp.com/album/fragments', imageAlt: 'Fragments album artwork by Bonobo', wikipediaArticle: 'Fragments_(Bonobo_album)' },
  { slug: 'khruangbin-a-la-sala', title: 'A LA SALA', subject: 'ALBUM', creatorLabel: 'Khruangbin',
    subjectUrl: 'https://khruangbin.bandcamp.com/album/a-la-sala', imageAlt: 'A LA SALA album artwork by Khruangbin', wikipediaArticle: 'A_La_Sala' },
  { slug: 'svelte-github', title: 'Svelte', subject: 'ACCOUNT', creatorLabel: 'Svelte',
    subjectUrl: 'https://github.com/sveltejs', imageAlt: 'Official Svelte GitHub organization avatar', githubLogin: 'sveltejs' },
  { slug: 'vite-github', title: 'Vite', subject: 'ACCOUNT', creatorLabel: 'Vite',
    subjectUrl: 'https://github.com/vitejs', imageAlt: 'Official Vite GitHub organization avatar', githubLogin: 'vitejs' },
  { slug: 'deno-github', title: 'Deno', subject: 'ACCOUNT', creatorLabel: 'Deno',
    subjectUrl: 'https://github.com/denoland', imageAlt: 'Official Deno GitHub organization avatar', githubLogin: 'denoland' },
];
