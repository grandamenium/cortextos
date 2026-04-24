'use client';

import { useState } from 'react';
import { PipelineData, Candidate, formatScore } from '@/lib/content-pipeline-types';
import { CandidateCard } from './candidate-card';
import { SelectionSlots } from './selection-slots';
import { DetailModal } from './detail-modal';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface ContentPipelineDashboardProps {
  data: PipelineData;
  date: string;
}

export function ContentPipelineDashboard({ data, date }: ContentPipelineDashboardProps) {
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selections, setSelections] = useState(data.selections);
  const [showFiltered, setShowFiltered] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<'pending' | 'approved'>('pending');

  const handleSelectCandidate = (candidateId: string, type: number) => {
    const candidate = data.candidates.find(c => c.id === candidateId);
    if (candidate) {
      setSelections(prev => ({
        ...prev,
        [type]: {
          ...prev[type as 1 | 2 | 3 | 4],
          candidate,
          status: 'pending'
        }
      }));
    }
  };

  const handleApprove = async () => {
    setApprovalStatus('approved');
    // In real implementation, would send to backend to trigger enrichment workflow
    console.log('Approving selections:', selections);
  };

  const filledSlots = Object.values(selections).filter(s => s.candidate).length;
  const totalSlots = 4;

  return (
    <div className="grid grid-cols-4 gap-6">
      {/* Main Content Area */}
      <div className="col-span-3 space-y-6">
        {/* Candidates Section */}
        <Card className="p-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Candidates ({data.candidates.length})</h2>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowFiltered(!showFiltered)}>
                  {showFiltered ? 'Show All' : `Show Filtered (${data.filtered.length})`}
                </Button>
              </div>
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {data.candidates.map(candidate => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  onSelectType={(type) => handleSelectCandidate(candidate.id, type)}
                  onView={() => setSelectedCandidate(candidate)}
                />
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Sidebar: Selection Interface */}
      <div className="space-y-6">
        <Card className="p-6 sticky top-6">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Selections</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {filledSlots}/{totalSlots} filled
              </p>
            </div>

            <SelectionSlots
              selections={selections}
              onSelectCandidate={handleSelectCandidate}
              candidates={data.candidates}
            />

            <div className="space-y-2 pt-4 border-t">
              <div className="text-sm font-medium">Approval Status</div>
              <div className="text-xs text-muted-foreground">
                {approvalStatus === 'approved' ? (
                  <div className="text-green-600">✓ Approved</div>
                ) : (
                  <div>{filledSlots}/{totalSlots} ready</div>
                )}
              </div>

              {approvalStatus === 'pending' && (
                <Button
                  onClick={handleApprove}
                  disabled={filledSlots < 4}
                  className="w-full mt-2"
                  size="sm"
                >
                  Approve All
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Detail Modal */}
      {selectedCandidate && (
        <DetailModal
          candidate={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          onSelect={(type) => {
            handleSelectCandidate(selectedCandidate.id, type);
            setSelectedCandidate(null);
          }}
        />
      )}
    </div>
  );
}
