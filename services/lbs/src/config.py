import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "LBS Microservice"
    API_V1_STR: str = "/api/lbs"
    LBS_SECRET_KEY: str = "your-secret-key-here"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 8  # 8 days
    
    # Server Configuration
    LBS_ENV: str = "dev"
    LBS_BIND_HOST: str = "127.0.0.1"
    BACKEND_PORT: int = 8100
    
    # Auth & Security
    LBS_REQUIRE_API_KEY: bool = False
    LBS_DEFAULT_USER_ID: str = "00000000-0000-0000-0000-000000000000"
    LBS_ENABLE_DEV_HEADER_AUTH: bool = False
    LBS_CORS_ALLOW_ORIGINS: str = "*"
    LBS_API_KEY_PEPPER: str = "lbs-default-pepper-change-me"
    ALLOW_DEV_FALLBACK: bool = True # Only works in LBS_ENV != "prod"
    
    # External System Integration
    ENABLE_EXTERNAL_LINKING: bool = True
    ENABLE_EXTERNAL_LOGIN: bool = False
    
    # Database
    DATABASE_URL: str = "sqlite:///./lbs.db"
    
    # LBS Defaults
    DEFAULT_ALPHA: float = 0.1
    DEFAULT_BETA: float = 1.2
    DEFAULT_CAP: float = 8.0
    DEFAULT_SWITCH_COST: float = 0.5
    LBS_REFRESH_DEBOUNCE_ENABLED: bool = True
    LBS_REFRESH_DEBOUNCE_SECONDS: int = 1

    model_config = {
        "env_file": ".env",
        "case_sensitive": True,
        "extra": "ignore"
    }

settings = Settings()
