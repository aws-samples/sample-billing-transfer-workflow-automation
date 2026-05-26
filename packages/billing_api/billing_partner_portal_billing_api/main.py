import asyncio
import contextvars
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import boto3
import uvicorn
from dotenv import load_dotenv
from fastapi import Request
from fastapi.responses import StreamingResponse as RawStreamingResponse
from pydantic import BaseModel, Field

from .init import JsonStreamingResponse, app, tracer

load_dotenv()

logger = logging.getLogger(__name__)

# Account context — contextvar set explicitly per-thread in _run_with_context
_current_account_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_account_id", default=None)


def _account_from_request(request: Request) -> str | None:
    """Extract account_id from request header."""
    return request.headers.get("x-account-id") or None


async def _run_with_context(account_id: str | None, fn, *args):
    """Run fn in executor with account_id set in thread-local contextvar."""

    def _wrapper():
        token = _current_account_id.set(account_id)
        try:
            return fn(*args)
        finally:
            _current_account_id.reset(token)

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _wrapper)


class EchoOutput(BaseModel):
    message: str


MAX_PROMPT_LENGTH = 10_000


class ChatInput(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_PROMPT_LENGTH)
    session_id: str | None = Field(default=None, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")


class StreamChunk(BaseModel):
    content: str
    chunk_type: str = "text"


class BillingGroup(BaseModel):
    name: str
    arn: str
    status: str
    primary_account_id: str
    size: int
    computation_preference: str


class MonthlyCost(BaseModel):
    period: str
    amount: str
    currency: str
    unit: str


class ServiceCost(BaseModel):
    service: str
    amount: str


class DashboardData(BaseModel):
    billing_groups: list[BillingGroup]
    monthly_costs: list[MonthlyCost]
    service_costs: list[ServiceCost]
    total_current_month: str
    account_count: int


# ---------------------------------------------------------------------------
# TTL cache for slow-changing data (billing groups, pricing plans/rules)
# ---------------------------------------------------------------------------
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 120  # seconds


def _cached(key: str, fn, ttl: int = _CACHE_TTL):
    """Return cached value if fresh, otherwise call fn() and cache the result."""
    import time

    # Include current account in cache key for multi-account isolation
    account_id = _current_account_id.get() or "local"
    cache_key = f"{account_id}:{key}"
    now = time.time()
    with _cache_lock:
        if cache_key in _cache and now - _cache[cache_key][0] < ttl:
            return _cache[cache_key][1]
    value = fn()
    with _cache_lock:
        _cache[cache_key] = (now, value)
    return value


# ---------------------------------------------------------------------------
# Parallel boto3 calls
# ---------------------------------------------------------------------------
_tool_executor = ThreadPoolExecutor(max_workers=6)


def _parallel(*fns):
    """Run callables concurrently and return results in order."""
    futures = [_tool_executor.submit(fn) for fn in fns]
    return [f.result() for f in futures]


def _fetch_dashboard() -> DashboardData:
    billing_groups = _cached("billing_groups", lambda: _fetch_billing_groups())

    account_count, (monthly_costs, total_current), service_costs = _parallel(
        lambda: _fetch_account_count(fallback=len(billing_groups)),
        lambda: _fetch_monthly_costs(),
        lambda: _fetch_service_costs(),
    )

    return DashboardData(
        billing_groups=billing_groups,
        monthly_costs=monthly_costs,
        service_costs=service_costs,
        total_current_month=total_current,
        account_count=account_count,
    )


def _fetch_billing_groups(client=None) -> list[BillingGroup]:
    try:
        bc = _boto_session().client("billingconductor")
        bg_list = []
        paginator = bc.get_paginator("list_billing_groups")
        for page in paginator.paginate():
            bg_list.extend(page.get("BillingGroups", []))
        return [
            BillingGroup(
                name=bg.get("Name", ""),
                arn=bg.get("Arn", ""),
                status=bg.get("Status", ""),
                primary_account_id=bg.get("PrimaryAccountId", ""),
                size=bg.get("Size", 0),
                computation_preference=str(bg.get("ComputationPreference", "")),
            )
            for bg in bg_list
        ]
    except Exception as e:
        logger.error(f"_fetch_billing_groups error: {e}")
        return []


def _fetch_account_count(client=None, fallback: int = 0) -> int:
    try:
        bc = _boto_session().client("billingconductor")
        items = []
        paginator = bc.get_paginator("list_account_associations")
        for page in paginator.paginate():
            items.extend(page.get("LinkedAccounts", []))
        return len(items)
    except Exception as e:
        logger.error(f"_fetch_account_count error: {e}")
        return fallback


def _fetch_monthly_costs(client=None) -> tuple[list[MonthlyCost], str]:
    try:
        ce = _boto_session().client("ce")
        now = datetime.now()
        start = (now.replace(day=1) - timedelta(days=90)).replace(day=1).strftime("%Y-%m-%d")
        end = now.strftime("%Y-%m-%d")
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
        costs = []
        for period in resp.get("ResultsByTime", []):
            uc = period.get("Total", {}).get("UnblendedCost", {})
            amt = uc.get("Amount", "0")
            unit = uc.get("Unit", "USD")
            start_date = period.get("TimePeriod", {}).get("Start", "")
            costs.append(
                MonthlyCost(
                    period=start_date[:7],
                    amount=f"{float(amt):.2f}",
                    currency=unit,
                    unit=unit,
                )
            )
        total = costs[-1].amount if costs else "0.00"
        return costs, total
    except Exception as e:
        logger.error(f"_fetch_monthly_costs error: {e}")
        return [], "0.00"


def _fetch_service_costs(client=None) -> list[ServiceCost]:
    try:
        ce = _boto_session().client("ce")
        now = datetime.now()
        start = now.replace(day=1).strftime("%Y-%m-%d")
        end = now.strftime("%Y-%m-%d")
        if start == end:
            prev = now.replace(day=1) - timedelta(days=1)
            start = prev.replace(day=1).strftime("%Y-%m-%d")
            end = (prev.replace(day=1) + timedelta(days=32)).replace(day=1).strftime("%Y-%m-%d")
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        services = []
        results = resp.get("ResultsByTime", [])
        if results:
            for group in results[0].get("Groups", []):
                svc = group.get("Keys", ["Unknown"])[0]
                amt = group.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", "0")
                if float(amt) > 0.001:
                    services.append(ServiceCost(service=svc, amount=f"{float(amt):.2f}"))
        if not services:
            prev = now.replace(day=1) - timedelta(days=1)
            ps = prev.replace(day=1).strftime("%Y-%m-%d")
            pe = now.replace(day=1).strftime("%Y-%m-%d")
            resp = ce.get_cost_and_usage(
                TimePeriod={"Start": ps, "End": pe},
                Granularity="MONTHLY",
                Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
            )
            results = resp.get("ResultsByTime", [])
            if results:
                for group in results[0].get("Groups", []):
                    svc = group.get("Keys", ["Unknown"])[0]
                    amt = group.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", "0")
                    if float(amt) > 0.001:
                        services.append(ServiceCost(service=svc, amount=f"{float(amt):.2f}"))
        services.sort(key=lambda s: float(s.amount), reverse=True)
        return services
    except Exception as e:
        logger.error(f"_fetch_service_costs error: {e}")
        return []


class TransferInfo(BaseModel):
    bill_source_account: str
    bill_source_name: str
    status: str
    effective_date: str


class AccountCost(BaseModel):
    account_id: str
    account_name: str
    my_view_cost: str
    showback_cost: str
    margin: str


class TransferDashboardData(BaseModel):
    transfers: list[TransferInfo]
    account_costs: list[AccountCost]
    total_my_view: str
    total_showback: str
    total_margin: str


class PricingPlanInfo(BaseModel):
    arn: str
    name: str
    description: str
    size: int
    rules: list[dict]
    billing_groups: list[str]


class CustomLineItemInfo(BaseModel):
    name: str
    description: str
    account_id: str
    billing_group_name: str
    charge_type: str
    percentage: float | None
    flat_amount: float | None


class BillingConductorData(BaseModel):
    pricing_plans: list[PricingPlanInfo]
    custom_line_items: list[CustomLineItemInfo]


class AccountServiceCost(BaseModel):
    account_id: str
    service: str
    amount: str


class MarginHistoryEntry(BaseModel):
    period: str
    aws_cost: str
    proforma_cost: str
    margin: str


class BudgetInfo(BaseModel):
    name: str
    budget_type: str
    limit_amount: str
    actual_spend: str
    forecasted_spend: str
    pct_used: str


class FinOpsData(BaseModel):
    account_service_costs: list[AccountServiceCost]
    margin_history: list[MarginHistoryEntry]
    budgets: list[BudgetInfo]
    credits_amount: str
    anomaly_count: int


def _fetch_transfer_dashboard() -> TransferDashboardData:
    billing_groups = _cached("billing_groups", lambda: _fetch_billing_groups())
    bg_map = {bg.arn: bg for bg in billing_groups}

    bc = _boto_session().client("billingconductor")
    reports = []
    try:
        paginator = bc.get_paginator("list_billing_group_cost_reports")
        for page in paginator.paginate():
            reports.extend(page.get("BillingGroupCostReports", []))
    except Exception as e:
        logger.error(f"list_billing_group_cost_reports error: {e}")

    all_zero = all(float(r.get("AWSCost", 0)) == 0 for r in reports)
    if all_zero and reports:
        reports = []
        prev = (datetime.now() - timedelta(days=1)).strftime("%Y-%m")
        try:
            for page in paginator.paginate(BillingPeriod=prev):
                reports.extend(page.get("BillingGroupCostReports", []))
        except Exception:
            pass

    transfers = []
    account_costs = []
    total_my = 0.0
    total_show = 0.0
    total_margin = 0.0

    for r in reports:
        arn = r.get("Arn", "")
        bg = bg_map.get(arn)
        name = bg.name if bg else arn
        account_id = bg.primary_account_id if bg else ""
        status = bg.status if bg else "UNKNOWN"

        aws_cost = float(r.get("AWSCost", 0))
        proforma = float(r.get("ProformaCost", 0))
        margin = float(r.get("Margin", 0))

        total_my += aws_cost
        total_show += proforma
        total_margin += margin

        transfers.append(
            TransferInfo(
                bill_source_account=account_id,
                bill_source_name=name,
                status=status,
                effective_date="",
            )
        )
        account_costs.append(
            AccountCost(
                account_id=account_id,
                account_name=name,
                my_view_cost=f"{aws_cost:.2f}",
                showback_cost=f"{proforma:.2f}",
                margin=f"{margin:.2f}",
            )
        )

    return TransferDashboardData(
        transfers=transfers,
        account_costs=account_costs,
        total_my_view=f"{total_my:.2f}",
        total_showback=f"{total_show:.2f}",
        total_margin=f"{total_margin:.2f}",
    )


def _fetch_billing_conductor() -> BillingConductorData:
    bc = _boto_session().client("billingconductor")
    bgs = _cached("billing_groups", lambda: _fetch_billing_groups())
    bg_name_map = {bg.arn: bg.name for bg in bgs}

    plan_to_bgs: dict[str, list[str]] = {}
    for bg in bgs:
        cp = bg.computation_preference
        plan_arn = ""
        if "pricing_plan_arn" in cp:
            try:
                import ast

                plan_arn = ast.literal_eval(cp).get("pricing_plan_arn", "")
            except Exception:
                pass
        if plan_arn:
            plan_to_bgs.setdefault(plan_arn, []).append(f"{bg.name} ({bg.primary_account_id})")

    # Fetch pricing rules, plans, and CLIs in parallel
    def _get_rules():
        items = []
        paginator = bc.get_paginator("list_pricing_rules")
        for page in paginator.paginate():
            items.extend(page.get("PricingRules", []))
        return {r.get("Arn", ""): r for r in items}

    def _get_plans():
        items = []
        paginator = bc.get_paginator("list_pricing_plans")
        for page in paginator.paginate():
            items.extend(page.get("PricingPlans", []))
        return items

    def _get_clis():
        items = []
        paginator = bc.get_paginator("list_custom_line_items")
        for page in paginator.paginate():
            items.extend(page.get("CustomLineItems", []))
        return items

    all_rules, plans_raw, cli_raw = _parallel(_get_rules, _get_plans, _get_clis)

    plans = []
    for p in plans_raw:
        arn = p.get("Arn", "")
        rules = []
        try:
            rule_arns = []
            paginator = bc.get_paginator("list_pricing_rules_associated_to_pricing_plan")
            for page in paginator.paginate(PricingPlanArn=arn):
                rule_arns.extend(page.get("PricingRuleArns", []))
            for rule_arn in rule_arns:
                r = all_rules.get(rule_arn, {})
                if r:
                    rules.append(
                        {
                            "name": r.get("Name", ""),
                            "type": r.get("Type", ""),
                            "scope": r.get("Scope", ""),
                            "modifier_percentage": r.get("ModifierPercentage", 0),
                            "service": r.get("Service") or "All",
                        }
                    )
        except Exception:
            pass
        plans.append(
            PricingPlanInfo(
                arn=arn,
                name=p.get("Name", ""),
                description=p.get("Description") or "",
                size=p.get("Size", 0),
                rules=rules,
                billing_groups=plan_to_bgs.get(arn, []),
            )
        )

    items = []
    for c in cli_raw:
        charge = c.get("ChargeDetails", {})
        pct = charge.get("Percentage", {}).get("PercentageValue") if charge.get("Percentage") else None
        flat = charge.get("Flat", {}).get("ChargeValue") if charge.get("Flat") else None
        items.append(
            CustomLineItemInfo(
                name=c.get("Name", ""),
                description=c.get("Description", ""),
                account_id=c.get("AccountId", ""),
                billing_group_name=bg_name_map.get(c.get("BillingGroupArn", ""), c.get("BillingGroupArn", "")),
                charge_type=charge.get("Type", ""),
                percentage=pct,
                flat_amount=flat,
            )
        )

    return BillingConductorData(pricing_plans=plans, custom_line_items=items)


def _fetch_finops() -> FinOpsData:
    now = datetime.now()
    month_start = now.replace(day=1).strftime("%Y-%m-%d")
    prev_start = (now.replace(day=1) - timedelta(days=1)).replace(day=1).strftime("%Y-%m-%d")

    def _account_service():
        ce = _boto_session().client("ce")
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": prev_start, "End": month_start},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[
                {"Type": "DIMENSION", "Key": "LINKED_ACCOUNT"},
                {"Type": "DIMENSION", "Key": "SERVICE"},
            ],
        )
        costs = []
        results = resp.get("ResultsByTime", [])
        if results:
            for g in results[0].get("Groups", []):
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", "0"))
                if amt > 0.01:
                    keys = g.get("Keys", ["", ""])
                    costs.append(AccountServiceCost(account_id=keys[0], service=keys[1], amount=f"{amt:.2f}"))
            costs.sort(key=lambda x: float(x.amount), reverse=True)
        return costs[:20]

    def _margin_for_period(period):
        bc = _boto_session().client("billingconductor")
        reports = []
        try:
            paginator = bc.get_paginator("list_billing_group_cost_reports")
            for page in paginator.paginate(BillingPeriod=period):
                reports.extend(page.get("BillingGroupCostReports", []))
        except Exception:
            return None
        aws = sum(float(x.get("AWSCost", 0)) for x in reports)
        pf = sum(float(x.get("ProformaCost", 0)) for x in reports)
        if aws > 0 or pf > 0:
            return MarginHistoryEntry(
                period=period, aws_cost=f"{aws:.2f}", proforma_cost=f"{pf:.2f}", margin=f"{pf - aws:.2f}"
            )
        return None

    def _all_margins():
        periods = [(now.replace(day=1) - timedelta(days=30 * i)).strftime("%Y-%m") for i in range(6, 0, -1)]
        futures = [_tool_executor.submit(_margin_for_period, p) for p in periods]
        return [f.result() for f in futures if f.result() is not None]

    def _budgets():
        try:
            budgets_client = _boto_session().client("budgets")
            sts = _boto_session().client("sts")
            account_id = sts.get_caller_identity()["Account"]
            resp = budgets_client.describe_budgets(AccountId=account_id)
            out = []
            for b in resp.get("Budgets", []):
                limit = float(b.get("BudgetLimit", {}).get("Amount", "0"))
                actual = float(b.get("CalculatedSpend", {}).get("ActualSpend", {}).get("Amount", "0"))
                forecast = float(b.get("CalculatedSpend", {}).get("ForecastedSpend", {}).get("Amount", "0"))
                pct = (actual / limit * 100) if limit > 0 else 0
                out.append(
                    BudgetInfo(
                        name=b.get("BudgetName", ""),
                        budget_type=b.get("BudgetType", ""),
                        limit_amount=f"{limit:.2f}",
                        actual_spend=f"{actual:.2f}",
                        forecasted_spend=f"{forecast:.2f}",
                        pct_used=f"{pct:.1f}",
                    )
                )
            return out
        except Exception as e:
            logger.error(f"_budgets error: {e}")
            return []

    def _credits():
        ce = _boto_session().client("ce")
        try:
            resp = ce.get_cost_and_usage(
                TimePeriod={"Start": prev_start, "End": month_start},
                Granularity="MONTHLY",
                Metrics=["UnblendedCost"],
                Filter={"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}},
            )
            results = resp.get("ResultsByTime", [])
            if results:
                amt = results[0].get("Total", {}).get("UnblendedCost", {}).get("Amount", "0")
                return f"{abs(float(amt)):.2f}"
        except Exception as e:
            logger.error(f"_credits error: {e}")
        return "0.00"

    def _anomalies():
        ce = _boto_session().client("ce")
        try:
            resp = ce.get_anomalies(
                DateInterval={
                    "StartDate": (now - timedelta(days=30)).strftime("%Y-%m-%d"),
                    "EndDate": now.strftime("%Y-%m-%d"),
                },
            )
            return len(resp.get("Anomalies", []))
        except Exception as e:
            logger.error(f"_anomalies error: {e}")
            return 0

    account_service_costs, margin_history, budgets, credits_amount, anomaly_count = _parallel(
        _account_service,
        _all_margins,
        _budgets,
        _credits,
        _anomalies,
    )

    return FinOpsData(
        account_service_costs=account_service_costs,
        margin_history=[m for m in margin_history if m is not None],
        budgets=budgets,
        credits_amount=credits_amount,
        anomaly_count=anomaly_count,
    )


@app.get("/dashboard")
@tracer.capture_method
async def dashboard(request: Request) -> DashboardData:
    """Fetch key billing metrics for the home page dashboard."""
    return await _run_with_context(_account_from_request(request), _fetch_dashboard)


@app.get("/transfer-dashboard")
@tracer.capture_method
async def transfer_dashboard(request: Request) -> TransferDashboardData:
    """Fetch billing transfer overview with per-account margin analysis."""
    return await _run_with_context(_account_from_request(request), _fetch_transfer_dashboard)


@app.get("/billing-conductor")
@tracer.capture_method
async def billing_conductor(request: Request) -> BillingConductorData:
    """Fetch pricing plans, rules, and custom line items from Billing Conductor."""
    return await _run_with_context(_account_from_request(request), _fetch_billing_conductor)


@app.get("/finops")
@tracer.capture_method
async def finops(request: Request) -> FinOpsData:
    """Fetch financial operations data: usage breakdown, margin history, budgets, credits, anomalies."""
    return await _run_with_context(_account_from_request(request), _fetch_finops)


@app.get("/echo")
@tracer.capture_method
def echo(message: str) -> EchoOutput:
    return EchoOutput(message=f"{message}")


@app.post(
    "/chat",
    response_class=JsonStreamingResponse,
    responses={
        200: JsonStreamingResponse.openapi_response(StreamChunk, "Streaming chat response"),
    },
    openapi_extra={"x-mutation": True},
)
async def chat(input: ChatInput, request: Request) -> JsonStreamingResponse:
    """Stream orchestrator agent response to the client."""
    session_id = input.session_id or uuid.uuid4().hex
    account_id = _account_from_request(request)

    async def generate():
        from billing_partner_portal_agents.agent.agent import get_agent

        try:
            yield StreamChunk(content="", chunk_type="thinking")

            credentials = await _run_with_context(account_id, _get_assumed_credentials, account_id)
            with get_agent(session_id, credentials=credentials) as orchestrator:
                response = await _run_with_context(None, orchestrator, input.message)
                msg = getattr(response, "message", response)
                if isinstance(msg, dict):
                    content = msg.get("content", msg)
                    if isinstance(content, list):
                        text = "".join(
                            item.get("text", "") if isinstance(item, dict) else str(item) for item in content
                        )
                    else:
                        text = str(content)
                elif isinstance(msg, list):
                    text = "".join(item.get("text", "") if isinstance(item, dict) else str(item) for item in msg)
                else:
                    text = str(msg)
                import re

                text = re.sub(r"</?thinking>.*?(?:</thinking>|$)", "", text, flags=re.DOTALL).strip()
                yield StreamChunk(content=text, chunk_type="text")

            yield StreamChunk(content="", chunk_type="done")
        except Exception as e:
            import traceback

            traceback.print_exc()
            yield StreamChunk(content=str(e), chunk_type="error")

    return JsonStreamingResponse(generate())


# ── Pro Forma Gap Detection ─────────────────────────────────────────────────


class GapDetail(BaseModel):
    category: str  # SUPPORT | CREDIT | REFUND
    my_view_amount: str
    showback_amount: str
    cli_amount: str
    gap: str  # uncovered amount


class BillingGroupGap(BaseModel):
    billing_group_name: str
    billing_group_arn: str
    primary_account_id: str
    my_view_total: str
    showback_total: str
    margin: str
    gaps: list[GapDetail]
    suggested_clis: list[dict]


class GapAnalysisData(BaseModel):
    billing_groups: list[BillingGroupGap]
    total_uncovered: str


def _fetch_gap_analysis() -> GapAnalysisData:
    """Compare My View vs Showback per billing group and identify uncovered gaps."""
    billing_groups = _fetch_billing_groups()
    bg_map = {bg.arn: bg for bg in billing_groups}

    bc = _boto_session().client("billingconductor")
    reports = []
    try:
        paginator = bc.get_paginator("list_billing_group_cost_reports")
        for page in paginator.paginate():
            reports.extend(page.get("BillingGroupCostReports", []))
    except Exception as e:
        logger.error(f"gap_analysis cost reports error: {e}")

    if all(float(r.get("AWSCost", 0)) == 0 for r in reports):
        prev = (datetime.now() - timedelta(days=1)).strftime("%Y-%m")
        reports = []
        try:
            for page in paginator.paginate(BillingPeriod=prev):
                reports.extend(page.get("BillingGroupCostReports", []))
        except Exception:
            pass

    # Get existing CLIs
    all_clis = []
    try:
        cli_paginator = bc.get_paginator("list_custom_line_items")
        for page in cli_paginator.paginate():
            all_clis.extend(page.get("CustomLineItems", []))
    except Exception:
        pass

    # Get support costs from Cost Explorer
    ce = _boto_session().client("ce")
    now = datetime.now()
    prev_start = (now.replace(day=1) - timedelta(days=1)).replace(day=1).strftime("%Y-%m-%d")
    month_start = now.replace(day=1).strftime("%Y-%m-%d")
    support_costs: dict = {}
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": prev_start, "End": month_start},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        results = resp.get("ResultsByTime", [])
        if results:
            for g in results[0].get("Groups", []):
                svc = g.get("Keys", [""])[0]
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", "0"))
                if "support" in svc.lower() and amt > 0:
                    support_costs["total"] = support_costs.get("total", 0) + amt
    except Exception as e:
        logger.warning(f"gap_analysis support detection error: {e}")

    # Get credit amounts
    credit_total = 0.0
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": prev_start, "End": month_start},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            Filter={"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}},
        )
        results = resp.get("ResultsByTime", [])
        if results:
            amt = float(results[0].get("Total", {}).get("UnblendedCost", {}).get("Amount", "0"))
            credit_total = abs(amt)
    except Exception as e:
        logger.warning(f"gap_analysis credit detection error: {e}")

    # Analyze each billing group
    total_uncovered = 0.0
    bg_gaps = []

    for r in reports:
        arn = r.get("Arn", "")
        bg = bg_map.get(arn)
        if not bg:
            continue

        aws_cost = float(r.get("AWSCost", 0))
        proforma = float(r.get("ProformaCost", 0))
        margin_val = float(r.get("Margin", 0))

        # Find CLIs for this billing group
        bg_clis = [c for c in all_clis if c.get("BillingGroupArn") == arn]
        support_cli_total = sum(
            abs(float(c.get("ChargeDetails", {}).get("Flat", {}).get("ChargeValue", 0)))
            for c in bg_clis
            if "support" in c.get("Name", "").lower() or "support" in c.get("Description", "").lower()
        )
        credit_cli_total = sum(
            abs(float(c.get("ChargeDetails", {}).get("Flat", {}).get("ChargeValue", 0)))
            for c in bg_clis
            if c.get("ChargeDetails", {}).get("Type") == "CREDIT" or "credit" in c.get("Name", "").lower()
        )

        # Estimate per-BG share of support/credits (proportional to cost)
        total_aws = sum(float(x.get("AWSCost", 0)) for x in reports)
        cost_share = aws_cost / total_aws if total_aws > 0 else 0
        bg_support = support_costs.get("total", 0) * cost_share
        bg_credits = credit_total * cost_share

        gaps = []
        suggested = []

        # Support gap
        support_gap = bg_support - support_cli_total
        if bg_support > 0.01:
            gaps.append(
                GapDetail(
                    category="SUPPORT",
                    my_view_amount=f"{bg_support:.2f}",
                    showback_amount="0.00",
                    cli_amount=f"{support_cli_total:.2f}",
                    gap=f"{max(support_gap, 0):.2f}",
                )
            )
            if support_gap > 0.01:
                total_uncovered += support_gap
                suggested.append(
                    {
                        "name": f"Support-{bg.name}",
                        "description": f"AWS Support charges for {bg.name}",
                        "billing_group_arn": arn,
                        "charge_type": "FEE",
                        "flat_amount": round(support_gap, 2),
                    }
                )

        # Credit gap
        credit_gap = bg_credits - credit_cli_total
        if bg_credits > 0.01:
            gaps.append(
                GapDetail(
                    category="CREDIT",
                    my_view_amount=f"{bg_credits:.2f}",
                    showback_amount="0.00",
                    cli_amount=f"{credit_cli_total:.2f}",
                    gap=f"{max(credit_gap, 0):.2f}",
                )
            )
            if credit_gap > 0.01:
                total_uncovered += credit_gap
                suggested.append(
                    {
                        "name": f"Credit-{bg.name}",
                        "description": f"AWS credits pass-through for {bg.name}",
                        "billing_group_arn": arn,
                        "charge_type": "CREDIT",
                        "flat_amount": round(-credit_gap, 2),
                    }
                )

        bg_gaps.append(
            BillingGroupGap(
                billing_group_name=bg.name,
                billing_group_arn=arn,
                primary_account_id=bg.primary_account_id,
                my_view_total=f"{aws_cost:.2f}",
                showback_total=f"{proforma:.2f}",
                margin=f"{margin_val:.2f}",
                gaps=gaps,
                suggested_clis=suggested,
            )
        )

    return GapAnalysisData(
        billing_groups=bg_gaps,
        total_uncovered=f"{total_uncovered:.2f}",
    )


