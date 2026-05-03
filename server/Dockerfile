# syntax=docker/dockerfile:1
FROM python:3.11-slim

# Java is required by JMeter; wget+unzip are needed to fetch the binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless \
        wget \
        unzip \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JMETER_VERSION=5.6.3
RUN wget -q https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz \
    && tar -xzf apache-jmeter-${JMETER_VERSION}.tgz -C /opt \
    && rm apache-jmeter-${JMETER_VERSION}.tgz \
    && ln -s /opt/apache-jmeter-${JMETER_VERSION}/bin/jmeter /usr/local/bin/jmeter

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000 \
    PYTHONUNBUFFERED=1 \
    JMX_RUNS_DIR=/tmp/jmx-runs

EXPOSE 5000

# gthread worker class is needed because each SSE connection holds a thread
# for the duration of the run. The 600s timeout matches our run cap.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 2 --threads 4 --worker-class gthread --timeout 600 app:app"]
