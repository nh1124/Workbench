# Stage 1: Build the frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm install
COPY ui/ .
RUN npm run build

# Stage 2: Final image
FROM python:3.12-slim
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY . .

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/ui/dist ./ui/dist

# Create data directory for SQLite
RUN mkdir -p data

# Expose the API port (unified)
EXPOSE 8000

# Run the application
CMD ["python", "-m", "src.main"]
