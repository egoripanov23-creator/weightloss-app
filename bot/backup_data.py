"""Backup runtime data (users.db, tickets, reviews, sources) into one archive.

Run on your PC BEFORE migrating to a VPS:
    python bot/backup_data.py

Creates bot_data_backup.zip in the project root. Copy it to the VPS and extract
into ~/weightloss-app/bot/data/  so all registered users and tickets survive.
"""
import os
import zipfile
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", BASE)
OUT = os.path.join(os.path.dirname(BASE), "bot_data_backup.zip")

FILES = ["users.db", "tickets.json", "reviews.json", "sources.json"]

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        path = os.path.join(DATA_DIR, name)
        if os.path.exists(path):
            z.write(path, arcname=name)
            print(f"  + {name}")
        else:
            print(f"  - {name} (not found, skipped)")

print(f"\n✅ Backup created: {OUT}")
print("Copy it to VPS:  scp bot_data_backup.zip root@YOUR_SERVER:~/weightloss-app/bot/")
print("On VPS:          cd ~/weightloss-app/bot && unzip -o bot_data_backup.zip -d data/")
