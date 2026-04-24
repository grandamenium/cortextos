'use client';

import { Candidate, formatScore } from '@/lib/content-pipeline-types';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface DetailModalProps {
  candidate: Candidate;
  onClose: () => void;
  onSelect: (type: number) => void;
}

export function DetailModal({ candidate, onClose, onSelect }: DetailModalProps) {
  const score = parseFloat(formatScore(candidate.scoring));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-end z-50 overflow-y-auto">
      <div className="bg-background w-full max-w-2xl h-screen flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex-1">
            <h2 className="text-xl font-semibold">{candidate.title}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {candidate.source === 'youtube' && `${candidate.creator} • YouTube`}
              {candidate.source === 'ecosystem' && `${candidate.sourceId} • Ecosystem`}
              {candidate.source === 'james-send' && 'James • Manual Send'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-accent rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Scoring */}
          <div className="space-y-3">
            <h3 className="font-semibold text-sm">Scoring Breakdown</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Virality</label>
                <div className="text-lg font-bold">{candidate.scoring.virality}/10</div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Actionability</label>
                <div className="text-lg font-bold">{candidate.scoring.actionability}/10</div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Claude Code</label>
                <div className="text-lg font-bold">{candidate.scoring.claudeCode}/10</div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">cortextOS</label>
                <div className="text-lg font-bold">{candidate.scoring.cortextOS}/10</div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Deliverable</label>
                <div className="text-lg font-bold">{candidate.scoring.deliverable}/10</div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Skool CTA</label>
                <div className="text-lg font-bold">{candidate.scoring.skoolCTA}/10</div>
              </div>
            </div>
            <div className="text-center py-3 bg-primary/10 rounded">
              <div className="text-xs text-muted-foreground">Overall Score</div>
              <div className="text-3xl font-bold">{score.toFixed(1)}/10</div>
            </div>
          </div>

          {/* Content Preview */}
          {candidate.rawContent && (
            <div className="space-y-3">
              <h3 className="font-semibold text-sm">Content Preview</h3>
              <div className="bg-muted p-4 rounded text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
                {candidate.rawContent}
              </div>
            </div>
          )}

          {/* Dedup Status */}
          <div className="space-y-3">
            <h3 className="font-semibold text-sm">Dedup Status</h3>
            {candidate.dedupStatus === 'unique' ? (
              <Badge className="bg-green-100 text-green-800">
                ✓ Unique — No conflicts
              </Badge>
            ) : candidate.dedupStatus === 'conflict' ? (
              <Badge className="bg-amber-100 text-amber-800">
                ⚠️ Potential duplicate with {candidate.conflictWith}
              </Badge>
            ) : (
              <Badge variant="secondary">✓ Reviewed</Badge>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-6 border-t">
          <Button variant="outline" onClick={onClose} className="flex-1">
            Close
          </Button>
          <select
            onChange={(e) => {
              if (e.target.value) {
                onSelect(parseInt(e.target.value));
              }
            }}
            defaultValue=""
            className="px-3 py-2 border rounded bg-background text-sm"
          >
            <option value="">Select Type...</option>
            <option value="1">Type 1 — Educational Technical</option>
            <option value="2">Type 2 — Educational Technical #2</option>
            <option value="3">Type 3 — cortextOS Showcase</option>
            <option value="4">Type 4 — Opinion Piece</option>
          </select>
        </div>
      </div>
    </div>
  );
}
