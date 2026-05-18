from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os
import logging
import sys
from .api import routes, users, auth, condition
from .auth import get_password_hash, hash_api_key
from .models.database import engine, Base, SessionLocal, User, APIKey
from .config import settings



app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json"
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("lbs")

# Add CORS middleware
origins = settings.LBS_CORS_ALLOW_ORIGINS.split(",") if settings.LBS_CORS_ALLOW_ORIGINS != "*" else ["*"]

# Security check for PROD
if settings.LBS_ENV.lower() == "prod":
    if "*" in origins:
        logger.critical("SECURITY ERROR: CORS wildcard '*' is not allowed in PROD environment.")
        sys.exit(1)
    if not settings.LBS_REQUIRE_API_KEY:
        logger.critical("SECURITY ERROR: LBS_REQUIRE_API_KEY must be true in PROD environment.")
        sys.exit(1)
    if settings.LBS_ENABLE_DEV_HEADER_AUTH:
        logger.critical("SECURITY ERROR: LBS_ENABLE_DEV_HEADER_AUTH must be false in PROD environment.")
        sys.exit(1)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_populate():
    # Create tables (ensure all exist)
    Base.metadata.create_all(bind=engine)
    
    # Ensure default user exists if LBS_REQUIRE_API_KEY is false
    if not settings.LBS_REQUIRE_API_KEY:
        db = SessionLocal()
        try:
            default_user = db.query(User).filter(User.user_id == settings.LBS_DEFAULT_USER_ID).first()
            if not default_user:
                logger.info(f"Creating default user {settings.LBS_DEFAULT_USER_ID} for dev mode")
                user = User(
                    user_id=settings.LBS_DEFAULT_USER_ID,
                    email="dev-fallback@lbs.internal",
                    name="Default Dev User",
                    password_hash=get_password_hash("password") # Default dev password
                )
                db.add(user)
                db.commit()
        finally:
            db.close()

# Include routers
app.include_router(auth.router, prefix=settings.API_V1_STR)
app.include_router(users.router, prefix=settings.API_V1_STR)
app.include_router(routes.router, prefix=settings.API_V1_STR)
app.include_router(condition.router, prefix=settings.API_V1_STR)

@app.get("/")
def root():
    return {"message": "LBS Microservice is running", "docs": "/docs"}

@app.get("/health")
def health_check():
    return {"status": "healthy"}

# Serve static files from the UI build directory
# We assume the 'ui/dist' folder exists after the frontend build
UI_DIST_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "ui", "dist")

if os.path.exists(UI_DIST_PATH):
    app.mount("/assets", StaticFiles(directory=os.path.join(UI_DIST_PATH, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        # If the request is for an API route, let it fall through or it should have been caught by the routers
        if full_path.startswith(settings.API_V1_STR.lstrip('/')):
            return None # This should not happen if routes are defined
        
        # Check if it's a file that exists in dist (like favicon.ico)
        file_path = os.path.join(UI_DIST_PATH, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
            
        # Otherwise serve index.html for SPA routing
        return FileResponse(os.path.join(UI_DIST_PATH, "index.html"))
if __name__ == "__main__":
    import uvicorn
    
    logger.info(f"Starting {settings.PROJECT_NAME}...")
    logger.info(f"Environment: {settings.LBS_ENV}")
    logger.info(f"Bind Host (Internal): {settings.LBS_BIND_HOST}")
    logger.info(f"External Access: Restricted by Docker to LBS_BIND_HOST from .env if applicable")
    logger.info(f"Port: {settings.BACKEND_PORT}")
    logger.info(f"API Key Required: {settings.LBS_REQUIRE_API_KEY}")
    logger.info(f"Dev Header Auth Enabled: {settings.LBS_ENABLE_DEV_HEADER_AUTH}")
    logger.info(f"CORS Allowed Origins: {settings.LBS_CORS_ALLOW_ORIGINS}")
    
    uvicorn.run(app, host=settings.LBS_BIND_HOST, port=settings.BACKEND_PORT)
