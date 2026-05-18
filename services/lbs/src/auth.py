import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, List
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status, Header
from fastapi.security import OAuth2PasswordBearer, APIKeyHeader
from sqlalchemy.orm import Session
from pydantic import BaseModel
import hashlib
import hmac
import secrets

from .models.database import get_db, User, APIKey
from .models.external_identity import ExternalIdentity
from .config import settings
from passlib.context import CryptContext

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class UnlinkedIdentityError(HTTPException):
    def __init__(self, issuer: str, subject: str):
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "unlinked_identity",
                "issuer": issuer,
                "subject": subject
            }
        )

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/lbs/auth/login", auto_error=False)
logger = logging.getLogger("lbs.auth")

class Identity(BaseModel):
    user_id: str
    client_id: Optional[str] = None
    scopes: List[str] = []
    auth_method: str # local, external, api_key, dev_fallback
    issuer: Optional[str] = None
    audience: Optional[str] = None
    warnings: List[str] = []

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def generate_api_key() -> str:
    """Generate a high-entropy random API key (32 bytesURL-safe base64)."""
    return secrets.token_urlsafe(32)

def hash_api_key(api_key: str) -> str:
    """Hash an API key using HMAC-SHA256 with a server-side pepper."""
    return hmac.new(
        settings.LBS_API_KEY_PEPPER.encode(),
        api_key.encode(),
        hashlib.sha256
    ).hexdigest()

def verify_api_key(plain_key: str, hashed_key: str) -> bool:
    """Verify a plain API key against a hashed key using constant-time comparison."""
    return hmac.compare_digest(hash_api_key(plain_key), hashed_key)

async def get_identity_from_jwt(token: str) -> dict:
    try:
        # Decode without verification first to check issuer
        unverified = jwt.get_unverified_claims(token)
        issuer = unverified.get("iss")
        
        # If issued by LBS, we use our own secret
        if issuer == "lbs":
            payload = jwt.decode(
                token, 
                settings.LBS_SECRET_KEY, 
                algorithms=[settings.ALGORITHM],
                audience="lbs-ui"
            )
            return payload
      
        # Otherwise, verify as External System JWT
        # TODO: Implement issuer allowlist check
        # TODO: Implement mapping of issuer -> public key/JWKS for multi-tenant support
        
        # For now, we still use the same secret (placeholder for dev).
        # In a real scenario, we would use the External System's public key or JWKS.
        # Logic is separated here to allow future expansion.
        payload = jwt.decode(token, settings.LBS_SECRET_KEY, algorithms=[settings.ALGORITHM])
        
        issuer = payload.get("iss")
        subject = payload.get("sub")
        audience = payload.get("aud")
        
        if not issuer or not subject:
            raise JWTError("Missing iss or sub")
            
        # Verify LBS is in audience for external tokens
        valid_aud = False
        if audience == "lbs":
            valid_aud = True
        elif isinstance(audience, list) and "lbs" in audience:
            valid_aud = True
            
        if not valid_aud:
            raise JWTError("Invalid audience (target 'lbs' not found)")
            
        return payload
    except JWTError as e:
        logger.warning(f"JWT Verification failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

def resolve_user_from_identity(db: Session, identity_payload: dict) -> User:
    issuer = identity_payload.get("iss")
    subject = identity_payload.get("sub")
    
    mapping = db.query(ExternalIdentity).filter(
        ExternalIdentity.issuer == issuer,
        ExternalIdentity.subject == subject
    ).first()
    
    if mapping:
        user = db.query(User).filter(User.user_id == mapping.user_id).first()
        if user:
            return user
            
    raise UnlinkedIdentityError(issuer=issuer, subject=subject)

async def resolve_identity(
    db: Session = Depends(get_db),
    x_api_key: Optional[str] = Header(None, alias="X-API-KEY"),
    token: Optional[str] = Depends(oauth2_scheme)
) -> Identity:
    warnings = []
    
    # 1. JWT Auth (Primary for UI/Users)
    if token:
        payload = await get_identity_from_jwt(token)
        issuer = payload.get("iss")
        
        # Scenario A: Local LBS JWT
        if issuer == "lbs":
            return Identity(
                user_id=payload.get("sub"),
                auth_method="local",
                issuer="lbs",
                audience=payload.get("aud"),
                warnings=warnings
            )
            
        # Scenario B: External System JWT (Only if linked or for specific flows)
        try:
            user = resolve_user_from_identity(db, payload)
            return Identity(
                user_id=user.user_id,
                auth_method="external",
                issuer=issuer,
                audience=payload.get("aud"),
                warnings=warnings
            )
        except UnlinkedIdentityError:
            # If we allow External Login without linking, handle here.
            # Otherwise, raise for linking flow.
            if settings.ENABLE_EXTERNAL_LOGIN:
                # Custom logic for auto-provisioning or temporary session
                pass
            raise

    # 2. API Key Auth (Primary for Automation/M2M)
    if x_api_key:
        # Use standard import from models.database (handled at top level)
        key_hash = hash_api_key(x_api_key)
        api_key_record = db.query(APIKey).filter(
            APIKey.key_hash == key_hash,
            APIKey.is_active == True
        ).first()
        
        if api_key_record:
            # Check for expiration
            if api_key_record.expires_at and api_key_record.expires_at < datetime.now(timezone.utc):
                logger.warning(f"Expired API Key attempt for user {api_key_record.user_id}")
                raise HTTPException(status_code=401, detail="API Key expired")

            # Update last_used_at
            api_key_record.last_used_at = datetime.now(timezone.utc)
            db.commit()
            
            logger.debug(f"Authenticated with API Key ({api_key_record.client_id}) for user {api_key_record.user_id}")
            return Identity(
                user_id=api_key_record.user_id,
                client_id=api_key_record.client_id,
                scopes=api_key_record.scopes or [],
                auth_method="api_key",
                warnings=warnings
            )
        else:
            logger.warning(f"Invalid API Key attempt: {x_api_key[:8]}...")

    # 3. Dev Fallback (Only in non-prod and ONLY if explicitly enabled)
    if not settings.LBS_REQUIRE_API_KEY and settings.LBS_ENV != "prod" and settings.ALLOW_DEV_FALLBACK:
        return Identity(
            user_id=settings.LBS_DEFAULT_USER_ID,
            auth_method="dev_fallback",
            issuer="lbs",
            warnings=["Authenticated via Dev Fallback"]
        )

    # 4. Final failure if no auth method provided
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing or invalid authentication",
        headers={"WWW-Authenticate": "Bearer"},
    )