@app.get("/gap-analysis")
@tracer.capture_method
async def gap_analysis(request: Request, demo: bool = False) -> GapAnalysisData:
    """Detect pro forma gaps. Pass ?demo=true to inject simulated gaps for testing."""
    data = await _run_with_context(_account_from_request(request), _fetch_gap_analysis)
    if demo:
        # Inject simulated gaps for demo/testing
        for bg in data.billing_groups:
            aws = float(bg.my_view_total)
            if aws > 0:
                support_amt = round(aws * 0.10, 2)  # simulate 10% support
                credit_amt = round(aws * 0.05, 2)  # simulate 5% credits
                bg.gaps = [
                    GapDetail(
                        category="SUPPORT",
                        my_view_amount=f"{support_amt:.2f}",
                        showback_amount="0.00",
                        cli_amount="0.00",
                        gap=f"{support_amt:.2f}",
                    ),
                    GapDetail(
                        category="CREDIT",
                        my_view_amount=f"{credit_amt:.2f}",
                        showback_amount="0.00",
                        cli_amount="0.00",
                        gap=f"{credit_amt:.2f}",
                    ),
                ]
                bg.suggested_clis = [
                    {
                        "name": f"Support-{bg.billing_group_name}",
                        "description": f"AWS Business Support for {bg.billing_group_name}",
                        "billing_group_arn": bg.billing_group_arn,
                        "charge_type": "FEE",
                        "flat_amount": support_amt,
                    },
                    {
                        "name": f"Credit-{bg.billing_group_name}",
                        "description": f"AWS promotional credits for {bg.billing_group_name}",
                        "billing_group_arn": bg.billing_group_arn,
                        "charge_type": "CREDIT",
                        "flat_amount": round(-credit_amt, 2),
                    },
                ]
        data.total_uncovered = f"{sum(float(g.gap) for bg in data.billing_groups for g in bg.gaps):.2f}"
    return data


