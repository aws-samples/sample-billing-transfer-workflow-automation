import { useApiFetch } from '../hooks/useApiFetch';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  Box,
  Table,
  StatusIndicator,
  Button,
  Modal,
  FormField,
  Input,
  Select,
  Alert,
  ColumnLayout,
  Badge,
  Flashbar,
  CollectionPreferences,
  Pagination,
  TextFilter,
} from '@cloudscape-design/components';
import { createFileRoute } from '@tanstack/react-router';

interface CurExportInfo {
  exportName: string;
  exportArn: string | null;
  status: string;
  billingView: string;
  s3Bucket: string;
  s3Prefix: string;
  format: string;
  billingGroupName: string | null;
  lastRefreshed: string | null;
}

interface BillingGroupOption {
  name: string;
  arn: string;
  primaryAccountId: string;
}

interface CurManagerData {
  exports: CurExportInfo[];
  billingGroupsWithoutCur: string[];
  billingGroups: BillingGroupOption[];
  defaultBucket: string;
}

const COLUMN_DEFS = [
  {
    id: 'name',
    header: 'Export name',
    cell: (e: CurExportInfo) => e.exportName,
    sortingField: 'exportName',
    width: 260,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (e: CurExportInfo) => (
      <StatusIndicator
        type={
          e.status === 'HEALTHY'
            ? 'success'
            : e.status === 'IN_PROGRESS'
              ? 'in-progress'
              : 'error'
        }
      >
        {e.status === 'IN_PROGRESS' ? 'In Progress' : e.status}
      </StatusIndicator>
    ),
    width: 120,
  },
  {
    id: 'billingGroup',
    header: 'Billing group',
    cell: (e: CurExportInfo) =>
      e.billingGroupName ?? <Badge color="grey">Unmatched</Badge>,
    width: 180,
  },
  {
    id: 'view',
    header: 'Billing view',
    cell: (e: CurExportInfo) => (
      <Badge color={e.billingView === 'SHOWBACK' ? 'blue' : 'grey'}>
        {e.billingView === 'SHOWBACK' ? 'Showback' : 'My View'}
      </Badge>
    ),
    width: 120,
  },
  {
    id: 'format',
    header: 'Format',
    cell: (e: CurExportInfo) => e.format,
    width: 90,
  },
  {
    id: 's3',
    header: 'S3 destination',
    cell: (e: CurExportInfo) => (
      <Box fontSize="body-s" fontWeight="normal">
        <code>
          s3://{e.s3Bucket}/{e.s3Prefix}
        </code>
      </Box>
    ),
  },
];

