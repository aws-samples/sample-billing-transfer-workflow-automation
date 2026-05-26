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
  Table,
  BarChart,
  PieChart,
  Tabs,
  Badge,
  ExpandableSection,
  Button,
  Alert,
  Flashbar,
  KeyValuePairs,
  ProgressBar,
  Link,
  Modal,
  FormField,
  Input,
} from '@cloudscape-design/components';
import { createFileRoute } from '@tanstack/react-router';
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

interface TransferInfo {
  billSourceAccount: string;
  billSourceName: string;
  status: string;
  effectiveDate: string;
}

interface AccountCost {
  accountId: string;
  accountName: string;
  myViewCost: string;
  showbackCost: string;
  margin: string;
}

interface TransferDashboardData {
  transfers: TransferInfo[];
  accountCosts: AccountCost[];
  totalMyView: string;
  totalShowback: string;
  totalMargin: string;
}

interface PricingPlanInfo {
  arn: string;
  name: string;
  description: string;
  size: number;
  billingGroups: string[];
  rules: {
    name: string;
    type: string;
    scope: string;
    modifier_percentage: number;
    service: string;
  }[];
}

interface CustomLineItemInfo {
  name: string;
  description: string;
  accountId: string;
  billingGroupName: string;
  chargeType: string;
  percentage: number | null;
  flatAmount: number | null;
}

interface BillingConductorData {
  pricingPlans: PricingPlanInfo[];
  customLineItems: CustomLineItemInfo[];
}

interface AccountServiceCost {
  accountId: string;
  service: string;
  amount: string;
}

interface MarginHistoryEntry {
  period: string;
  awsCost: string;
  proformaCost: string;
  margin: string;
}

interface BudgetInfo {
  name: string;
  budgetType: string;
  limitAmount: string;
  actualSpend: string;
  forecastedSpend: string;
  pctUsed: string;
}

interface FinOpsData {
  accountServiceCosts: AccountServiceCost[];
  marginHistory: MarginHistoryEntry[];
  budgets: BudgetInfo[];
  creditsAmount: string;
  anomalyCount: number;
}

interface CreditBillingGroup {
  billingGroupName: string;
  billingGroupArn: string;
  primaryAccountId: string;
  creditAmount: string;
  cliModeledAmount: string;
  unmodeledAmount: string;
  isModeled: boolean;
}

interface CreditTrackerData {
  billingGroups: CreditBillingGroup[];
  totalCredits: string;
  totalModeled: string;
  totalUnmodeled: string;
  billingPeriod: string;
}

export const Route = createFileRoute('/partner-dashboard')({
  component: PartnerDashboard,
});