class ApplyCliInput(BaseModel):
    name: str
    description: str
    billing_group_arn: str
    charge_type: str  # FEE | CREDIT
    flat_amount: float


class ApplyCliResult(BaseModel):
    success: bool
    message: str


class ApplyAllClisInput(BaseModel):
    clis: list[ApplyCliInput]


class ApplyAllClisResult(BaseModel):
    created: list[str]
    failed: list[str]
    message: str


def _apply_cli(cli: ApplyCliInput) -> ApplyCliResult:
    """Create a single custom line item in Billing Conductor."""
    bc = _boto_session().client("billingconductor")

    # Billing period = current month (CLIs apply to current billing period)
    billing_period = datetime.now().strftime("%Y-%m")

    charge_details = {
        "Type": cli.charge_type,
        "Flat": {"ChargeValue": abs(cli.flat_amount)},
    }

    try:
        bc.create_custom_line_item(
            Name=cli.name,
            Description=cli.description,
            BillingGroupArn=cli.billing_group_arn,
            BillingPeriodRange={
                "InclusiveStartBillingPeriod": billing_period,
            },
            ChargeDetails=charge_details,
        )
        return ApplyCliResult(success=True, message=f"Created '{cli.name}'")
    except Exception as e:
        logger.error(f"create_custom_line_item error: {e}")
        return ApplyCliResult(success=False, message=f"Failed '{cli.name}': {str(e)}")