function CurManagerPage() {
  const { apiBase, apiFetch } = useApiFetch();

  const [data, setData] = useState<CurManagerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [crawlerLoading, setCrawlerLoading] = useState(false);
  const [flashItems, setFlashItems] = useState<any[]>([]);
  const [selectedExports, setSelectedExports] = useState<CurExportInfo[]>([]);
  const [selectedMissing, setSelectedMissing] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [filterText, setFilterText] = useState('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [visibleColumns, setVisibleColumns] = useState([
    'name',
    'status',
    'billingGroup',
    'view',
    'format',
    's3',
  ]);

  const [selectedBg, setSelectedBg] = useState<any>(null);
  const [newBucket, setNewBucket] = useState('');
  const [newFormat, setNewFormat] = useState({
    label: 'Parquet (recommended)',
    value: 'PARQUET',
  });
  const [newView, setNewView] = useState({
    label: 'Showback / Chargeback',
    value: 'SHOWBACK',
  });
  const [exportType, setExportType] = useState({
    label: 'Legacy CUR',
    value: 'LEGACY',
  });

  const flash = (type: string, content: string) =>
    setFlashItems([
      {
        type,
        content,
        dismissible: true,
        onDismiss: () => setFlashItems([]),
        id: Date.now().toString(),
      },
    ]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(`/cur-manager`);
      const raw = await resp.json();
      setData({
        exports: (raw.exports || []).map((e: any) => ({
          exportName: e.export_name,
          exportArn: e.export_arn,
          status: e.status,
          billingView: e.billing_view,
          s3Bucket: e.s3_bucket,
          s3Prefix: e.s3_prefix,
          format: e.format,
          billingGroupName: e.billing_group_name,
          lastRefreshed: e.last_refreshed,
        })),
        billingGroupsWithoutCur: raw.billing_groups_without_cur || [],
        billingGroups: (raw.billing_groups || []).map((bg: any) => ({
          name: bg.name,
          arn: bg.arn,
          primaryAccountId: bg.primary_account_id,
        })),
        defaultBucket: raw.default_bucket || '',
      });
      if (raw.default_bucket && !newBucket) {
        setNewBucket(raw.default_bucket);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreate = async () => {
    if (!selectedBg) return;
    setCreating(true);
    try {
      const resp = await apiFetch(`/cur-manager/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billing_group_name: selectedBg.value,
          billing_group_arn: selectedBg.arn,
          s3_bucket: newBucket,
          s3_prefix: 'cur-exports',
          format: newFormat.value,
          billing_view: newView.value,
        }),
      });
      const result = await resp.json();
      flash(result.success ? 'success' : 'error', result.message);
      if (result.success) {
        setShowCreate(false);
        setSelectedBg(null);
        fetchData();
      }
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    let ok = 0;
    for (const exp of selectedExports) {
      if (!exp.exportArn) continue;
      try {
        const resp = await apiFetch(`/cur-manager/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export_arn: exp.exportArn }),
        });
        const r = await resp.json();
        if (r.success) ok++;
      } catch {
        /* ignore individual delete failures */
      }
    }
    setSelectedExports([]);
    setDeleting(false);
    flash('success', `Deleted ${ok} export(s).`);
    fetchData();
  };

  const handleBulkCreate = async () => {
    const toCreate =
      selectedMissing.length > 0
        ? selectedMissing
        : data?.billingGroupsWithoutCur || [];
    if (toCreate.length === 0) return;
    setBulkCreating(true);
    try {
      const resp = await apiFetch(`/cur-manager/create-all-missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3_bucket: data?.defaultBucket || newBucket,
          format: 'PARQUET',
          export_type: exportType.value,
          billing_groups: toCreate,
        }),
      });
      const result = await resp.json();
      flash(result.failed?.length ? 'warning' : 'success', result.message);
      fetchData();
      // Start polling every 10s until page unmounts
      if (!pollingRef.current) {
        pollingRef.current = setInterval(fetchData, 10000);
      }
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setBulkCreating(false);
    }
  };

  const handleRunCrawler = async () => {
    setCrawlerLoading(true);
    try {
      const resp = await apiFetch(`/cur-manager/run-crawler`, {
        method: 'POST',
      });
      const result = await resp.json();
      flash(
        result.status === 'STARTED'
          ? 'success'
          : result.status === 'ALREADY_RUNNING'
            ? 'info'
            : 'error',
        result.message,
      );
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setCrawlerLoading(false);
    }
  };

  const healthyCount =
    data?.exports.filter((e) => e.status === 'HEALTHY').length ?? 0;
  const unhealthyCount =
    data?.exports.filter((e) => e.status === 'UNHEALTHY').length ?? 0;
  const missingCount = data?.billingGroupsWithoutCur.length ?? 0;

  const filtered = (data?.exports ?? []).filter((e) => {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      e.exportName.toLowerCase().includes(q) ||
      (e.billingGroupName || '').toLowerCase().includes(q)
    );
  });
  const totalPages = Math.ceil(filtered.length / pageSize);
  const paged = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Manage Cost and Usage Report exports across all billing transfer relationships"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button loading={crawlerLoading} onClick={handleRunCrawler}>
                Run crawler
              </Button>
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                Create export
              </Button>
            </SpaceBetween>
          }
        >
          CUR Export Manager
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Flashbar items={flashItems} />

        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Total exports</Box>
              <Box variant="awsui-value-large">
                {data?.exports.length ?? '—'}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Healthy</Box>
              <Box variant="awsui-value-large">
                <StatusIndicator type="success">{healthyCount}</StatusIndicator>
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Unhealthy</Box>
              <Box variant="awsui-value-large">
                {unhealthyCount > 0 ? (
                  <StatusIndicator type="error">
                    {unhealthyCount}
                  </StatusIndicator>
                ) : (
                  <StatusIndicator type="success">0</StatusIndicator>
                )}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Missing coverage</Box>
              <Box variant="awsui-value-large">
                {missingCount > 0 ? (
                  <StatusIndicator type="warning">
                    {missingCount}
                  </StatusIndicator>
                ) : (
                  <StatusIndicator type="success">0</StatusIndicator>
                )}
              </Box>
            </div>
          </ColumnLayout>
        </Container>

        {missingCount > 0 && (
          <Alert
            type="warning"
            header={`${missingCount} billing group(s) have no CUR export — select which to create`}
            action={
              <SpaceBetween direction="horizontal" size="xs">
                <Select
                  selectedOption={exportType}
                  onChange={({ detail }) =>
                    setExportType(detail.selectedOption as any)
                  }
                  options={[
                    {
                      label: 'Legacy CUR',
                      value: 'LEGACY',
                    },
                    { label: 'CUR 2.0', value: 'CUR_2_0' },
                  ]}
                />
                <Button
                  loading={bulkCreating}
                  onClick={handleBulkCreate}
                  disabled={selectedMissing.length === 0}
                >
                  {`Create exports (${selectedMissing.length} selected)`}
                </Button>
              </SpaceBetween>
            }
          >
            <SpaceBetween direction="vertical" size="xxs">
              <Box>
                <Button
                  variant="link"
                  onClick={() =>
                    setSelectedMissing(
                      selectedMissing.length === missingCount
                        ? []
                        : [...data!.billingGroupsWithoutCur],
                    )
                  }
                >
                  {selectedMissing.length === missingCount
                    ? 'Deselect all'
                    : 'Select all'}
                </Button>
              </Box>
              {data!.billingGroupsWithoutCur.map((name) => (
                <label key={name} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedMissing.includes(name)}
                    onChange={(e) =>
                      setSelectedMissing(
                        e.target.checked
                          ? [...selectedMissing, name]
                          : selectedMissing.filter((n) => n !== name),
                      )
                    }
                  />{' '}
                  <strong>{name}</strong>
                </label>
              ))}
            </SpaceBetween>
          </Alert>
        )}

        <Table
          header={
            <Header
              counter={`(${filtered.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    disabled={selectedExports.length === 0}
                    loading={deleting}
                    onClick={handleDelete}
                  >
                    Delete selected
                  </Button>
                  <Button
                    iconName="refresh"
                    onClick={fetchData}
                    loading={loading}
                  />
                </SpaceBetween>
              }
            >
              CUR Exports
            </Header>
          }
          loading={loading}
          loadingText="Loading exports..."
          items={paged}
          selectionType="multi"
          selectedItems={selectedExports}
          onSelectionChange={({ detail }) =>
            setSelectedExports(detail.selectedItems)
          }
          trackBy="exportName"
          filter={
            <TextFilter
              filteringText={filterText}
              filteringPlaceholder="Find exports"
              onChange={({ detail }) => {
                setFilterText(detail.filteringText);
                setCurrentPage(1);
              }}
            />
          }
          pagination={
            <Pagination
              currentPageIndex={currentPage}
              pagesCount={totalPages || 1}
              onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
            />
          }
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              preferences={{ pageSize, visibleContent: visibleColumns }}
              onConfirm={({ detail }) => {
                if (detail.pageSize) setPageSize(detail.pageSize);
                if (detail.visibleContent)
                  setVisibleColumns([...detail.visibleContent]);
              }}
              pageSizePreference={{
                title: 'Page size',
                options: [
                  { value: 5, label: '5 exports' },
                  { value: 10, label: '10 exports' },
                  { value: 25, label: '25 exports' },
                ],
              }}
              visibleContentPreference={{
                title: 'Visible columns',
                options: [
                  {
                    label: 'Properties',
                    options: COLUMN_DEFS.map((c) => ({
                      id: c.id,
                      label: c.header as string,
                    })),
                  },
                ],
              }}
            />
          }
          columnDefinitions={COLUMN_DEFS.filter((c) =>
            visibleColumns.includes(c.id),
          )}
          empty={
            <Box textAlign="center" padding={{ vertical: 'l' }}>
              <SpaceBetween size="m">
                <b>No CUR exports</b>
                <Box variant="p" color="text-body-secondary">
                  No exports have been configured yet.
                </Box>
                <Button onClick={() => setShowCreate(true)}>
                  Create export
                </Button>
              </SpaceBetween>
            </Box>
          }
          stripedRows
          stickyHeader
          variant="full-page"
        />

        <Modal
          visible={showCreate}
          onDismiss={() => setShowCreate(false)}
          header="Create CUR export"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={creating}
                  onClick={handleCreate}
                  disabled={!selectedBg || !newBucket}
                >
                  Create export
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Alert type="info">
              This creates a new CUR that delivers billing data to S3
              automatically. Data populates within 24-48 hours.
            </Alert>
            <FormField
              label="Billing group"
              description="Select the billing group for this export"
            >
              <Select
                selectedOption={selectedBg}
                onChange={({ detail }) => setSelectedBg(detail.selectedOption)}
                options={(data?.billingGroups ?? []).map((bg) => ({
                  label: `${bg.name} (${bg.primaryAccountId})`,
                  value: bg.name,
                  arn: bg.arn,
                }))}
                placeholder="Select a billing group"
                filteringType="auto"
              />
            </FormField>
            <FormField
              label="Billing view"
              description="Showback is what customers see. My View is your actual cost."
            >
              <Select
                selectedOption={newView}
                onChange={({ detail }) =>
                  setNewView(detail.selectedOption as any)
                }
                options={[
                  {
                    label: 'Showback / Chargeback (customer-facing)',
                    value: 'SHOWBACK',
                  },
                  { label: 'My View (your actual cost)', value: 'MY_VIEW' },
                ]}
              />
            </FormField>
            <ColumnLayout columns={2}>
              <FormField label="Output format">
                <Select
                  selectedOption={newFormat}
                  onChange={({ detail }) =>
                    setNewFormat(detail.selectedOption as any)
                  }
                  options={[
                    { label: 'Parquet (recommended)', value: 'PARQUET' },
                    { label: 'CSV', value: 'TEXT_OR_CSV' },
                  ]}
                />
              </FormField>
              <FormField label="S3 bucket">
                <Input
                  value={newBucket}
                  onChange={({ detail }) => setNewBucket(detail.value)}
                />
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
    </ContentLayout>
  );
}

export const Route = createFileRoute('/cur-manager')({
  component: CurManagerPage,
});
