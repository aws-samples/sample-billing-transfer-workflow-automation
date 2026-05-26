import { useApiFetch } from '../hooks/useApiFetch';
import { useEffect, useState, useCallback } from 'react';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  Box,
  Table,
  Button,
  Badge,
  Alert,
  ColumnLayout,
  TextFilter,
  Pagination,
  Select,
  CollectionPreferences,
} from '@cloudscape-design/components';
import { createFileRoute } from '@tanstack/react-router';

interface ReportEntry {
  billingPeriod: string;
  accountId: string;
  accountName: string;
  rowCount: number;
}

function CustomerReportsPage() {
  const { apiBase, apiFetch } = useApiFetch();

  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(`/customer-reports`);
      const raw = await resp.json();
      setReports(
        (raw.reports || []).map((r: any) => ({
          billingPeriod: r.billing_period,
          accountId: r.account_id,
          accountName: r.account_name,
          rowCount: r.row_count,
        })),
      );
      setPeriods(raw.periods || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = reports.filter((r) => {
    if (selectedPeriod?.value && r.billingPeriod !== selectedPeriod.value)
      return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      return r.accountId.includes(q) || r.accountName.toLowerCase().includes(q);
    }
    return true;
  });

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paged = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const handleDownload = async (billingPeriod: string, accountId?: string) => {
    const params = new URLSearchParams({ billing_period: billingPeriod });
    if (accountId) params.set('account_id', accountId);
    try {
      const resp = await apiFetch(
        `/customer-reports/download?${params.toString()}`,
      );
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cur-${billingPeriod}${accountId ? `-${accountId}` : ''}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  };

  const periodOptions = [
    { label: 'All periods', value: '' },
    ...periods.map((p) => ({ label: p, value: p })),
  ];
  const uniqueAccounts = new Set(reports.map((r) => r.accountId)).size;
  const totalLineItems = filtered.reduce((sum, r) => sum + r.rowCount, 0);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Download billing reports filtered per customer — powered by Amazon Athena"
        >
          Customer Reports
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Billing periods</Box>
              <Box variant="awsui-value-large">{periods.length}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Customer accounts</Box>
              <Box variant="awsui-value-large">{uniqueAccounts}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Filtered results</Box>
              <Box variant="awsui-value-large">{filtered.length}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Total line items</Box>
              <Box variant="awsui-value-large">
                {totalLineItems.toLocaleString()}
              </Box>
            </div>
          </ColumnLayout>
        </Container>

        <Alert type="info">
          Use <strong>Download for customer</strong> to get a CSV with only that
          customer's billing line items. Use{' '}
          <strong>Download full period</strong> to get all accounts for a
          billing period. Queries run on Amazon Athena — no data is loaded into
          the server.
        </Alert>

        <Table
          header={
            <Header
              counter={`(${filtered.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  {selectedPeriod?.value && (
                    <Button
                      variant="normal"
                      iconName="download"
                      onClick={() => handleDownload(selectedPeriod.value)}
                    >
                      Download full period: {selectedPeriod.value}
                    </Button>
                  )}
                  <Button
                    iconName="refresh"
                    onClick={fetchData}
                    loading={loading}
                  />
                </SpaceBetween>
              }
            >
              CUR Data by Account
            </Header>
          }
          loading={loading}
          loadingText="Querying Athena..."
          items={paged}
          filter={
            <SpaceBetween direction="horizontal" size="s">
              <TextFilter
                filteringText={filterText}
                filteringPlaceholder="Search by account ID or name..."
                onChange={({ detail }) => {
                  setFilterText(detail.filteringText);
                  setCurrentPage(1);
                }}
              />
              <Select
                selectedOption={selectedPeriod || periodOptions[0]}
                onChange={({ detail }) => {
                  setSelectedPeriod(
                    detail.selectedOption.value ? detail.selectedOption : null,
                  );
                  setCurrentPage(1);
                }}
                options={periodOptions}
              />
            </SpaceBetween>
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
              preferences={{ pageSize }}
              onConfirm={({ detail }) => {
                if (detail.pageSize) setPageSize(detail.pageSize);
              }}
              pageSizePreference={{
                title: 'Page size',
                options: [
                  { value: 10, label: '10 rows' },
                  { value: 20, label: '20 rows' },
                  { value: 50, label: '50 rows' },
                ],
              }}
            />
          }
          empty={
            <Box textAlign="center" padding={{ vertical: 'l' }}>
              <SpaceBetween size="m">
                <b>No CUR data found</b>
                <Box variant="p" color="text-body-secondary">
                  CUR exports need 24-48 hours to deliver data. Check the CUR
                  Export Manager.
                </Box>
              </SpaceBetween>
            </Box>
          }
          stripedRows
          stickyHeader
          variant="full-page"
          columnDefinitions={[
            {
              id: 'period',
              header: 'Billing period',
              cell: (r) => <Badge color="blue">{r.billingPeriod}</Badge>,
              sortingField: 'billingPeriod',
              width: 130,
            },
            {
              id: 'account',
              header: 'Account ID',
              cell: (r) => (
                <Box fontSize="body-s">
                  <code>{r.accountId}</code>
                </Box>
              ),
              sortingField: 'accountId',
              width: 150,
            },
            {
              id: 'name',
              header: 'Account name',
              cell: (r) => r.accountName || '—',
              width: 200,
            },
            {
              id: 'rows',
              header: 'Line items',
              cell: (r) => r.rowCount.toLocaleString(),
              sortingField: 'rowCount',
              width: 110,
            },
            {
              id: 'actions',
              header: '',
              cell: (r) => (
                <Button
                  variant="primary"
                  iconName="download"
                  onClick={() => handleDownload(r.billingPeriod, r.accountId)}
                >
                  Download for customer
                </Button>
              ),
              width: 240,
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

export const Route = createFileRoute('/customer-reports')({
  component: CustomerReportsPage,
});
