import fs from 'fs';
import path from 'path';
import { getAgentDir } from '@/lib/config';

export interface TrendingPick {
  repo: string;
  url: string;
  reason: string;
  verdict: 'steal' | 'skip' | 'unknown';
  stars: number;
  language: string;
  description: string;
  readmeExcerpt: string;
}

export interface TrendingData {
  date: string | null;
  availableDates: string[];
  picks: TrendingPick[];
  error?: 'parse';
}

interface RawTrendingPick {
  repo?: string;
  url?: string;
  one_line_steal_reason?: string;
  stars?: number;
  language?: string | null;
  description?: string;
  readme_excerpt?: string;
}

interface RawTrendingFile {
  date?: string;
  picks?: RawTrendingPick[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTrendingDate(value: string | undefined): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

export function parseTrendingReason(oneLineStealReason?: string): {
  verdict: 'steal' | 'skip' | 'unknown';
  reason: string;
} {
  const raw = oneLineStealReason?.trim() ?? '';
  const upper = raw.toUpperCase();

  if (upper.startsWith('STEAL')) {
    return {
      verdict: 'steal',
      reason: raw.replace(/^STEAL\s*[—-]?\s*/i, '').trim(),
    };
  }

  if (upper.startsWith('SKIP')) {
    return {
      verdict: 'skip',
      reason: raw.replace(/^SKIP\s*[—-]?\s*/i, '').trim(),
    };
  }

  return {
    verdict: 'unknown',
    reason: raw,
  };
}

function listHistoryDates(historyDir: string): string[] {
  if (!fs.existsSync(historyDir)) return [];

  try {
    return fs
      .readdirSync(historyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && DATE_PATTERN.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function readTrendingFile(filePath: string): { data: RawTrendingFile | null; error?: 'parse' } {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawTrendingFile;
    return { data: parsed };
  } catch {
    return { data: null, error: 'parse' };
  }
}

function normalizeTrendingPicks(rawPicks: RawTrendingPick[] | undefined): TrendingPick[] {
  if (!Array.isArray(rawPicks)) return [];

  return rawPicks.map((pick) => {
    const parsedReason = parseTrendingReason(pick.one_line_steal_reason);

    return {
      repo: typeof pick.repo === 'string' ? pick.repo : '',
      url: typeof pick.url === 'string' ? pick.url : '',
      reason: parsedReason.reason,
      verdict: parsedReason.verdict,
      stars: typeof pick.stars === 'number' ? pick.stars : 0,
      language: typeof pick.language === 'string' ? pick.language : '',
      description: typeof pick.description === 'string' ? pick.description : '',
      readmeExcerpt: typeof pick.readme_excerpt === 'string' ? pick.readme_excerpt : '',
    };
  });
}

export function getTrending(selectedDate?: string): TrendingData {
  const memoryDir = path.join(getAgentDir('frank2', 'clearworksai'), 'memory');
  const historyDir = path.join(memoryDir, 'trending-history');
  const fallbackPath = path.join(memoryDir, 'trending-picks.json');

  let availableDates = listHistoryDates(historyDir);

  if (availableDates.length === 0 && fs.existsSync(fallbackPath)) {
    const fallback = readTrendingFile(fallbackPath);
    const fallbackDate = fallback.data?.date;
    if (isValidTrendingDate(fallbackDate)) {
      availableDates = [fallbackDate];
    }
    if (fallback.error) {
      return {
        date: isValidTrendingDate(fallbackDate) ? fallbackDate : null,
        availableDates,
        picks: [],
        error: 'parse',
      };
    }
    if (fallback.data) {
      return {
        date: isValidTrendingDate(fallbackDate) ? fallbackDate : null,
        availableDates,
        picks: normalizeTrendingPicks(fallback.data.picks),
      };
    }
  }

  if (availableDates.length === 0) {
    return { date: null, availableDates: [], picks: [] };
  }

  const resolvedDate = isValidTrendingDate(selectedDate) && availableDates.includes(selectedDate)
    ? selectedDate
    : availableDates[0];

  const filePath = path.join(historyDir, `${resolvedDate}.json`);
  const result = readTrendingFile(filePath);
  if (result.error) {
    return {
      date: resolvedDate,
      availableDates,
      picks: [],
      error: 'parse',
    };
  }

  return {
    date: isValidTrendingDate(result.data?.date) ? result.data?.date : resolvedDate,
    availableDates,
    picks: normalizeTrendingPicks(result.data?.picks),
  };
}