def _apply_all_clis(input: ApplyAllClisInput) -> ApplyAllClisResult:
    created = []
    failed = []
    for i, cli in enumerate(input.clis):
        if i > 0 and i % 5 == 0:
            time.sleep(0.5)  # Throttle: 5 CLIs then pause to avoid rate limits
        result = _apply_cli(cli)
        if result.success:
            created.append(cli.name)
        else:
            failed.append(result.message)
    msg = f"Created {len(created)} CLI(s)"
    if failed:
        msg += f", {len(failed)} failed"
    return ApplyAllClisResult(created=created, failed=failed, message=msg)


@app.post("/gap-analysis/apply")
@tracer.capture_method
async def apply_clis(request: Request, input: ApplyAllClisInput) -> ApplyAllClisResult:
    """Create custom line items in Billing Conductor to close pro forma gaps."""
    return await _run_with_context(_account_from_request(request), _apply_all_clis, input)


# ── Reseller Commission ─────────────────────────────────────────────────────


class CommissionInput(BaseModel):
    billing_group_arn: str
    billing_group_name: str
    percentage: float  # e.g. 10.0 for 10%


class CommissionResult(BaseModel):
    created: list[str]
    failed: list[str]
    message: str


def _apply_commission(items: list[CommissionInput]) -> CommissionResult:
    bc = _boto_session().client("billingconductor")
    billing_period = datetime.now().strftime("%Y-%m")
    created, failed = [], []
    for item in items:
        name = f"Commission-{item.billing_group_name}-{item.percentage}pct"
        try:
            bc.create_custom_line_item(
                Name=name,
                Description=f"{item.percentage}% reseller commission for {item.billing_group_name}",
                BillingGroupArn=item.billing_group_arn,
                BillingPeriodRange={"InclusiveStartBillingPeriod": billing_period},
                ChargeDetails={
                    "Type": "FEE",
                    "Percentage": {"PercentageValue": item.percentage},
                },
            )
            created.append(name)
        except Exception as e:
            logger.error(f"commission error: {e}")
            failed.append(f"{name}: {e}")
    msg = f"Created {len(created)} commission CLI(s)"
    if failed:
        msg += f", {len(failed)} failed"
    return CommissionResult(created=created, failed=failed, message=msg)


@app.post("/commission/apply")
@tracer.capture_method
async def apply_commission(request: Request, items: list[CommissionInput]) -> CommissionResult:
    """Create percentage-based FEE CLIs as reseller commission."""
    return await _run_with_context(_account_from_request(request), _apply_commission, items)


# ── Credit Tracker ───────────────────────────────────────────────────────────


class CreditBillingGroup(BaseModel):
    billing_group_name: str
    billing_group_arn: str
    primary_account_id: str
    credit_amount: str
    cli_modeled_amount: str
    unmodeled_amount: str
    is_modeled: bool


class CreditTrackerData(BaseModel):
    billing_groups: list[CreditBillingGroup]
    total_credits: str
    total_modeled: str
    total_unmodeled: str
    billing_period: str


def _fetch_credit_tracker() -> CreditTrackerData:
    """Per-billing-group credit visibility with CLI modeling status."""
    billing_groups = _fetch_billing_groups()
    bg_map = {bg.arn: bg for bg in billing_groups}

    bc = _boto_session().client("billingconductor")
    reports = []
    now = datetime.now()
    billing_period = now.strftime("%Y-%m")
    try:
        paginator = bc.get_paginator("list_billing_group_cost_reports")
        for page in paginator.paginate():
            reports.extend(page.get("BillingGroupCostReports", []))
    except Exception:
        pass

    if all(float(r.get("AWSCost", 0)) == 0 for r in reports):
        prev = (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        reports = []
        try:
            for page in paginator.paginate(BillingPeriod=prev):
                reports.extend(page.get("BillingGroupCostReports", []))
        except Exception:
            pass
        billing_period = prev

    # Total credits from Cost Explorer
    ce = _boto_session().client("ce")
    prev_start = (now.replace(day=1) - timedelta(days=1)).replace(day=1).strftime("%Y-%m-%d")
    month_start = now.replace(day=1).strftime("%Y-%m-%d")
    credit_total = 0.0
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": prev_start, "End": month_start},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            Filter={"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}},
        )
        results = resp.get("ResultsByTime", [])
        if results:
            amt = float(results[0].get("Total", {}).get("UnblendedCost", {}).get("Amount", "0"))
            credit_total = abs(amt)
    except Exception as e:
        logger.warning(f"credit_tracker credit fetch error: {e}")

    # Existing credit CLIs
    all_clis = []
    try:
        cli_paginator = bc.get_paginator("list_custom_line_items")
        for page in cli_paginator.paginate():
            all_clis.extend(page.get("CustomLineItems", []))
    except Exception:
        pass

    # Allocate credits proportionally and check CLI coverage
    total_aws = sum(float(r.get("AWSCost", 0)) for r in reports)
    total_modeled = 0.0
    total_unmodeled = 0.0
    bg_results = []

    for r in reports:
        arn = r.get("Arn", "")
        bg = bg_map.get(arn)
        if not bg:
            continue

        aws_cost = float(r.get("AWSCost", 0))
        share = aws_cost / total_aws if total_aws > 0 else 0
        bg_credits = credit_total * share

        # Sum credit CLIs for this billing group
        bg_clis = [c for c in all_clis if c.get("BillingGroupArn") == arn]
        cli_credit_total = sum(
            abs(float(c.get("ChargeDetails", {}).get("Flat", {}).get("ChargeValue", 0)))
            for c in bg_clis
            if c.get("ChargeDetails", {}).get("Type") == "CREDIT" or "credit" in c.get("Name", "").lower()
        )

        unmodeled = max(bg_credits - cli_credit_total, 0)
        total_modeled += cli_credit_total
        total_unmodeled += unmodeled

        bg_results.append(
            CreditBillingGroup(
                billing_group_name=bg.name,
                billing_group_arn=arn,
                primary_account_id=bg.primary_account_id,
                credit_amount=f"{bg_credits:.2f}",
                cli_modeled_amount=f"{cli_credit_total:.2f}",
                unmodeled_amount=f"{unmodeled:.2f}",
                is_modeled=unmodeled < 0.01,
            )
        )

    return CreditTrackerData(
        billing_groups=bg_results,
        total_credits=f"{credit_total:.2f}",
        total_modeled=f"{total_modeled:.2f}",
        total_unmodeled=f"{total_unmodeled:.2f}",
        billing_period=billing_period,
    )


@app.get("/credit-tracker")
@tracer.capture_method
async def credit_tracker(request: Request, demo: bool = False) -> CreditTrackerData:
    """Per-billing-group credit visibility and CLI modeling status. Pass ?demo=true for simulated MAP credits."""
    data = await _run_with_context(_account_from_request(request), _fetch_credit_tracker)
    if demo:
        total_credits = 0.0
        total_modeled = 0.0
        total_unmodeled = 0.0
        for bg in data.billing_groups:
            # Simulate MAP 2.0 credits proportional to cost
            aws_cost = float(bg.credit_amount) if float(bg.credit_amount) > 0 else 150.0
            map_credit = round(aws_cost * 0.25, 2)  # 25% MAP credit
            existing_cli = float(bg.cli_modeled_amount)
            unmodeled = round(max(map_credit - existing_cli, 0), 2)
            bg.credit_amount = f"{map_credit:.2f}"
            bg.unmodeled_amount = f"{unmodeled:.2f}"
            bg.is_modeled = unmodeled < 0.01
            total_credits += map_credit
            total_modeled += existing_cli
            total_unmodeled += unmodeled
        data.total_credits = f"{total_credits:.2f}"
        data.total_modeled = f"{total_modeled:.2f}"
        data.total_unmodeled = f"{total_unmodeled:.2f}"
    return data


# ── CUR Export Manager ──────────────────────────────────────────────────────


# Cache for assumed sessions (account_id -> (session, expiry))
_assumed_session_cache: dict[str, tuple[boto3.Session, datetime]] = {}
# Cache for raw credentials (account_id -> (creds_dict, expiry))
_assumed_creds_cache: dict[str, tuple[dict, datetime]] = {}


def _boto_session():
    """Get a boto3 session — uses assumed role if account context is set and differs from local."""
    account_id = _current_account_id.get()
    if account_id and account_id != os.environ.get("AWS_ACCOUNT_ID", ""):
        return _get_assumed_session(account_id)
    profile = os.environ.get("AWS_PROFILE", None)
    region = os.environ.get("AWS_REGION", "us-east-1")
    return boto3.Session(profile_name=profile, region_name=region)


# ── Multi-Account Management ───────────────────────────────────────────────

ACCOUNTS_TABLE_NAME = os.environ.get("ACCOUNTS_TABLE_NAME", "billing-portal-accounts")
CROSS_ACCOUNT_ROLE_NAME = "BillingPortalCrossAccountRole"


class AccountInfo(BaseModel):
    account_id: str
    account_name: str
    role_arn: str = ""
    external_id: str = "billing-portal-cross-account"
    region: str = "us-east-1"
    status: str = "active"


class AccountListResponse(BaseModel):
    accounts: list[AccountInfo]


