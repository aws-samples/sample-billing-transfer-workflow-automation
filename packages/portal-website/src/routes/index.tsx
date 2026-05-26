import { useApiFetch } from '../hooks/useApiFetch';
import { useEffect, useState } from 'react';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  Box,
  ColumnLayout,
  StatusIndicator,
  BarChart,
  PieChart,
  Grid,
  Link,
  KeyValuePairs,
} from '@cloudscape-design/components';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useBillingApiClient } from '../hooks/useBillingApiClient';
import type { DashboardData } from '../generated/billing-api/types.gen';

const Skeleton = ({
  width = 'w-32',
  height = 'h-7',
}: {
  width?: string;
  height?: string;
}) => (
  <div
    className={`relative overflow-hidden ${width} ${height} rounded bg-gray-200`}
  >
    <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/60 to-transparent" />
  </div>
);

const KpiSkeleton = () => (
  <SpaceBetween size="xxs" direction="vertical">
    <Skeleton width="w-40" height="h-9" />
    <Skeleton width="w-36" height="h-4" />
  </SpaceBetween>
);

export const Route = createFileRoute('/')({
  component: HomePage,
});

interface TransferSummary {
  totalMyView: string;
  totalShowback: string;
  totalMargin: string;
  transfers: {
    billSourceName: string;
    billSourceAccount: string;
    status: string;
    myViewCost: string;
    showbackCost: string;
    margin: string;
  }[];
}

