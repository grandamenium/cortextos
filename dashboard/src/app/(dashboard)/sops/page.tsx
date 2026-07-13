import { Card, CardContent } from '@/components/ui/card';
import { LaneHeader } from '@/components/pulse/pulse-ui';
import { getSopIndex } from '@/lib/data/sops';
import { SopLibrary } from '@/components/sops/sop-library';

export const dynamic = 'force-dynamic';

export default async function SopLibraryPage() {
  const data = await getSopIndex();

  if (data.state !== 'ready') {
    return (
      <div className="mx-auto max-w-6xl space-y-6 pb-12">
        <LaneHeader label="SOP Library" sub="46 playbooks, every external action human-gated" />
        <Card className="border-dashed">
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-lg font-semibold">SOP Library unavailable</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{data.reason}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <SopLibrary rows={data.rows} />
    </div>
  );
}
