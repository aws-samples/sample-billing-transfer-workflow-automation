"""
Billing Transfer Automation Portal - Agent

Uses awslabs.billing-cost-management-mcp-server via stdio for billing tools.
Cross-account credentials are passed as env vars to the MCP subprocess.
"""

import logging
import os
from contextlib import contextmanager

from mcp.client.stdio import StdioServerParameters, stdio_client
from strands import Agent
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "")
BEDROCK_GUARDRAIL_ID = os.environ.get("BEDROCK_GUARDRAIL_ID", "")
BEDROCK_GUARDRAIL_VERSION = os.environ.get("BEDROCK_GUARDRAIL_VERSION", "DRAFT")


def _get_model():
    from strands.models.bedrock import BedrockModel

    streaming = "nova" not in BEDROCK_MODEL_ID.lower()
    kwargs = {"model_id": BEDROCK_MODEL_ID, "streaming": streaming}
    if BEDROCK_GUARDRAIL_ID:
        kwargs["guardrail_id"] = BEDROCK_GUARDRAIL_ID
        kwargs["guardrail_version"] = BEDROCK_GUARDRAIL_VERSION
    return BedrockModel(**kwargs)


SYSTEM_PROMPT = """You are the AWS Billing Transfer Automation Portal assistant.
You help AWS distributors manage billing transfers and understand costs.

RULES:
1. ALWAYS call tools before answering data questions.
2. NEVER fabricate numbers. Only use data from tool responses.
3. Present data in clean markdown tables. Never show ARNs.
4. Add business insights: trends, comparisons, margin analysis.
5. Calculate margin % from the data.
6. All operations are READ-ONLY.
7. NEVER include <thinking> tags or internal reasoning in your response. Only output the final answer.
8. When showing billing group cost reports:
   - AWSCost = "My View" (what the distributor pays AWS)
   - ProformaCost = "Showback" (what the customer sees)
   - Margin = Showback - My View (distributor's markup)
   Always label these clearly as My View and Showback, not "AWS Cost" and "Proforma".

For billing transfer knowledge questions, answer from your training data.
"""


def _build_mcp_env(credentials: dict | None = None) -> dict[str, str]:
    """Build env vars for the MCP subprocess, optionally with assumed-role credentials."""
    env = {
        "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"),
        "FASTMCP_LOG_LEVEL": "ERROR",
    }
    if credentials:
        env["AWS_ACCESS_KEY_ID"] = credentials["AccessKeyId"]
        env["AWS_SECRET_ACCESS_KEY"] = credentials["SecretAccessKey"]
        env["AWS_SESSION_TOKEN"] = credentials["SessionToken"]
    elif os.environ.get("AWS_PROFILE"):
        env["AWS_PROFILE"] = os.environ["AWS_PROFILE"]
    else:
        # On ECS/Fargate, pass through container credential endpoint
        for key in (
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN",
            "AWS_DEFAULT_REGION",
        ):
            if os.environ.get(key):
                env[key] = os.environ[key]
    return env


@contextmanager
def get_agent(session_id: str, credentials: dict | None = None):
    """Create an agent backed by the billing-cost-management MCP server.

    Args:
        session_id: Unique session identifier.
        credentials: Optional assumed-role credentials dict with AccessKeyId,
                     SecretAccessKey, SessionToken. If None, uses default creds.
    """
    mcp_client = MCPClient(
        lambda: stdio_client(
            StdioServerParameters(
                command="uvx",
                args=["awslabs.billing-cost-management-mcp-server@latest"],
                env=_build_mcp_env(credentials),
            )
        )
    )
    agent = Agent(
        model=_get_model(),
        system_prompt=SYSTEM_PROMPT,
        tools=[mcp_client],
    )
    try:
        yield agent
    finally:
        mcp_client.__exit__(None, None, None)
