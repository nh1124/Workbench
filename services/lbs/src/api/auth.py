from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional

from ..models.database import get_db, User, APIKey
from ..models.external_identity import ExternalIdentity
from .schemas import (
    LinkRequest, 
    LinkedUserResponse, 
    ProvisionRequest, 
    ProvisionResponse,
    APIKeyCreate,
    APIKeyResponse,
    APIKeyMetaResponse,
    LoginRequest,
    TokenResponse,
    LinkConfirmRequest
)
from ..auth import (
    resolve_identity, 
    Identity, 
    get_identity_from_jwt, 
    oauth2_scheme,
    verify_password,
    UnlinkedIdentityError,
    require_local_user,
    require_external_identity,
    require_client_api_key,
    generate_api_key,
    hash_api_key,
    create_access_token
)
from ..config import settings
from datetime import datetime, timedelta, timezone
from fastapi import Header

router = APIRouter(prefix="/auth", tags=["Auth"])

@router.post("/login", response_model=TokenResponse)
async def login_local(
    req: LoginRequest,
    db: Session = Depends(get_db)
):
    """
    Authenticate with local username/password and issue an LBS JWT.
    """
    user = db.query(User).filter(
        (User.email == req.username_or_email) | (User.name == req.username_or_email)
    ).first()
    
    if not user or not user.password_hash or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )
        
    # Issue LBS JWT with strict claims (iss="lbs", aud="lbs-ui")
    access_token = create_access_token(user_id=user.user_id)
    return {"access_token": access_token}

@router.get("/me")
async def get_auth_me(
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    """
    Return current local identity information.
    """
    user = db.query(User).filter(User.user_id == identity.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    return {
        "user_id": user.user_id,
        "username": user.name or user.email,
        "email": user.email,
        "auth_method": "local",
        "issuer": "lbs"
    }

@router.get("/identity")
async def get_full_identity(
    identity: Identity = Depends(resolve_identity)
):
    """
    Debug endpoint to show resolved identity (local, external, or api_key).
    Only available in non-production environments.
    """
    if settings.LBS_ENV == "prod":
        raise HTTPException(status_code=404, detail="Not Found")
        
    return identity.model_dump()

@router.post("/link/confirm")
async def confirm_link_external(
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user),
    external_payload: dict = Depends(require_external_identity)
):
    """
    Link a verified External System JWT identity (from X-EXTERNAL-JWT header) 
    to the currently logged-in local LBS account.
    """
    issuer = external_payload.get("iss")
    subject = external_payload.get("sub")
    
    # 1. Check if this identity is already linked
    existing_link = db.query(ExternalIdentity).filter(
        ExternalIdentity.issuer == issuer,
        ExternalIdentity.subject == subject
    ).first()
    
    if existing_link:
        if existing_link.user_id == identity.user_id:
            return {
                "message": "External identity already linked to this account", 
                "linked": True, 
                "already_linked": True
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, 
                detail="External identity already linked to a DIFFERENT account. Takeover not allowed."
            )
        
    # 2. Create link for the local user
    new_link = ExternalIdentity(
        user_id=identity.user_id,
        issuer=issuer,
        subject=subject
    )
    db.add(new_link)
    db.commit()
    
    return {
        "message": "External identity linked successfully", 
        "linked": True,
        "issuer": issuer, 
        "subject": subject
    }

# Legacy /link removed in favor of /link/confirm (local-first)

@router.post("/api-keys/provision", response_model=ProvisionResponse)
async def provision_external_client_key(
    req: ProvisionRequest,
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    """
    Client key provisioning (manual). 
    Enables a user to (re)issue a key for a specific external integration client.
    
    TODO: Support client_id allowlist/parameter for multi-tenant integration.
    Currently hardcoded to 'external-client' as a temporary default.
    """
    client_id = "external-client"
    
    existing_key = db.query(APIKey).filter(
        APIKey.user_id == identity.user_id,
        APIKey.client_id == client_id,
        APIKey.is_active == True
    ).first()
    
    if existing_key and not req.rotate:
        return ProvisionResponse(
            client_id=client_id,
            already_exists=True
        )
        
    # Rotate: Revoke old if exists
    if existing_key:
        existing_key.is_active = False
        existing_key.revoked_at = datetime.now(timezone.utc)
        
    # Create new
    plain_key = generate_api_key()
    new_key = APIKey(
        user_id=identity.user_id,
        client_id=client_id,
        key_hash=hash_api_key(plain_key),
        scopes=req.scopes,
        is_active=True
    )
    db.add(new_key)
    db.commit()
    
    return ProvisionResponse(
        client_id=client_id,
        api_key=plain_key
    )

@router.post("/api-keys", response_model=APIKeyResponse)
async def create_api_key(
    req: APIKeyCreate,
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    """Create a user-managed API key."""
    plain_key = generate_api_key()
    expires_at = None
    if req.expires_in_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=req.expires_in_days)
        
    new_key = APIKey(
        user_id=identity.user_id,
        client_id=req.client_id,
        key_hash=hash_api_key(plain_key),
        scopes=req.scopes,
        expires_at=expires_at,
        is_active=True
    )
    db.add(new_key)
    db.commit()
    db.refresh(new_key)
    
    # Map to response model and inject plaintext key once
    resp = APIKeyResponse.model_validate(new_key)
    resp.api_key = plain_key
    return resp

@router.get("/api-keys", response_model=list[APIKeyMetaResponse])
async def list_api_keys(
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    """List metadata for all API keys belonging to the current user. Plaintext and hashes are NEVER returned here."""
    keys = db.query(APIKey).filter(
        APIKey.user_id == identity.user_id
    ).all()
    return keys

@router.delete("/api-keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    """Revoke an API key."""
    key = db.query(APIKey).filter(
        APIKey.id == key_id,
        APIKey.user_id == identity.user_id
    ).first()
    
    if not key:
        raise HTTPException(status_code=404, detail="API Key not found")
        
    key.is_active = False
    key.revoked_at = datetime.now(timezone.utc)
    db.commit()
    
    return {"message": "API key revoked"}
