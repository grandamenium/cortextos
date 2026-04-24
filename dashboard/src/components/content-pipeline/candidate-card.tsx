'use client';

import { Candidate, formatScore } from '@/lib/content-pipeline-types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface CandidateCardProps {
  candidate: Candidate;
  onSelectType: (type: number) => void;
  onView: () => void;
}

export function CandidateCard({ candidate, onSelectType, onView }: CandidateCardProps) {
  const score = parseFloat(formatScore(candidate.scoring));

  return (
    <Card className="p-4 hover:bg-accent/50 transition-colors">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium truncate">{candidate.title}</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {candidate.source === 'youtube' && `${candidate.creator} • YouTube`}
              {candidate.source === 'ecosystem' && `${candidate.sourceId} • Ecosystem`}
              {candidate.source === 'james-send' && 'James • Manual Send'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">{score.toFixed(1)}</div>
            <div className="text-xs text-muted-foreground">/10</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary" className="text-xs">
            V: {candidate.scoring.virality}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            A: {candidate.scoring.actionability}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            C: {candidate.scoring.claudeCode}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            CX: {candidate.scoring.cortextOS}
          </Badge>
        </div>

        {candidate.dedupStatus === 'conflict' && (
          <div className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
            ⚠️ Potential duplicate with {candidate.conflictWith}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onView}
            className="flex-1"
          >
            View
          </Button>
          <select
            onChange={(e) => {
              if (e.target.value) {
                onSelectType(parseInt(e.target.value));
                e.target.value = '';
              }
            }}
            defaultValue=""
            className="px-2 py-1 text-xs border rounded bg-background"
          >
            <option value="">Add to...</option>
            <option value="1">Type 1</option>
            <option value="2">Type 2</option>
            <option value="3">Type 3</option>
            <option value="4">Type 4</option>
          </select>
        </div>
      </div>
    </Card>
  );
}
