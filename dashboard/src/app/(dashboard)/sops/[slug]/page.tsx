import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IconArrowLeft } from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getSop } from '@/lib/data/sops';
import { describeStep } from '@/lib/data/sop-model';
import { SopStepCard } from '@/components/sops/sop-step-card';
import { SopRightRail } from '@/components/sops/sop-right-rail';

export const dynamic = 'force-dynamic';

export default async function SopDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getSop(slug);

  if (data.state !== 'ready') {
    notFound();
  }

  const { sop, version, versions } = data;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 pb-12">
      <div className="space-y-2">
        <Link href="/sops" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <IconArrowLeft size={14} />
          Back to SOP Library
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{sop.name}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{sop.description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{sop.subject_type}</Badge>
            {sop.slug.startsWith('demo-') && <Badge variant="secondary">Demo fixture</Badge>}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          {sop.stages.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                This SOP has no stages yet.
              </CardContent>
            </Card>
          ) : (
            sop.stages.map((stage, stageIndex) => (
              <section key={stage.stage_key} className="space-y-3">
                <div>
                  <h2 className="text-base font-semibold">{stage.name}</h2>
                  {stage.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{stage.description}</p>
                  )}
                </div>
                {stage.steps.length === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="py-6 text-sm text-muted-foreground">
                      This stage has no steps.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {stage.steps.map((step, stepIndex) => (
                      <SopStepCard
                        key={step.task_key}
                        step={step}
                        info={describeStep(sop, stageIndex, stepIndex)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
        <SopRightRail sop={sop} version={version} versions={versions} source={data.source} />
      </div>
    </div>
  );
}
