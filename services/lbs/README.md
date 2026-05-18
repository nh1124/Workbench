# LBS (Load Balancing System)

LBS is a comprehensive Load Balancing System that manages and schedules tasks. It includes a FastAPI backend and a modern React-based UI for maintenance and monitoring.

## Features

-   **Dual-Layer Architecture**: Clean separation between **Master Task Definitions** and **Daily Execution Schedules**.
-   **High-Performance Schedule API**: A unified endpoint for daily loads and grouped task states using optimized server-side caching.
-   **Execution History**: Granular tracking of task outcomes (`DONE`, `SKIPPED`, `IN_PROGRESS`) with progress and time tracking.
-   **CSV Task Import**: Support for bulk task registration with advanced recurrence rules.
-   **Cognitive Load Balancing**: Automatic load calculation with adaptive penalties for context switching and task density.
-   **Integrated Python Client**: Ready-to-use SDK for AI agents and automation.

## Tech Stack

### Backend
-   **Language**: Python 3.x
-   **Framework**: FastAPI
-   **ORM**: SQLAlchemy
-   **Database**: PostgreSQL

### Frontend
-   **Framework**: React (Vite)
-   **Styling**: Vanilla CSS / Design Tokens

### Infrastructure
-   **Docker**: Containerization for consistent environments.
-   **Docker Compose**: Orchestration for multi-container setup.

## Getting Started

### Prerequisites

-   [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) installed on your machine.

### Installation & Running

1.  Clone the repository:
    ```bash
    git clone https://github.com/nh1124/LBS.git
    cd LBS
    ```

2.  Start the application using Docker Compose:
    ```bash
    docker-compose up --build
    ```

    This command will build the backend and frontend images and start the services, including the PostgreSQL database.

3.  Access the services:
    -   **LBS UI & API**: Open [http://localhost:8100](http://localhost:8100) in your browser.
    -   **API Documentation**: Open [http://localhost:8100/docs](http://localhost:8100/docs) for the interactive Swagger UI.

## Project Structure

-   `src/`: Backend source code (FastAPI, LBS Engine, Data Models).
-   `ui/`: Frontend source code (Vite + React Glassmorphism Dashboard).
-   `docs/`: System design and API usage guidelines.
-   `samples/`: Integration samples and the core Python Client.
-   `samples/python_client/`: Official LBS Python SDK.
-   `samples/tasks_template.csv`: Template for bulk task import.
-   `docker-compose.yml`: Service definitions.
-   `.env.example`: Sample environment configuration.

## Samples & Python Client

LBS provides an official Python Client for high-level integration, located in `samples/python_client`.

- `lbs_client.py`: The core `LBSClient` class.
- `client_examples.py`: Examples for task management, schedule retrieval, and history tracking.

To use the client:
```python
from samples.python_client.lbs_client import LBSClient, TaskStatus
from datetime import date

client = LBSClient(base_url="http://localhost:8100/api/lbs", api_key="your_key")
schedule = client.get_schedule(date.today(), date.today())
```

## Authentication & Security

LBS uses a **Local-First** authentication model with optional **External System Linking**.

### Auth Concepts

1.  **Local Identity**:
    *   Issued by LBS.
    *   Authenticated via local username/password.
    *   Used for all standard UI/API operations.
2.  **External Identity (Optional)**:
    *   Issued by an External IdP (e.g. Antigravity OS).
    *   Linked to a local LBS user for cross-system integration.
3.  **Client Credentials (M2M)**:
    *   API keys issued by LBS.
    *   Used for automation and external system interactions.

### Auth Methods (Priority Order)

1.  **JWT Bearer Token (Local)**: Primary method for human users. Verified against LBS secret.
2.  **X-API-KEY Header**: Secondary method for M2M/Automation.
3.  **JWT Bearer Token (External)**: Strictly for linking flows or specific automation.
4.  **Dev Fallback**: Used only if `LBS_REQUIRE_API_KEY=false`.

### User Setup

1.  Open the UI at [http://localhost:8100](http://localhost:8100).
2.  Create a **Local Account** with a username and password.
3.  Log in to access the Dashboard.
4.  (Optional) Go to **Settings** to:
    *   **Link External System**: Connect your account to an external IdP.
    *   **Manage API Keys**: Generate keys for automation scripts.

### Usage Examples (Curl)
```bash
# Get Master Tasks
curl -H "X-API-KEY: your-key" http://localhost:8100/api/lbs/tasks

# Get Daily Schedule (Source of Truth)
curl -H "X-API-KEY: your-key" "http://localhost:8100/api/lbs/schedule?start_date=2024-01-01&end_date=2024-01-01"

# Record Execution
curl -X POST -H "X-API-KEY: your-key" -H "Content-Type: application/json" \
     -d '{"target_date": "2024-01-01", "status": "done"}' \
     http://localhost:8100/api/lbs/tasks/T-12345/complete
```

### Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `LBS_ENV` | `dev` | `dev` or `prod`. `prod` restricts debug endpoints and enforces strict security. |
| `LBS_REQUIRE_API_KEY` | `false` | If `true`, requires API key or JWT. If `false`, falls back to default user (only in non-prod). |
| `ALLOW_DEV_FALLBACK` | `true` | If `true`, allows auth fallback in non-prod environments. |
| `LBS_DEFAULT_USER_ID` | `0000...` | UUID used for dev fallback. |
| `LBS_API_KEY_PEPPER` | `lbs-default...` | Pepper used for API key hashing. **Change in production!** |
| `LBS_BIND_HOST` | `127.0.0.1` | Host to bind uvicorn. |
| `BACKEND_PORT` | `8100` | Port for the backend service. |
| `LBS_REFRESH_DEBOUNCE_ENABLED` | `true` | If `true`, enables debouncing of schedule recalculations. |
| `LBS_REFRESH_DEBOUNCE_SECONDS` | `3` | Time window (in seconds) to skip recalculation if already generated. |

## Development

To run the backend locally (without Docker):
1.  Create a virtual environment: `python -m venv venv`
2.  Activate it: `source venv/bin/activate` (or `venv\Scripts\activate` on Windows)
3.  Install dependencies: `pip install -r requirements.txt`
4.  Run the server: `uvicorn src.main:app --reload`
