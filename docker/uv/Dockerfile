ARG UV_VERSION=0.9.11
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM python:3.12-slim
COPY --from=uv /uv /usr/local/bin/uv
COPY package_proxy.py bridge.py job.py /opt/relay/
RUN mkdir /relay-proxy && chown 65534:65534 /relay-proxy
ENV PYTHONDONTWRITEBYTECODE=1