const fmt = (v: string | number) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const pctChange = (current: string, previous: string) => {
  const c = parseFloat(current);
  const p = parseFloat(previous);
  if (p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
};

function HomePage() {
  const client = useBillingApiClient();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [transfer, setTransfer] = useState<TransferSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [transferLoading, setTransferLoading] = useState(true);
  const [showAllRows, setShowAllRows] = useState(false);
  const PAGE_SIZE = 10;

  const { apiFetch } = useApiFetch();

  useEffect(() => {
    let cancelled = false;
    client
      .dashboard()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    apiFetch(`/transfer-dashboard`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setTransfer({
            totalMyView: json.total_my_view,
            totalShowback: json.total_showback,
            totalMargin: json.total_margin,
            transfers: (json.account_costs ?? []).map((a: any) => ({
              billSourceName: a.account_name,
              billSourceAccount: a.account_id,
              status: 'ACTIVE',
              myViewCost: a.my_view_cost,
              showbackCost: a.showback_cost,
              margin: a.margin,
            })),
          });
        }
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setTransferLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  const monthlyCosts = data?.monthlyCosts ?? [];
  const prevMonth =
    monthlyCosts.length >= 2 ? monthlyCosts[monthlyCosts.length - 2] : null;
  const spendChange = prevMonth
    ? pctChange(data?.totalCurrentMonth ?? '0', prevMonth.amount)
    : null;

  const marginPct =
    transfer && parseFloat(transfer.totalMyView) > 0
      ? (
          (parseFloat(transfer.totalMargin) /
            parseFloat(transfer.totalMyView)) *
          100
        ).toFixed(1)
      : null;

  const pieData =
    data?.serviceCosts?.map((s) => ({
      title: s.service,
      value: parseFloat(s.amount),
    })) ?? [];

  const activeTransfers =
    transfer?.transfers.filter((t) => t.status === 'ACTIVE').length ?? 0;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            monthlyCosts.length > 0
              ? `Billing period: ${monthlyCosts[monthlyCosts.length - 1]?.period}`
              : 'Consolidated billing overview'
          }
        >
          Dashboard
        </Header>
      }
    >
      <SpaceBetween size="l">
        {/* ── Tier 1: Executive KPIs ── */}
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <KeyValuePairs
              items={[
                {
                  label: 'Current month spend',
                  value: loading ? (
                    <KpiSkeleton />
                  ) : (
                    <SpaceBetween size="xxs" direction="vertical">
                      <Box variant="h1" fontSize="display-l" fontWeight="bold">
                        {data ? fmt(data.totalCurrentMonth) : '—'}
                      </Box>
                      {spendChange !== null && (
                        <StatusIndicator
                          type={spendChange > 0 ? 'warning' : 'success'}
                        >
                          {spendChange > 0 ? '▲' : '▼'}{' '}
                          {Math.abs(spendChange).toFixed(1)}% vs prior month
                        </StatusIndicator>
                      )}
                    </SpaceBetween>
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Pro forma revenue',
                  value: transferLoading ? (
                    <KpiSkeleton />
                  ) : (
                    <SpaceBetween size="xxs" direction="vertical">
                      <Box variant="h1" fontSize="display-l" fontWeight="bold">
                        {transfer ? fmt(transfer.totalShowback) : '—'}
                      </Box>
                      <Box variant="small" color="text-body-secondary">
                        Billed to downstream accounts
                      </Box>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Margin',
                  value: transferLoading ? (
                    <KpiSkeleton />
                  ) : (
                    <SpaceBetween size="xxs" direction="vertical">
                      <Box
                        variant="h1"
                        fontSize="display-l"
                        fontWeight="bold"
                        color={
                          transfer && parseFloat(transfer.totalMargin) >= 0
                            ? 'text-status-success'
                            : 'text-status-error'
                        }
                      >
                        {transfer ? fmt(transfer.totalMargin) : '—'}
                      </Box>
                      {marginPct && (
                        <StatusIndicator
                          type={
                            parseFloat(marginPct) >= 0 ? 'success' : 'error'
                          }
                        >
                          {marginPct}% margin rate
                        </StatusIndicator>
                      )}
                    </SpaceBetween>
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Active transfers',
                  value: transferLoading ? (
                    <KpiSkeleton />
                  ) : (
                    <SpaceBetween size="xxs" direction="vertical">
                      <Box variant="h1" fontSize="display-l" fontWeight="bold">
                        {activeTransfers}
                      </Box>
                      <Box variant="small" color="text-body-secondary">
                        {loading ? '…' : (data?.accountCount ?? 0)} linked
                        accounts
                      </Box>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          </ColumnLayout>
        </Container>

        {/* ── Tier 2: Charts ── */}
        <Grid gridDefinition={[{ colspan: 8 }, { colspan: 4 }]}>
          <Container
            header={
              <Header
                variant="h2"
                description="Unblended cost by billing period"
              >
                Monthly cost trend
              </Header>
            }
          >
            {monthlyCosts.length > 0 ? (
              <BarChart
                series={[
                  {
                    title: 'Cost (USD)',
                    type: 'bar',
                    data: monthlyCosts.map((c) => ({
                      x: c.period,
                      y: parseFloat(c.amount),
                    })),
                  },
                ]}
                xDomain={monthlyCosts.map((c) => c.period)}
                yTitle="Cost (USD)"
                xTitle=""
                height={300}
                hideFilter
                hideLegend
                yScaleType="linear"
                statusType={loading ? 'loading' : 'finished'}
              />
            ) : (
              <Box padding="l" textAlign="center" color="text-body-secondary">
                {loading ? (
                  <Skeleton width="w-48" height="h-5" />
                ) : (
                  'No cost data available'
                )}
              </Box>
            )}
          </Container>

          <Container
            header={
              <Header variant="h2" description="Current billing period">
                Spend by service
              </Header>
            }
          >
            {pieData.length > 0 ? (
              <PieChart
                data={pieData}
                detailPopoverContent={(datum) => [
                  { key: 'Cost', value: fmt(datum.value) },
                  {
                    key: 'Share',
                    value: `${((datum.value / pieData.reduce((a, b) => a + b.value, 0)) * 100).toFixed(1)}%`,
                  },
                ]}
                segmentDescription={(datum) => fmt(datum.value)}
                size="medium"
                hideFilter
                variant="donut"
                innerMetricDescription="total"
                innerMetricValue={fmt(pieData.reduce((a, b) => a + b.value, 0))}
                statusType={loading ? 'loading' : 'finished'}
              />
            ) : (
              <Box padding="l" textAlign="center" color="text-body-secondary">
                {loading ? (
                  <Skeleton width="w-48" height="h-5" />
                ) : (
                  'No service data available'
                )}
              </Box>
            )}
          </Container>
        </Grid>

        {/* ── Tier 3: Billing group margin ── */}
        <Container
          header={
            <Header
              variant="h2"
              counter={transfer ? `(${transfer.transfers.length})` : undefined}
              description="Per-account profitability for current billing period"
              actions={
                <Link
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate({ to: '/partner-dashboard' });
                  }}
                  href="/partner-dashboard"
                >
                  View full analysis →
                </Link>
              }
            >
              Billing group margin
            </Header>
          }
        >
          {transferLoading ? (
            <SpaceBetween size="m" direction="vertical">
              <Skeleton width="w-full" height="h-4" />
              <Skeleton width="w-full" height="h-10" />
              <Skeleton width="w-full" height="h-10" />
            </SpaceBetween>
          ) : (transfer?.transfers ?? []).length === 0 ? (
            <Box textAlign="center" padding="l" color="text-body-secondary">
              <b>No billing transfers found</b>
            </Box>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500 text-xs uppercase tracking-wider">
                    <th className="py-2 pr-4 font-medium">
                      <div>Billing Group</div>
                      <div className="text-[10px] normal-case tracking-normal text-gray-400">
                        Account #
                      </div>
                    </th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium text-right">Cost</th>
                    <th className="py-2 pr-4 font-medium text-right">
                      Revenue
                    </th>
                    <th className="py-2 pr-4 font-medium text-right">Margin</th>
                    <th className="py-2 font-medium text-right">Margin %</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllRows
                    ? transfer!.transfers
                    : transfer!.transfers.slice(0, PAGE_SIZE)
                  ).map((item, i) => {
                    const m = parseFloat(item.margin);
                    const cost = parseFloat(item.myViewCost);
                    const pct =
                      cost > 0 ? ((m / cost) * 100).toFixed(1) : '0.0';
                    const color = m >= 0 ? 'text-green-600' : 'text-red-600';
                    return (
                      <tr
                        key={i}
                        className={`border-b border-gray-100 ${i % 2 === 1 ? 'bg-gray-50' : ''}`}
                      >
                        <td className="py-3 pr-4">
                          <div className="font-semibold text-gray-900">
                            {item.billSourceName}
                          </div>
                          <div className="text-xs text-gray-400">
                            {item.billSourceAccount}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                            {item.status}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {fmt(item.myViewCost)}
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {fmt(item.showbackCost)}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right font-semibold ${color}`}
                        >
                          {fmt(item.margin)}
                        </td>
                        <td className={`py-3 text-right ${color}`}>{pct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {(() => {
                    const totalCost = parseFloat(transfer!.totalMyView);
                    const totalMargin = parseFloat(transfer!.totalMargin);
                    const totalPct =
                      totalCost > 0
                        ? ((totalMargin / totalCost) * 100).toFixed(1)
                        : '0.0';
                    const color =
                      totalMargin >= 0 ? 'text-green-600' : 'text-red-600';
                    return (
                      <tr className="border-t-2 border-gray-300 font-semibold">
                        <td className="py-3 pr-4">TOTAL</td>
                        <td className="py-3 pr-4" />
                        <td className="py-3 pr-4 text-right">
                          {fmt(transfer!.totalMyView)}
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {fmt(transfer!.totalShowback)}
                        </td>
                        <td className={`py-3 pr-4 text-right ${color}`}>
                          {fmt(transfer!.totalMargin)}
                        </td>
                        <td className={`py-3 text-right ${color}`}>
                          {totalPct}%
                        </td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
              <div className="mt-3 pt-3 border-t border-gray-100 text-[11px] text-gray-400">
                Margin = Revenue (Showback) − Cost (My View) &nbsp;·&nbsp;
                Margin % = Margin ÷ Cost × 100
              </div>
              {transfer!.transfers.length > PAGE_SIZE && (
                <div className="mt-2 text-center">
                  <button
                    className="text-sm text-blue-600 hover:underline cursor-pointer"
                    onClick={() => setShowAllRows(!showAllRows)}
                  >
                    {showAllRows
                      ? 'Show less'
                      : `View all ${transfer!.transfers.length} billing groups`}
                  </button>
                </div>
              )}
            </>
          )}
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
