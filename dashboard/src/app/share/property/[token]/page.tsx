import { getPropertyByShareToken } from '@/lib/data/properties';
import { notFound } from 'next/navigation';

function fmt(amount: number | null) {
  if (amount === null) return 'TBD';
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const priorityBadge: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border border-red-300',
  high: 'bg-orange-100 text-orange-700 border border-orange-300',
  medium: 'bg-yellow-100 text-yellow-700 border border-yellow-300',
  low: 'bg-slate-100 text-slate-600 border border-slate-300',
};

const statusBadge: Record<string, string> = {
  needed: 'bg-red-100 text-red-700',
  in_progress: 'bg-blue-100 text-blue-700',
  pending: 'bg-yellow-100 text-yellow-700',
  on_hold: 'bg-gray-100 text-gray-600',
  quote_pending: 'bg-purple-100 text-purple-700',
  done: 'bg-green-100 text-green-700',
};

export default async function SharePropertyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const property = getPropertyByShareToken(token);
  if (!property) notFound();

  const openNeeds = property.needs.filter((n) => n.status !== 'done');
  const urgentCount = openNeeds.filter((n) => n.priority === 'urgent' || n.priority === 'high').length;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-5">

        {/* Header */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{property.name}</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                {property.city}, {property.state} &middot; {property.entity} &middot; {property.type}
              </p>
              {property.lender && (
                <p className="text-xs text-gray-400 mt-0.5">Lender: {property.lender}</p>
              )}
            </div>
            {property.spreadsheet_url && (
              <a
                href={property.spreadsheet_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline border border-blue-200 rounded px-2 py-1"
              >
                Budget Sheet ↗
              </a>
            )}
          </div>

          {/* Stats row */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            {property.original_budget != null && (
              <div className="rounded-lg bg-gray-50 border p-3 text-center">
                <div className="text-base font-bold text-gray-800">{fmt(property.original_budget)}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Original Budget</div>
              </div>
            )}
            {property.total_budget != null && (
              <div className={`rounded-lg border p-3 text-center ${
                property.original_budget != null && property.total_budget > property.original_budget
                  ? 'bg-orange-50 border-orange-200'
                  : 'bg-gray-50'
              }`}>
                <div className={`text-base font-bold ${
                  property.original_budget != null && property.total_budget > property.original_budget
                    ? 'text-orange-600'
                    : 'text-gray-800'
                }`}>
                  {fmt(property.total_budget)}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Current Estimate</div>
                {property.original_budget != null && property.total_budget > property.original_budget && (
                  <div className="text-[10px] text-orange-500 mt-0.5">
                    +{fmt(property.total_budget - property.original_budget)} over
                  </div>
                )}
              </div>
            )}
            <div className={`rounded-lg border p-3 text-center ${urgentCount > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50'}`}>
              <div className={`text-base font-bold ${urgentCount > 0 ? 'text-red-600' : 'text-gray-800'}`}>{urgentCount}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Urgent Items</div>
            </div>
            <div className="rounded-lg bg-gray-50 border p-3 text-center">
              <div className="text-base font-bold text-gray-800">{openNeeds.length}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Open Tasks</div>
            </div>
          </div>

          {property.status_note && (
            <div className="mt-4 rounded-lg border border-slate-200 overflow-hidden">
              <div className="bg-slate-700 px-3 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Project Status</span>
              </div>
              <div className="divide-y divide-slate-100">
                {property.status_note.split('\n').filter(Boolean).map((line, i) => {
                  const isRisk = line.startsWith('⚠');
                  return (
                    <div key={i} className={`flex items-start gap-2 px-3 py-1.5 text-sm ${isRisk ? 'bg-amber-50 text-amber-800' : 'bg-white text-gray-700'}`}>
                      <span className="shrink-0 mt-0.5">{isRisk ? '⚠' : '▸'}</span>
                      <span>{line.replace(/^[⚠•]\s*/, '')}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Total Committed */}
        {property.total_committed && (() => {
          const tc = property.total_committed!;
          return (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Total Committed</h2>
                <span className="text-lg font-bold text-gray-900">{fmt(tc.total)}</span>
              </div>
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between rounded-lg bg-gray-50 border px-3 py-2">
                  <span className="text-gray-500">Purchase Price</span>
                  <span className="font-semibold text-gray-800">{fmt(tc.purchase_price)}</span>
                </div>
                {/* Closing costs */}
                <details className="rounded-lg bg-gray-50 border overflow-hidden">
                  <summary className="flex items-center justify-between px-3 py-2 cursor-pointer list-none hover:bg-gray-100">
                    <span className="text-gray-500">Closing Costs</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">{fmt(tc.closing_costs.total)}</span>
                      <span className="text-gray-400 text-xs">▼</span>
                    </div>
                  </summary>
                  <div className="px-3 pb-2 pt-1 border-t border-gray-200 space-y-1">
                    {tc.closing_costs.items.map((it, i) => (
                      <div key={i} className="flex items-center justify-between text-xs text-gray-500 py-0.5">
                        <span>{it.item}</span>
                        <span>{fmt(it.amount)}</span>
                      </div>
                    ))}
                  </div>
                </details>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 border px-3 py-2">
                  <span className="text-gray-500">Rehab Released (Draws 1+2)</span>
                  <span className="font-semibold text-gray-800">{fmt(tc.rehab_released)}</span>
                </div>
                {/* Outstanding debts */}
                <details className="rounded-lg bg-orange-50 border border-orange-200 overflow-hidden">
                  <summary className="flex items-center justify-between px-3 py-2 cursor-pointer list-none hover:bg-orange-100">
                    <span className="text-orange-600">Outstanding Debts</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-orange-700">{fmt(tc.outstanding_debts.total)}</span>
                      <span className="text-orange-400 text-xs">▼</span>
                    </div>
                  </summary>
                  <div className="px-3 pb-2 pt-1 border-t border-orange-200 space-y-1">
                    {tc.outstanding_debts.items.map((it, i) => (
                      <div key={i} className="flex items-center justify-between text-xs text-gray-600 py-0.5">
                        <div className="flex items-center gap-1.5">
                          <span>{it.item}</span>
                          {it.status === 'estimated' && (
                            <span className="rounded-full bg-yellow-100 text-yellow-700 px-1.5 py-0.5 text-[9px]">est.</span>
                          )}
                          {it.status === 'pending' && (
                            <span className="rounded-full bg-blue-100 text-blue-700 px-1.5 py-0.5 text-[9px]">pending</span>
                          )}
                        </div>
                        <span>{it.amount != null ? fmt(it.amount) : 'TBD'}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          );
        })()}

        {/* Project Summary */}
        {property.project_summary && (() => {
          const ps = property.project_summary!;
          const sell = ps.exit_scenarios?.sell;
          const refi = ps.exit_scenarios?.hold_refi;
          return (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="bg-slate-700 px-5 py-2.5">
                <h2 className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Project Summary &amp; Exit Analysis</h2>
              </div>
              <div className="divide-y divide-gray-100">

                {/* ARV */}
                {ps.arv && (
                  <div className="px-5 py-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">After-Repair Value (ARV)</h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase text-gray-400 border-b border-gray-100">
                          <th className="text-left pb-1 font-medium">Scenario</th>
                          <th className="text-right pb-1 font-medium">Low</th>
                          <th className="text-right pb-1 font-medium">High</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {ps.arv.without_basement && (
                          <tr>
                            <td className="py-1.5 text-gray-600">Without basement finish</td>
                            <td className="py-1.5 text-right font-semibold text-gray-800">{fmt(ps.arv.without_basement.low)}</td>
                            <td className="py-1.5 text-right font-semibold text-gray-800">{fmt(ps.arv.without_basement.high)}</td>
                          </tr>
                        )}
                        {ps.arv.with_basement && (
                          <tr>
                            <td className="py-1.5 text-gray-600">With basement finish</td>
                            <td className="py-1.5 text-right font-semibold text-gray-800">{fmt(ps.arv.with_basement.low)}</td>
                            <td className="py-1.5 text-right font-semibold text-gray-800">{fmt(ps.arv.with_basement.high)}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {ps.arv.market_note && (
                      <p className="text-[11px] text-gray-400 mt-2 italic">{ps.arv.market_note}</p>
                    )}
                  </div>
                )}

                {/* Ownership */}
                {ps.ownership && ps.ownership.length > 0 && (
                  <div className="px-5 py-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Ownership Structure</h3>
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-gray-50">
                        {ps.ownership.map((o, i) => (
                          <tr key={i}>
                            <td className="py-1.5 text-gray-700">{o.entity}</td>
                            <td className="py-1.5 text-right font-semibold text-gray-800">{o.share}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Sell Scenario */}
                {sell && (
                  <div className="px-5 py-4 space-y-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Exit Scenario A — Sell</h3>

                    {/* Key metrics */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg bg-green-50 border border-green-100 p-2 text-center">
                        <div className="text-sm font-bold text-green-700">{fmt(sell.assumed_price ?? null)}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">Sale Price</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 border p-2 text-center">
                        <div className="text-sm font-bold text-gray-700">{fmt(sell.gross_net ?? null)}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">Gross Net</div>
                        <div className="text-[9px] text-gray-400">after payoff + costs</div>
                      </div>
                      <div className="rounded-lg bg-blue-50 border border-blue-100 p-2 text-center">
                        <div className="text-sm font-bold text-blue-700">{fmt(sell.profit_pool ?? sell.net_to_partners ?? null)}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">Profit Pool</div>
                        <div className="text-[9px] text-gray-400">after all paybacks</div>
                      </div>
                    </div>

                    {/* Step 1: Capital Returns */}
                    {sell.capital_returns && sell.capital_returns.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 mb-1.5">Step 1 — Capital Returns</p>
                        <table className="w-full text-sm">
                          <tbody className="divide-y divide-gray-100">
                            {sell.capital_returns.map((c, i) => (
                              <tr key={i} className="bg-gray-50">
                                <td className="py-1.5 px-2 text-gray-700">
                                  {c.recipient}
                                  {c.note && <span className="block text-[10px] text-gray-400">{c.note}</span>}
                                </td>
                                <td className="py-1.5 px-2 text-right font-semibold text-gray-800">{fmt(c.amount)}</td>
                              </tr>
                            ))}
                            {sell.total_capital_returns != null && (
                              <tr className="bg-gray-100">
                                <td className="py-1.5 px-2 text-xs font-semibold text-gray-600">Total Capital Returns</td>
                                <td className="py-1.5 px-2 text-right font-bold text-gray-800">{fmt(sell.total_capital_returns)}</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Step 2: Profit Split */}
                    {sell.waterfall && sell.waterfall.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 mb-1.5">Step 2 — Profit Split (40 / 40 / 20)</p>
                        <table className="w-full text-sm">
                          <tbody className="divide-y divide-gray-100">
                            {sell.waterfall.map((w, i) => (
                              <tr key={i} className="bg-blue-50">
                                <td className="py-1.5 px-2 text-gray-700">{w.recipient}</td>
                                <td className="py-1.5 px-2 text-right font-semibold text-blue-700">{fmt(w.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Partner Totals */}
                    {sell.partner_totals && sell.partner_totals.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase font-semibold text-gray-400 mb-1.5">Partner Totals Out</p>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-[10px] uppercase text-gray-400 border-b border-gray-100">
                              <th className="text-left pb-1 px-2 font-medium">Partner</th>
                              <th className="text-right pb-1 px-2 font-medium">Capital</th>
                              <th className="text-right pb-1 px-2 font-medium">Profit</th>
                              <th className="text-right pb-1 px-2 font-medium">Total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {sell.partner_totals.map((pt, i) => (
                              <tr key={i}>
                                <td className="py-1.5 px-2 text-gray-700">{pt.recipient}</td>
                                <td className="py-1.5 px-2 text-right text-gray-500">{fmt(pt.capital)}</td>
                                <td className="py-1.5 px-2 text-right text-blue-600">{fmt(pt.profit)}</td>
                                <td className="py-1.5 px-2 text-right font-bold text-gray-900">{fmt(pt.total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {sell.note && <p className="text-[11px] text-gray-400 italic">{sell.note}</p>}
                  </div>
                )}

                {/* Hold/Refi Scenario */}
                {refi && (
                  <div className="px-5 py-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Exit Scenario B — Hold &amp; Refi</h3>
                    {refi.note && <p className="text-xs text-gray-500 mb-2">{refi.note}</p>}
                    {refi.rental && (
                      <table className="w-full text-sm mb-2">
                        <tbody className="divide-y divide-gray-50">
                          {refi.rental.monthly_rent_est && (
                            <tr>
                              <td className="py-1.5 text-gray-600">Est. Monthly Rent</td>
                              <td className="py-1.5 text-right font-semibold text-gray-800">
                                {fmt(refi.rental.monthly_rent_est.low)} – {fmt(refi.rental.monthly_rent_est.high)}
                              </td>
                            </tr>
                          )}
                          {refi.rental.monthly_dscr_payment != null && (
                            <tr>
                              <td className="py-1.5 text-gray-600">DSCR Payment</td>
                              <td className="py-1.5 text-right font-semibold text-gray-800">{fmt(refi.rental.monthly_dscr_payment)}</td>
                            </tr>
                          )}
                          {refi.rental.monthly_cash_flow_est && (
                            <tr>
                              <td className="py-1.5 text-green-700 font-medium">Est. Monthly Cash Flow</td>
                              <td className="py-1.5 text-right font-bold text-green-700">
                                {fmt(refi.rental.monthly_cash_flow_est.low)} – {fmt(refi.rental.monthly_cash_flow_est.high)}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Draw Progress */}
        {property.draws && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">PPF Draw Progress</h2>
              {property.draws.source_url && (
                <a href={property.draws.source_url} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:underline">Loan Budget ↗</a>
              )}
            </div>
            {/* Progress bar */}
            <div className="relative h-3 rounded-full bg-gray-100 mb-3 overflow-hidden">
              <div
                className="absolute left-0 top-0 h-full rounded-full bg-blue-500"
                style={{ width: `${Math.min(100, (property.draws.total_released / property.draws.loan_total) * 100)}%` }}
              />
              {property.draws.total_approved > property.draws.total_released && (
                <div
                  className="absolute top-0 h-full bg-blue-200"
                  style={{
                    left: `${(property.draws.total_released / property.draws.loan_total) * 100}%`,
                    width: `${Math.min(100 - (property.draws.total_released / property.draws.loan_total) * 100, ((property.draws.total_approved - property.draws.total_released) / property.draws.loan_total) * 100)}%`,
                  }}
                />
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              <div className="rounded-lg bg-blue-50 border border-blue-100 p-2">
                <div className="text-sm font-bold text-blue-600">{fmt(property.draws.total_released)}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">Released</div>
              </div>
              <div className="rounded-lg bg-gray-50 border p-2">
                <div className="text-sm font-bold text-gray-700">{fmt(property.draws.total_approved)}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">Approved</div>
              </div>
              <div className="rounded-lg bg-green-50 border border-green-100 p-2">
                <div className="text-sm font-bold text-green-600">{fmt(property.draws.remaining_balance)}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">Remaining</div>
              </div>
            </div>
            {property.draws.line_items && property.draws.line_items.length > 0 && (
              <details className="group">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 list-none">
                  ▶ Show line items ({property.draws.line_items.length})
                </summary>
                <div className="mt-2 space-y-1.5">
                  {property.draws.line_items.map((li, i) => {
                    const pct = li.budget > 0 ? Math.min(100, (li.released / li.budget) * 100) : 0;
                    const isOver = (li.approved ?? li.released) > li.budget;
                    return (
                      <div key={i} className={`rounded-lg px-3 py-2 text-xs ${isOver ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50 border'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-gray-700">#{li.line} {li.item}</span>
                          <span className={`font-semibold ${isOver ? 'text-orange-600' : 'text-gray-700'}`}>
                            {fmt(li.released)} / {fmt(li.budget)}{isOver ? ' ⚠' : ''}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${isOver ? 'bg-orange-400' : li.status === 'complete' ? 'bg-green-500' : 'bg-blue-400'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {li.notes && <p className="text-gray-500 mt-1">{li.notes}</p>}
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Project Financials */}
        {property.financials && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Project Financials</h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-green-50 border border-green-100 p-3 text-center">
                <div className="text-base font-bold text-green-600">{fmt(property.financials.target_sale_price)}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Target Sale</div>
              </div>
              <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-center">
                <div className="text-base font-bold text-red-600">{fmt(property.financials.total_obligations)}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Obligations</div>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-center">
                <div className="text-base font-bold text-blue-600">{fmt(property.financials.projected_net)}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">Proj. Net</div>
              </div>
            </div>
            {property.financials.note && (
              <p className="text-xs text-gray-400 mt-2">{property.financials.note}</p>
            )}
          </div>
        )}

        {/* Team */}
        {property.team && property.team.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Team</h2>
            <div className="space-y-2">
              {property.team.map((member, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium text-gray-800">{member.name}</span>
                  </div>
                  {member.email && (
                    <a href={`mailto:${member.email}`} className="text-blue-500 hover:underline text-xs">
                      {member.email}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Open Tasks / Needs */}
        {openNeeds.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
              Open Tasks &amp; Needs
              {urgentCount > 0 && (
                <span className="ml-2 text-red-600 normal-case font-normal">({urgentCount} urgent)</span>
              )}
            </h2>
            <div className="space-y-2">
              {openNeeds.map((need, i) => (
                <div key={i} className="rounded-lg bg-gray-50 border px-3 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityBadge[need.priority] ?? ''}`}>
                      {need.priority}
                    </span>
                    <span className="text-sm font-medium text-gray-800">{need.item}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ml-auto ${statusBadge[need.status] ?? ''}`}>
                      {need.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {need.notes && (
                    <div className="mt-1.5 pl-1 space-y-0.5">
                      {need.notes.split('\n').filter(Boolean).map((line, li) => {
                        const isHeader = line.startsWith('---');
                        const isAction = line.startsWith('ACTION:');
                        if (isHeader) return (
                          <p key={li} className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 pt-1">{line.replace(/---/g, '').trim()}</p>
                        );
                        if (isAction) return (
                          <p key={li} className="text-xs font-semibold text-amber-700">{line}</p>
                        );
                        return <p key={li} className="text-xs text-gray-500">{line}</p>;
                      })}
                    </div>
                  )}
                  {need.vendor && (
                    <p className="text-xs text-gray-400 mt-0.5 pl-1">Vendor: {need.vendor}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Past Orders / Draws */}
        {property.past_orders.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Completed Work &amp; Draws</h2>
            <div className="space-y-2">
              {property.past_orders.map((order, i) => (
                <div key={i} className="flex items-center justify-between text-sm rounded-lg bg-green-50 border border-green-100 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600">✓</span>
                    <span className="text-gray-400 text-xs">{order.date}</span>
                    <span className="font-medium text-gray-800">{order.item}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs">{order.vendor}</span>
                    <span className="font-semibold text-gray-800">{fmt(order.cost)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quotes */}
        {property.quotes.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Quotes</h2>
            <div className="space-y-2">
              {property.quotes.map((q, i) => (
                q.notes ? (
                  <details key={i} className="rounded-lg bg-gray-50 border overflow-hidden group">
                    <summary className="flex items-center justify-between px-3 py-2.5 text-sm cursor-pointer list-none hover:bg-gray-100 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400 text-xs">{q.date}</span>
                        <span className="font-medium text-gray-800">{q.item}</span>
                        {q.vendor && q.vendor !== 'TBD' && <span className="text-gray-500 text-xs">{q.vendor}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-700">
                          {q.amount != null ? fmt(q.amount) : q.amount_range ?? 'TBD'}
                        </span>
                        <span className="text-gray-400 text-xs select-none">▼</span>
                      </div>
                    </summary>
                    <div className="px-3 pb-3 pt-2 border-t border-gray-200">
                      <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{q.notes}</p>
                    </div>
                  </details>
                ) : (
                  <div key={i} className="flex items-center justify-between text-sm rounded-lg bg-gray-50 border px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs">{q.date}</span>
                      <span className="font-medium text-gray-800">{q.item}</span>
                      {q.vendor && q.vendor !== 'TBD' && <span className="text-gray-500 text-xs">{q.vendor}</span>}
                    </div>
                    <span className="font-semibold text-gray-700">
                      {q.amount != null ? fmt(q.amount) : q.amount_range ?? 'TBD'}
                    </span>
                  </div>
                )
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-[11px] text-gray-300 pb-4">
          Read-only view &middot; Last updated {property.updated_at.slice(0, 10)} by {property.last_report_by ?? 'team'}
        </p>
      </div>
    </div>
  );
}
