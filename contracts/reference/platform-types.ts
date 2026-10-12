/** Captured native platform metrics. Read-only and never settlement inputs. */
export interface PlatformReference {
  slug: string;
  title: string;
  subject: 'VIDEO' | 'TRACK' | 'POST';
  platform: 'YouTube' | 'X' | 'Spotify';
  creatorLabel: string;
  subjectUrl: string;
  imageUrl: string;
  imageSourceUrl: string;
  imageAlt: string;
  metric: {
    kind: 'YOUTUBE_VIEWS' | 'X_LIKES' | 'SPOTIFY_STREAMS';
    value: string;
    unit: 'views' | 'likes' | 'streams';
    label: string;
    capturedAt: string;
    /** Provider's observation timestamp, when available; otherwise capture time. */
    asOf: string;
    reportedDate?: string;
    sourceUrl: string;
    provider: string;
    sourceType: 'PLATFORM' | 'THIRD_PARTY';
    rawFile: string;
    rawSha256: string;
    extraction: string;
  };
}
