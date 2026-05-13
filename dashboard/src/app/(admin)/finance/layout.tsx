import Link from 'next/link';
import { cn } from '@/lib/utils';

const tabs = [
  { label: 'P&L',      href: '/finance/pnl' },
  { label: 'Forecast', href: '/finance/forecast' },
  { label: 'Clients',  href: '/finance/clients' },
  { label: 'Tokens',   href: '/finance/tokens' },
];

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-full">
      {/* Sub-nav tabs */}
      <div className="border-b bg-background sticky top-0 z-10">
        <nav className="flex gap-1 px-6 pt-2">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                '-mb-px border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