const fmt = (v: string) =>
  `$${parseFloat(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function PartnerDashboard() {
  const client = useBillingApiClient();
  const [data, setData] = useState<DashboardData | null>(null);
  const [transferData, setTransferData] =
    useState<TransferDashboardData | null>(null);
  const [conductorData, setConductorData] =
    useState<BillingConductorData | null>(null);
  const [finOps, setFinOps] = useState<FinOpsData | null>(null);
  const [creditTracker, setCreditTracker] = useState<CreditTrackerData | null>(
    null,
  );
  const [creditFixing, setCreditFixing] = useState(false);
  const [creditFlash, setCreditFlash] = useState<any[]>([]);
  const [creditDemo, setCreditDemo] = useState(false);
  const [creditFormVisible, setCreditFormVisible] = useState(false);
  const [creditFormItem, setCreditFormItem] =
    useState<CreditBillingGroup | null>(null);
  const [creditFormName, setCreditFormName] = useState('');
  const [creditFormDesc, setCreditFormDesc] = useState('');
  const [creditFormAmount, setCreditFormAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [transferLoading, setTransferLoading] = useState(true);
  const [showAllTransfers, setShowAllTransfers] = useState(false);
  const [showAllMargin, setShowAllMargin] = useState(false);
  const PD_PAGE = 10;
  const [, setConductorLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { apiFetch } = useApiFetch();

  useEffect(() => {
    let cancelled = false;

    client
      .dashboard()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? 'Failed to load dashboard');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    apiFetch(`/transfer-dashboard`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setTransferData({
            transfers: (json.transfers ?? []).map((t: any) => ({
              billSourceAccount: t.bill_source_account,
              billSourceName: t.bill_source_name,
              status: t.status,
              effectiveDate: t.effective_date,
            })),
            accountCosts: (json.account_costs ?? []).map((a: any) => ({
              accountId: a.account_id,
              accountName: a.account_name,
              myViewCost: a.my_view_cost,
              showbackCost: a.showback_cost,
              margin: a.margin,
            })),
            totalMyView: json.total_my_view,
            totalShowback: json.total_showback,
            totalMargin: json.total_margin,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? 'Failed to load transfer data');
      })
      .finally(() => {
        if (!cancelled) setTransferLoading(false);
      });

    apiFetch(`/billing-conductor`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setConductorData({
            pricingPlans: (json.pricing_plans ?? []).map((p: any) => ({
              arn: p.arn,
              name: p.name,
              description: p.description,
              size: p.size,
              billingGroups: p.billing_groups ?? [],
              rules: p.rules ?? [],
            })),
            customLineItems: (json.custom_line_items ?? []).map((c: any) => ({
              name: c.name,
              description: c.description,
              accountId: c.account_id,
              billingGroupName: c.billing_group_name,
              chargeType: c.charge_type,
              percentage: c.percentage,
              flatAmount: c.flat_amount,
            })),
          });
        }
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setConductorLoading(false);
      });

    // Fetch FinOps data
    apiFetch(`/finops`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setFinOps({
            accountServiceCosts: (json.account_service_costs ?? []).map(
              (a: any) => ({
                accountId: a.account_id,
                service: a.service,
                amount: a.amount,
              }),
            ),
            marginHistory: (json.margin_history ?? []).map((m: any) => ({
              period: m.period,
              awsCost: m.aws_cost,
              proformaCost: m.proforma_cost,
              margin: m.margin,
            })),
            budgets: (json.budgets ?? []).map((b: any) => ({
              name: b.name,
              budgetType: b.budget_type,
              limitAmount: b.limit_amount,
              actualSpend: b.actual_spend,
              forecastedSpend: b.forecasted_spend,
              pctUsed: b.pct_used,
            })),
            creditsAmount: json.credits_amount ?? '0.00',
            anomalyCount: json.anomaly_count ?? 0,
          });
        }
      })
      .catch(() => {
        /* ignore */
      });

    // Fetch credit tracker data
    apiFetch(`/credit-tracker${creditDemo ? '?demo=true' : ''}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          setCreditTracker({
            billingGroups: (json.billing_groups ?? []).map((bg: any) => ({
              billingGroupName: bg.billing_group_name,
              billingGroupArn: bg.billing_group_arn,
              primaryAccountId: bg.primary_account_id,
              creditAmount: bg.credit_amount,
              cliModeledAmount: bg.cli_modeled_amount,
              unmodeledAmount: bg.unmodeled_amount,
              isModeled: bg.is_modeled,
            })),
            totalCredits: json.total_credits ?? '0.00',
            totalModeled: json.total_modeled ?? '0.00',
            totalUnmodeled: json.total_unmodeled ?? '0.00',
            billingPeriod: json.billing_period ?? '',
          });
        }
      })
      .catch(() => {
        /* ignore */
      });

    return () => {
      cancelled = true;
    };
  }, [client, creditDemo]);

  const pieData =
    data?.serviceCosts?.map((s) => ({
      title: s.service,
      value: parseFloat(s.amount),
    })) ?? [];

  const marginData =
    transferData?.accountCosts?.map((a) => ({
      accountName: a.accountName,
      myView: parseFloat(a.myViewCost),
      showback: parseFloat(a.showbackCost),
      margin: parseFloat(a.margin),
    })) ?? [];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Billing transfer overview and margin analysis for bill receiver"
        >
          Billing Transfer
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && <StatusIndicator type="error">{error}</StatusIndicator>}

        {/* KPIs */}
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <KeyValuePairs
              items={[
                {
                  label: 'AWS cost (My View)',
                  value: transferLoading ? (
                    <KpiSkeleton />
                  ) : (
                    <Box variant="h1" fontSize="display-l" fontWeight="bold">
                      {transferData ? fmt(transferData.totalMyView) : '—'}
                    </Box>
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Pro forma (Showback)',
                  value: transferLoading ? (
                    <KpiSkeleton />
                  ) : (
                    <Box variant="h1" fontSize="display-l" fontWeight="bold">
                      {transferData ? fmt(transferData.totalShowback) : '—'}
                    </Box>
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
                          transferData &&
                          parseFloat(transferData.totalMargin) >= 0
                            ? 'text-status-success'
                            : 'text-status-error'
                        }
                      >
                        {transferData ? fmt(transferData.totalMargin) : '—'}
                      </Box>
                      {transferData &&
                        parseFloat(transferData.totalMyView) > 0 && (
                          <StatusIndicator
                            type={
                              parseFloat(transferData.totalMargin) >= 0
                                ? 'success'
                                : 'error'
                            }
                          >
                            {(
                              (parseFloat(transferData.totalMargin) /
                                parseFloat(transferData.totalMyView)) *
                              100
                            ).toFixed(1)}
                            % margin rate
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
                        {transferData
                          ? String(
                              transferData.transfers.filter(
                                (t) => t.status === 'ACTIVE',
                              ).length,
                            )
                          : '—'}
                      </Box>
                      <Box variant="small" color="text-body-secondary">
                        {data?.accountCount ?? 0} linked accounts
                      </Box>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          </ColumnLayout>
        </Container>

        {/* Margin Analysis */}
        {transferData && transferData.accountCosts.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                counter={`(${transferData.accountCosts.length})`}
                description="AWS cost vs pro forma cost per bill-source account"
              >
                Margin Analysis
              </Header>
            }
          >
            <SpaceBetween size="l">
              <BarChart
                series={[
                  {
                    title: 'AWS Cost',
                    type: 'bar',
                    color: '#0972d3',
                    data: marginData.map((a) => ({
                      x: a.accountName,
                      y: a.myView,
                    })),
                  },
                  {
                    title: 'Pro Forma',
                    type: 'bar',
                    color: '#7d8998',
                    data: marginData.map((a) => ({
                      x: a.accountName,
                      y: a.showback,
                    })),
                  },
                ]}
                xDomain={marginData.map((a) => a.accountName)}
                yTitle="Cost (USD)"
                xTitle="Bill-Source Account"
                height={280}
                hideFilter
              />
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
                  {(showAllMargin
                    ? transferData.accountCosts
                    : transferData.accountCosts.slice(0, PD_PAGE)
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
                            {item.accountName}
                          </div>
                          <div className="text-xs text-gray-400">
                            {item.accountId}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                            ACTIVE
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
                    const totalCost = parseFloat(transferData.totalMyView);
                    const totalMargin = parseFloat(transferData.totalMargin);
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
                          {fmt(transferData.totalMyView)}
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {fmt(transferData.totalShowback)}
                        </td>
                        <td className={`py-3 pr-4 text-right ${color}`}>
                          {fmt(transferData.totalMargin)}
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
                Margin = Revenue (Showback) − Cost (My View) · Margin % = Margin
                ÷ Cost × 100
              </div>
              {transferData.accountCosts.length > PD_PAGE && (
                <div className="mt-2 text-center">
                  <button
                    className="text-sm text-blue-600 hover:underline cursor-pointer"
                    onClick={() => setShowAllMargin(!showAllMargin)}
                  >
                    {showAllMargin
                      ? 'Show less'
                      : `View all ${transferData.accountCosts.length} billing groups`}
                  </button>
                </div>
              )}
            </SpaceBetween>
          </Container>
        )}

        {/* Pro Forma Coverage */}
        {transferData && conductorData && (
          <Container
            header={
              <Header
                variant="h2"
                description="Checks whether support charges, credits, and refunds are modeled as Custom Line Items"
                actions={<Link href="/gap-analysis">View gap analysis →</Link>}
              >
                Pro forma coverage
              </Header>
            }
          >
            <Table
              columnDefinitions={[
                {
                  id: 'bg',
                  header: 'Billing group',
                  cell: (item: any) => <Box fontWeight="bold">{item.name}</Box>,
                },
                {
                  id: 'support',
                  header: 'Support charges',
                  cell: (item: any) =>
                    item.hasSupport ? (
                      <StatusIndicator type="success">Modeled</StatusIndicator>
                    ) : (
                      <StatusIndicator type="error">
                        Not configured
                      </StatusIndicator>
                    ),
                },
                {
                  id: 'credits',
                  header: 'Credits',
                  cell: (item: any) =>
                    item.hasCredits ? (
                      <StatusIndicator type="success">Modeled</StatusIndicator>
                    ) : (
                      <StatusIndicator type="warning">
                        Not configured
                      </StatusIndicator>
                    ),
                },
                {
                  id: 'coverage',
                  header: 'Coverage',
                  cell: (item: any) => {
                    const checks = [item.hasSupport, item.hasCredits];
                    const covered = checks.filter(Boolean).length;
                    const pct = Math.round((covered / checks.length) * 100);
                    return (
                      <ProgressBar
                        value={pct}
                        status={pct === 100 ? 'success' : 'in-progress'}
                      />
                    );
                  },
                },
                {
                  id: 'action',
                  header: 'Action needed',
                  cell: (item: any) => (
                    <Box color="text-body-secondary" fontSize="body-s">
                      {item.action}
                    </Box>
                  ),
                },
              ]}
              items={transferData.transfers.map((t) => {
                const bgClis = conductorData.customLineItems.filter(
                  (c) => c.billingGroupName === t.billSourceName,
                );
                const hasSupport = bgClis.some(
                  (c) =>
                    c.name.toLowerCase().includes('support') ||
                    c.description.toLowerCase().includes('support'),
                );
                const hasCredits = bgClis.some(
                  (c) =>
                    c.chargeType === 'CREDIT' ||
                    c.name.toLowerCase().includes('credit'),
                );
                const actions = [];
                if (!hasSupport) actions.push('Add support charge CLI');
                if (!hasCredits) actions.push('Add credit CLI');
                return {
                  name: t.billSourceName,
                  hasSupport,
                  hasCredits,
                  action: actions.length > 0 ? actions.join('; ') : '—',
                };
              })}
              sortingDisabled
              variant="embedded"
              stripedRows
            />
          </Container>
        )}

        {/* Credit Tracker */}
        {creditTracker && (
          <Container
            header={
              <Header
                variant="h2"
                description={`Credit visibility for bill-source accounts — ${creditTracker.billingPeriod || 'current period'}. After billing transfer, customers lose access to the Credits page and MAP dashboard. Use Billing Conductor CLIs to model credits into pro forma artifacts.`}
                actions={
                  <Button
                    variant={creditDemo ? 'primary' : 'normal'}
                    onClick={() => setCreditDemo(!creditDemo)}
                  >
                    {creditDemo ? 'Demo mode ON' : 'Demo mode'}
                  </Button>
                }
              >
                Credit Tracker
              </Header>
            }
          >
            <SpaceBetween size="l">
              <Flashbar items={creditFlash} />
              <Alert type="info">
                Bill-source accounts cannot view credits or MAP balances after
                billing transfer (AWS Billing User Guide §334). Model credits as
                Custom Line Items so they appear in customer Showback views.
              </Alert>
              <ColumnLayout columns={3} variant="text-grid">
                <KeyValuePairs
                  items={[
                    {
                      label: 'Total credits (My View)',
                      value: (
                        <Box variant="h2">
                          {fmt(creditTracker.totalCredits)}
                        </Box>
                      ),
                    },
                  ]}
                />
                <KeyValuePairs
                  items={[
                    {
                      label: 'Modeled via CLI',
                      value: (
                        <Box variant="h2" color="text-status-success">
                          {fmt(creditTracker.totalModeled)}
                        </Box>
                      ),
                    },
                  ]}
                />
                <KeyValuePairs
                  items={[
                    {
                      label: 'Unmodeled (not visible to customers)',
                      value: (
                        <Box
                          variant="h2"
                          color={
                            parseFloat(creditTracker.totalUnmodeled) > 0
                              ? 'text-status-error'
                              : 'text-status-success'
                          }
                        >
                          {fmt(creditTracker.totalUnmodeled)}
                        </Box>
                      ),
                    },
                  ]}
                />
              </ColumnLayout>
              <Table
                columnDefinitions={[
                  {
                    id: 'bg',
                    header: 'Billing Group',
                    cell: (item: CreditBillingGroup) => (
                      <Box fontWeight="bold">{item.billingGroupName}</Box>
                    ),
                  },
                  {
                    id: 'account',
                    header: 'Account',
                    cell: (item: CreditBillingGroup) => (
                      <Box variant="code">{item.primaryAccountId}</Box>
                    ),
                  },
                  {
                    id: 'credits',
                    header: 'Credits (My View)',
                    cell: (item: CreditBillingGroup) => (
                      <Box textAlign="right">{fmt(item.creditAmount)}</Box>
                    ),
                  },
                  {
                    id: 'modeled',
                    header: <Box textAlign="right">CLI modeled</Box>,
                    cell: (item: CreditBillingGroup) => (
                      <Box textAlign="right">{fmt(item.cliModeledAmount)}</Box>
                    ),
                  },
                  {
                    id: 'status',
                    header: 'Status',
                    cell: (item: CreditBillingGroup) =>
                      item.isModeled ? (
                        <Badge color="green">Visible to customer</Badge>
                      ) : (
                        <Badge color="red">
                          Not visible — ${item.unmodeledAmount} unmodeled
                        </Badge>
                      ),
                  },
                  {
                    id: 'action',
                    header: '',
                    cell: (item: CreditBillingGroup) =>
                      !item.isModeled &&
                      parseFloat(item.unmodeledAmount) > 0.01 ? (
                        <Button
                          variant="inline-link"
                          onClick={() => {
                            setCreditFormItem(item);
                            setCreditFormName(
                              `Credit-${item.billingGroupName}`,
                            );
                            setCreditFormDesc(
                              `AWS credits pass-through for ${item.billingGroupName}`,
                            );
                            setCreditFormAmount(
                              Math.abs(
                                parseFloat(item.unmodeledAmount),
                              ).toFixed(2),
                            );
                            setCreditFormVisible(true);
                          }}
                        >
                          Model as CLI
                        </Button>
                      ) : null,
                  },
                ]}
                items={creditTracker.billingGroups}
                sortingDisabled
                variant="embedded"
                stripedRows
              />
            </SpaceBetween>
          </Container>
        )}

        {/* Credit CLI Form Modal */}
        <Modal
          visible={creditFormVisible}
          onDismiss={() => setCreditFormVisible(false)}
          header={`Model credit as Custom Line Item`}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="link"
                  onClick={() => setCreditFormVisible(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={creditFixing}
                  disabled={
                    !creditFormAmount || parseFloat(creditFormAmount) <= 0
                  }
                  onClick={async () => {
                    if (!creditFormItem) return;
                    setCreditFixing(true);
                    try {
                      const resp = await apiFetch(`/gap-analysis/apply`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          clis: [
                            {
                              name: creditFormName,
                              description: creditFormDesc,
                              billing_group_arn: creditFormItem.billingGroupArn,
                              charge_type: 'CREDIT',
                              flat_amount: -Math.abs(
                                parseFloat(creditFormAmount),
                              ),
                            },
                          ],
                        }),
                      });
                      const result = await resp.json();
                      setCreditFlash([
                        {
                          type: result.failed?.length ? 'warning' : 'success',
                          content: result.message,
                          dismissible: true,
                          onDismiss: () => setCreditFlash([]),
                          id: Date.now().toString(),
                        },
                      ]);
                      setCreditFormVisible(false);
                      // Refresh
                      const r2 = await apiFetch(
                        `/credit-tracker${creditDemo ? '?demo=true' : ''}`,
                      );
                      const json = await r2.json();
                      setCreditTracker({
                        billingGroups: (json.billing_groups ?? []).map(
                          (bg: any) => ({
                            billingGroupName: bg.billing_group_name,
                            billingGroupArn: bg.billing_group_arn,
                            primaryAccountId: bg.primary_account_id,
                            creditAmount: bg.credit_amount,
                            cliModeledAmount: bg.cli_modeled_amount,
                            unmodeledAmount: bg.unmodeled_amount,
                            isModeled: bg.is_modeled,
                          }),
                        ),
                        totalCredits: json.total_credits ?? '0.00',
                        totalModeled: json.total_modeled ?? '0.00',
                        totalUnmodeled: json.total_unmodeled ?? '0.00',
                        billingPeriod: json.billing_period ?? '',
                      });
                    } catch (e: any) {
                      setCreditFlash([
                        {
                          type: 'error',
                          content: `Failed: ${e.message}`,
                          dismissible: true,
                          onDismiss: () => setCreditFlash([]),
                          id: Date.now().toString(),
                        },
                      ]);
                    } finally {
                      setCreditFixing(false);
                    }
                  }}
                >
                  Create credit CLI
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {creditFormItem && (
              <Alert type="info">
                Billing group: <b>{creditFormItem.billingGroupName}</b> —
                Account {creditFormItem.primaryAccountId}
              </Alert>
            )}
            <FormField label="Name">
              <Input
                value={creditFormName}
                onChange={({ detail }) => setCreditFormName(detail.value)}
              />
            </FormField>
            <FormField label="Description">
              <Input
                value={creditFormDesc}
                onChange={({ detail }) => setCreditFormDesc(detail.value)}
              />
            </FormField>
            <FormField
              label="Credit amount ($)"
              description="The amount that will appear as a credit on the customer's Showback view"
            >
              <Input
                type="number"
                value={creditFormAmount}
                onChange={({ detail }) => setCreditFormAmount(detail.value)}
                step={0.01}
              />
            </FormField>
          </SpaceBetween>
        </Modal>

        {/* Charts */}
        <Tabs
          tabs={[
            {
              label: 'Monthly Trend',
              id: 'trend',
              content:
                data?.monthlyCosts && data.monthlyCosts.length > 0 ? (
                  <BarChart
                    series={[
                      {
                        title: 'Cost (USD)',
                        type: 'bar',
                        data: data.monthlyCosts.map((c) => ({
                          x: c.period,
                          y: parseFloat(c.amount),
                        })),
                      },
                    ]}
                    xDomain={data.monthlyCosts.map((c) => c.period)}
                    yTitle="Cost (USD)"
                    xTitle="Month"
                    height={300}
                    hideFilter
                    hideLegend
                  />
                ) : (
                  <Box
                    padding="l"
                    textAlign="center"
                    color="text-body-secondary"
                  >
                    {loading ? (
                      <Skeleton width="w-48" height="h-5" />
                    ) : (
                      'No monthly data available'
                    )}
                  </Box>
                ),
            },
            {
              label: 'Spend by Service',
              id: 'services',
              content:
                pieData.length > 0 ? (
                  <PieChart
                    data={pieData}
                    detailPopoverContent={(datum) => [
                      { key: 'Cost', value: `$${datum.value.toFixed(2)}` },
                      {
                        key: 'Share',
                        value: `${((datum.value / pieData.reduce((a, b) => a + b.value, 0)) * 100).toFixed(1)}%`,
                      },
                    ]}
                    segmentDescription={(datum) => `$${datum.value.toFixed(2)}`}
                    size="large"
                    hideFilter
                  />
                ) : (
                  <Box
                    padding="l"
                    textAlign="center"
                    color="text-body-secondary"
                  >
                    {loading ? (
                      <Skeleton width="w-48" height="h-5" />
                    ) : (
                      'No service data available'
                    )}
                  </Box>
                ),
            },
          ]}
        />

        {/* Billing Transfers */}
        {transferData && transferData.transfers.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                counter={`(${transferData.transfers.length})`}
              >
                Billing transfers
              </Header>
            }
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 text-xs uppercase tracking-wider">
                  <th className="py-2 pr-4 font-medium">Bill-source name</th>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Effective Date</th>
                </tr>
              </thead>
              <tbody>
                {(showAllTransfers
                  ? transferData.transfers
                  : transferData.transfers.slice(0, PD_PAGE)
                ).map((item, i) => (
                  <tr
                    key={i}
                    className={`border-b border-gray-100 ${i % 2 === 1 ? 'bg-gray-50' : ''}`}
                  >
                    <td className="py-3 pr-4 font-semibold text-gray-900">
                      {item.billSourceName}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-gray-600">
                      {item.billSourceAccount}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="inline-flex items-center gap-1 text-green-600">
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 text-gray-600">
                      {item.effectiveDate || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {transferData.transfers.length > PD_PAGE && (
              <div className="mt-2 text-center">
                <button
                  className="text-sm text-blue-600 hover:underline cursor-pointer"
                  onClick={() => setShowAllTransfers(!showAllTransfers)}
                >
                  {showAllTransfers
                    ? 'Show less'
                    : `View all ${transferData.transfers.length} transfers`}
                </button>
              </div>
            )}
          </Container>
        )}

        {/* Financial Operations */}
        <Container
          header={
            <Header
              variant="h2"
              description="Credits, budgets, anomalies, and margin trend"
            >
              Financial Operations
            </Header>
          }
        >
          <SpaceBetween size="l">
            {/* KPI row */}
            <ColumnLayout columns={3} variant="text-grid">
              <KeyValuePairs
                items={[
                  {
                    label: 'Credits applied (last month)',
                    value: (
                      <Box variant="h2">
                        {finOps ? fmt(finOps.creditsAmount) : '—'}
                      </Box>
                    ),
                  },
                ]}
              />
              <KeyValuePairs
                items={[
                  {
                    label: 'Cost anomalies (30d)',
                    value: finOps ? (
                      <StatusIndicator
                        type={finOps.anomalyCount > 0 ? 'warning' : 'success'}
                      >
                        {finOps.anomalyCount} detected
                      </StatusIndicator>
                    ) : (
                      <Box>—</Box>
                    ),
                  },
                ]}
              />
              <KeyValuePairs
                items={[
                  {
                    label: 'Active budgets',
                    value: (
                      <Box variant="h2">
                        {finOps ? String(finOps.budgets.length) : '—'}
                      </Box>
                    ),
                  },
                ]}
              />
            </ColumnLayout>

            {/* Margin History Chart */}
            {finOps && finOps.marginHistory.length > 0 && (
              <BarChart
                series={[
                  {
                    title: 'AWS Cost',
                    type: 'bar',
                    color: '#0972d3',
                    data: finOps.marginHistory.map((m) => ({
                      x: m.period,
                      y: parseFloat(m.awsCost),
                    })),
                  },
                  {
                    title: 'Pro Forma',
                    type: 'bar',
                    color: '#7d8998',
                    data: finOps.marginHistory.map((m) => ({
                      x: m.period,
                      y: parseFloat(m.proformaCost),
                    })),
                  },
                  {
                    title: 'Margin',
                    type: 'bar',
                    color: '#037f0c',
                    data: finOps.marginHistory.map((m) => ({
                      x: m.period,
                      y: parseFloat(m.margin),
                    })),
                  },
                ]}
                xDomain={finOps.marginHistory.map((m) => m.period)}
                yTitle="USD"
                xTitle="Billing Period"
                height={250}
                hideFilter
              />
            )}

            {/* Budgets Table */}
            {finOps && finOps.budgets.length > 0 && (
              <Table
                header={
                  <Header variant="h3" counter={`(${finOps.budgets.length})`}>
                    Budgets
                  </Header>
                }
                columnDefinitions={[
                  {
                    id: 'name',
                    header: 'Budget',
                    cell: (b) => <Box fontWeight="bold">{b.name}</Box>,
                  },
                  {
                    id: 'type',
                    header: 'Type',
                    cell: (b) => <Badge color="blue">{b.budgetType}</Badge>,
                  },
                  {
                    id: 'limit',
                    header: <Box textAlign="right">Limit</Box>,
                    cell: (b) => (
                      <Box textAlign="right">{fmt(b.limitAmount)}</Box>
                    ),
                  },
                  {
                    id: 'actual',
                    header: <Box textAlign="right">Actual</Box>,
                    cell: (b) => (
                      <Box textAlign="right">{fmt(b.actualSpend)}</Box>
                    ),
                  },
                  {
                    id: 'forecast',
                    header: <Box textAlign="right">Forecast</Box>,
                    cell: (b) => (
                      <Box textAlign="right">{fmt(b.forecastedSpend)}</Box>
                    ),
                  },
                  {
                    id: 'pct',
                    header: 'Utilization',
                    cell: (b) => {
                      const p = parseFloat(b.pctUsed);
                      return (
                        <ProgressBar
                          value={Math.min(p, 100)}
                          status={
                            p > 80
                              ? 'error'
                              : p > 50
                                ? 'in-progress'
                                : 'success'
                          }
                          additionalInfo={`${b.pctUsed}%`}
                        />
                      );
                    },
                  },
                ]}
                items={finOps.budgets}
                sortingDisabled
                variant="embedded"
                stripedRows
              />
            )}
          </SpaceBetween>
        </Container>

        {/* Usage by Account & Service */}
        {finOps && finOps.accountServiceCosts.length > 0 && (
          <Table
            header={
              <Header
                variant="h2"
                counter={`(${finOps.accountServiceCosts.length})`}
                description="Top spend by account and service (previous month)"
              >
                Usage Breakdown
              </Header>
            }
            columnDefinitions={[
              {
                id: 'account',
                header: 'Account',
                cell: (i) => <Box variant="code">{i.accountId}</Box>,
              },
              {
                id: 'service',
                header: 'Service',
                cell: (i) => i.service,
              },
              {
                id: 'amount',
                header: 'Cost (USD)',
                cell: (i) => <Box fontWeight="bold">{fmt(i.amount)}</Box>,
              },
            ]}
            items={finOps.accountServiceCosts}
            sortingDisabled
            variant="container"
            stripedRows
          />
        )}

        {/* Pricing Configuration */}
        {conductorData && conductorData.pricingPlans.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                counter={`(${conductorData.pricingPlans.length})`}
                description="Billing Conductor pricing plans and associated rules"
              >
                Pricing Configuration
              </Header>
            }
          >
            <SpaceBetween size="m">
              {conductorData.pricingPlans.map((plan) => (
                <ExpandableSection
                  key={plan.arn}
                  variant="container"
                  headerText={plan.name}
                  headerDescription={
                    plan.billingGroups.length > 0
                      ? `Applied to: ${plan.billingGroups.join(', ')}`
                      : 'Not assigned to any billing group'
                  }
                  headerCounter={`${plan.rules.length} rules`}
                  defaultExpanded={plan.rules.length > 0}
                >
                  {plan.rules.length > 0 ? (
                    <Table
                      columnDefinitions={[
                        {
                          id: 'name',
                          header: 'Rule Name',
                          cell: (r) => <Box fontWeight="bold">{r.name}</Box>,
                        },
                        {
                          id: 'type',
                          header: 'Type',
                          cell: (r) => (
                            <Badge color={r.type === 'MARKUP' ? 'red' : 'blue'}>
                              {r.type}
                            </Badge>
                          ),
                        },
                        {
                          id: 'scope',
                          header: 'Scope',
                          cell: (r) => r.scope,
                        },
                        {
                          id: 'pct',
                          header: 'Modifier',
                          cell: (r) => (
                            <Box fontWeight="bold">
                              {r.modifier_percentage}%
                            </Box>
                          ),
                        },
                        {
                          id: 'service',
                          header: 'Service',
                          cell: (r) => r.service,
                        },
                      ]}
                      items={plan.rules}
                      sortingDisabled
                      variant="embedded"
                      stripedRows
                    />
                  ) : (
                    <Box
                      padding="s"
                      color="text-body-secondary"
                      textAlign="center"
                    >
                      Base AWS pricing — no custom rules applied
                    </Box>
                  )}
                </ExpandableSection>
              ))}
            </SpaceBetween>
          </Container>
        )}

        {/* Custom Line Items */}
        {conductorData && conductorData.customLineItems.length > 0 && (
          <Table
            header={
              <Header
                variant="h2"
                counter={`(${conductorData.customLineItems.length})`}
                description="Recurring charges and credits applied via Billing Conductor"
              >
                Custom Line Items
              </Header>
            }
            columnDefinitions={[
              {
                id: 'name',
                header: 'Name',
                cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
              },
              {
                id: 'desc',
                header: 'Description',
                cell: (item) => item.description,
              },
              {
                id: 'bg',
                header: 'Billing Group',
                cell: (item) => item.billingGroupName,
              },
              {
                id: 'account',
                header: 'Account',
                cell: (item) => <Box variant="code">{item.accountId}</Box>,
              },
              {
                id: 'type',
                header: 'Type',
                cell: (item) => (
                  <Badge
                    color={
                      item.chargeType === 'CREDIT'
                        ? 'green'
                        : item.chargeType === 'FEE'
                          ? 'blue'
                          : 'grey'
                    }
                  >
                    {item.chargeType}
                  </Badge>
                ),
              },
              {
                id: 'value',
                header: 'Value',
                cell: (item) => (
                  <Box fontWeight="bold">
                    {item.percentage != null
                      ? `${item.percentage}%`
                      : item.flatAmount != null
                        ? `$${item.flatAmount.toLocaleString()}`
                        : '—'}
                  </Box>
                ),
              },
            ]}
            items={conductorData.customLineItems}
            sortingDisabled
            variant="container"
            stripedRows
          />
        )}

        {/* Billing Groups */}
        {data?.billingGroups && data.billingGroups.length > 0 && (
          <Table
            header={
              <Header variant="h2" counter={`(${data.billingGroups.length})`}>
                Billing Groups
              </Header>
            }
            columnDefinitions={[
              {
                id: 'name',
                header: 'Name',
                cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
              },
              {
                id: 'status',
                header: 'Status',
                cell: (item) => (
                  <Badge color={item.status === 'ACTIVE' ? 'green' : 'grey'}>
                    {item.status}
                  </Badge>
                ),
              },
              {
                id: 'primaryAccount',
                header: 'Primary Account',
                cell: (item) => (
                  <Box variant="code">{item.primaryAccountId}</Box>
                ),
              },
              {
                id: 'members',
                header: 'Members',
                cell: (item) => item.size,
              },
              {
                id: 'type',
                header: 'Type',
                cell: () => <Badge color="blue">Billing Transfer</Badge>,
              },
            ]}
            items={data.billingGroups}
            sortingDisabled
            variant="container"
            stripedRows
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
