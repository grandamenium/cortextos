import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const BUNDLE = path.join(process.cwd(), 'public', 'agent-city', 'index.html');

/**
 * Agent City — the 3D fleet view.
 *
 * This is an ADDITIONAL view. It replaces nothing: the existing Overview stays
 * exactly where it was, and the city becomes the default only if the owner says
 * so after seeing it.
 *
 * The scene is a self-contained bundle in public/agent-city/, produced by the
 * agent-side build (build/build-internal.mjs) and hosted in an iframe rather
 * than ported to React. Two reasons, both about honesty rather than effort: the
 * bundle is the artifact that was verified, and a hand-port would be a second
 * copy of every data binding, free to drift from the first with nothing on
 * screen admitting the two disagree.
 *
 * The scene polls /api/city-state itself and prints its own cadence in the
 * footer. It is a sampler, and it says so.
 */
export default function CityPage() {
  const present = fs.existsSync(BUNDLE);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {present ? (
        <iframe
          src="/agent-city/index.html"
          title="Agent City — live fleet view"
          className="h-full w-full border-0"
          /* NOT A SECURITY BOUNDARY — do not read it as one.
             allow-scripts and allow-same-origin TOGETHER defeat the sandbox: a
             framed document granted both can reach out and remove its own
             sandbox attribute, so this pair confers no containment whatsoever.
             It is here because the scene needs same-origin to send the session
             cookie with its own /api/city-state polls, and scripts to run at
             all — i.e. it is a capability declaration, not a restriction.
             What actually makes framing this safe is that the document is
             first-party content we build and serve ourselves, not the sandbox.
             (Flagged by guard, 2026-08-26.) */
          sandbox="allow-scripts allow-same-origin"
        />
      ) : (
        /* Absent renders as absent. A blank frame would look like a city with
           nothing happening in it, which is a legitimate fleet state and would
           therefore read as truth rather than as a missing file. */
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-lg font-medium">The Agent City bundle is not built.</p>
          <p className="max-w-prose text-sm opacity-70">
            Nothing is being shown here because <code>public/agent-city/index.html</code> is
            missing — not because the fleet is quiet. Run{' '}
            <code>node build/build-internal.mjs</code> in the city agent directory to produce it.
          </p>
        </div>
      )}
    </div>
  );
}