class AccountTestResult(BaseModel):
    success: bool
    message: str
    account_id: str


def _get_accounts_table():
    """Always use local session for DynamoDB (accounts table is in portal account)."""
    profile = os.environ.get("AWS_PROFILE", None)
    region = os.environ.get("AWS_REGION", "us-east-1")
    session = boto3.Session(profile_name=profile, region_name=region)
    return session.resource("dynamodb").Table(ACCOUNTS_TABLE_NAME)


def _list_accounts() -> list[AccountInfo]:
    table = _get_accounts_table()
    resp = table.scan()
    return [AccountInfo(**item) for item in resp.get("Items", [])]


def _get_assumed_session(account_id: str) -> boto3.Session:
    """Assume role into a target bill-receiver account and return a session (cached for 50 min)."""
    # Check cache
    if account_id in _assumed_session_cache:
        session, expiry = _assumed_session_cache[account_id]
        if datetime.now() < expiry:
            return session

    accounts = _list_accounts()
    account = next((a for a in accounts if a.account_id == account_id), None)
    if not account:
        raise ValueError(f"Account {account_id} not found in registry")

    role_arn = account.role_arn or f"arn:aws:iam::{account_id}:role/{CROSS_ACCOUNT_ROLE_NAME}"
    profile = os.environ.get("AWS_PROFILE", None)
    region = os.environ.get("AWS_REGION", "us-east-1")
    base_session = boto3.Session(profile_name=profile, region_name=region)
    sts = base_session.client("sts")
    resp = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=f"billing-portal-{account_id[:8]}",
        ExternalId=account.external_id,
        DurationSeconds=3600,
    )
    creds = resp["Credentials"]
    assumed = boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=account.region,
    )
    _assumed_session_cache[account_id] = (assumed, datetime.now() + timedelta(minutes=50))
    _assumed_creds_cache[account_id] = (
        {
            "AccessKeyId": creds["AccessKeyId"],
            "SecretAccessKey": creds["SecretAccessKey"],
            "SessionToken": creds["SessionToken"],
        },
        datetime.now() + timedelta(minutes=50),
    )
    return assumed


def _get_session_for_account(account_id: str | None) -> boto3.Session:
    """Get a boto3 session — either assumed into target account or local."""
    if account_id:
        return _get_assumed_session(account_id)
    return _boto_session()


def _get_assumed_credentials(account_id: str | None) -> dict | None:
    """Get raw assumed-role credentials for a target account, or None for local."""
    if not account_id or account_id == os.environ.get("AWS_ACCOUNT_ID", ""):
        return None
    # Ensure session is assumed (populates creds cache)
    _get_assumed_session(account_id)
    entry = _assumed_creds_cache.get(account_id)
    if entry and datetime.now() < entry[1]:
        return entry[0]
    # Re-assume if expired
    _assumed_session_cache.pop(account_id, None)
    _assumed_creds_cache.pop(account_id, None)
    _get_assumed_session(account_id)
    return _assumed_creds_cache[account_id][0]


@app.get("/accounts")
@tracer.capture_method
async def list_accounts(request: Request) -> AccountListResponse:
    """List all registered bill-receiver accounts."""
    accounts = await _run_with_context(_account_from_request(request), _list_accounts)
    return AccountListResponse(accounts=accounts)


class AddAccountInput(BaseModel):
    account_id: str = Field(..., pattern=r"^[0-9]{12}$")
    account_name: str = Field(..., min_length=1, max_length=128)
    role_arn: str = ""
    external_id: str = "billing-portal-cross-account"
    region: str = "us-east-1"


@app.post("/accounts")
@tracer.capture_method
async def add_account(input: AddAccountInput) -> AccountInfo:
    """Register a new bill-receiver account."""
    table = _get_accounts_table()
    item = {
        "account_id": input.account_id,
        "account_name": input.account_name,
        "role_arn": input.role_arn or f"arn:aws:iam::{input.account_id}:role/{CROSS_ACCOUNT_ROLE_NAME}",
        "external_id": input.external_id,
        "region": input.region,
        "status": "active",
    }
    table.put_item(Item=item)
    return AccountInfo(**item)


class RemoveAccountResult(BaseModel):
    success: bool
    message: str


@app.delete("/accounts/{account_id}")
@tracer.capture_method
async def remove_account(account_id: str) -> RemoveAccountResult:
    """Remove a bill-receiver account from the registry."""
    table = _get_accounts_table()
    table.delete_item(Key={"account_id": account_id})
    return RemoveAccountResult(success=True, message=f"Account {account_id} removed")


@app.post("/accounts/{account_id}/test")
@tracer.capture_method
async def test_account_connection(account_id: str) -> AccountTestResult:
    """Test connectivity to a target account by assuming the cross-account role."""
    try:
        session = _get_assumed_session(account_id)
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        return AccountTestResult(
            success=True,
            message=f"Connected as {identity['Arn']}",
            account_id=account_id,
        )
    except Exception as e:
        return AccountTestResult(
            success=False,
            message=f"Connection failed: {str(e)}",
            account_id=account_id,
        )


# ── End Multi-Account Management ───────────────────────────────────────────


class CurExportInfo(BaseModel):
    export_name: str
    export_arn: str | None = None
    status: str  # HEALTHY | UNHEALTHY
    billing_view: str  # MY_VIEW | SHOWBACK
    s3_bucket: str
    s3_prefix: str
    format: str
    billing_group_name: str | None = None
    last_refreshed: str | None = None


class BillingViewInfo(BaseModel):
    arn: str
    name: str
    view_type: str  # BILLING_TRANSFER_SHOWBACK | BILLING_TRANSFER_MY_VIEW
    source_account_id: str


class BillingGroupOption(BaseModel):
    name: str
    arn: str
    primary_account_id: str


class CurManagerData(BaseModel):
    exports: list[CurExportInfo]
    billing_groups_without_cur: list[str]
    billing_groups: list[BillingGroupOption]
    billing_views: list[BillingViewInfo]
    default_bucket: str = ""


class CreateCurExportInput(BaseModel):
    billing_group_name: str
    billing_group_arn: str
    primary_account_id: str = ""
    s3_bucket: str
    s3_prefix: str = "cur-exports"
    format: str = "PARQUET"  # PARQUET | TEXT_OR_CSV
    billing_view: str = "SHOWBACK"  # MY_VIEW | SHOWBACK


class CreateCurExportResult(BaseModel):
    success: bool
    export_name: str
    message: str


def _get_data_exports_client():
    return _boto_session().client("bcm-data-exports")


def _list_cur_exports() -> list[dict]:
    """List all data exports via BCM Data Exports API, handling pagination manually."""
    client = _get_data_exports_client()
    exports = []
    try:
        next_token = None
        while True:
            kwargs = {"MaxResults": 100}
            if next_token:
                kwargs["NextToken"] = next_token
            resp = client.list_exports(**kwargs)
            exports.extend(resp.get("Exports", []))
            next_token = resp.get("NextToken")
            if not next_token:
                break
    except Exception as e:
        logger.error(f"list_exports error: {e}")
    return exports


def _get_export_detail(client, export_arn: str) -> dict:
    """Get full export details including S3 destination config."""
    try:
        resp = client.get_export(ExportArn=export_arn)
        return resp
    except Exception as e:
        logger.error(f"get_export error for {export_arn}: {e}")
        return {}


def _parse_export(
    export_ref: dict, export_detail: dict, bg_name_map: dict[str, str], bg_account_map: dict[str, str]
) -> CurExportInfo:
    """Parse a BCM Data Exports export reference + detail into our model."""
    # list_exports returns: ExportArn, ExportName, ExportStatus
    name = export_ref.get("ExportName", "")
    arn = export_ref.get("ExportArn", "")

    status_obj = export_ref.get("ExportStatus", {})
    status_code = status_obj.get("StatusCode", "UNKNOWN")
    status = "HEALTHY" if status_code == "HEALTHY" else "UNHEALTHY"
    last_refreshed = str(status_obj.get("LastRefreshedAt", "")) or None

    # get_export returns full Export object with DestinationConfigurations
    full_export = export_detail.get("Export", {})
    dest = full_export.get("DestinationConfigurations", {})
    s3_dest = dest.get("S3Destination", {})
    s3_bucket = s3_dest.get("S3Bucket", "")
    s3_prefix = s3_dest.get("S3Prefix", "")
    fmt = s3_dest.get("S3OutputConfigurations", {}).get("Format", "PARQUET")

    # Determine billing view from export name convention
    name_lower = name.lower()
    billing_view = "SHOWBACK" if "showback" in name_lower or "chargeback" in name_lower else "MY_VIEW"

    # Match to billing group: try name, then account ID in name/prefix
    searchable = f"{name_lower} {s3_prefix.lower()}"
    bg_name = None
    for _bg_arn, bname in bg_name_map.items():
        safe = bname.lower().replace(" ", "-").replace("_", "-")
        if safe in searchable:
            bg_name = bname
            break
    if not bg_name:
        # Try matching by primary account ID appearing in export name or S3 prefix
        for _bg_arn, acct_id in bg_account_map.items():
            if acct_id and acct_id in searchable:
                bg_name = bg_name_map.get(_bg_arn)
                break

    return CurExportInfo(
        export_name=name,
        export_arn=arn,
        status=status,
        billing_view=billing_view,
        s3_bucket=s3_bucket,
        s3_prefix=s3_prefix,
        format=fmt,
        billing_group_name=bg_name,
        last_refreshed=last_refreshed,
    )


