/** Public provider observations; neither token quotes nor settlement inputs. */
export interface PlatformHistoryReference {
  slug: string;
  title: string;
  subject: 'VIDEO' | 'TRACK';
  platform: 'YouTube' | 'Spotify';
  creatorLabel: string;
  subjectUrl: string;
  imageUrl: string;
  imageSourceUrl: string;
  imageAlt: string;
  aggregation: 'cumulative' | 'daily';
  label: string;
  unit: 'streams' | 'views';
  provider: string;
  sourceType: 'THIRD_PARTY';
  sourceUrl: string;
  capturedAt: string;
  metadataVerifiedAt?: string;
  /** True when counts are restricted to Spotify chart-eligible streams. */
  chartEligible: boolean;
  scope: string;
  /** Date-only provider labels have no inferred time of day or timezone. */
  datePrecision: 'day';
  rawFile: string;
  rawSha256: string;
  points: readonly {
    date: string;
    value: string;
    sourceUrl: string;
    rawFile: string;
    /** SHA-256 of the extract containing this exact date, value, and source URL. */
    rawSha256: string;
  }[];
}
