FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Europe/Moscow

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py db.py proxy.py ./

# Runtime data (persist via volume): users.db, tickets.json, reviews.json, sources.json
VOLUME /app/data

CMD ["python", "main.py"]