def _fetch_cur_manager() -> CurManagerData:
    """Fetch all CUR exports and identify billing groups without exports."""
    billing_groups = _cached("billing_groups", lambda: _fetch_billing_groups())

    bg_name_map = {bg.arn: bg.name for bg in billing_groups}
    bg_account_map = {bg.arn: bg.primary_account_id for bg in billing_groups}
    bg_names = {bg.name for bg in billing_groups}

    # Get all data exports (list gives summary, get_export gives full detail)
    raw_exports = _list_cur_exports()
    de_client = _get_data_exports_client()
    exports = []
    for ref in raw_exports:
        arn = ref.get("ExportArn", "")
        detail = _get_export_detail(de_client, arn) if arn else {}
        exports.append(_parse_export(ref, detail, bg_name_map, bg_account_map))

    # Find billing groups that don't have a CUR export (check both CUR 2.0 and legacy)
    covered = {e.billing_group_name for e in exports if e.billing_group_name}

    # Also check legacy CUR reports for coverage
    try:
        cur_client = _boto_session().client("cur", region_name="us-east-1")
        legacy_reports = cur_client.describe_report_definitions().get("ReportDefinitions", [])
        # Match legacy reports to billing groups by billing view ARN source account
        billing_client = _boto_session().client("billing")
        views_resp = billing_client.list_billing_views().get("billingViews", [])
        # Build map: billing view ARN -> source account ID
        view_to_account = {v.get("arn", ""): v.get("sourceAccountId", "") for v in views_resp}
        # Build map: primary account -> billing group name
        account_to_bg = {bg.primary_account_id: bg.name for bg in billing_groups}
        for r in legacy_reports:
            bv_arn = r.get("BillingViewArn", "")
            src_account = view_to_account.get(bv_arn, "")
            bg_name = account_to_bg.get(src_account, "")
            if bg_name:
                covered.add(bg_name)
            # Add to exports table
            view_type = "SHOWBACK" if "showback" in bv_arn.lower() else "MY_VIEW"
            status = "HEALTHY" if r.get("ReportStatus", {}).get("lastDelivery") else "IN_PROGRESS"
            exports.append(
                CurExportInfo(
                    export_name=r.get("ReportName", ""),
                    export_arn=None,
                    status=status,
                    billing_view=view_type,
                    s3_bucket=r.get("S3Bucket", ""),
                    s3_prefix=r.get("S3Prefix", ""),
                    format=r.get("Format", "Parquet"),
                    billing_group_name=bg_name or None,
                    last_refreshed=r.get("ReportStatus", {}).get("lastDelivery"),
                )
            )
    except Exception as e:
        logger.warning(f"Could not check legacy CUR coverage: {e}")

    missing = sorted(bg_names - covered)

    # Build billing group options for the create form
    bg_options = [
        BillingGroupOption(name=bg.name, arn=bg.arn, primary_account_id=bg.primary_account_id) for bg in billing_groups
    ]

    # Fetch billing views for the create form
    billing_views = []
    try:
        billing_client = _boto_session().client("billing")
        resp = billing_client.list_billing_views()
        seen = set()
        for v in resp.get("billingViews", []):
            vtype = v.get("billingViewType", "")
            src = v.get("sourceAccountId", "")
            key = f"{vtype}-{src}"
            if vtype.startswith("BILLING_TRANSFER") and key not in seen:
                seen.add(key)
                billing_views.append(
                    BillingViewInfo(
                        arn=v.get("arn", ""),
                        name=v.get("name", ""),
                        view_type=vtype,
                        source_account_id=src,
                    )
                )
    except Exception as e:
        logger.warning(f"Could not fetch billing views: {e}")

    # Default bucket uses target account ID
    account_id = _current_account_id.get() or os.environ.get("AWS_ACCOUNT_ID", "")
    region = os.environ.get("AWS_REGION", "us-east-1")
    default_bucket = (
        f"billing-portal-cur-data-{account_id}-{region}" if account_id else os.environ.get("CUR_BUCKET_NAME", "")
    )

    return CurManagerData(
        exports=exports,
        billing_groups_without_cur=missing,
        billing_groups=bg_options,
        billing_views=billing_views,
        default_bucket=default_bucket,
    )


def _create_cur_export(input: CreateCurExportInput) -> CreateCurExportResult:
    """Create a new CUR data export for a billing group."""
    client = _get_data_exports_client()

    safe_name = input.billing_group_name.lower().replace(" ", "-").replace("_", "-")
    view_tag = "showback" if input.billing_view == "SHOWBACK" else "myview"
    ts = datetime.now().strftime("%Y%m%d%H%M")
    export_name = f"cur-{safe_name}-{view_tag}-{ts}"

    # CUR 2.0 requires explicit column list — standard CUR columns
    columns = (
        "bill_bill_type, bill_billing_entity, bill_billing_period_end_date, "
        "bill_billing_period_start_date, bill_invoice_id, bill_invoicing_entity, "
        "bill_payer_account_id, bill_payer_account_name, cost_category, discount, "
        "discount_bundled_discount, discount_total_discount, identity_line_item_id, "
        "identity_time_interval, line_item_availability_zone, line_item_blended_cost, "
        "line_item_blended_rate, line_item_currency_code, line_item_legal_entity, "
        "line_item_line_item_description, line_item_line_item_type, "
        "line_item_net_unblended_cost, line_item_net_unblended_rate, "
        "line_item_normalization_factor, line_item_normalized_usage_amount, "
        "line_item_operation, line_item_product_code, line_item_tax_type, "
        "line_item_unblended_cost, line_item_unblended_rate, "
        "line_item_usage_account_id, line_item_usage_account_name, "
        "line_item_usage_amount, line_item_usage_end_date, "
        "line_item_usage_start_date, line_item_usage_type, pricing_currency, "
        "pricing_lease_contract_length, pricing_offering_class, "
        "pricing_public_on_demand_cost, pricing_public_on_demand_rate, "
        "pricing_purchase_option, pricing_rate_code, pricing_rate_id, "
        "pricing_term, pricing_unit, product, product_comment, "
        "product_fee_code, product_fee_description, product_from_location, "
        "product_from_location_type, product_from_region_code, "
        "product_instance_family, product_instance_type, product_instancesku, "
        "product_location, product_location_type, product_operation, "
        "product_pricing_unit, product_product_family, product_region_code, "
        "product_servicecode, product_sku, product_to_location, "
        "product_to_location_type, product_to_region_code, product_usagetype, "
        "reservation_amortized_upfront_cost_for_usage, "
        "reservation_amortized_upfront_fee_for_billing_period, "
        "reservation_availability_zone, reservation_effective_cost, "
        "reservation_end_time, reservation_modification_status, "
        "reservation_net_amortized_upfront_cost_for_usage, "
        "reservation_net_amortized_upfront_fee_for_billing_period, "
        "reservation_net_effective_cost, reservation_net_recurring_fee_for_usage, "
        "reservation_net_unused_amortized_upfront_fee_for_billing_period, "
        "reservation_net_unused_recurring_fee, reservation_net_upfront_value, "
        "reservation_normalized_units_per_reservation, "
        "reservation_number_of_reservations, reservation_recurring_fee_for_usage, "
        "reservation_reservation_a_r_n, reservation_start_time, "
        "reservation_subscription_id, reservation_total_reserved_normalized_units, "
        "reservation_total_reserved_units, reservation_units_per_reservation, "
        "reservation_unused_amortized_upfront_fee_for_billing_period, "
        "reservation_unused_normalized_unit_quantity, reservation_unused_quantity, "
        "reservation_unused_recurring_fee, reservation_upfront_value, "
        "resource_tags, savings_plan_amortized_upfront_commitment_for_billing_period, "
        "savings_plan_end_time, savings_plan_instance_type_family, "
        "savings_plan_net_amortized_upfront_commitment_for_billing_period, "
        "savings_plan_net_recurring_commitment_for_billing_period, "
        "savings_plan_net_savings_plan_effective_cost, savings_plan_offering_type, "
        "savings_plan_payment_option, savings_plan_purchase_term, "
        "savings_plan_recurring_commitment_for_billing_period, savings_plan_region, "
        "savings_plan_savings_plan_a_r_n, savings_plan_savings_plan_effective_cost, "
        "savings_plan_savings_plan_rate, savings_plan_start_time, "
        "savings_plan_total_commitment_to_date, savings_plan_used_commitment"
    )
    query = "SELECT " + columns + " FROM COST_AND_USAGE_REPORT"  # nosec B608 - columns is a hardcoded constant

    # Resolve billing view ARN — look up from billing:ListBillingViews
    billing_view_arn = ""
    try:
        billing_client = _boto_session().client("billing")
        resp = billing_client.list_billing_views()
        views = resp.get("BillingViews", resp.get("billingViews", []))
        view_type = "BILLING_TRANSFER_SHOWBACK" if input.billing_view == "SHOWBACK" else "BILLING_TRANSFER"
        # Match billing view by source account ID (= billing group's primary account)
        bg_account = input.primary_account_id
        for v in views:
            vtype = v.get("billingViewType", v.get("BillingViewType", ""))
            src = v.get("sourceAccountId", v.get("SourceAccountId", ""))
            if vtype == view_type and src == bg_account:
                billing_view_arn = v.get("arn", v.get("Arn", ""))
                break
    except Exception as e:
        logger.warning(f"Could not resolve billing view ARN: {e}")

    # Compression must match format
    compression = "PARQUET" if input.format == "PARQUET" else "GZIP"

    table_config = {
        "TIME_GRANULARITY": "DAILY",
        "INCLUDE_RESOURCES": "FALSE",
        "INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY": "FALSE",
        "INCLUDE_SPLIT_COST_ALLOCATION_DATA": "FALSE",
    }
    if billing_view_arn:
        table_config["BILLING_VIEW_ARN"] = billing_view_arn

    try:
        client.create_export(
            Export={
                "Name": export_name,
                "DataQuery": {
                    "QueryStatement": query,
                    "TableConfigurations": {"COST_AND_USAGE_REPORT": table_config},
                },
                "DestinationConfigurations": {
                    "S3Destination": {
                        "S3Bucket": input.s3_bucket,
                        "S3Prefix": f"{input.s3_prefix}/{safe_name}",
                        "S3Region": os.environ.get("AWS_REGION", "us-east-1"),
                        "S3OutputConfigurations": {
                            "OutputType": "CUSTOM",
                            "Format": input.format,
                            "Compression": compression,
                            "Overwrite": "OVERWRITE_REPORT",
                        },
                    }
                },
                "RefreshCadence": {"Frequency": "SYNCHRONOUS"},
            }
        )
        return CreateCurExportResult(
            success=True,
            export_name=export_name,
            message=f"Export '{export_name}' created. Data will populate within 24-48 hours.",
        )
    except client.exceptions.ServiceQuotaExceededException:
        return CreateCurExportResult(
            success=False,
            export_name=export_name,
            message="Export quota exceeded. Delete unused exports or request a quota increase via Service Quotas.",
        )
    except Exception as e:
        logger.error(f"create_export error: {e}")
        return CreateCurExportResult(
            success=False,
            export_name=export_name,
            message=f"Failed to create export: {str(e)}",
        )


