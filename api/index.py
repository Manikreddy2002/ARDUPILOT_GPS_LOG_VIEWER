import os
import sys

# Ensure project root is in Python module search path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import app

# Vercel looks for the WSGI application object 'app'
# This handles all routing, template rendering, and API requests
