# Python Training Worker Dockerfile
# Builds a container for the ML training worker that processes training jobs from RabbitMQ

FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for PyTorch and image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
# PyTorch from PyPI automatically selects the appropriate CPU/GPU variant for the platform
RUN pip install --no-cache-dir -r requirements.txt

# Copy training code
COPY . .

# Run the worker
CMD ["python", "-u", "worker.py"]