@app.get("/cur-manager")
@tracer.capture_method
async def cur_manager(request: Request) -> CurManagerData:
    """List all CUR exports and identify billing groups without coverage."""
    return await _run_with_context(_account_from_request(request), _fetch_cur_manager)


@app.post("/cur-manager/create")
@tracer.capture_method
async def create_cur_export(request: Request, input: CreateCurExportInput) -> CreateCurExportResult:
    """Create a new CUR data export for a billing group."""
    return await _run_with_context(_account_from_request(request), _create_cur_export, input)


class DeleteCurExportInput(BaseModel):
    export_arn: str


class DeleteCurExportResult(BaseModel):
    success: bool
    message: str


def _delete_cur_export(input: DeleteCurExportInput) -> DeleteCurExportResult:
    client = _get_data_exports_client()
    try:
        client.delete_export(ExportArn=input.export_arn)
        return DeleteCurExportResult(success=True, message="Export deleted.")
    except Exception as e:
        logger.error(f"delete_export error: {e}")
        return DeleteCurExportResult(success=False, message=f"Failed: {str(e)}")


@app.post("/cur-manager/delete")
@tracer.capture_method
async def delete_cur_export(request: Request, input: DeleteCurExportInput) -> DeleteCurExportResult:
    """Delete a CUR data export."""
    return await _run_with_context(_account_from_request(request), _delete_cur_export, input)


class BulkCreateInput(BaseModel):
    s3_bucket: str
    format: str = "PARQUET"
    export_type: str = "CUR_2_0"  # CUR_2_0 or LEGACY
    billing_groups: list[str] | None = None  # If provided, only create for these


class BulkCreateResult(BaseModel):
    created: list[str]
    failed: list[str]
    message: str


def _create_legacy_cur_report(
    billing_group_name: str, billing_group_arn: str, s3_bucket: str, billing_view: str, primary_account_id: str = ""
) -> CreateCurExportResult:
    """Create a legacy CUR report using cur:PutReportDefinition (1000 quota for billing transfer accounts)."""
    cur_client = _boto_session().client("cur", region_name="us-east-1")

    safe_name = billing_group_name.lower().replace(" ", "-").replace("_", "-")
    view_tag = "showback" if billing_view == "SHOWBACK" else "myview"
    ts = datetime.now().strftime("%Y%m%d%H%M")
    report_name = f"cur-{safe_name}-{view_tag}-{ts}"

    # Resolve billing view ARN
    billing_view_arn = ""
    try:
        billing_client = _boto_session().client("billing")
        resp = billing_client.list_billing_views()
        views = resp.get("BillingViews", resp.get("billingViews", []))
        view_type = "BILLING_TRANSFER_SHOWBACK" if billing_view == "SHOWBACK" else "BILLING_TRANSFER"
        bg_account = primary_account_id
        for v in views:
            vtype = v.get("billingViewType", v.get("BillingViewType", ""))
            src = v.get("sourceAccountId", v.get("SourceAccountId", ""))
            if vtype == view_type and src == bg_account:
                billing_view_arn = v.get("arn", v.get("Arn", ""))
                break
    except Exception as e:
        logger.warning(f"Could not resolve billing view ARN for legacy CUR: {e}")

    report_def: dict = {
        "ReportName": report_name,
        "TimeUnit": "DAILY",
        "Format": "Parquet",
        "Compression": "Parquet",
        "AdditionalSchemaElements": ["RESOURCES"],
        "S3Bucket": s3_bucket,
        "S3Prefix": f"cur-exports/{safe_name}",
        "S3Region": os.environ.get("AWS_REGION", "us-east-1"),
        "AdditionalArtifacts": ["ATHENA"],
        "RefreshClosedReports": True,
        "ReportVersioning": "OVERWRITE_REPORT",
    }
    if billing_view_arn:
        report_def["BillingViewArn"] = billing_view_arn

    try:
        cur_client.put_report_definition(ReportDefinition=report_def)
        return CreateCurExportResult(
            success=True,
            export_name=report_name,
            message=f"Legacy CUR report '{report_name}' created.",
        )
    except Exception as e:
        logger.error(f"put_report_definition error: {e}")
        return CreateCurExportResult(
            success=False,
            export_name=report_name,
            message=f"Failed to create legacy CUR: {str(e)}",
        )


def _bulk_create_missing(input: BulkCreateInput) -> BulkCreateResult:
    """Create CUR exports for selected billing groups (or all missing if none specified)."""
    data = _fetch_cur_manager()
    missing = input.billing_groups if input.billing_groups else data.billing_groups_without_cur
    if not missing:
        return BulkCreateResult(created=[], failed=[], message="All billing groups already have CUR exports.")

    # Find ARNs and primary accounts for missing billing groups
    bg_arn_map = {bg.name: bg.arn for bg in data.billing_groups}
    bg_account_map = {bg.name: bg.primary_account_id for bg in data.billing_groups}

    created = []
    failed = []
    op_count = 0
    for bg_name in missing:
        for view in ["SHOWBACK", "MY_VIEW"]:
            if op_count > 0 and op_count % 3 == 0:
                time.sleep(1)  # Throttle: 3 exports then pause to avoid BCM rate limits
            if input.export_type == "LEGACY":
                result = _create_legacy_cur_report(
                    billing_group_name=bg_name,
                    billing_group_arn=bg_arn_map.get(bg_name, ""),
                    s3_bucket=input.s3_bucket,
                    billing_view=view,
                    primary_account_id=bg_account_map.get(bg_name, ""),
                )
            else:
                result = _create_cur_export(
                    CreateCurExportInput(
                        billing_group_name=bg_name,
                        billing_group_arn=bg_arn_map.get(bg_name, ""),
                        primary_account_id=bg_account_map.get(bg_name, ""),
                        s3_bucket=input.s3_bucket,
                        s3_prefix="cur-exports",
                        format=input.format,
                        billing_view=view,
                    )
                )
            if result.success:
                created.append(result.export_name)
            else:
                failed.append(f"{bg_name} ({view}): {result.message}")
            op_count += 1

    msg = f"Created {len(created)} export(s)"
    if failed:
        msg += f", {len(failed)} failed"
    msg += ". Data will populate within 24-48 hours."
    return BulkCreateResult(created=created, failed=failed, message=msg)


@app.post("/cur-manager/create-all-missing")
@tracer.capture_method
async def bulk_create_missing(request: Request, input: BulkCreateInput) -> BulkCreateResult:
    """Create CUR exports in background — returns immediately."""
    import threading

    account_id = _account_from_request(request)

    def _run_in_background():
        token = _current_account_id.set(account_id)
        try:
            _bulk_create_missing(input)
        except Exception as e:
            logger.error(f"Background bulk create failed: {e}")
        finally:
            _current_account_id.reset(token)

    threading.Thread(target=_run_in_background, daemon=True).start()
    count = len(input.billing_groups) if input.billing_groups else 0
    return BulkCreateResult(
        created=[],
        failed=[],
        message=f"Creating exports for {count} billing group(s) in background. Refresh in a minute to see results.",
    )


GLUE_CRAWLER_NAME = os.environ.get("GLUE_CRAWLER_NAME", "billing-portal-cur-crawler")


class CrawlerStatus(BaseModel):
    status: str
    message: str


@app.post("/cur-manager/run-crawler")
@tracer.capture_method
async def run_crawler(request: Request) -> CrawlerStatus:
    """Auto-discover all CUR S3 paths, update crawler targets, then start the crawler."""
    account_id = _account_from_request(request)

    def _do():
        glue_client = _boto_session().client("glue")
        try:
            s3_targets = _discover_cur_s3_targets()
            if s3_targets:
                glue_client.update_crawler(
                    Name=GLUE_CRAWLER_NAME,
                    Targets={"S3Targets": [{"Path": p} for p in s3_targets]},
                )
                logger.info(f"Updated crawler with {len(s3_targets)} S3 targets")

            resp = glue_client.get_crawler(Name=GLUE_CRAWLER_NAME)
            state = resp["Crawler"]["State"]
            if state == "RUNNING":
                return CrawlerStatus(status="ALREADY_RUNNING", message="Crawler is already running.")
            glue_client.start_crawler(Name=GLUE_CRAWLER_NAME)
            return CrawlerStatus(
                status="STARTED",
                message=f"Crawler started with {len(s3_targets)} S3 target(s)."
                " Table will be available in a few minutes.",
            )
        except glue_client.exceptions.EntityNotFoundException:
            return CrawlerStatus(
                status="NOT_FOUND", message=f"Crawler '{GLUE_CRAWLER_NAME}' not found. Deploy infrastructure first."
            )
        except glue_client.exceptions.CrawlerRunningException:
            return CrawlerStatus(status="ALREADY_RUNNING", message="Crawler is already running.")

    return await _run_with_context(account_id, _do)


