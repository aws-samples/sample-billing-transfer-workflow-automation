# CUR Export Manager & Customer Reports — Design Document

## The Problem

AWS Distributors (bill receivers) managing billing transfers for downstream partners and customers face a set of operational challenges that make billing reconciliation manual, error-prone, and unscalable.

### Current Customer Pain Points

**1. Manual CUR Setup Per Relationship**

When a distributor onboards a new customer via Billing Transfer, they must manually create a Cost and Usage Report (CUR) export in the AWS console. This involves:
- Remembering to create the export only AFTER the billing transfer relationship activates (creating it before results in an UNHEALTHY export)
- Selecting the correct billing view (Showback for customer-facing data, My View for internal P&L)
- Disabling Split Cost Allocation (incompatible with Billing Transfer — fails silently)
- Entering the full CUR 2.0 column list (113 columns — `SELECT *` is not supported by the Data Exports API)
- Configuring the correct `BILLING_VIEW_ARN` from the billing views API
- Using a unique export name (reusing a deleted export's name causes a cryptic error)
- Setting up the S3 destination with correct bucket policies

For a distributor with 50 customers, this is 50+ manual console sessions. At 1000 customers, it's unmanageable.

**2. CUR Export Limit**

The BCM Data Exports API has a hard limit of 5 exports per account for the `COST_AND_USAGE_REPORT` table. This limit is not adjustable. A distributor cannot create one export per customer — they must use a small number of exports that cover all customers, then filter at query time.

**3. No Visibility Into Export Health**

CUR exports can silently become UNHEALTHY due to a known bug where settings revert to "Primary View" after Billing Transfer activation. Distributors discover this at month-end when reconciliation data is missing. There is no proactive alerting.

**4. Billing Conductor Pro Forma Gaps**

AWS Billing Conductor's Showback (pro forma) data excludes by design:
- Support plan charges (Business, Enterprise, etc.)
- AWS credits (MAP, promotional, contractual)
- Refunds
- Free Tier usage (credit-based)

The official AWS guidance is for distributors to manually create Custom Line Items (CLIs) in Billing Conductor to model these charges. This requires:
- Knowing the exact dollar amount of support charges per customer
- Calculating proportional credit allocations
- Creating CLIs manually in the console each billing period
- Tracking which CLIs exist and whether they match current amounts

**5. No Per-Customer Report Generation**

CUR files contain line items for ALL customers in a single parquet file. To share billing data with a specific customer, the distributor must:
- Download the multi-GB parquet file
- Load it into a tool (Excel, Athena, custom scripts)
- Filter by `line_item_usage_account_id`
- Export the filtered data as CSV
- Send it to the customer

This is repeated monthly for every customer.

---

## Solution Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Billing Transfer Automation Portal                     │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ CUR Export    │  │ Customer     │  │ Pro Forma Gap      │ │
│  │ Manager       │  │ Reports      │  │ Analysis           │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬─────────────┘ │
│         │                  │                  │               │
│  ┌──────┴──────────────────┴──────────────────┴─────────┐   │
│  │              FastAPI Backend (Python)                  │   │
│  └──────┬───────────────┬─────────────────┬─────────────┘   │
└─────────┼───────────────┼─────────────────┼─────────────────┘
          │               │                 │
    ┌─────┴─────┐   ┌────┴────┐    ┌──────┴──────┐
    │ BCM Data  │   │ Amazon  │    │ Billing     │
    │ Exports   │   │ Athena  │    │ Conductor   │
    │ API       │   │         │    │ API         │
    └─────┬─────┘   └────┬────┘    └──────┬──────┘
          │               │                │
    ┌─────┴─────┐   ┌────┴────┐    ┌──────┴──────┐
    │ S3 Bucket │◄──┤ Glue    │    │ Custom Line │
    │ (Parquet) │   │ Catalog │    │ Items       │
    └───────────┘   └─────────┘    └─────────────┘
```

### Technology Choices

| Component | Technology | Why |
|-----------|-----------|-----|
| CUR version | CUR 2.0 (BCM Data Exports API) | Required for Billing Transfer views. CUR 1.0 is legacy. |
| CUR format | Parquet (Snappy compression) | Columnar format enables Athena to read only needed columns. 10x smaller than CSV. |
| Query engine | Amazon Athena | Serverless SQL over S3. No infrastructure to manage. Scales to TB of CUR data. Costs $5/TB scanned — parquet columnar format minimizes scan. |
| Metadata catalog | AWS Glue | Required by Athena for table schema and partition discovery. |
| Report filtering | Athena SQL | `WHERE line_item_usage_account_id = '...'` — filtering happens in Athena, not in the application server. Server never loads raw CUR data. |
| CLI management | Billing Conductor API | `CreateCustomLineItem` / `UpdateCustomLineItem` / `DeleteCustomLineItem` for automated gap fixes. |
| Frontend | React + Cloudscape Design System | Enterprise AWS console look and feel. |
| Backend | FastAPI (Python) | Async endpoints, boto3 for AWS API calls. |

---

## Feature 1: CUR Export Manager

### What It Does

Provides a single dashboard to manage all CUR data exports across billing transfer relationships.

### Workflow

1. **Page Load** — Backend calls `bcm-data-exports:ListExports` and `bcm-data-exports:GetExport` for each export. Cross-references with billing groups from Billing Conductor (`list-billing-groups` via MCP server) to identify which groups have CUR coverage.

2. **Health Monitoring** — Each export shows HEALTHY or UNHEALTHY status. Billing groups without any CUR export are flagged in a warning banner.

3. **Create All Missing** — One-click button creates CUR exports for all uncovered billing groups. For each:
   - Resolves the correct `BILLING_VIEW_ARN` via `billing:ListBillingViews`
   - Builds the full 113-column `SELECT` statement (required by the API — `SELECT *` is not supported)
   - Sets `INCLUDE_SPLIT_COST_ALLOCATION_DATA = FALSE` (incompatible with Billing Transfer)
   - Configures Parquet format with Snappy compression
   - Creates both Showback and My View exports
   - Uses a naming convention that enables automatic matching back to billing groups

4. **Delete Broken Exports** — Multi-select exports and delete them to free up the 5-export quota.

### Scale Consideration: The 5-Export Limit

The BCM Data Exports API limits accounts to 5 `COST_AND_USAGE_REPORT` exports. This is a hard, non-adjustable quota. For a distributor with 1000 customers, the approach is:
- Create 1-2 exports (Showback + My View) that cover ALL billing groups
- Filter per-customer at query time using Athena
- The CUR Export Manager handles this automatically

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/cur-manager` | GET | List all exports with health status and coverage gaps |
| `/cur-manager/create` | POST | Create a single CUR export |
| `/cur-manager/create-all-missing` | POST | Bulk create exports for all uncovered billing groups |
| `/cur-manager/delete` | POST | Delete a CUR export |

---

## Feature 2: Customer Reports

### What It Does

Enables distributors to download per-customer billing reports as CSV, filtered from the CUR data using Athena — without loading raw data into the application server.

### Workflow

1. **Page Load** — Backend runs an Athena `GROUP BY` query:
   ```sql
   SELECT BILLING_PERIOD, line_item_usage_account_id,
          line_item_usage_account_name, count(*) as cnt
   FROM cur_data
   GROUP BY BILLING_PERIOD, line_item_usage_account_id, line_item_usage_account_name
   ```
   This returns a summary: which accounts exist in which billing periods, with row counts. No raw CUR data is transferred.

2. **Browse & Filter** — The frontend shows a paginated table (20 rows per page) with:
   - Text search by account ID or name
   - Billing period dropdown filter
   - Row counts per account per period

3. **Download for Customer** — When the distributor clicks download, the backend runs:
   ```sql
   SELECT * FROM cur_data
   WHERE BILLING_PERIOD = '2026-01'
   AND line_item_usage_account_id = '<CUSTOMER_ACCOUNT_ID>'
   ```
   Athena writes the result as CSV to an S3 results bucket. The backend streams this CSV to the browser as a file download. The application server never loads the parquet data.

4. **Download Full Period** — Same flow without the account filter — downloads all accounts for a billing period.

### Architecture for Scale

```
Browser → FastAPI → Athena SQL query → S3 (parquet, partitioned by BILLING_PERIOD)
                                      ↓
                              Athena writes CSV result to S3
                                      ↓
                         FastAPI streams CSV from S3 → Browser download
```

For 1000 customers × 12 months:
- The summary query scans only the `line_item_usage_account_id` column (a few MB due to Parquet columnar format)
- Per-customer downloads scan only the relevant partition (one month) and filter by account
- Athena auto-scales — no infrastructure to provision
- Cost: ~$0.005 per query for a typical monthly CUR partition

### Infrastructure

| Resource | Purpose |
|----------|---------|
| Glue Database: `billing_portal_cur` | Metadata catalog for Athena |
| Glue Table: `cur_data` | Schema definition over CUR parquet files in S3 |
| S3: `my-billing-transfer-cur-bucket` | CUR data delivery (parquet files, partitioned by `BILLING_PERIOD`) |
| S3: `billing-portal-athena-results-*` | Athena query results (CSV files) |
| Athena Workgroup: `primary` | Query execution |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/customer-reports` | GET | List available billing periods and accounts via Athena |
| `/customer-reports/download` | GET | Download CUR as CSV, optionally filtered by account and period |

---

## Feature 3: Pro Forma Gap Analysis

### What It Does

Compares the distributor's actual costs (My View) against what customers see (Showback) to identify dollar-amount gaps caused by support charges, credits, and refunds that Billing Conductor excludes by design. Generates ready-to-apply Custom Line Item (CLI) specifications and can create them automatically.

### Workflow

1. **Gap Detection** — Backend fetches:
   - Per-billing-group cost reports from Billing Conductor (`list-billing-group-cost-reports`) — gives My View vs Showback totals
   - Service-level costs from Cost Explorer — identifies support charges by service name
   - Credit/refund amounts from Cost Explorer — filtered by `RECORD_TYPE`
   - Existing CLIs from Billing Conductor (`list-custom-line-items`) — to see what's already covered

2. **Gap Calculation** — For each billing group:
   - Calculates proportional share of support charges (based on cost share across all billing groups)
   - Calculates proportional share of credits/refunds
   - Subtracts existing CLI amounts
   - The remainder is the uncovered gap

3. **CLI Suggestions** — For each gap, generates a CLI spec:
   - Name: `Support-{billing-group-name}` or `Credit-{billing-group-name}`
   - Charge type: `FEE` for support, `CREDIT` for credits
   - Amount: the exact dollar gap
   - Billing group ARN: for API targeting

4. **Apply** — Three options:
   - **Per-row Fix** — Inline link on each billing group row, creates CLIs for just that group
   - **Fix Selected** — Select multiple billing groups with checkboxes, apply to selection
   - **Fix All** — One click to create all suggested CLIs across all billing groups

5. **Verification** — After applying, the page refreshes. The gap analysis re-runs and should show the gaps as covered (existing CLI amounts now match the detected charges).

### How CLIs Work in Billing Conductor

- CLIs are created per **billing group** (not per account)
- A billing group can have **multiple CLIs** (support, credits, custom fees, etc.)
- All member accounts in a billing group see the same CLIs in their Showback view
- In the Billing Transfer model, best practice is one billing group per customer org, so CLIs are effectively per-customer
- CLIs apply to a specific billing period (set via `BillingPeriodRange`)
- CLIs appear in the customer's pro forma CUR, Cost Explorer, and Bills page

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/gap-analysis` | GET | Detect gaps with dollar amounts and generate CLI suggestions |
| `/gap-analysis/apply` | POST | Create CLIs in Billing Conductor for selected billing groups |

---

## IAM Permissions

All features run under the `billing_user_dp_role` in the distributor's master account (bill receiver). The policy includes:

| Permission Group | Actions | Purpose |
|-----------------|---------|---------|
| Billing Conductor (read) | `List*`, `Get*` | Read billing groups, cost reports, pricing plans, CLIs |
| Billing Conductor (write) | `CreateCustomLineItem`, `UpdateCustomLineItem`, `DeleteCustomLineItem` | Apply gap fixes |
| BCM Data Exports | `ListExports`, `GetExport`, `CreateExport`, `DeleteExport`, `UpdateExport`, `ListTables`, `GetTable` | Manage CUR exports |
| Athena | `StartQueryExecution`, `GetQueryExecution`, `GetQueryResults`, `GetWorkGroup` | Run queries for customer reports |
| Glue | `GetDatabase`, `GetTable`, `GetPartitions`, `GetPartition`, `BatchGetPartition` | Athena metadata catalog |
| S3 (CUR bucket) | `GetObject`, `PutObject`, `GetBucketLocation` | Read CUR data, write exports |
| S3 (Athena results) | `GetObject`, `PutObject`, `ListBucket`, `GetBucketLocation` | Athena query results |
| Cost Explorer | `GetCostAndUsage`, `GetCostForecast`, etc. | Gap analysis cost data |
| Billing | `Get*`, `List*` | Billing views for CUR export configuration |

---

## Roadmap

### Completed
- [x] CUR Export Manager with health monitoring and bulk create
- [x] Customer Reports with Athena-powered per-customer CSV download
- [x] Pro Forma Gap Analysis with dollar-amount detection
- [x] Automated CLI creation (Fix selected / Fix all)
- [x] Pagination and search for 1000+ customer scale

### Next
- [ ] **Auto-heal unhealthy exports** — Detect UNHEALTHY CUR exports and recreate them automatically
- [ ] **Monthly auto-apply CLIs** — EventBridge scheduled rule to run gap analysis and apply CLIs after month-end data settles (5-7 business days)
- [ ] **Date range picker** — Allow custom date ranges for customer report downloads (not just calendar month partitions)
- [ ] **CUDOS Dashboard Integration** — Deploy Cloud Intelligence Dashboards (CUDOS/CID/KPI) on top of the Athena CUR data for executive-level QuickSight visualizations. Architecture is already in place: CUR 2.0 → S3 → Glue → Athena. Reference: https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html
- [ ] **CUR Enrichment** — Add margin columns (My View cost - Showback cost) to downloaded CSVs
- [ ] **Notification system** — Alert distributors when new CUR data arrives, exports go unhealthy, or gaps are detected
