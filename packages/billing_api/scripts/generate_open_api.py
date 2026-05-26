import json
import os
import sys

from billing_partner_portal_billing_api.main import app

os.makedirs(os.path.dirname(sys.argv[1]), exist_ok=True)
with open(sys.argv[1], 'w') as f:
  json.dump(app.openapi(), f)
