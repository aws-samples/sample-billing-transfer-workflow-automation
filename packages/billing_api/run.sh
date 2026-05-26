#!/bin/bash
exec python -m uvicorn billing_partner_portal_billing_api.main:app --host 0.0.0.0 --port ${PORT:-8000}