async def require_local_user(identity: Identity = Depends(resolve_identity)) -> Identity:
    """Accept ONLY LBS-issued JWT (local identity)."""
    if identity.auth_method == "dev_fallback":
        return identity
        
    if identity.auth_method != "local" or identity.issuer != "lbs" or identity.audience != "lbs-ui":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This endpoint requires a local LBS session (lbs-ui)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return identity

async def require_external_identity(
    db: Session = Depends(get_db),
    x_external_jwt: str = Header(..., alias="X-EXTERNAL-JWT")
) -> dict:
    """Accept ONLY external-system JWT via custom header. Returns verified payload."""
    payload = await get_identity_from_jwt(x_external_jwt)
    issuer = payload.get("iss")
    
    if issuer == "lbs":
        raise HTTPException(status_code=400, detail="Cannot use LBS local token as external identity")
        
    return payload

async def require_client_api_key(identity: Identity = Depends(resolve_identity)) -> Identity:
    """Accept ONLY X-API-KEY (M2M automation)."""
    if identity.auth_method not in ["api_key", "dev_fallback"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint requires a valid X-API-KEY"
        )
    return identity

async def require_user_identity(identity: Identity = Depends(resolve_identity)) -> Identity:
    """Accept any valid identity mapped to a user (local, external, api_key, dev_fallback)."""
    # resolve_identity already raises 401 if no valid auth is found.
    # We just need to ensure it's not an unlinked external identity (which already raises in resolve_identity).
    return identity

def create_access_token(user_id: str, expires_delta: Optional[timedelta] = None):
    """Issues an LBS token with strict claims: iss="lbs", aud="lbs-ui", sub=<user_id>"""
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode = {
        "sub": str(user_id),
        "iss": "lbs",
        "aud": "lbs-ui",
        "exp": expire,
        "iat": datetime.now(timezone.utc)
    }
    
    encoded_jwt = jwt.encode(to_encode, settings.LBS_SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

async def get_current_user(
    db: Session = Depends(get_db),
    identity: Identity = Depends(resolve_identity)
):
    """Backward compatibility layer for existing get_current_user usage."""
    user = db.query(User).filter(User.user_id == identity.user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    return user
