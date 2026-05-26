import { useApiFetch } from '../hooks/useApiFetch';
import { useEffect, useState, useCallback } from 'react';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  Box,
  Table,
  StatusIndicator,
  Badge,
  Alert,
  ColumnLayout,
  Button,
  Flashbar,
  ProgressBar,
  ExpandableSection,
  Modal,
  FormField,
  Input,
  Select,
  KeyValuePairs,
} from '@cloudscape-design/components';
import { createFileRoute } from '@tanstack/react-router';

interface GapDetail {
  category: string;
  myViewAmount: string;
  showbackAmount: string;
  cliAmount: string;
  gap: string;
}

interface SuggestedCli {
  name: string;
  description: string;
  billingGroupArn: string;
  chargeType: string;
  flatAmount: number;
}

interface BillingGroupGap {
  billingGroupName: string;
  billingGroupArn: string;
  primaryAccountId: string;
  myViewTotal: string;
  showbackTotal: string;
  margin: string;
  gaps: GapDetail[];
  suggestedClis: SuggestedCli[];
}

// Editable version for the review modal
interface EditableCli {
  name: string;
  description: string;
  billingGroupArn: string;
  billingGroupName: string;
  chargeType: { label: string; value: string };
  amount: string;
}

function GapAnalysisPage() {
  const { apiBase, apiFetch } = useApiFetch();

  const [data, setData] = useState<{
    billingGroups: BillingGroupGap[];
    totalUncovered: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [flashItems, setFlashItems] = useState<any[]>([]);
  const [selectedItems, setSelectedItems] = useState<BillingGroupGap[]>([]);
  const [demoMode, setDemoMode] = useState(false);

  // Review modal state
  const [showReview, setShowReview] = useState(false);
  const [editableClis, setEditableClis] = useState<EditableCli[]>([]);

  // Commission state
  const [commissionRate, setCommissionRate] = useState<{
    label: string;
    value: string;
  }>({ label: '10%', value: '10' });
  const [applyingCommission, setApplyingCommission] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(
        `/gap-analysis${demoMode ? '?demo=true' : ''}`,
      );
      const raw = await resp.json();
      setData({
        totalUncovered: raw.total_uncovered,
        billingGroups: (raw.billing_groups || []).map((bg: any) => ({
          billingGroupName: bg.billing_group_name,
          billingGroupArn: bg.billing_group_arn,
          primaryAccountId: bg.primary_account_id,
          myViewTotal: bg.my_view_total,
          showbackTotal: bg.showback_total,
          margin: bg.margin,
          gaps: (bg.gaps || []).map((g: any) => ({
            category: g.category,
            myViewAmount: g.my_view_amount,
            showbackAmount: g.showback_amount,
            cliAmount: g.cli_amount,
            gap: g.gap,
          })),
          suggestedClis: (bg.suggested_clis || []).map((c: any) => ({
            name: c.name,
            description: c.description,
            billingGroupArn: c.billing_group_arn,
            chargeType: c.charge_type,
            flatAmount: c.flat_amount,
          })),
        })),
      });
      setSelectedItems([]);
    } catch (e) {
      console.error('Failed to load gap analysis', e);
    } finally {
      setLoading(false);
    }
  }, [apiBase, demoMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const bgAll = data?.billingGroups ?? [];
  const bgWithGaps = bgAll.filter((bg) => bg.suggestedClis.length > 0);
  const totalUncovered = parseFloat(data?.totalUncovered ?? '0');
  const selectedClis = selectedItems.flatMap((bg) => bg.suggestedClis);
  const coveragePercent =
    bgAll.length > 0
      ? Math.round(((bgAll.length - bgWithGaps.length) / bgAll.length) * 100)
      : 100;

  const chargeTypeOptions = [
    { label: 'Fee (charge)', value: 'FEE' },
    { label: 'Credit', value: 'CREDIT' },
  ];

  // Open review modal with editable CLIs from selected groups (or all)
  const openReview = (groups: BillingGroupGap[]) => {
    const clis: EditableCli[] = groups.flatMap((bg) =>
      bg.suggestedClis.map((c) => ({
        name: c.name,
        description: c.description,
        billingGroupArn: c.billingGroupArn,
        billingGroupName: bg.billingGroupName,
        chargeType:
          chargeTypeOptions.find((o) => o.value === c.chargeType) ||
          chargeTypeOptions[0],
        amount: Math.abs(c.flatAmount).toFixed(2),
      })),
    );
    setEditableClis(clis);
    setShowReview(true);
  };

  const updateCli = (index: number, field: string, value: any) => {
    setEditableClis((prev) =>
      prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    );
  };

  const removeCli = (index: number) => {
    setEditableClis((prev) => prev.filter((_, i) => i !== index));
  };

  const handleConfirmApply = async () => {
    if (editableClis.length === 0) return;
    setApplying(true);
    try {
      const resp = await apiFetch(`/gap-analysis/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clis: editableClis.map((c) => ({
            name: c.name,
            description: c.description,
            billing_group_arn: c.billingGroupArn,
            charge_type: c.chargeType.value,
            flat_amount:
              c.chargeType.value === 'CREDIT'
                ? -Math.abs(parseFloat(c.amount))
                : Math.abs(parseFloat(c.amount)),
          })),
        }),
      });
      const result = await resp.json();
      setFlashItems([
        {
          type: result.failed?.length ? 'warning' : 'success',
          content: result.message,
          dismissible: true,
          onDismiss: () => setFlashItems([]),
          id: Date.now().toString(),
        },
      ]);
      setShowReview(false);
      fetchData();
    } catch (e: any) {
      setFlashItems([
        {
          type: 'error',
          content: `Apply failed: ${e.message}`,
          dismissible: true,
          onDismiss: () => setFlashItems([]),
          id: Date.now().toString(),
        },
      ]);
    } finally {
      setApplying(false);
    }
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Detects support charges, credits, and refunds missing from customer Showback views"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant={demoMode ? 'primary' : 'normal'}
                onClick={() => setDemoMode(!demoMode)}
              >
                {demoMode ? 'Demo mode ON' : 'Demo mode'}
              </Button>
              <Button
                variant="normal"
                iconName="refresh"
                onClick={fetchData}
                loading={loading}
              >
                Refresh
              </Button>
            </SpaceBetween>
          }
        >
          Pro Forma Gap Analysis
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Flashbar items={flashItems} />

        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <KeyValuePairs
              items={[
                {
                  label: 'Billing groups',
                  value: (
                    <Box variant="h1" fontSize="display-l" fontWeight="bold">
                      {bgAll.length}
                    </Box>
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Coverage',
                  value: (
                    <ProgressBar
                      value={coveragePercent}
                      status={
                        coveragePercent === 100 ? 'success' : 'in-progress'
                      }
                      additionalInfo={`${bgAll.length - bgWithGaps.length} of ${bgAll.length} fully covered`}
                    />
                  ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Groups with gaps',
                  value:
                    bgWithGaps.length > 0 ? (
                      <StatusIndicator type="warning">
                        <Box variant="h2">{bgWithGaps.length}</Box>
                      </StatusIndicator>
                    ) : (
                      <StatusIndicator type="success">
                        <Box variant="h2">0</Box>
                      </StatusIndicator>
                    ),
                },
              ]}
            />
            <KeyValuePairs
              items={[
                {
                  label: 'Total uncovered',
                  value:
                    totalUncovered > 0 ? (
                      <Box
                        variant="h1"
                        fontSize="display-l"
                        fontWeight="bold"
                        color="text-status-error"
                      >
                        ${totalUncovered.toFixed(2)}
                      </Box>
                    ) : (
                      <Box
                        variant="h1"
                        fontSize="display-l"
                        fontWeight="bold"
                        color="text-status-success"
                      >
                        $0.00
                      </Box>
                    ),
                },
              ]}
            />
          </ColumnLayout>
        </Container>

        <Alert type="info">
          AWS Billing Conductor excludes support charges, credits, and refunds
          from Showback by design. Select billing groups and click{' '}
          <strong>Fix selected</strong> to review and create Custom Line Items.
        </Alert>

        <Container
          header={
            <Header
              variant="h2"
              description="Apply a standard percentage-based commission fee to selected billing groups. Creates a recurring FEE Custom Line Item in Billing Conductor."
            >
              Reseller Commission
            </Header>
          }
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={3}>
              <FormField label="Commission rate (%)">
                <SpaceBetween size="xs">
                  <Input
                    type="number"
                    value={commissionRate.value}
                    onChange={({ detail }) =>
                      setCommissionRate({
                        label: `${detail.value}%`,
                        value: detail.value,
                      })
                    }
                    placeholder="e.g. 12.5"
                    step={0.1}
                  />
                  <SpaceBetween direction="horizontal" size="xxs">
                    {['5', '10', '15', '20'].map((v) => (
                      <Button
                        key={v}
                        variant={
                          commissionRate.value === v ? 'primary' : 'normal'
                        }
                        onClick={() =>
                          setCommissionRate({ label: `${v}%`, value: v })
                        }
                      >
                        {v}%
                      </Button>
                    ))}
                  </SpaceBetween>
                </SpaceBetween>
              </FormField>
              <FormField label="Selected billing groups">
                <Box variant="p" padding={{ top: 'xs' }}>
                  {selectedItems.length > 0
                    ? selectedItems.map((bg) => bg.billingGroupName).join(', ')
                    : 'Select billing groups from the table below'}
                </Box>
              </FormField>
              <FormField label="&nbsp;">
                <Button
                  variant="primary"
                  loading={applyingCommission}
                  disabled={selectedItems.length === 0}
                  onClick={async () => {
                    setApplyingCommission(true);
                    try {
                      const resp = await apiFetch(`/commission/apply`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(
                          selectedItems.map((bg) => ({
                            billing_group_arn: bg.billingGroupArn,
                            billing_group_name: bg.billingGroupName,
                            percentage: parseFloat(commissionRate.value),
                          })),
                        ),
                      });
                      const result = await resp.json();
                      setFlashItems([
                        {
                          type: result.failed?.length ? 'warning' : 'success',
                          content: result.message,
                          dismissible: true,
                          onDismiss: () => setFlashItems([]),
                          id: Date.now().toString(),
                        },
                      ]);
                      setSelectedItems([]);
                    } catch (e: any) {
                      setFlashItems([
                        {
                          type: 'error',
                          content: `Commission failed: ${e.message}`,
                          dismissible: true,
                          onDismiss: () => setFlashItems([]),
                          id: Date.now().toString(),
                        },
                      ]);
                    } finally {
                      setApplyingCommission(false);
                    }
                  }}
                >
                  Apply {commissionRate.value}% to {selectedItems.length}{' '}
                  group(s)
                </Button>
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Container>

        <Table
          header={
            <Header
              counter={`(${bgAll.length})`}
              description="Select billing groups to review and apply fixes"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="normal"
                    disabled={selectedClis.length === 0}
                    onClick={() => openReview(selectedItems)}
                  >
                    {selectedClis.length > 0
                      ? `Fix selected (${selectedClis.length} items)`
                      : 'Fix selected'}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={bgWithGaps.length === 0}
                    onClick={() => openReview(bgWithGaps)}
                  >
                    Fix all
                  </Button>
                </SpaceBetween>
              }
            >
              Billing Groups
            </Header>
          }
          loading={loading}
          loadingText="Analyzing gaps..."
          items={bgAll}
          selectionType="multi"
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) =>
            setSelectedItems(detail.selectedItems)
          }
          trackBy="billingGroupName"
          empty={
            <Box textAlign="center" padding="l">
              <b>No billing groups found</b>
            </Box>
          }
          stripedRows
          columnDefinitions={[
            {
              id: 'name',
              header: 'Billing group',
              cell: (bg) => <Box fontWeight="bold">{bg.billingGroupName}</Box>,
              width: 200,
            },
            {
              id: 'account',
              header: 'Account',
              cell: (bg) => (
                <span style={{ fontFamily: 'monospace' }}>
                  {bg.primaryAccountId}
                </span>
              ),
              width: 140,
            },
            {
              id: 'myView',
              header: <Box textAlign="right">My View</Box>,
              cell: (bg) => <Box textAlign="right">${bg.myViewTotal}</Box>,
              width: 100,
            },
            {
              id: 'showback',
              header: <Box textAlign="right">Showback</Box>,
              cell: (bg) => <Box textAlign="right">${bg.showbackTotal}</Box>,
              width: 100,
            },
            {
              id: 'margin',
              header: <Box textAlign="right">Margin</Box>,
              cell: (bg) => (
                <Box
                  textAlign="right"
                  fontWeight="bold"
                  color={
                    parseFloat(bg.margin) >= 0
                      ? 'text-status-success'
                      : 'text-status-error'
                  }
                >
                  ${bg.margin}
                </Box>
              ),
              width: 100,
            },
            {
              id: 'status',
              header: 'Coverage',
              cell: (bg) =>
                bg.suggestedClis.length === 0 ? (
                  <StatusIndicator type="success">All covered</StatusIndicator>
                ) : (
                  <StatusIndicator type="warning">
                    {bg.suggestedClis.length} gap(s) — $
                    {bg.gaps
                      .reduce((s, g) => s + Math.max(parseFloat(g.gap), 0), 0)
                      .toFixed(2)}
                  </StatusIndicator>
                ),
              width: 220,
            },
            {
              id: 'detail',
              header: 'Details',
              cell: (bg) =>
                bg.suggestedClis.length > 0 ? (
                  <ExpandableSection
                    headerText={`${bg.suggestedClis.length} item(s)`}
                    variant="footer"
                  >
                    <SpaceBetween size="xxs">
                      {bg.suggestedClis.map((c, i) => (
                        <Box key={i} fontSize="body-s">
                          <Badge
                            color={c.chargeType === 'FEE' ? 'blue' : 'green'}
                          >
                            {c.chargeType}
                          </Badge>{' '}
                          {c.name} — ${Math.abs(c.flatAmount).toFixed(2)}
                        </Box>
                      ))}
                    </SpaceBetween>
                  </ExpandableSection>
                ) : (
                  <Box color="text-status-inactive" fontSize="body-s">
                    —
                  </Box>
                ),
            },
            {
              id: 'action',
              header: '',
              cell: (bg) =>
                bg.suggestedClis.length > 0 ? (
                  <Button
                    variant="inline-link"
                    onClick={() => openReview([bg])}
                  >
                    Fix
                  </Button>
                ) : null,
              width: 60,
            },
          ]}
        />

        {/* Review & Edit Modal */}
        <Modal
          visible={showReview}
          onDismiss={() => setShowReview(false)}
          size="large"
          header="Review Custom Line Items"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowReview(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={applying}
                  disabled={editableClis.length === 0}
                  onClick={handleConfirmApply}
                >
                  Create {editableClis.length} line item(s)
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Alert type="info">
              Review and adjust the values below. These Custom Line Items will
              be created in Billing Conductor for the current billing period.
              All accounts in each billing group will see these charges in their
              Showback view.
            </Alert>

            {editableClis.map((cli, idx) => (
              <Container
                key={idx}
                header={
                  <Header
                    variant="h3"
                    description={`Billing group: ${cli.billingGroupName}`}
                    actions={
                      <Button
                        variant="icon"
                        iconName="close"
                        onClick={() => removeCli(idx)}
                      />
                    }
                  >
                    {cli.name}
                  </Header>
                }
              >
                <ColumnLayout columns={2}>
                  <FormField label="Name">
                    <Input
                      value={cli.name}
                      onChange={({ detail }) =>
                        updateCli(idx, 'name', detail.value)
                      }
                    />
                  </FormField>
                  <FormField label="Description">
                    <Input
                      value={cli.description}
                      onChange={({ detail }) =>
                        updateCli(idx, 'description', detail.value)
                      }
                    />
                  </FormField>
                  <FormField label="Type">
                    <Select
                      selectedOption={cli.chargeType}
                      onChange={({ detail }) =>
                        updateCli(idx, 'chargeType', detail.selectedOption)
                      }
                      options={chargeTypeOptions}
                    />
                  </FormField>
                  <FormField label="Amount ($)">
                    <Input
                      type="number"
                      value={cli.amount}
                      onChange={({ detail }) =>
                        updateCli(idx, 'amount', detail.value)
                      }
                    />
                  </FormField>
                </ColumnLayout>
              </Container>
            ))}

            {editableClis.length === 0 && (
              <Box textAlign="center" padding="l" color="text-status-inactive">
                All line items removed. Click Cancel to go back.
              </Box>
            )}
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
    </ContentLayout>
  );
}

export const Route = createFileRoute('/gap-analysis')({
  component: GapAnalysisPage,
});
