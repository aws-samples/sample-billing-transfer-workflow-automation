FROM --platform=linux/amd64 python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY packages/billing_api/ packages/billing_api/
COPY packages/agents/ packages/agents/

RUN uv sync --frozen --no-dev

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/echo?message=health')"

CMD ["uv", "run", "uvicorn", "billing_partner_portal_billing_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
# platform: linux/amd64 v4
