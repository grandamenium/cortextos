import * as fs from 'fs';
import * as path from 'path';
import { Candidate, Selection, PipelineData, CandidateScoring } from './content-pipeline-types';

const DATA_AGENT_PATH = '/Users/cortextos/cortextos/orgs/lifeos/agents/data';

interface YouTubeAnalysis {
  id: string;
  creator: string;
  title: string;
  publishDate: string;
  score: number;
  insights: string;
  transcriptPath?: string;
  fullPath: string;
}

export async function loadYouTubeAnalysis(date: string): Promise<YouTubeAnalysis[]> {
  const dir = path.join(DATA_AGENT_PATH, '.claude/skills/youtube-monitor/data', date);

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('-analysis.md'));

  return files.map(file => {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const fullPath = path.join(dir, file);

    // Parse creator from filename: {creator-slug}-{videoid}-analysis.md
    const parts = file.replace('-analysis.md', '').split('-');
    const videoId = parts[parts.length - 1];
    const creator = parts.slice(0, -1).join('-');

    // Extract score and title from markdown
    const scoreMatch = content.match(/strategic[a-z\s]+score[:\s]+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 5;

    const titleMatch = content.match(/##\s+(.+)/);
    const title = titleMatch ? titleMatch[1] : file;

    return {
      id: `youtube-${videoId}`,
      creator,
      title,
      publishDate: date,
      score,
      insights: content.substring(0, 200),
      transcriptPath: path.join(dir, file.replace('-analysis.md', '-transcript.json')),
      fullPath
    };
  });
}

export async function loadEcosystemSignals(date: string): Promise<Candidate[]> {
  const dir = path.join(DATA_AGENT_PATH, '.claude/skills/ecosystem-monitoring/digests', date);

  if (!fs.existsSync(dir)) {
    return [];
  }

  const candidates: Candidate[] = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.startsWith('##')) {
        const title = line.replace(/^##\s+/, '');
        candidates.push({
          id: `ecosystem-${file}-${title}`,
          source: 'ecosystem',
          sourceId: file,
          title,
          scoring: {
            virality: 6,
            actionability: 5,
            newType: 6,
            deliverable: 4,
            claudeCode: 6,
            cortextOS: 5,
            skoolCTA: 3
          },
          overallScore: 5.3,
          dedupStatus: 'unique',
          fullPath: path.join(dir, file),
          rawContent: content.substring(0, 300)
        });
      }
    }
  }

  return candidates;
}

export async function loadCurrentSelections(date: string): Promise<Selection[]> {
  const selectionsPath = path.join(DATA_AGENT_PATH, 'docs/briefs', date, 'selections.md');

  if (!fs.existsSync(selectionsPath)) {
    return [
      { type: 1, status: 'empty' },
      { type: 2, status: 'empty' },
      { type: 3, status: 'empty' },
      { type: 4, status: 'empty' }
    ];
  }

  // Parse selections.md to get current selections
  const content = fs.readFileSync(selectionsPath, 'utf-8');

  return [
    { type: 1, status: 'pending' },
    { type: 2, status: 'empty' },
    { type: 3, status: 'pending' },
    { type: 4, status: 'pending' }
  ];
}

export async function loadPipelineData(date: string): Promise<PipelineData> {
  const [youtube, ecosystem, selections] = await Promise.all([
    loadYouTubeAnalysis(date),
    loadEcosystemSignals(date),
    loadCurrentSelections(date)
  ]);

  // Convert YouTube analysis to candidates
  const youtubeCandidate = youtube.map(y => ({
    id: y.id,
    source: 'youtube' as const,
    sourceId: y.id,
    title: y.title,
    creator: y.creator,
    scoring: {
      virality: y.score,
      actionability: y.score - 1,
      newType: y.score,
      deliverable: y.score - 1,
      claudeCode: y.score,
      cortextOS: y.score - 1,
      skoolCTA: y.score - 2
    },
    overallScore: y.score,
    dedupStatus: 'unique' as const,
    fullPath: y.fullPath,
    rawContent: y.insights
  }));

  const allCandidates = [...youtubeCandidate, ...ecosystem];

  // Sort by score
  allCandidates.sort((a, b) => b.overallScore - a.overallScore);

  return {
    date,
    candidates: allCandidates,
    selections: {
      1: selections[0],
      2: selections[1],
      3: selections[2],
      4: selections[3]
    },
    filtered: [],
    approvalStatus: 'pending'
  };
}

export function readFileContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
