import {
  IconMail,
  IconBolt,
  IconTag,
  IconInbox,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InboxItem } from '@/lib/data/inbox';

interface InboxDigestProps {
  items: InboxItem[];
}

const CATEGORY_COLORS: Record<string, string> = {
  Deals:           'text-yellow-600 dark:text-yellow-400',
  'Property-Alerts': 'text-blue-600 dark:text-blue-400',
  Lenders:         'text-purple-600 dark:text-purple-400',
  Tenants:         'text-green-600 dark:text-green-400',
  Banking:         'text-emerald-600 dark:text-emerald-400',
  Invoices:        'text-orange-600 dark:text-orange-400',
  Bills:           'text-orange-600 dark:text-orange-400',
  Legal:           'text-red-600 dark:text-red-400',
  Meetings:        'text-cyan-600 dark:text-cyan-400',
};

function senderName(from: string): string {
  // Extract display name, strip <email>
  return from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from.split('@')[0];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function InboxDigest({ items }: InboxDigestProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <IconMail size={14} />
          Priority Inbox
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground px-6 py-4 text-sm">
            <IconInbox size={16} />
            <span>No flagged emails — inbox is clear</span>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item, i) => {
              const catColor = item.category ? (CATEGORY_COLORS[item.category] ?? 'text-muted-foreground') : '';
              return (
                <div key={i} className="px-6 py-3 hover:bg-muted/40 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground shrink-0">
                          {item.account}
                        </span>
                        {item.isDeal && (
                          <IconBolt size={12} className="text-yellow-500 shrink-0" />
                        )}
                        {item.category && (
                          <span className={`text-xs ${catColor} flex items-center gap-0.5`}>
                            <IconTag size={10} />
                            {item.category}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium truncate mt-0.5">
                        {item.subject}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {senderName(item.from)}
                        {item.snippet ? ` — ${item.snippet.slice(0, 80)}` : ''}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
                      {relativeTime(item.flaggedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
