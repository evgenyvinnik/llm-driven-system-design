FROM node:20-alpine

# Install Python
RUN apk add --no-cache python3 py3-pip

# Create non-root user for code execution
RUN adduser -D -u 1001 coderunner

# Set working directory
WORKDIR /code

# Switch to non-root user
USER coderunner

# Default command - keep container running
CMD ["tail", "-f", "/dev/null"]
