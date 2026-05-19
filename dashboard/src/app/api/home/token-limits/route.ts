import { getTokenUsage } from '@/lib/token-usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await getTokenUsage());
}