def _discover_cur_s3_targets() -> list[str]:
    """Discover all S3 paths from legacy CUR reports and CUR 2.0 exports (precise paths only)."""
    paths: set[str] = set()

    # Legacy CUR reports: data lives at s3://bucket/prefix/report-name/
    try:
        cur_client = _boto_session().client("cur", region_name="us-east-1")
        reports = cur_client.describe_report_definitions().get("ReportDefinitions", [])
        for r in reports:
            bucket = r.get("S3Bucket", "")
            prefix = r.get("S3Prefix", "").rstrip("/")
            name = r.get("ReportName", "")
            if bucket and name:
                path = f"s3://{bucket}/{prefix}/{name}/" if prefix else f"s3://{bucket}/{name}/"
                paths.add(path)
    except Exception as e:
        logger.warning(f"Could not list legacy CUR reports: {e}")

    # CUR 2.0 exports: data lives at s3://bucket/prefix/
    try:
        bcm_client = _boto_session().client("bcm-data-exports", region_name="us-east-1")
        exports = bcm_client.list_exports().get("Exports", [])
        for exp in exports:
            try:
                detail = bcm_client.get_export(ExportArn=exp["ExportArn"]).get("Export", {})
                s3_dest = detail.get("DestinationConfigurations", {}).get("S3Destination", {})
                bucket = s3_dest.get("S3Bucket", "")
                prefix = s3_dest.get("S3Prefix", "").rstrip("/")
                if bucket and prefix:
                    paths.add(f"s3://{bucket}/{prefix}/")
            except Exception:
                continue
    except Exception as e:
        logger.warning(f"Could not list CUR 2.0 exports: {e}")

    # Also include the portal's own CUR bucket
    cur_bucket = os.environ.get("CUR_BUCKET_NAME", "")
    if cur_bucket:
        paths.add(f"s3://{cur_bucket}/cur-exports/")

    return sorted(paths)


# ── Customer Reports ────────────────────────────────────────────────────────


ATHENA_DATABASE = os.environ.get("ATHENA_DATABASE", "billing_portal_cur")
ATHENA_TABLE = os.environ.get("ATHENA_TABLE", "cur_data")
ATHENA_RESULTS_BUCKET = os.environ.get("ATHENA_RESULTS_BUCKET", "")

_resolved_table: str | None = None


def _get_athena_table() -> str:
    """Return the Athena table name, auto-discovering from Glue if the configured one doesn't exist."""
    global _resolved_table
    if _resolved_table:
        return _resolved_table
    glue_client = _boto_session().client("glue")
    # Try the configured table first
    try:
        glue_client.get_table(DatabaseName=ATHENA_DATABASE, Name=ATHENA_TABLE)
        _resolved_table = ATHENA_TABLE
        return _resolved_table
    except Exception:
        pass
    # Auto-discover: find the first table with parquet data columns
    try:
        tables = glue_client.get_tables(DatabaseName=ATHENA_DATABASE)["TableList"]
        for t in tables:
            cols = t.get("StorageDescriptor", {}).get("Columns", [])
            col_names = [c["Name"] for c in cols]
            if "line_item_usage_account_id" in col_names:
                _resolved_table = t["Name"]
                logger.info(f"Auto-discovered Athena table: {_resolved_table}")
                return _resolved_table
    except Exception as e:
        logger.warning(f"Could not auto-discover Athena table: {e}")
    _resolved_table = ATHENA_TABLE
    return _resolved_table


class CustomerReportEntry(BaseModel):
    billing_period: str
    account_id: str
    account_name: str
    row_count: int


class CustomerReportsData(BaseModel):
    reports: list[CustomerReportEntry]
    periods: list[str]
    accounts: list[str]


def _athena_query(query: str, parameters: list[str] | None = None) -> str:
    """Submit Athena query and return the query execution ID."""
    client = _boto_session().client("athena")
    kwargs: dict = {
        "QueryString": query,
        "QueryExecutionContext": {"Database": ATHENA_DATABASE},
        "ResultConfiguration": {"OutputLocation": f"s3://{ATHENA_RESULTS_BUCKET}/"},
    }
    if parameters:
        kwargs["ExecutionParameters"] = parameters
    resp = client.start_query_execution(**kwargs)
    return resp["QueryExecutionId"]


def _athena_wait(query_id: str, timeout: int = 30) -> str:
    """Wait for Athena query to complete. Returns status."""
    import time

    client = _boto_session().client("athena")
    for _ in range(timeout):
        resp = client.get_query_execution(QueryExecutionId=query_id)
        state = resp["QueryExecution"]["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            return state
        time.sleep(1)
    return "TIMEOUT"


def _athena_results(query_id: str) -> list[dict]:
    """Fetch Athena query results as list of dicts."""
    client = _boto_session().client("athena")
    rows = []
    kwargs = {"QueryExecutionId": query_id}
    while True:
        resp = client.get_query_results(**kwargs)
        result_rows = resp["ResultSet"]["Rows"]
        if not rows:
            # First batch — first row is header
            headers = [d.get("VarCharValue", "") for d in result_rows[0]["Data"]]
            for row in result_rows[1:]:
                vals = [d.get("VarCharValue", "") for d in row["Data"]]
                rows.append(dict(zip(headers, vals, strict=False)))
        else:
            for row in result_rows:
                vals = [d.get("VarCharValue", "") for d in row["Data"]]
                rows.append(dict(zip(headers, vals, strict=False)))
        token = resp.get("NextToken")
        if not token:
            break
        kwargs["NextToken"] = token
    return rows


def _detect_cur_schema() -> str:
    """Detect whether the Athena table uses legacy CUR (year/month partitions) or CUR 2.0 (BILLING_PERIOD column).
    Returns 'legacy' or 'cur2'."""
    glue = _boto_session().client("glue")
    try:
        resp = glue.get_table(DatabaseName=ATHENA_DATABASE, Name=_get_athena_table())
        parts = [p["Name"] for p in resp["Table"].get("PartitionKeys", [])]
        if "year" in parts and "month" in parts:
            return "legacy"
    except Exception:
        pass
    return "cur2"


_cur_schema: str | None = None


def _get_cur_schema() -> str:
    global _cur_schema
    if _cur_schema is None:
        _cur_schema = _detect_cur_schema()
        logger.info(f"Detected CUR schema: {_cur_schema}")
    return _cur_schema


def _list_customer_reports() -> CustomerReportsData:
    """Query Athena for available billing periods and accounts."""
    schema = _get_cur_schema()
    if schema == "legacy":
        query = (
            "SELECT concat(year, '-', lpad(month, 2, '0')) as BILLING_PERIOD,"
            " line_item_usage_account_id,"
            " line_item_usage_account_id as line_item_usage_account_name,"
            " count(*) as cnt"
            " FROM "
            + _get_athena_table()  # nosec B608 - table name from Glue catalog
            + " GROUP BY year, month, line_item_usage_account_id"
            " ORDER BY year DESC, month DESC, line_item_usage_account_id"
        )
    else:
        query = (
            'SELECT "BILLING_PERIOD", line_item_usage_account_id,'
            " line_item_usage_account_name, count(*) as cnt"
            " FROM "
            + _get_athena_table()  # nosec B608 - table name from Glue catalog
            + ' GROUP BY "BILLING_PERIOD", line_item_usage_account_id, line_item_usage_account_name'
            ' ORDER BY "BILLING_PERIOD" DESC, line_item_usage_account_id'
        )
    qid = _athena_query(query)
    status = _athena_wait(qid)
    if status != "SUCCEEDED":
        logger.error(f"Athena query failed: {status}")
        return CustomerReportsData(reports=[], periods=[], accounts=[])

    rows = _athena_results(qid)
    reports = []
    periods = set()
    accounts = set()
    for r in rows:
        acct = r.get("line_item_usage_account_id", "")
        period = r.get("BILLING_PERIOD", "")
        periods.add(period)
        accounts.add(acct)
        reports.append(
            CustomerReportEntry(
                billing_period=period,
                account_id=acct,
                account_name=r.get("line_item_usage_account_name", acct),
                row_count=int(r.get("cnt", 0)),
            )
        )
    return CustomerReportsData(
        reports=reports,
        periods=sorted(periods, reverse=True),
        accounts=sorted(accounts),
    )


def _generate_customer_csv(billing_period: str, account_id: str | None) -> str:
    """Run Athena query filtered by period/account, return the S3 key of the CSV result."""
    import re

    if not re.fullmatch(r"\d{4}-\d{2}", billing_period):
        raise ValueError("Invalid billing_period format")
    if account_id and not re.fullmatch(r"\d{12}", account_id):
        raise ValueError("Invalid account_id format")

    params = []
    schema = _get_cur_schema()
    if schema == "legacy":
        params = [billing_period[:4], str(int(billing_period[5:7]))]
        query = (
            "SELECT * FROM " + _get_athena_table() + " WHERE year = cast(? as varchar) AND month = cast(? as varchar)"
        )  # nosec B608 - parameterized query
    else:
        params = [billing_period]
        query = "SELECT * FROM " + _get_athena_table() + ' WHERE "BILLING_PERIOD" = cast(? as varchar)'  # nosec B608 - parameterized query
    if account_id:
        query += " AND line_item_usage_account_id = cast(? as varchar)"
        params.append(account_id)
    qid = _athena_query(query, parameters=params)
    status = _athena_wait(qid, timeout=60)
    if status != "SUCCEEDED":
        raise Exception(f"Athena query failed: {status}")
    # Athena writes results as CSV to S3 automatically
    return f"s3://{ATHENA_RESULTS_BUCKET}/{qid}.csv"


@app.get("/customer-reports")
@tracer.capture_method
async def customer_reports(request: Request) -> CustomerReportsData:
    """List available billing periods and customer accounts from CUR via Athena."""
    return await _run_with_context(_account_from_request(request), _list_customer_reports)


@app.get("/customer-reports/download")
@tracer.capture_method
async def download_customer_report(request: Request, billing_period: str, account_id: str | None = None):
    """Download CUR data as CSV via Athena query, optionally filtered by customer account."""
    s3_uri = await _run_with_context(_account_from_request(request), _generate_customer_csv, billing_period, account_id)

    # Stream the CSV from S3
    bucket = s3_uri.split("/")[2]
    key = "/".join(s3_uri.split("/")[3:])
    s3 = _boto_session().client("s3")
    resp = s3.get_object(Bucket=bucket, Key=key)

    filename = f"cur-{billing_period}"
    if account_id:
        filename += f"-{account_id}"
    return RawStreamingResponse(
        resp["Body"],
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
    )


if __name__ == "__main__":
    uvicorn.run("billing_partner_portal_billing_api.main:app", port=8000)
