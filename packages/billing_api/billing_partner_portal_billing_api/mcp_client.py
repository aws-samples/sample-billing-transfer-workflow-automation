"""MCP client for direct tool calls to the billing-cost-management MCP server."""

import asyncio
import json
import os
from contextlib import asynccontextmanager

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def _build_env(credentials: dict | None = None) -> dict[str, str]:
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
        for key in (
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN",
            "AWS_DEFAULT_REGION",
        ):
            if os.environ.get(key):
                env[key] = os.environ[key]
    return env


@asynccontextmanager
async def mcp_session(credentials: dict | None = None):
    """Async context manager yielding an MCP ClientSession."""
    params = StdioServerParameters(
        command="uvx",
        args=["awslabs.billing-cost-management-mcp-server@latest"],
        env=_build_env(credentials),
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        yield session


async def call_tool(session: ClientSession, tool_name: str, arguments: dict | None = None) -> dict:
    """Call an MCP tool and return parsed JSON response."""
    result = await session.call_tool(tool_name, arguments or {})
    for item in result.content:
        if hasattr(item, "text"):
            return json.loads(item.text)
    return {}


def call_tool_sync(tool_name: str, arguments: dict | None = None, credentials: dict | None = None) -> dict:
    """Synchronous wrapper for calling a single MCP tool."""

    async def _run():
        async with mcp_session(credentials) as session:
            return await call_tool(session, tool_name, arguments)

    return asyncio.run(_run())


def call_tools_sync(calls: list[tuple[str, dict | None]], credentials: dict | None = None) -> list[dict]:
    """Call multiple MCP tools in a single session (avoids repeated subprocess startup)."""

    async def _run():
        async with mcp_session(credentials) as session:
            return [await call_tool(session, name, args) for name, args in calls]

    return asyncio.run(_run())
