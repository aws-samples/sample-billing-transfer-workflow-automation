# Security Report

> Generated: 2026-04-16 01:27 UTC
> Project: billing_api
> Scanners: Bandit, Semgrep, Checkov

## Executive Summary

**Risk Level:** 🟡 MEDIUM
**Total Findings:** 5 (3 Medium, 2 Low)

Three SQL injection vectors in Athena query construction are the primary concern. Two low-severity silent exception swallowing issues were also detected. No findings from Semgrep or Checkov.

## Scan Results

| Scanner | Findings | Critical | High | Medium | Low |
|---------|----------|----------|------|--------|-----|
| Bandit  | 5        | 0        | 0    | 3      | 2   |
| Semgrep | 0        | 0        | 0    | 0      | 0   |
| Checkov | 0        | 0        | 0    | 0      | 0   |

## Findings

### MEDIUM — SQL Injection via String Interpolation (B608)

All three findings are in `billing_partner_portal_billing_api/main.py` and involve f-string interpolation into Athena SQL queries.

#### Finding 1: Column interpolation (line 1505)

```python
query = f"SELECT {columns} FROM COST_AND_USAGE_REPORT"
```

**Risk:** Low in practice — `columns` is derived from an internal constant list, not user input. However, the pattern is fragile and could become exploitable if the column source changes.

#### Finding 2: Table name interpolation (line 1753)

```python
query = f"""
    SELECT "BILLING_PERIOD", line_item_usage_account_id,
           line_item_usage_account_name, count(*) as cnt
    FROM {ATHENA_TABLE}
    GROUP BY "BILLING_PERIOD", line_item_usage_account_id, line_item_usage_account_name
    ORDER BY "BILLING_PERIOD" DESC, line_item_usage_account_id
"""
```

**Risk:** Low — `ATHENA_TABLE` is a module-level constant, not user-controlled.

#### Finding 3: User input interpolation (line 1794–1795) ⚠️ **Highest risk**

```python
where += f" AND line_item_usage_account_id = '{account_id}'"
query = f"SELECT * FROM {ATHENA_TABLE} {where}"
```

**Risk:** `account_id` comes from the `_generate_customer_csv(billing_period, account_id)` function parameter, which is called from the `/customer-reports` endpoint. If `account_id` originates from a query parameter without validation, a crafted value like `' OR 1=1 --` could manipulate the Athena query.

**Remediation:** Use Athena parameterized queries:

```python
# Before (vulnerable)
where += f" AND line_item_usage_account_id = '{account_id}'"
query = f"SELECT * FROM {ATHENA_TABLE} {where}"
qid = _athena_query(query)

# After (safe)
query = f"SELECT * FROM {ATHENA_TABLE} WHERE \"BILLING_PERIOD\" = ? AND line_item_usage_account_id = ?"
qid = _athena_query(query, parameters=[billing_period, account_id])
```

Athena supports parameterized queries via `ExecutionParameters` in the `StartQueryExecution` API. Alternatively, validate `account_id` against a strict regex pattern (AWS account IDs are 12-digit numbers):

```python
import re
if account_id and not re.fullmatch(r"\d{12}", account_id):
    raise HTTPException(status_code=400, detail="Invalid account ID format")
```

### LOW — Silent Exception Swallowing (B110)

#### Finding 4–5: try/except/pass (lines 435, 464)

```python
except Exception:
    pass
```

**Risk:** Silently catching all exceptions can hide bugs, mask security-relevant errors, and make debugging difficult.

**Remediation:** Log the exception or catch a specific exception type:

```python
except (ValueError, SyntaxError):
    logger.debug("Failed to parse pricing plan ARN", exc_info=True)
```

## STRIDE Threat Model

| Threat | Status | Notes |
|--------|--------|-------|
| **Tampering** | ⚠️ Yes | SQL injection at line 1795 allows query manipulation |
| **Information Disclosure** | ⚠️ Yes | SQL injection could expose data from other accounts |
| **Spoofing** | Review needed | Verify Cognito OIDC auth covers all endpoints |
| **Repudiation** | Review needed | Verify audit logging for billing operations |
| **Denial of Service** | Review needed | No rate limiting or query timeout validation observed |
| **Elevation of Privilege** | Review needed | Verify account-level access controls on Athena queries |

## Recommendations

1. **P1 — Fix SQL injection at line 1795.** Use Athena parameterized queries or validate `account_id` as a 12-digit number. This is the only finding where user input flows directly into SQL.
2. **P2 — Add input validation** to `billing_period` and `account_id` parameters at the API layer (FastAPI path/query parameter validation with regex constraints).
3. **P3 — Replace silent exception handlers** at lines 435 and 464 with specific exception types and logging.
4. **P3 — Consider extracting SQL queries** into a query builder or constants module to reduce the surface area for injection patterns as the codebase grows.
5. **P4 — Add pre-commit security scanning** (bandit, semgrep) to catch issues before they reach the main branch.

## Tool Information

- [Bandit](https://bandit.readthedocs.io/) v1.9.4
- [Semgrep](https://semgrep.dev/) (security ruleset)
- [Checkov](https://www.checkov.io/) (IaC scanner — no IaC files found)
