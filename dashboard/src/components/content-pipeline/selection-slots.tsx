'use client';

import { Selection, Candidate } from '@/lib/content-pipeline-types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

interface SelectionSlotsProps {
  selections: Record<number, Selection>;
  onSelectCandidate: (candidateId: string, type: number) => void;
  candidates: Candidate[];
}

const typeLabels = {
  1: 'Type 1 — Educational Technical',
  2: 'Type 2 — Educational Technical #2',
  3: 'Type 3 — cortextOS Showcase',
  4: 'Type 4 — Opinion Piece'
};

export function SelectionSlots({ selections, onSelectCandidate, candidates }: SelectionSlotsProps) {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((type) => {
        const selection = selections[type as 1 | 2 | 3 | 4];
        const candidate = selection.candidate;

        return (
          <div key={type} className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {typeLabels[type as keyof typeof typeLabels]}
            </label>
            {candidate ? (
              <div className="bg-primary/10 p-3 rounded border border-primary/20">
                <div className="text-sm font-medium truncate">{candidate.title}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Score: {candidate.overallScore.toFixed(1)}/10
                </div>
              </div>
            ) : (
              <div className="border-2 border-dashed border-muted-foreground/30 p-3 rounded text-center">
                <select
                  onChange={(e) => {
                    if (e.target.value) {
                      onSelectCandidate(e.target.value, type);
                      e.target.value = '';
                    }
                  }}
                  defaultValue=""
                  className="w-full text-xs bg-transparent border-0 p-0 cursor-pointer"
                >
                  <option value="">+ Add topic</option>
                  {candidates.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.title.substring(0, 50)}... ({c.overallScore.toFixed(1)})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
