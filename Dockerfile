FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir \
        requests \
        beautifulsoup4 \
        python-dotenv \
        Pillow \
        pytesseract \
        numpy \
        prometheus_client

COPY skeleton.py .

ENV PYTHONUNBUFFERED=1 \
    COOKIE_FILE=/data/.cookies \
    METRICS_PORT=8080 \
    WAIT_FOR_FULL_AP=true \
    SINGLE_RUN=true \
    SWEEP_WIDTH=15

EXPOSE 8080

ENTRYPOINT ["python", "skeleton.py"]
