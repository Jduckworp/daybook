FROM python:3.12-slim

# Nothing here is compiled, so the slim image needs no build toolchain.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DONEBOOK_DATA_DIR=/data \
    DONEBOOK_CONFIG=/data/config.json

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY templates/ ./templates/
COPY static/ ./static/

# The database and the password hash both live on the volume, so recreating
# the container never loses the record and never regenerates the password.
# Creating /data in the image with the right owner is what lets a named
# volume inherit that ownership on first use.
RUN useradd --system --uid 1000 --create-home donebook \
 && mkdir -p /data \
 && chown -R donebook:donebook /data /app
USER donebook

VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=4).status==200 else 1)"

CMD ["gunicorn", "--workers", "2", "--threads", "4", "--timeout", "60", \
     "--bind", "0.0.0.0:8765", "--access-logfile", "-", "--error-logfile", "-", \
     "app:app"]
